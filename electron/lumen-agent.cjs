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
  lumen-agent create --agent claude --root "C:\\repo" --worktree agent/login-fix --base main --model MODEL --effort high --text "Fix login"
  lumen-agent create --agent claude --text-file task.txt
  lumen-agent get TASK_ID
  lumen-agent send TASK_ID --text "Heads up: the review is starting"   (deliver to a running agent)
  lumen-agent steer TASK_ID --text "Correction for the active run"
  lumen-agent steer TASK_ID MESSAGE_ID   (steer an existing queued message)
  lumen-agent remove TASK_ID MESSAGE_ID
  lumen-agent resume|stop|focus|close TASK_ID
  lumen-agent models TASK_ID
  lumen-agent configure TASK_ID --model MODEL --effort LEVEL --work-mode plan --speed default|priority|ultrafast
  lumen-agent rename TASK_ID --name "New title"
  lumen-agent answer TASK_ID REQUEST_ID --response '{"value":"..."}'
  lumen-agent watch TASK_ID [--timeout 600] [--interval 1000]
  lumen-agent browser list
  lumen-agent browser open --url http://localhost:3000 [--chat-id TASK_ID]
  lumen-agent browser inspect|screenshot|reload|back|forward|select|close TAB_ID
  lumen-agent browser navigate TAB_ID --url https://example.com
  lumen-agent browser evaluate TAB_ID --script-file interaction.js
  lumen-agent browser view TAB_ID --device iphone|pixel|ipad [--orientation landscape]   (phone-size view; --device desktop switches back)
  lumen-agent browser screenshot-markup TAB_ID --marks '[{"label":"broken button","x":0.42,"y":0.18}]' [--output marked.png]   (x/y normalized 0-1)
  lumen-agent browser snapshot TAB_ID   (list visible clickable elements with refs)
  lumen-agent browser click TAB_ID --ref N | --selector CSS | --text "Sign in" | --x 120 --y 240 [--double]
  lumen-agent browser hover TAB_ID --ref N | --selector CSS | --x 120 --y 240
  lumen-agent browser type TAB_ID --text "hello" [--ref N | --selector CSS] [--submit]
  lumen-agent browser press TAB_ID --key Enter [--modifiers control,shift]
  lumen-agent browser scroll TAB_ID --dy 600 [--dx 0] [--x 120 --y 240]
  Drive actions move a visible cursor in the pane and send real mouse/key input.
  lumen-agent whoami   (inside a Lumen chat: your own task id and state)
  lumen-agent guide    (print the full agent guide)
  Screenshot: --output FILE.png saves the image instead of printing a data URL.
Options: --connection FILE, --id UUID (retry-safe task/message ID), --owner NAME,
  --cwd FOLDER, --account-id UUID, --worktree BRANCH, --base REF.
  --worktree creates/reuses its dedicated checkout and needs --root.
  Omit --root for a chat without a workspace.
