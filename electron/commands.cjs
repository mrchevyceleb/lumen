const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { catalog, cliOptions, extraOptions } = require("./models.cjs");
const { accountEnvironment, codexAccountOptions } = require("./accounts.cjs");

// Read metadata from the installed CLI. No user prompt or model turn is sent.
async function discoverCommands(s, launcher, kill) {
  const model = cliOptions({ ...s, workMode: "" });
  const args = {
    pi: ["--mode", "rpc", "--no-session", ...model],
    claude: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...model],
    codex: ["app-server", "--listen", "stdio://", ...codexAccountOptions(s)],
    grok: [...model, "agent", "--no-leader", "stdio"],
  }[s.agent];
  if (!args) return { commands: [], origin: "Shell" };
  const launch = typeof launcher === "function" ? launcher([...args, ...extraOptions(s)]) : { file: launcher.file, args: [...launcher.args, ...args, ...extraOptions(s)] };
  const child = spawn(launch.file, launch.args, {
    cwd: s.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...accountEnvironment(s, s.profileEnvironment || process.env), ...(s.agent === "grok" && s.grokHome ? { GROK_HOME: s.grokHome } : {}), NO_COLOR: "1" },
  });
  s.discoveryChild = child;
  let timer, buffer = "", stderr = "", settled = false, finish, grokCommands, grokReady = false, grokInfo;
  let codexCommands, codexWarning, codexConfig, codexModels = [], codexPage = 10;
  const requestId = crypto.randomUUID();
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  try {
    return await new Promise((resolve, reject) => {
      finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      child.on("error", (error) => finish(error));
      child.stdin.on("error", (error) => finish(error));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
      child.on("close", () => finish(new Error(stderr.trim() || "The CLI closed before returning its commands.")));
      timer = setTimeout(() => finish(new Error("Command discovery timed out. Try refreshing, or open native view to check the CLI.")), 30000);
      const handle = (e) => {
        if (s.agent === "pi" && e.type === "response" && e.id === requestId) {
          if (!e.success) throw new Error(e.error || "Pi could not list commands.");
          finish(null, { commands: normalize(e.data?.commands, "pi"), origin: "Pi RPC" });
        }
        if (s.agent === "claude" && e.type === "control_response" && e.response?.request_id === requestId) {
          if (e.response.subtype === "error") throw new Error(e.response.error || "Claude could not list commands.");
          const info = e.response.response || {};
          finish(null, { commands: normalize(info.commands, "claude"), origin: "Claude CLI",
            catalog: catalog("claude", info.models, { currentModel: s.model || "default", currentEffort: s.effort || "",
              currentMode: s.workMode || info.current_permission_mode || "" }) });
        }
        if (["grok", "codex"].includes(s.agent) && e.error) throw new Error(e.error.message || "Command discovery failed.");
        if (s.agent === "codex") {
          if (e.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "skills/list", params: { cwds: [s.root], forceReload: true } });
            send({ id: 3, method: "config/read", params: { cwd: s.root, includeLayers: false } });
            send({ id: codexPage, method: "model/list", params: { limit: 100 } });
          }
          if (e.id === 2) {
            const entries = e.result?.data || [];
            const errors = entries.flatMap((entry) => entry.errors || []);
            codexCommands = normalize(entries.flatMap((entry) => entry.skills || []), "codex");
            codexWarning = errors.length ? `${errors.length} skill files could not load. Check them in native view.` : undefined;
          }
          if (e.id === 3) codexConfig = e.result?.config || {};
          if (e.id === codexPage) {
            codexModels.push(...(e.result?.data || []));
            if (e.result?.nextCursor && codexPage < 60) send({ id: ++codexPage, method: "model/list", params: { limit: 100, cursor: e.result.nextCursor } });
            else codexModels.ready = true;
          }
          if (codexCommands && codexConfig && codexModels.ready) finish(null, { commands: codexCommands, origin: "Codex CLI", warning: codexWarning,
            catalog: catalog("codex", codexModels, { currentModel: s.model || codexConfig.model || "",
              currentEffort: s.effort || codexConfig.model_reasoning_effort || "" }) });
        }
        if (s.agent === "grok") {
          if (e.id === 1) {
            const auth = e.result?.authMethods || [];
            const methodId = process.env.XAI_API_KEY && auth.some((a) => a.id === "xai.api_key") ? "xai.api_key" : auth.some((a) => a.id === "cached_token") ? "cached_token" : "";
            if (!methodId) throw new Error("Sign in to Grok in native view before discovering its commands.");
            send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId, _meta: { headless: true } } });
          }
          if (e.id === 2) send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: s.root, mcpServers: [] } });
          if (e.method === "session/update" && e.params?.update?.sessionUpdate === "available_commands_update")
            grokCommands = e.params.update.availableCommands;
          if (e.id === 3) { grokReady = true; grokInfo = e.result; }
          // Grok announces a preliminary list before the working folder finishes
          // loading. Use the latest inventory once session/new is complete.
          if (grokReady && grokCommands) finish(null, { commands: normalize(grokCommands, "grok"), origin: "Grok ACP",
            catalog: catalog("grok", grokInfo.models?.availableModels, { currentModel: s.model || grokInfo.models?.currentModelId || "",
              currentEffort: s.effort || grokInfo.configOptions?.find((o) => o.id === "reasoning_effort")?.currentValue || "",
              currentMode: s.workMode || "" }) });
          // Discovery cannot approve tools or invoke models, even if a CLI extension asks.
          if (e.method && e.id !== undefined) send({ jsonrpc: "2.0", id: e.id, error: { code: -32601, message: "Metadata discovery only" } });
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        if (settled) return;
        buffer += data;
        let pos;
        while ((pos = buffer.indexOf("\n")) >= 0 && !settled) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          try { handle(event); } catch (error) { finish(error); }
        }
        if (buffer.length > 8 * 1024 * 1024) finish(new Error("The CLI returned an oversized command list."));
      });
      if (s.agent === "pi") send({ id: requestId, type: "get_commands" });
      if (s.agent === "claude") send({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
      if (s.agent === "codex") send({ id: 1, method: "initialize", params: { clientInfo: { name: "lumen", version: "0.1.4" } } });
      if (s.agent === "grok") send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "lumen", version: "0.1.4" } } });
    });
  } finally {
    clearTimeout(timer);
    await kill(child);
    if (s.discoveryChild === child) s.discoveryChild = null;
  }
}

