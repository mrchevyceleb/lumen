const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

class ControlError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function validate(action, body) {
  if (!object(body)) throw new ControlError("Send a JSON object.");
  const fields = {
    create: ["id", "agent", "name", "owner", "root", "cwd", "worktree", "base", "model", "effort", "workMode", "serviceTier", "accountId", "text"],
    message: ["id", "text"], queue: ["messageId", "action"], configure: ["model", "effort", "workMode", "serviceTier"],
    rename: ["name"], answer: ["requestId", "response"], stop: [], focus: [], close: [], resume: [],
  }[action];
  if (!fields) return body;
  for (const key of Object.keys(body)) if (!fields.includes(key)) throw new ControlError(`Unknown field: ${key}`);
  for (const key of fields.filter((key) => key !== "response")) {
    if (body[key] !== undefined && typeof body[key] !== "string") throw new ControlError(`${key} must be a string.`);
  }
  for (const key of ["id", "messageId"]) if (body[key] !== undefined && !uuid.test(body[key])) throw new ControlError(`${key} must be a UUID.`);
  for (const key of ["name", "owner", "model", "effort", "workMode", "serviceTier", "accountId", "worktree", "base"]) {
    if (body[key] !== undefined && (body[key].length > 300 || /[\x00-\x1f]/.test(body[key]))) throw new ControlError(`Invalid ${key}.`);
  }
  if (action === "create") {
    body.agent ||= "codex"; body.id ||= crypto.randomUUID();
    if (!["shell", "pi", "codex", "claude", "grok", "google"].includes(body.agent)) throw new ControlError("Choose shell, pi, codex, claude, grok, or google.");
    for (const key of ["root", "cwd"]) if (body[key] && !path.isAbsolute(body[key])) throw new ControlError(`${key} must be an absolute folder.`);
    if (body.cwd && !body.root) throw new ControlError("Choose a workspace root when specifying cwd.");
    if (body.worktree && !body.root) throw new ControlError("Choose a Git workspace root when creating a worktree.");
    if (body.worktree && body.cwd) throw new ControlError("Worktree jobs start at the new worktree root; omit cwd.");
    if (body.base && !body.worktree) throw new ControlError("Choose a worktree branch when specifying its base.");
    if (body.worktree !== undefined && !body.worktree.trim()) throw new ControlError("Enter a worktree branch name.");
    // Sessions.create resolves real paths and rejects cwd outside the registered root.
  }
  if (action === "message" || (action === "create" && body.text !== undefined)) {
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 200000) throw new ControlError("Enter a message under 200,000 characters.");
    if (action === "message") body.id ||= crypto.randomUUID();
  }
  if (action === "queue" && (!body.messageId || !["steer", "remove"].includes(body.action))) throw new ControlError("Choose a queued messageId and steer or remove.");
  if (action === "rename" && !body.name?.trim()) throw new ControlError("Enter a task name.");
  if (action === "answer") {
    if (!body.requestId || !object(body.response)) throw new ControlError("Choose a pending requestId and response object.");
    const response = body.response;
    if (Object.keys(response).some((key) => !["value", "confirmed", "answers", "answerLists", "notes", "cancelled"].includes(key))) throw new ControlError("Use the native dialog response fields.");
    const string = (value) => typeof value === "string" && value.length <= 80000;
    const map = (value, valid) => object(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => key.length <= 80000 && valid(item));
    if (["value", "confirmed", "answers", "cancelled"].filter((key) => response[key] !== undefined).length !== 1 ||
      (response.value !== undefined && !string(response.value)) ||
      (response.confirmed !== undefined && typeof response.confirmed !== "boolean") ||
      (response.cancelled !== undefined && response.cancelled !== true) ||
      (response.answers !== undefined && !map(response.answers, string)) ||
      (response.answerLists !== undefined && (response.answers === undefined || !map(response.answerLists, (items) => Array.isArray(items) && items.length <= 100 && items.every(string)))) ||
      (response.notes !== undefined && (response.answers === undefined || !map(response.notes, string))))
      throw new ControlError("Invalid or conflicting native dialog response.");
  }
  return body;
}

