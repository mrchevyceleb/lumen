const os = require("node:os");
const crypto = require("node:crypto");
const { accountEnvironment } = require("./accounts.cjs");
const { profiledLaunch } = require("./profile-launcher.cjs");
const { discoverCommands } = require("./commands.cjs");

// Discovery initializes the CLI protocol without creating a Lumen chat or sending a prompt.
class DefaultModels {
  constructor(sessions, accounts, resolveLauncher, modelCache = null) {
    this.sessions = sessions; this.accounts = accounts; this.resolveLauncher = resolveLauncher;
    this.cache = new Map(); this.pending = new Map(); this.active = new Set(); this.closed = false;
    this.modelCache = modelCache;
    this.refreshTimers = new Map();
  }
  async list(config, refresh = false) {
    const { agent, command, extraArgs = [], loadShellProfile = true } = config || {};
    if (this.closed || !["pi", "codex", "claude", "grok", "google"].includes(agent)) throw new Error("Choose an available agent.");
    if (typeof command !== "string" || !Array.isArray(extraArgs) || extraArgs.some((v) => typeof v !== "string")) throw new Error("Check this agent's executable and arguments.");
    const account = this.accounts.select(agent);
    const revision = account.accountId ? this.accounts.get(account.accountId).revision : "";
    const key = JSON.stringify([agent, command, extraArgs, loadShellProfile, account.accountId, revision]);
    const sourceKey = crypto.createHash("sha256").update(key).digest("hex");
    if (this.accounts.signingIn({ agent, ...account })) throw new Error("Finish signing in before loading this account's models.");
    let cached = this.cache.get(key);
    const s = { agent, command: command || (agent === "google" ? "agy" : agent), extraArgs: [], loadShellProfile,
      ...account, root: os.homedir(), cwd: os.homedir(), projectless: true, cacheExtraArgs: extraArgs, model: "", effort: "", workMode: "", modelsOnly: true };
    cached ||= this.modelCache?.read(s);
    if (!refresh && cached) {
      const stale = Date.now() - cached.at >= 10 * 60 * 1000;
      if (stale && !this.pending.has(key) && !this.refreshTimers.has(key)) this.refreshTimers.set(key, setTimeout(() => {
        this.refreshTimers.delete(key);
        if (!this.closed) void this.list(config, true).catch(() => {});
      }, 100));
      return { ...cached.value, sourceKey, warning: stale ? "Using saved models while refreshing the list…" : cached.value.warning };
    }
    if (this.pending.has(key)) return this.pending.get(key);
    // The metadata protocol owns startup/model flags; saved advanced arguments cannot send a prompt.
    const owned = new Set(["--model", "-m", "--effort", "--thinking", "--reasoning-effort", "--mode", "--input-format", "--output-format", "--prompt", "--single", "--prompt-interactive", "-i", "--image", "--conversation", "--resume", "-r", "--session", "--session-dir", "--session-id"]);
    if (agent === "google") { owned.add("--print"); owned.add("-p"); }
    if (agent === "grok") owned.add("-p");
    const values = new Set(["-c", "--config", "--profile", "--settings", "--setting-sources", "--permission-mode", "--plugin-dir", "--add-dir", "--mcp-config", "--agents", "--extension", "-e", "--provider", "--api-key", "--models", "--base-url", "--api-base", "--api-key-env", "--config-dir", "--log-file"]);
    if (agent === "codex") values.add("-p");
    for (let i = 0; i < extraArgs.length; i++) {
      const arg = extraArgs[i], flag = arg.split("=")[0];
      if (arg === "--") break;
      if (owned.has(flag)) { if (!arg.includes("=") && extraArgs[i + 1] && !extraArgs[i + 1].startsWith("-")) i++; continue; }
      if (flag === "--print" || (flag === "-p" && agent !== "codex")) continue;
      if (flag === "--continue" || (flag === "-c" && agent !== "codex")) continue;
      if (!arg.startsWith("-")) continue;
      s.extraArgs.push(arg);
      if (values.has(flag) && !arg.includes("=") && extraArgs[i + 1] && !extraArgs[i + 1].startsWith("-")) s.extraArgs.push(extraArgs[++i]);
    }
    this.active.add(s);
    const request = (async () => {
      await this.sessions.prepareLaunch(s);
      if (this.closed || s.cancelled) throw new Error("Model discovery was canceled.");
      s.profileEnvironment = accountEnvironment(s, s.profileEnvironment);
      const launch = (args) => profiledLaunch(s, args, this.resolveLauncher);
      const kill = (child) => this.sessions.kill(child, true);
      const value = agent === "google" ? await require("./google.cjs").modelCatalog(s, launch(["models"]), kill) :
        (await discoverCommands(s, launch, kill)).catalog;
      if (!value?.models?.length) throw new Error("This CLI returned no models. Check its sign-in and try Refresh.");
      if (this.closed || s.cancelled) throw new Error("Model discovery was canceled.");
      this.cache.set(key, { value, at: Date.now() });
      this.modelCache?.remember(s, value);
      if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
      const result = { ...value, sourceKey };
      this.sessions.emit?.({ id: "", type: "default-models", catalog: result });
      return result;
    })().catch((error) => {
      if (cached && !this.closed && !s.cancelled) {
        const result = { ...cached.value, sourceKey, warning: "Using the last available models. " + error.message };
        this.sessions.emit?.({ id: "", type: "default-models", catalog: result });
        return result;
      }
      throw error;
    }).finally(() => { this.pending.delete(key); this.active.delete(s); });
    this.pending.set(key, request);
    return request;
  }
  async invalidate(agent) {
    for (const key of this.cache.keys()) if (JSON.parse(key)[0] === agent) this.cache.delete(key);
    for (const [key, timer] of this.refreshTimers) if (JSON.parse(key)[0] === agent) { clearTimeout(timer); this.refreshTimers.delete(key); }
    await Promise.allSettled([...this.active].filter((s) => s.agent === agent).map((s) => { s.cancelled = true; return this.sessions.cancelDiscovery(s); }));
  }
  async close() {
    this.closed = true;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    await Promise.allSettled([...this.active].map((s) => this.sessions.cancelDiscovery(s)));
    await Promise.allSettled([...this.pending.values()]);
  }
}
module.exports = { DefaultModels };