function normalize(values, agent) {
  if (!Array.isArray(values)) throw new Error("This CLI did not return a supported command list. Open native view for its commands.");
  const seen = new Set();
  return values.slice(0, 3000).flatMap((value) => {
    const c = typeof value === "string" ? { name: value } : value;
    if (!c || typeof c.name !== "string" || !c.name || c.name === "__lumen_controls" || /[\s\x00-\x1f]/.test(c.name) || c.name.length > 200 || c.enabled === false) return [];
    const name = c.name.replace(/^[/\$]/, "");
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const skill = agent === "codex" || c.source === "skill" || !!c._meta?.path;
    const source = agent === "pi" ? c.source || "command" : skill ? "skill" : c._meta?.workflowPath ? "workflow" : "command";
    return [{
      name, insertText: `${agent === "codex" ? "$" : "/"}${name}`,
      description: String(c.interface?.shortDescription || c.shortDescription || c.description || "Run this CLI command").slice(0, 1000),
      argumentHint: String(c.argumentHint || c.input?.hint || "").slice(0, 250),
      source, scope: c.sourceInfo?.scope || c.scope || c._meta?.scope || "",
      // Grok's ACP shell builtins can return UI-only output in its one-shot print mode.
      // Keep those in the actual terminal; discovered skills/workflows work in readable view.
      native: c.native === true || (agent === "grok" && !c._meta?.path && !c._meta?.workflowPath),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { discoverCommands, normalize };
