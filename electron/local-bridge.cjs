const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
// Local authenticated JSONL side channel. PTY stdout always remains terminal
// output; profile banners and ANSI sequences cannot enter the control stream.
async function localBridge(onMessage) {
  const token = crypto.randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\lumen-${crypto.randomUUID()}` : path.join(os.tmpdir(), `lumen-${crypto.randomUUID()}.sock`);
  let socket, connectedResolve, connectedReject;
  const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  connected.catch(() => {});
  const server = net.createServer((client) => {
    if (socket) { client.destroy(); return; }
    let buffer = "", authenticated = false;
    client.setEncoding("utf8");
    client.on("error", () => {});
    client.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { client.destroy(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { client.destroy(); return; }
        if (!authenticated) {
          if (typeof message.token !== "string" || !/^[0-9a-f]{64}$/.test(message.token) || !crypto.timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) { client.destroy(); return; }
          authenticated = true; socket = client; connectedResolve();
        } else onMessage(message);
      }
    });
    client.on("close", () => { if (socket === client) { socket = null; onMessage({ type: "bridge_closed" }); } });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return { endpoint, token, connected,
    write(message) { if (!socket || socket.destroyed) throw new Error("The terminal bridge is disconnected."); socket.write(JSON.stringify(message) + "\n"); },
    close() { socket?.destroy(); server.close(); connectedReject(new Error("The terminal bridge closed.")); },
  };
}
module.exports = { localBridge };
