const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const TOML = require("@iarna/toml");
const { cliOptions } = require("./models.cjs");
const uuid = () => crypto.randomUUID();
const withoutNulls = (value) => Array.isArray(value) ? value.map(withoutNulls) : value && typeof value === "object" ?
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)])) : value;
const exists = (file) => fs.stat(file).then(() => true, () => false);
const jsonFile = (file) => fs.readFile(file, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
const atomicWrite = async (file, text) => { const temporary = file + "." + uuid() + ".tmp"; await fs.writeFile(temporary, text, { mode: 0o600 }); await fs.rename(temporary, file); };
const inFolder = (root, child) => { const relative = path.relative(root, child); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const sessionId = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

function policy(value = {}) {
  const tokens = value.autoCompactTokens ?? null;
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1000 || tokens > 2000000))
    throw new Error("Choose an auto-compact threshold between 1,000 and 2,000,000 tokens.");
  const overrides = value.mcpOverrides ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.keys(overrides).length > 500)
    throw new Error("Invalid MCP selection.");
  for (const [name, enabled] of Object.entries(overrides))
    if (!name || name.length > 300 || /[\x00-\x1f]/.test(name) || typeof enabled !== "boolean") throw new Error("Invalid MCP selection.");
  return { autoCompactTokens: tokens, mcpOverrides: { ...overrides } };
}
function launchOptions(s) {
  if (s.agent === "claude") return s.autoCompactTokens ? ["--autocompact", String(s.autoCompactTokens)] : [];
  if (s.agent !== "codex") return [];
  const config = codexConfig(s);
  for (const [name, enabled] of Object.entries(s.mcpOverrides)) {
    if (s.codexLocalServers?.includes(name)) config[`mcp_servers.${JSON.stringify(name)}.enabled`] = enabled;
    if (s.codexPluginIds?.[name]) config[`plugins.${JSON.stringify(s.codexPluginIds[name])}.enabled`] = enabled;
  }
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
function codexConfig(s) {
  const config = { "shell_environment_policy.inherit": "all", "shell_environment_policy.ignore_default_excludes": true };
  if (s.autoCompactTokens) {
    config.model_auto_compact_token_limit = s.autoCompactTokens;
    config.model_auto_compact_token_limit_scope = "total";
  }
  if (s.mcpOverrides.codex_apps !== undefined) config["features.apps"] = s.mcpOverrides.codex_apps;
  return config;
}

// Grok's MCP toggles persist. Give every Lumen chat its own preferences/auth cache;
// never call server toggles (which can also write project configuration).
async function grokHome(owner, s) {
  const base = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  const target = path.join(owner.dataDir, "grok", s.controlId);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const initialized = await exists(path.join(target, ".lumen-initialized"));
  if (!initialized) {
  for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/^(config\.toml|trusted_folders\.toml|GROK\.md|.*(?:auth|credential|token).*\.json|mcp_preferences\.json|models_cache\.json|managed.*\.toml|settings.*\.json)$/i.test(entry.name)) continue;
    await fs.copyFile(path.join(base, entry.name), path.join(target, entry.name));
    await fs.chmod(path.join(target, entry.name), 0o600).catch(() => {});
  }
  await fs.writeFile(path.join(target, ".lumen-initialized"), "1", { mode: 0o600 });
  }
  for (const name of ["plugins", "installed-plugins", "marketplace-cache", "skills", "agents", "commands", "workflows", "hooks", "memory", "memory-v2"])
    if (!await fs.stat(path.join(target, name)).then(() => true, () => false) && await fs.stat(path.join(base, name)).then((st) => st.isDirectory(), () => false))
      await fs.symlink(path.join(base, name), path.join(target, name), process.platform === "win32" ? "junction" : "dir");
  // Migrate a conversation created by Lumen's earlier headless adapter once.
  if (s.sessionRef) {
    if (!sessionId(s.sessionRef)) throw new Error("Invalid Grok conversation identifier.");
    const sessions = path.join(base, "sessions");
    for (const entry of await fs.readdir(sessions, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const source = path.join(sessions, entry.name, s.sessionRef);
      const destination = path.join(target, "sessions", entry.name, s.sessionRef);
      if (!inFolder(sessions, source) || !inFolder(path.join(target, "sessions"), destination)) throw new Error("Conversation is outside its session folder.");
      if (await fs.stat(destination).then(() => true, () => false)) continue;
      if (await fs.stat(source).then((st) => st.isDirectory(), () => false)) await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    }
  }
  s.grokHome = target;
  return target;
}
async function claudeHome(owner, s) {
  const source = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const target = path.join(owner.dataDir, "claude", s.controlId);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const initialized = await exists(path.join(target, ".lumen-initialized"));
  if (!initialized) {
  for (const name of ["settings.json", "settings.local.json", "CLAUDE.md", ".credentials.json", "credentials.json"])
    await fs.copyFile(path.join(source, name), path.join(target, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const config = process.env.CLAUDE_CONFIG_DIR ? path.join(source, ".claude.json") : path.join(os.homedir(), ".claude.json");
  await fs.copyFile(config, path.join(target, ".claude.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await fs.writeFile(path.join(target, ".lumen-initialized"), "1", { mode: 0o600 });
  }
  // Keep installed skills/plugins and conversation storage available without
  // copying their large caches. The private .claude.json owns MCP preferences.
  for (const name of ["plugins", "skills", "agents", "commands", "projects", "hooks", "memory-bank", "plans"])
    if (!await fs.stat(path.join(target, name)).then(() => true, () => false) && await fs.stat(path.join(source, name)).then((st) => st.isDirectory(), () => false))
      await fs.symlink(path.join(source, name), path.join(target, name), process.platform === "win32" ? "junction" : "dir");
  await fs.chmod(path.join(target, ".claude.json"), 0o600).catch(() => {});
  s.claudeHome = target;
  return target;
}
async function resetMcpPreferences(s) {
  if (s.agent === "grok" && s.grokHome) {
    const source = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
    const load = (file) => fs.readFile(file, "utf8").then(TOML.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
    const file = path.join(s.grokHome, "config.toml"), current = await load(file), baseline = await load(path.join(source, "config.toml"));
    for (const key of ["mcp_servers", "disabled_mcp_tools", "disabled_mcp_servers"]) { if (baseline[key] !== undefined) current[key] = baseline[key]; else delete current[key]; }
    await atomicWrite(file, TOML.stringify(current));
    await atomicWrite(path.join(s.grokHome, "lumen-mcp-baseline.json"), "{}");
    s.grokToolSelections = {};
  }
  if (s.agent === "claude" && s.claudeHome) {
    const source = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
    const file = path.join(s.claudeHome, ".claude.json"), current = await jsonFile(file), baseline = await jsonFile(source);
    const copyMcp = (to, from = {}) => {
      for (const key of ["mcpServers", "disabledMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"]) {
        if (from[key] !== undefined) to[key] = from[key]; else delete to[key];
      }
    };
    copyMcp(current, baseline);
    for (const [cwd, values] of Object.entries(current.projects || {}))
      if (path.resolve(cwd).toLowerCase() === path.resolve(s.cwd).toLowerCase()) copyMcp(values, baseline.projects?.[cwd]);
    await atomicWrite(file, JSON.stringify(current));
  }
}
async function syncNativeMcp(s) {
  await recoverGrokMcp(s);
  // Called AFTER the readable CLI exits, so its deferred writes cannot race ours.
  if (s.agent === "grok" && s.grokHome && Object.keys(s.mcpOverrides).length) {
    const baseline = await jsonFile(path.join(s.grokHome, "lumen-mcp-baseline.json"));
    const file = path.join(s.grokHome, "config.toml");
    const current = TOML.parse(await fs.readFile(file, "utf8")); current.disabled_mcp_tools ||= {};
    for (const [name, enabled] of Object.entries(s.mcpOverrides)) {
      if (!baseline[name]?.all) throw new Error("Refresh this chat's MCP controls before opening native view.");
      current.disabled_mcp_tools[name] = enabled ? baseline[name].all.filter((tool) => !baseline[name].selected.includes(tool)) : baseline[name].all;
    }
    await atomicWrite(file, TOML.stringify(current));
  }
}
async function recoverGrokMcp(s) {
  if (!s.mcpRecovery) return;
  if (s.process) throw new Error("Stop this chat before retrying its interrupted MCP change.");
  const { name, tools } = s.mcpRecovery;
  const file = path.join(s.grokHome, "config.toml");
  const current = TOML.parse(await fs.readFile(file, "utf8"));
  current.disabled_mcp_tools ||= {};
  const changed = new Set(tools.map((t) => t.name));
  current.disabled_mcp_tools[name] = [...(current.disabled_mcp_tools[name] || []).filter((t) => !changed.has(t)), ...tools.filter((t) => !t.enabled).map((t) => t.name)];
  await atomicWrite(file, TOML.stringify(current));
  s.mcpRecovery = null;
}

class Runtime {
  constructor(owner, s) {
    this.owner = owner; this.s = s; this.pending = new Map(); this.closed = false;
    this.uiRequests = new Map();
    this.hadPrompt = !!s.sessionRef;
  }
  write(message) {
    if (this.closed || this.child !== this.s.process) throw new Error("The CLI session closed. Try again.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params = {}, timeout = 45000) {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The CLI did not finish ${method}. Try again or use native view.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(this.s.agent === "claude" ? { type: "control_request", request_id: id, request: { subtype: method, ...params } } :
          { jsonrpc: "2.0", id, method, params });
      } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(message = "The CLI session closed.") {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    for (const id of this.uiRequests.keys()) this.owner.event(this.s, { type: "agent_ui_cancel", request: { id } });
    this.uiRequests.clear();
    this.compactionDone?.reject(new Error(message)); this.compactionDone = null;
    if (this.s.runtime === this) this.s.runtime = null;
  }
  receive(e) {
    const { owner: o, s } = this;
    if (this.closed || s.process !== this.child) return;
    const claude = s.agent === "claude";
    const response = claude ? e.type === "control_response" && e.response : !e.method && e.id !== undefined && e;
    const id = claude ? response?.request_id : response?.id;
    if (response && this.pending.has(id)) {
      const pending = this.pending.get(id); clearTimeout(pending.timer); this.pending.delete(id);
      const error = claude ? response.subtype === "error" && response.error : response.error;
      let result = claude ? response.response : response.result;
      if (s.agent === "grok" && result?.result !== undefined) result = result.result;
      error ? pending.reject(new Error(typeof error === "string" ? error : error.message || "CLI control failed.")) : pending.resolve(result || {});
      return;
    }
    // Lumen runs with the user's explicitly requested full local access. Questions
    // still need a real answer; tool approvals must never be silently denied here.
    if ((claude && e.type === "control_request") || (!claude && e.method && e.id !== undefined)) {
      if (claude && e.request?.subtype === "can_use_tool") {
        const reply = (response) => this.write({ type: "control_response", response: { subtype: "success", request_id: e.request_id, response } });
        if (e.request.tool_name === "AskUserQuestion") this.ask({ title: "Claude Code needs your input", questions: e.request.input?.questions?.map((q) => ({ ...q, id: q.question })) || [] },
          (answer) => reply(answer.cancelled ? { behavior: "deny", message: "The user cancelled this question." } : { behavior: "allow", updatedInput: { ...e.request.input, answers: answer.answers } }));
        else if (s.workMode === "plan" || e.request.tool_name === "ExitPlanMode") this.ask({ method: "confirm", title: "Claude Code · plan mode", message: `Allow ${e.request.tool_name}?\n${JSON.stringify(e.request.input || {}, null, 2)}` },
          (answer) => {
            reply(answer.confirmed ? { behavior: "allow", updatedInput: e.request.input || {} } : { behavior: "deny", message: "The user declined this action." });
            if (answer.confirmed && e.request.tool_name === "ExitPlanMode") { s.workMode = "default"; o.event(s, { type: "config", workMode: s.workMode }); }
          });
        else reply({ behavior: "allow", updatedInput: e.request.input || {} });
      } else if (s.agent === "grok" && ["_x.ai/ask_user_question", "x.ai/ask_user_question"].includes(e.method)) {
        this.ask({ title: "Grok needs your input", questions: (e.params?.questions || []).map((q) => ({ ...q, id: q.question, multiSelect: q.multiSelect ?? q.multi_select })) },
          (answer) => this.write({ jsonrpc: "2.0", id: e.id, result: answer.cancelled ? { outcome: "cancelled" } : { outcome: "accepted", answers: answer.selections || answer.answers,
            annotations: Object.fromEntries(Object.entries(answer.notes || {}).filter(([, text]) => text).map(([key, notes]) => [key, { notes }])) } }));
      } else if (s.agent === "grok" && ["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"].includes(e.method)) {
        this.ask({ method: "confirm", title: "Approve Grok's plan?", message: e.params?.planContent || "Approve this plan and start implementation?" },
          (answer) => {
            this.write({ jsonrpc: "2.0", id: e.id, result: { outcome: answer.confirmed ? "approved" : "cancelled" } });
            if (answer.confirmed) { s.workMode = "default"; o.event(s, { type: "config", workMode: s.workMode }); }
          });
      } else if (s.agent === "grok" && e.method === "session/request_permission") {
        const allowed = e.params?.options?.find((option) => option.kind === "allow_once") || e.params?.options?.find((option) => option.kind === "allow_always");
        const reply = (accept) => this.write({ jsonrpc: "2.0", id: e.id, result: { outcome: accept && allowed ? { outcome: "selected", optionId: allowed.optionId } : { outcome: "cancelled" } } });
        if (s.workMode === "plan") this.ask({ method: "confirm", title: "Grok · plan mode", message: e.params?.toolCall?.title || "Allow this tool action?" }, (answer) => reply(answer.confirmed));
        else reply(true);
      } else if (s.agent === "codex" && e.method === "item/tool/requestUserInput") {
        this.ask({ title: "Codex needs your input", questions: e.params?.questions || [] }, (answer) => this.write({ jsonrpc: "2.0", id: e.id,
          result: { answers: Object.fromEntries((e.params?.questions || []).map((q) => [q.id, { answers: answer.cancelled ? [] : answer.answerLists?.[q.id] || [answer.answers?.[q.id] || ""] }])) } }));
      } else if (s.agent === "codex" && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(e.method)) {
        this.write({ jsonrpc: "2.0", id: e.id, result: { decision: e.method.includes("/") ? "accept" : "approved" } });
      } else if (claude) this.write({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "This CLI control is not supported in readable view." } });
      else this.write({ jsonrpc: "2.0", id: e.id, error: { code: -32601, message: "This CLI control needs native view." } });
      return;
    }
    if (claude) {
      o.messagesEvent(s, !this.hadPrompt && e.session_id ? { ...e, session_id: undefined } : e);
      const messageUsage = e.type === "assistant" ? e.message?.usage : e.event?.type === "message_start" ? e.event.message?.usage : null;
      if (messageUsage) this.context = claudeContext(messageUsage);
      if (e.type === "system" && e.subtype === "compact_boundary") this.phase(false);
      if (e.type === "system" && e.subtype === "status") this.phase(e.status === "compacting");
      if (e.type === "result") { o.event(s, { type: "context", contextTokens: this.context ?? null }); o.finish(s, e.is_error ? 1 : 0); }
    } else if (s.agent === "codex") this.codexEvent(e);
    else this.grokEvent(e);
  }
  phase(compacting) {
    this.s.phase = compacting ? "compacting" : undefined;
    this.owner.event(this.s, { type: "phase", phase: this.s.phase });
  }
  async initialize() {
    const { owner: o, s } = this;
    let args, env;
    if (s.agent === "claude") {
      env = { CLAUDE_CONFIG_DIR: await claudeHome(o, s) };
      args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", ...cliOptions(s), ...launchOptions(s)];
      if (s.sessionRef) args.push("--resume", s.sessionRef);
    } else if (s.agent === "codex") args = ["app-server", "--stdio"];
    else {
      env = { GROK_HOME: await grokHome(o, s) };
      const watermark = (await jsonFile(path.join(s.grokHome, "lumen-context.json"))).lastCompactedUsage;
      this.lastCompactedUsage = Number.isFinite(watermark) && watermark >= 0 ? watermark : null;
      args = [...cliOptions({ ...s, workMode: "" }), "agent", "--no-leader", "stdio"];
    }
    this.child = o.child(s, args, env);
    o.jsonStream(s, this.child, (e) => this.receive(e));
    this.child.once("close", () => this.close());
    this.child.once("error", (error) => this.close(error.message));
    if (s.agent === "claude") {
      this.metadata = await this.request("initialize");
      if (s.workMode === "plan") {
        await this.request("set_permission_mode", { mode: "plan" });
        this.metadata.current_permission_mode = "plan";
      }
    }
    else if (s.agent === "codex") {
      await this.request("initialize", { clientInfo: { name: "lumen", version: "0.1.11" } });
      this.write({ method: "initialized" });
      const loaded = withoutNulls((await this.request("config/read", { cwd: s.cwd, includeLayers: false })).config?.mcp_servers || {});
      this.localServers = Object.keys(loaded);
      s.codexLocalServers = this.localServers;
      const servers = { ...loaded };
      for (const [name, enabled] of Object.entries(s.mcpOverrides)) if (servers[name]) servers[name] = { ...servers[name], enabled };
      const params = { cwd: s.cwd, approvalPolicy: "never", sandbox: "danger-full-access", config: { ...codexConfig(s), ...(Object.keys(s.mcpOverrides).length ? { mcp_servers: servers } : {}) }, ...(s.model ? { model: s.model } : {}) };
      const result = await this.request(s.sessionRef ? "thread/resume" : "thread/start", { ...params, ...(s.sessionRef ? { threadId: s.sessionRef, excludeTurns: true } : {}) });
      s.sessionRef = result.thread.id;
      if (this.hadPrompt) o.event(s, { type: "session", sessionRef: s.sessionRef });
    } else {
      const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "lumen", version: "0.1.11" } });
      const methodId = init.authMethods?.find((a) => a.id === "cached_token")?.id || init.authMethods?.find((a) => a.id === "xai.api_key")?.id;
      if (methodId) await this.request("authenticate", { methodId, _meta: { headless: true } });
      this.metadata = await this.request(s.sessionRef ? "session/load" : "session/new", { cwd: s.cwd, mcpServers: [], ...(s.sessionRef ? { sessionId: s.sessionRef } : {}) });
      s.sessionRef = this.metadata.sessionId || s.sessionRef;
      if (!sessionId(s.sessionRef)) throw new Error("Grok did not return a valid session ID.");
      o.event(s, { type: "session", sessionRef: s.sessionRef });
      await this.request("session/set_mode", { sessionId: s.sessionRef, modeId: s.workMode === "plan" ? "plan" : "default" });
    }
    if (["claude", "grok"].includes(s.agent)) await this.applyOverrides();
    return this;
  }
  async servers() {
    const s = this.s;
    let raw;
    if (s.agent === "claude") {
      raw = (await this.request("mcp_status")).mcpServers || [];
      this.rawServers = raw;
      return raw.map((r) => ({ name: r.name, status: r.status || "unknown", enabled: r.status !== "disabled", tools: r.tools?.length ?? null,
        source: r.scope || r.config?.scope || "Claude", canToggle: true }));
    }
    if (s.agent === "codex") {
      raw = []; let cursor;
      do {
        const page = await this.request("mcpServerStatus/list", { threadId: s.sessionRef, detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}) });
        raw.push(...(page.data || [])); cursor = page.nextCursor;
      } while (cursor && raw.length < 500);
      this.rawServers = raw;
      s.codexPluginIds = Object.fromEntries(raw.filter((r) => r.pluginId).map((r) => [r.name, r.pluginId]));
      if (s.mcpOverrides.codex_apps === false && !raw.some((r) => r.name === "codex_apps")) raw.push({ name: "codex_apps", runtimeStatus: "disabled", tools: {} });
      return raw.map((r) => ({ name: r.name, status: r.runtimeStatus || (r.authStatus === "notLoggedIn" ? "needs-auth" : "configured"),
        enabled: s.mcpOverrides[r.name] ?? r.runtimeStatus !== "disabled", tools: r.tools ? Object.keys(r.tools).length : null, source: r.pluginId ? "Plugin" : "Codex", canToggle: r.name === "codex_apps" || !!r.pluginId || this.localServers.includes(r.name) }));
    }
    raw = (await this.request("_x.ai/mcp/list", { sessionId: s.sessionRef, cache: true })).servers || [];
    this.rawServers = raw;
    return raw.map((r) => ({ name: r.name, status: r.session?.authRequired ? "needs-auth" : r.session?.status || (r.session?.enabled === false ? "disabled" : "unknown"),
      enabled: s.mcpOverrides[r.name] ?? r.session?.enabled !== false, tools: r.session?.tools?.filter((t) => t.enabled !== false).length ?? null,
      source: r.sourceLabel || r.source || "Grok", canToggle: r.type !== "managedGateway" && r.session?.enabled !== false && !!r.session?.tools?.length }));
  }
  ask(request, reply) {
    const id = uuid();
    this.uiRequests.set(id, reply);
    this.owner.event(this.s, { type: "agent_ui", request: { method: "questions", ...request, id } });
  }
  reply(response) {
    const reply = this.uiRequests.get(response.id);
    if (!reply) throw new Error("This CLI question is no longer pending.");
    reply(response);
    this.uiRequests.delete(response.id);
  }
  async toggle(name, enabled) {
    const s = this.s;
    await this.servers();
    const raw = this.rawServers.find((r) => r.name === name);
    if (!raw) throw new Error("This MCP is no longer available. Refresh the list.");
    if (s.agent === "claude") await this.request("mcp_toggle", { serverName: name, enabled });
    else if (s.agent === "grok") {
      for (let i = 0; raw.session?.status === "initializing" && i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await this.servers();
        Object.assign(raw, this.rawServers.find((r) => r.name === name) || {});
      }
      if (raw.type === "managedGateway" || raw.session?.enabled === false || !raw.session?.tools?.length)
        throw new Error("Enable or authenticate this MCP in Grok first. Lumen can change tool access for connected MCPs in this chat.");
      const baselineFile = path.join(s.grokHome, "lumen-mcp-baseline.json");
      const baseline = await jsonFile(baselineFile);
      if ((!enabled && s.mcpOverrides[name] !== false) || !baseline[name]) baseline[name] = { selected: raw.session.tools.filter((t) => t.enabled !== false).map((t) => t.name) };
      baseline[name].all = raw.session.tools.map((t) => t.name);
      await atomicWrite(baselineFile, JSON.stringify(baseline));
      // Restore the pre-disable selection, including tools disabled in native config.
      // This API persists only to the private GROK_HOME config, never project files.
      const previous = raw.session.tools.map((t) => ({ name: t.name, enabled: t.enabled !== false }));
      try {
        for (const tool of raw.session.tools) await this.request("_x.ai/mcp/toggle_tool", { session_id: s.sessionRef, server_name: name, tool_name: tool.name,
          enabled: enabled && baseline[name].selected.includes(tool.name) });
        await this.servers();
        const actual = this.rawServers.find((r) => r.name === name)?.session?.tools;
        if (!actual || previous.some((tool) => {
          const state = actual.find((t) => t.name === tool.name);
          return !state || (state.enabled !== false) !== (enabled && baseline[name].selected.includes(tool.name));
        })) throw new Error("Grok did not confirm the complete MCP tool selection.");
      } catch (error) {
        // Close the transport before restoring preferences, including a timed-out
        // request which may have applied. No prompt can use a partial selection.
        s.mcpRecovery = { name, tools: previous };
        this.close("MCP change interrupted. Reconnecting with its previous selection.");
        await this.owner.kill(this.child);
        if (s.process === this.child) s.process = null;
        await recoverGrokMcp(s);
        throw new Error("MCP change failed; its previous tool selection was restored. Refresh and try again. " + error.message);
      }
    } else throw new Error("Codex MCP changes apply when this thread is resumed.");
  }
  async applyOverrides() {
    for (const [name, enabled] of Object.entries(this.s.mcpOverrides)) await this.toggle(name, enabled);
  }
  async contextUsage() {
    if (this.s.agent === "grok") { const info = await this.request("_x.ai/session/info", { sessionId: this.s.sessionRef }); return (info.context || info.data?.context)?.used ?? null; }
    return this.context ?? null;
  }
  async prompt(text) {
    const { s, owner: o } = this;
    this.hadPrompt = true;
    if (s.agent === "codex") o.event(s, { type: "session", sessionRef: s.sessionRef });
    if (s.agent === "claude") this.write({ type: "user", session_id: s.sessionRef || "", parent_tool_use_id: null, message: { role: "user", content: text } });
    else if (s.agent === "codex") {
      await this.servers();
      const disabledPluginIds = [...new Set(this.rawServers.filter((r) => r.pluginId && s.mcpOverrides[r.name] === false).map((r) => r.pluginId))];
      await this.request("turn/start", { threadId: s.sessionRef, input: [{ type: "text", text }], disabledPluginIds, ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}) });
    }
    else {
      void this.grokPrompt(text).catch((error) => {
        if (this.closed || s.stopping || s.process !== this.child) return;
        o.event(s, { type: "error", message: error.message }); o.finish(s, 1);
      });
    }
  }
  async grokPrompt(text) {
    const { s, owner: o } = this;
    this.messageId = uuid();
    await this.grokCompact();
    const result = await this.request("session/prompt", { sessionId: s.sessionRef, prompt: [{ type: "text", text }] }, 24 * 60 * 60 * 1000);
    if (result.stopReason !== "cancelled") await this.grokCompact();
    if (result.stopReason && !["end_turn", "cancelled"].includes(result.stopReason)) o.event(s, { type: "diagnostic", text: `Grok finished: ${result.stopReason}.` });
    o.finish(s, result.stopReason === "cancelled" ? 130 : 0);
  }
  async grokCompact() {
    const { s, owner: o } = this;
    if (!s.autoCompactTokens) return;
    const used = await this.contextUsage();
    o.event(s, { type: "context", contextTokens: used });
    if (used !== null && used < s.autoCompactTokens && this.lastCompactedUsage !== null) {
      this.lastCompactedUsage = null;
      await atomicWrite(path.join(s.grokHome, "lumen-context.json"), JSON.stringify({ lastCompactedUsage: null }));
    }
    if (used === null || used < s.autoCompactTokens || (this.lastCompactedUsage != null && used < this.lastCompactedUsage + Math.max(1000, s.autoCompactTokens * .1))) return;
    this.phase(true);
    try {
      await this.request("_x.ai/compact_conversation", { sessionId: s.sessionRef }, 300000);
      this.lastCompactedUsage = await this.contextUsage() ?? used;
      await atomicWrite(path.join(s.grokHome, "lumen-context.json"), JSON.stringify({ lastCompactedUsage: this.lastCompactedUsage }));
      o.event(s, { type: "diagnostic", key: "auto-compact", text: "Context compacted. This conversation is ready to continue." });
    } finally { this.phase(false); }
  }
  codexEvent(e) {
    const { owner: o, s } = this, p = e.params || {};
    if (p.threadId && p.threadId !== s.sessionRef) return;
    if (e.method === "item/agentMessage/delta") o.text(s, p.delta, p.itemId || "answer");
    if (["item/started", "item/completed"].includes(e.method)) {
      const item = p.item;
      if (item?.type === "agentMessage" && e.method === "item/completed") o.text(s, item.text, item.id, true);
      else if (item && item.type !== "agentMessage") o.tool(s, item.id, item.type === "commandExecution" ? item.command : item.type.replace(/([A-Z])/g, " $1"),
        item.aggregatedOutput || item.text || JSON.stringify(item), e.method === "item/completed" ? "done" : "running");
      if (item?.type === "contextCompaction") this.phase(e.method === "item/started");
    }
    if (e.method === "thread/tokenUsage/updated") this.context = p.tokenUsage?.last?.totalTokens ?? null;
    if (e.method === "error") o.event(s, { type: "error", message: p.error?.message || "Codex turn failed." });
    if (e.method === "turn/completed") {
      if (p.turn?.error) o.event(s, { type: "error", message: p.turn.error.message });
      o.finish(s, p.turn?.status === "failed" ? 1 : p.turn?.status === "interrupted" ? 130 : 0);
    }
  }
  grokEvent(e) {
    const { owner: o, s } = this, p = e.params || {};
    if (p.sessionId && p.sessionId !== s.sessionRef) return;
    const u = p.update;
    if (e.method === "session/update" && u) {
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") o.text(s, u.content.text, this.messageId || "answer");
      if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") o.tool(s, "reasoning", "Thinking", u.content.text, "running");
      if (["tool_call", "tool_call_update"].includes(u.sessionUpdate)) {
        if (u.sessionUpdate === "tool_call") this.messageId = uuid();
        o.tool(s, u.toolCallId, u.title || "Tool result", u.content?.map((c) => c.content?.text || c.text || "").join("\n") || JSON.stringify(u.rawInput || u.rawOutput || {}), u.status || "running");
      }
    }
    if (e.method?.includes("context") && p.used !== undefined) this.context = p.used;
  }
}
function claudeContext(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens)) return null;
  return usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}
async function ensureRuntime(owner, s) {
  await recoverGrokMcp(s);
  if (s.runtime) { await s.runtime.ready; return s.runtime; }
  const runtime = new Runtime(owner, s); s.runtime = runtime;
  runtime.ready = runtime.initialize().catch(async (error) => { runtime.close(error.message); if (runtime.child === s.process) await owner.kill(runtime.child); throw error; });
  await runtime.ready;
  return runtime;
}
module.exports = { policy, launchOptions, ensureRuntime, grokHome, claudeHome, resetMcpPreferences, syncNativeMcp };