Send all agent messages directly, including updates: a busy agent receives them
in its current turn. Do not use --delivery queue unless the user explicitly asks
to wait until that turn finishes: lumen send TASK_ID --delivery queue --text "..."
Read the full result: steered means accepted; check the transcript when needed.
steerPending means automatic delivery after compaction. If deliveryUncertain is
true, inspect the chat before retrying. A queued or separately sent message was
accepted; do not resend it. Inspect the queue and use get to check the receiver.
If a routine message was queued by mistake or waits for the queue while a
supported receiver is busy, steer TASK_ID MESSAGE_ID on that existing message.
Never steer a paused or uncertain queue, or a command needing its own turn.
Gemini cannot steer; its queued messages wait for the next turn. If another
action is in progress, wait for it to finish before steering. Watch emits JSON
snapshots as the visible transcript changes; it exits when idle or awaiting input. Use get
to inspect its status. Lumen must be running.
Set LUMEN_CONTROL_FILE for portable/custom profiles. Never share its token.`;
async function main() {
  // PowerShell's binary launcher transports arguments in a temporary file:
  // native command-line quoting can lose them, and environment variables cap
  // otherwise valid long prompts at 32K characters.
  const forwardedFile = process.env.LUMEN_AGENT_ARGS_FILE;
  if (forwardedFile) {
    delete process.env.LUMEN_AGENT_ARGS_FILE;
    let forwarded;
    try { forwarded = await fs.readFile(forwardedFile, "utf8"); }
    finally { await fs.unlink(forwardedFile).catch(() => {}); }
    const match = /^(\d+):(.*)$/s.exec(forwarded);
    if (!match) throw new Error("Invalid forwarded Lumen arguments.");
    const count = Number(match[1]);
    const encoded = count ? match[2].split(",") : [];
    if (encoded.length !== count) throw new Error("Invalid forwarded Lumen argument count.");
    const values = encoded.map((value) => {
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64") !== value) throw new Error("Invalid forwarded Lumen arguments.");
      return bytes.toString("utf8");
    });
    const helperFile = process.env.LUMEN_AGENT_CLI_BASE64 ? Buffer.from(process.env.LUMEN_AGENT_CLI_BASE64, "base64").toString("utf8") : process.env.LUMEN_AGENT_CLI || "";
    delete process.env.LUMEN_AGENT_CLI_BASE64;
    process.argv = [process.argv[0], helperFile, ...values];
  }
  const options = {}, args = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) args.push(arg);
    else if (arg === "--help") options.help = true;
    else if (arg === "--submit" || arg === "--double") options[arg.slice(2)] = "true";
    else { if (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`); options[arg.slice(2)] = process.argv[++i]; }
  }
  if (options.help || !args.length || args[0] === "help") return console.log(help);
  const allowed = new Set(["connection", "id", "agent", "root", "cwd", "worktree", "base", "name", "text", "text-file", "owner", "model", "effort", "work-mode", "speed", "account-id", "response", "timeout", "interval", "url", "chat-id", "workspace", "script-file", "output", "device", "orientation", "marks", "selector", "ref", "x", "y", "key", "dy", "dx", "modifiers", "submit", "double", "delivery"]);
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
  if (command === "guide") {
    const guide = process.env.LUMEN_GUIDE || path.join(path.dirname(file), "lumen-agent-guide.md");
    try { return console.log(await fs.readFile(guide, "utf8")); }
    catch { throw new Error(`Open Lumen once so it writes its guide. Guide file: ${guide}`); }
  }
  if (command === "whoami") {
    const taskId = process.env.LUMEN_TASK_ID || "";
    if (!taskId) throw new Error("LUMEN_TASK_ID is not set. whoami works inside a Lumen chat; outside one, use list to see every task.");
    const task = await request("GET", `/v1/tasks/${taskId}`).catch((e) => ({ error: e.message }));
    return console.log(JSON.stringify({ taskId, task }, null, 2));
  }
  if (command === "browser") {
    if (!id) return console.log(help);
    const number = (value) => value === undefined ? undefined : Number(value);
    const body = { action: id, id: messageId, url: options.url, chatId: options["chat-id"], workspace: options.workspace,
      text: options.text, selector: options.selector, ref: number(options.ref), x: number(options.x), y: number(options.y),
      key: options.key, deltaY: number(options.dy), deltaX: number(options.dx),
      modifiers: options.modifiers ? options.modifiers.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean) : undefined,
      doubleClick: options.double === "true", submit: options.submit === "true",
      ...(options["script-file"] ? { script: await fs.readFile(options["script-file"], "utf8") } : {}) };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    if (id === "view") {
      body.view = !options.device || options.device === "desktop" ? { mode: "desktop" }
        : { mode: "mobile", device: options.device, orientation: options.orientation === "landscape" ? "landscape" : "portrait" };
    }
    if (id === "screenshot-markup") {
      if (!options.marks) throw new Error("screenshot-markup needs --marks '[{\"label\":\"...\",\"x\":0.42,\"y\":0.18}]' (x/y normalized 0-1).");
      try { body.marks = JSON.parse(options.marks); } catch { throw new Error("--marks must be a JSON array of {label, x, y}."); }
      if (!Array.isArray(body.marks)) throw new Error("--marks must be a JSON array of {label, x, y}.");
    }
    const result = await request("POST", "/v1/browser", body);
    if ((id === "screenshot" || id === "screenshot-markup") && options.output) {
      if (typeof result.image !== "string" || !result.image.startsWith("data:image/png;base64,")) throw new Error("No browser screenshot returned.");
      await fs.writeFile(options.output, Buffer.from(result.image.slice("data:image/png;base64,".length), "base64"));
      return console.log(JSON.stringify({ path: path.resolve(options.output) }));
    }
    return console.log(JSON.stringify(result));
  }
  if (command !== "create" && command !== "list" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "")) throw new Error("Choose a task ID from list or create.");
  let body = {};
  for (const [key, value] of Object.entries(options)) {
    const field = { "work-mode": "workMode", "account-id": "accountId", speed: "serviceTier" }[key] || key;
    if (!["connection", "text-file", "timeout", "interval", "response"].includes(key)) body[field] = value;
  }
  if (options["text-file"]) { if (options.text !== undefined) throw new Error("Choose --text or --text-file."); body.text = await fs.readFile(options["text-file"], "utf8"); }
  if (["create", "send"].includes(command) || (command === "steer" && body.text !== undefined)) {
    if (process.env.LUMEN_TASK_ID) body.senderId = process.env.LUMEN_TASK_ID;
  }
  const route = `/v1/tasks/${id}`;
  let result;
  if (command === "list") result = await request("GET", "/v1/tasks");
  else if (command === "create") { body.id ||= crypto.randomUUID(); result = await request("POST", "/v1/tasks", body); }
  else if (command === "get" || command === "models") result = await request("GET", command === "get" ? route : route + "/models");
  else if (command === "send" || command === "steer" && body.text !== undefined) {
    if (command === "steer" && messageId) throw new Error("Use steer TASK_ID --text for a new correction, or steer TASK_ID MESSAGE_ID without --text for a queued message.");
    body.id ||= crypto.randomUUID();
    if (command === "steer") body.delivery = "steer";
    result = await request("POST", route + "/messages", body);
  }
  else if (command === "steer" || command === "remove") result = await request("POST", route + "/queue", { messageId, action: command });
  else if (command === "answer") result = await request("POST", route + "/answer", { requestId: messageId, response: JSON.parse(options.response || "{}") });
  else if (["resume", "stop", "focus", "close", "rename", "configure"].includes(command)) result = await request("POST", route + "/" + command, body);
  else if (command === "watch") {
    const timeout = Number(options.timeout || 600), interval = Number(options.interval || 1000);
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval < 250) throw new Error("Use a positive timeout in seconds and interval of at least 250 ms.");
    const deadline = Date.now() + timeout * 1000; let previous = "";
    while (Date.now() < deadline) {
      const value = await request("GET", route), comparable = { ...value };
      delete comparable.silentMs;
      const serialized = JSON.stringify(comparable);
      if (serialized !== previous) console.log(JSON.stringify(value));
      previous = serialized;
      if (value.pendingRequests.length || (!value.busy && (!value.queuedMessages.length || value.queuePaused))) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error("Watch timed out. The task continues in Lumen.");
  } else throw new Error(`Unknown command ${command}. Use --help.`);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
