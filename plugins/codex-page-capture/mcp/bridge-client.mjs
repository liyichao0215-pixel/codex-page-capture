import { randomUUID } from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import { SOCKET_PATH } from "../native/core.mjs";

export function invokeBridge(method, args = {}, timeoutMs = 35 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(SOCKET_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`页面采集操作超时：${method}`));
    }, timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, args })}\n`);
    });
    socket.once("error", (error) => {
      const message = ["ENOENT", "ECONNREFUSED"].includes(error?.code)
        ? "Chrome 页面采集扩展尚未连接。请确认 Chrome 已打开、扩展已加载，并运行健康检查。"
        : error.message;
      finish(reject, new Error(message));
    });

    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("error", () => {
      // The socket's own error handler returns the user-facing connection message.
    });
    lines.once("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id && response.id !== id) throw new Error("本地桥响应 ID 不匹配");
        response.ok
          ? finish(resolve, response.result)
          : finish(reject, new Error(response.error || "页面采集失败"));
      } catch (error) {
        finish(reject, error);
      }
    });
  });
}