class AgentControl {
  constructor({ dataDir, window, notify, browser }) {
    this.dataDir = dataDir; this.window = window; this.notify = notify; this.browser = browser;
    this.file = path.join(dataDir, "agent-control.json");
    this.helper = path.join(dataDir, "lumen-agent.cjs");
    this.guide = path.join(dataDir, "lumen-agent-guide.md");
    this.pending = new Map(); this.ready = false; this.enabled = true; this.error = "";
    this.changing = Promise.resolve();
  }
  async init() {
    try { this.enabled = JSON.parse(await fs.readFile(path.join(this.dataDir, "agent-control-settings.json"), "utf8")).enabled !== false; }
    catch (e) { if (e.code !== "ENOENT") this.error = "Could not read agent-control preferences."; }
    await fs.copyFile(path.join(__dirname, "lumen-agent.cjs"), this.helper);
    await fs.copyFile(path.join(__dirname, "agent-control-guide.md"), this.guide);
    // A `lumen` command on every chat process's PATH (see accounts.cjs), so an
    // agent inside Lumen orchestrates the other chats with `lumen list`,
    // `lumen create …`, `lumen browser click …` and never needs a file path.
    const bin = path.join(this.dataDir, "bin");
    await fs.mkdir(bin, { recursive: true });
    // Run the helper on Lumen's own runtime (Electron as Node), so the command
    // works on machines with no system Node.js installed.
    const shQuote = (value) => value.replace(/([\\"$`])/g, "\\$1");
    await fs.writeFile(path.join(bin, "lumen.cmd"),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\nset LUMEN_AGENT_ARGS_FILE=\r\nif not defined LUMEN_AGENT_RUNTIME (echo Lumen's agent runtime is not configured. Start a new chat and try again. ^>^&2 & exit /b 1)\r\nif not defined LUMEN_AGENT_CLI (echo Lumen's agent helper is not configured. Start a new chat and try again. ^>^&2 & exit /b 1)\r\n"%LUMEN_AGENT_RUNTIME%" "%LUMEN_AGENT_CLI%" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    // PowerShell 5.1 mangles native/CMD argument quotes, and Restricted or
    // AllSigned blocks a generated .ps1. Its binary cmdlet receives the exact
    // managed strings and works without changing the machine's script policy.
    if (process.platform === "win32") {
      const candidates = [path.join(process.resourcesPath || "", "lumen-agent", "LumenAgent", "LumenAgent.dll"), path.join(__dirname, "..", "build", "lumen-agent", "LumenAgent", "LumenAgent.dll")];
      let assembly;
      for (const candidate of candidates) {
        try { assembly = await fs.readFile(candidate); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!assembly) throw new Error("Lumen's PowerShell command is missing. Run npm start to build it before launching the app.");
      const manifest = "@{ RootModule = 'LumenAgent.dll'; ModuleVersion = '1.0.0'; GUID = '0f149b83-93be-42f4-a2a5-f9b6a1d2b2a8'; CmdletsToExport = @('Invoke-Lumen'); AliasesToExport = @('lumen') }\r\n";
      const moduleRoot = path.join(bin, "modules", crypto.createHash("sha256").update(assembly).update(manifest).digest("hex").slice(0, 16));
      const moduleDir = path.join(moduleRoot, "LumenAgent");
      await fs.mkdir(moduleDir, { recursive: true });
      const installModuleFile = async (file, value) => {
        const expected = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const existing = await fs.readFile(file).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
        if (existing?.equals(expected)) return;
        // Publish only complete files. A crashed or concurrent install can leave
        // an existing path, but its bytes must never be trusted just because it exists.
        const temporary = file + ".tmp-" + process.pid + "-" + crypto.randomUUID();
        try {
          await fs.writeFile(temporary, expected, { flag: "wx" });
          await fs.rename(temporary, file);
        } catch (error) {
          const winner = await fs.readFile(file).catch(() => null);
          if (!winner?.equals(expected)) throw error;
        } finally { await fs.unlink(temporary).catch(() => {}); }
      };
      await installModuleFile(path.join(moduleDir, "LumenAgent.dll"), assembly);
      await installModuleFile(path.join(moduleDir, "LumenAgent.psd1"), manifest);
      process.env.LUMEN_AGENT_MODULE_ROOT = moduleRoot;
    }
    await fs.unlink(path.join(bin, "lumen.ps1")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.writeFile(path.join(bin, "lumen"),
      `#!/bin/sh\nLUMEN_AGENT_ARGS_FILE= ELECTRON_RUN_AS_NODE=1 exec "${shQuote(process.execPath)}" "${shQuote(this.helper)}" "$@"\n`, { mode: 0o755 });
    process.env.LUMEN_CONTROL_FILE = this.file;
    if (this.enabled) await this.start(); else await fs.unlink(this.file).catch(() => {});
  }
  status() {
    return { enabled: this.enabled, running: !!this.server, ready: this.ready, url: this.url || "", connectionFile: this.file, guideFile: this.guide,
      command: `node "${this.helper}"`, error: this.error };
  }
  async start() {
    if (this.server) return;
    const token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => void this.request(req, res, token));
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 65000; server.maxConnections = 32;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    this.url = `http://127.0.0.1:${server.address().port}`;
    try {
      const temporary = this.file + ".tmp";
      await fs.writeFile(temporary, JSON.stringify({ version: 1, url: this.url, token, pid: process.pid, helper: this.helper }), { mode: 0o600 });
      await fs.rename(temporary, this.file);
      this.server = server; this.error = "";
    } catch (e) { server.close(); this.url = ""; throw e; }
    this.notify(this.status());
  }
  async stop() {
    const server = this.server; this.server = null; this.url = "";
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new ControlError("Agent control disconnected.", 503)); }
    this.pending.clear();
    if (server) { server.close(); server.closeAllConnections(); }
    await fs.unlink(this.file).catch((e) => { if (e.code !== "ENOENT") throw e; });
    this.notify(this.status());
  }
  change(enabled) {
    if (typeof enabled !== "boolean") throw new ControlError("Choose on or off.");
    const next = this.changing.catch(() => {}).then(async () => {
      if (enabled) await this.start(); else await this.stop();
      await fs.writeFile(path.join(this.dataDir, "agent-control-settings.json"), JSON.stringify({ enabled }));
      this.enabled = enabled; this.notify(this.status()); return this.status();
    });
    this.changing = next; return next;
  }
  setReady(ready) {
    this.ready = ready;
    if (!ready) {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new ControlError("Lumen is reopening its chats. Reconnect shortly.", 503)); }
      this.pending.clear();
    }
    this.notify(this.status());
  }
  reply(id, result) {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(id);
    if (result?.error) request.reject(new ControlError(result.error, result.status || 409)); else request.resolve(result?.data);
  }
  call(action, id, body = {}) {
    const window = this.window();
    if (!this.ready || !window || window.isDestroyed()) throw new ControlError("Lumen is opening its chats. Try again shortly.", 503);
    if (this.pending.size >= 32) throw new ControlError("Too many pending requests.", 429);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new ControlError("The operation is still pending. Read the task before retrying; reuse the same task/message ID.", 504)); }, 60000);
      this.pending.set(requestId, { resolve, reject, timer });
      window.webContents.send("agent-control:request", { requestId, action, id, body });
    });
  }
  async request(req, res, token) {
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      const serialized = JSON.stringify(value);
      res.end(serialized === undefined ? "null" : serialized);
    };
    try {
      // A browser origin must never be able to use this local coding interface.
      if (req.headers.origin || req.headers.host !== new URL(this.url).host) throw new ControlError("Only local agent clients are allowed.", 403);
      const auth = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) throw new ControlError("Read Lumen's connection file to authenticate.", 401);
      if (!this.server) throw new ControlError("Agent control is off.", 503);
      const url = new URL(req.url, this.url);
      let body = {};
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new ControlError("Use Content-Type: application/json.", 415);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 900000) throw new ControlError("Request is too large.", 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ControlError("Invalid JSON."); }
      }
      if (req.method === "GET" && url.pathname === "/v1") return send(200, { version: 1, ready: this.ready, capabilities: ["tasks", "worktrees", "messages", "queue", "steer", "stop", "models", "configure", "focus", "answer", "close", "browser", "browser-drive"] });
      if (url.pathname === "/v1/browser" && ["GET", "POST"].includes(req.method)) {
        if (!this.ready || !this.browser) throw new ControlError("Lumen's browser is starting. Try again shortly.", 503);
        try { return send(200, await this.browser(req.method === "GET" ? { action: "list" } : body)); }
        catch (error) {
          // Browser validation failures are client errors, not server faults.
          const status = error.status || (/chat is closed|browser (?:tab )?(?:is|was) closed/i.test(error.message || "") ? 404 : 500);
          throw new ControlError(error.message, status);
        }
      }
      if (url.pathname === "/v1/tasks" && ["GET", "POST"].includes(req.method)) {
        const action = req.method === "GET" ? "list" : "create";
        return send(action === "create" ? 201 : 200, await this.call(action, "", validate(action, body)));
      }
      const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(messages|queue|resume|stop|focus|rename|models|configure|answer|close))?$/);
      if (!match || !uuid.test(match[1])) throw new ControlError("Unknown endpoint.", 404);
      const action = match[2] === "messages" ? "message" : match[2] || "get";
      if (req.method !== (["get", "models"].includes(action) ? "GET" : "POST")) throw new ControlError("Unsupported method.", 405);
      return send(200, await this.call(action, match[1], validate(action, body)));
    } catch (e) { send(e.status || 500, { error: e.message }); }
  }
}
module.exports = { AgentControl };
