#!/usr/bin/env node

import { connect } from "node:net";

const host = process.env.DSH_WEB_HOST || "127.0.0.1";
const port = Number(process.env.DSH_WEB_PORT || 3080);
const timeoutMs = Number(process.env.DSH_BROWSER_STREAM_PROBE_TIMEOUT_MS || 5000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DSH_WEB_PORT must be a valid TCP port");
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
  throw new Error("DSH_BROWSER_STREAM_PROBE_TIMEOUT_MS must be between 1 and 30000");
}

const response = await new Promise((resolve, reject) => {
  const socket = connect({ host, port });
  let received = "";
  let settled = false;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.destroy();
    callback();
  };
  const timeout = setTimeout(() => {
    finish(() => reject(new Error("timed out waiting for the Browser Use upgrade route")));
  }, timeoutMs);

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write([
      "GET /dsh-playwright/stream HTTP/1.1",
      `Host: ${host}:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: ZHNoLWNvbnRhaW5lci1wcm9iZQ==",
      `Origin: http://${host}:${port}`,
      "",
      "",
    ].join("\r\n"));
  });
  socket.on("data", chunk => {
    received += chunk;
    if (!received.includes("\r\n\r\n")) return;
    finish(() => resolve(received));
  });
  socket.on("error", error => finish(() => reject(error)));
  socket.on("close", () => {
    if (!settled) finish(() => reject(new Error("Browser Use upgrade socket closed without an HTTP response")));
  });
});

if (!response.startsWith("HTTP/1.1 400 Bad Request\r\n")) {
  throw new Error(`unexpected Browser Use upgrade probe response: ${JSON.stringify(response.slice(0, 160))}`);
}

console.log("Verified the live Browser Use WebSocket upgrade route.");
