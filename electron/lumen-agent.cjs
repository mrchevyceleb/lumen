#!/usr/bin/env node
// Dependency-free local client. Copied beside agent-control.json on Lumen startup.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const help = `Lumen agent control — all tasks are visible in the app
  lumen-agent list
  lumen-agent create --agent codex --root "C:\\repo" --name "Fix login" --text "..."
  lumen-agent create --agent claude --text-file task.txt
  lumen-agent get TASK_ID
  lumen-agent send TASK_ID --text "Continue with tests"
  lumen-agent steer TASK_ID MESSAGE_ID
  lumen-agent remove TASK_ID MESSAGE_ID
  lumen-agent resume|stop|focus|close TASK_ID
  lumen-agent models TASK_ID
  lumen-agent configure TASK_ID --model MODEL --effort LEVEL --work-mode plan
  lumen-agent rename TASK_ID --name "New title"
  lumen-agent answer TASK_ID REQUEST_ID --response '{"value":"..."}'
  lumen-agent watch TASK_ID [--timeout 600] [--interval 1000]
  lumen-agent browser list
  lumen-agent browser open --url http://localhost:3000 [--workspace FOLDER]
  lumen-agent browser inspect|screenshot|reload|back|forward|select|close TAB_ID
  lumen-agent browser navigate TAB_ID --url https://example.com
  lumen-agent browser evaluate TAB_ID --script-file interaction.js
  Screenshot: --output FILE.png saves the image instead of printing a data URL.
Options: --connection FILE, --id UUID (retry-safe task/message ID), --owner NAME,
  --cwd FOLDER, --account-id UUID. Omit --root for a chat without a workspace.
Messages queue by default. Steer names an existing queued message. Watch emits
JSON snapshots as the visible transcript changes; it exits when idle or awaiting
your input. Use get to inspect its status. Lumen must be running.
Set LUMEN_CONTROL_FILE for portable/custom profiles. Never share its token.`;
async function main() {
  const options = {}, args = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) args.push(arg);
    else if (arg === "--help") options.help = true;
    else { if (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`); options[arg.slice(2)] = process.argv[++i]; }
  }
  if (options.help || !args.length || args[0] === "help") return console.log(help);
  const allowed = new Set(["connection", "id", "agent", "root", "cwd", "name", "text", "text-file", "owner", "model", "effort", "work-mode", "account-id", "response", "timeout", "interval", "url", "workspace", "script-file", "output"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
  const dataDir = process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Lumen") : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Lumen") : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Lumen");
  const file = options.connection || process.env.LUMEN_CONTROL_FILE || path.join(dataDir, "agent-control.json");
  async function request(method, route, body) {
    let connection;
    try { connection = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error(`Open Lumen and enable Settings → Agent control. Connection file: ${file}`); }
    const base = new URL(connection.url);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || typeof connection.token !== "string") throw new Error("Invalid local connection file.");
    const data = body === undefined ? "" : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(route, base), { method, headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) } }, (res) => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", (part) => { text += part; if (text.length > 20000000) req.destroy(new Error("Transcript is too large.")); });
        res.on("end", () => { try { const value = JSON.parse(text); if (res.statusCode >= 400) reject(new Error(value.error || `HTTP ${res.statusCode}`)); else resolve(value); } catch (e) { reject(e); } });
        res.on("error", reject);
      });
      req.setTimeout(65000, () => req.destroy(new Error("Lumen timed out; read the task before retrying and reuse --id.")));
      req.on("error", reject); req.end(data);
    });
  }
  const [command, id, messageId] = args;
  if (command === "browser") {
    const result = await request("POST", "/v1/browser", { action: id, id: messageId, url: options.url, workspace: options.workspace,
      ...(options["script-file"] ? { script: await fs.readFile(options["script-file"], "utf8") } : {}) });
    if (id === "screenshot" && options.output) {
      if (typeof result.image !== "string" || !result.image.startsWith("data:image/png;base64,")) throw new Error("No browser screenshot returned.");
      await fs.writeFile(options.output, Buffer.from(result.image.slice("data:image/png;base64,".length), "base64"));
      return console.log(JSON.stringify({ path: path.resolve(options.output) }));
    }
    return console.log(JSON.stringify(result));
  }
  if (command !== "create" && command !== "list" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "")) throw new Error("Choose a task ID from list or create.");
  let body = {};
  for (const [key, value] of Object.entries(options)) {
    const field = { "work-mode": "workMode", "account-id": "accountId" }[key] || key;
    if (!["connection", "text-file", "timeout", "interval", "response"].includes(key)) body[field] = value;
  }
  if (options["text-file"]) { if (options.text !== undefined) throw new Error("Choose --text or --text-file."); body.text = await fs.readFile(options["text-file"], "utf8"); }
  const route = `/v1/tasks/${id}`;
  let result;
  if (command === "list") result = await request("GET", "/v1/tasks");
  else if (command === "create") { body.id ||= crypto.randomUUID(); result = await request("POST", "/v1/tasks", body); }
  else if (command === "get" || command === "models") result = await request("GET", command === "get" ? route : route + "/models");
  else if (command === "send") { body.id ||= crypto.randomUUID(); result = await request("POST", route + "/messages", body); }
  else if (command === "steer" || command === "remove") result = await request("POST", route + "/queue", { messageId, action: command });
  else if (command === "answer") result = await request("POST", route + "/answer", { requestId: messageId, response: JSON.parse(options.response || "{}") });
  else if (["resume", "stop", "focus", "close", "rename", "configure"].includes(command)) result = await request("POST", route + "/" + command, body);
  else if (command === "watch") {
    const timeout = Number(options.timeout || 600), interval = Number(options.interval || 1000);
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval < 250) throw new Error("Use a positive timeout in seconds and interval of at least 250 ms.");
    const deadline = Date.now() + timeout * 1000; let previous = "";
    while (Date.now() < deadline) {
      const value = await request("GET", route), serialized = JSON.stringify(value);
      if (serialized !== previous) console.log(serialized);
      previous = serialized;
      if (value.pendingRequests.length || (!value.busy && (!value.queuedMessages.length || value.queuePaused))) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error("Watch timed out. The task continues in Lumen.");
  } else throw new Error(`Unknown command ${command}. Use --help.`);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
