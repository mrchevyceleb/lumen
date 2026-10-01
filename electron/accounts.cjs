const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const TOML = require("@iarna/toml");
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const authVariable = (agent, key) => agent === "claude" ? /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|PROFILE|CONFIG_DIR|FEDERATION_RULE_ID|ORGANIZATION_ID)|CLAUDE_CONFIG_DIR|CLAUDE_CODE_(OAUTH_.*|USE_.*|PROVIDER_MANAGED_BY_HOST))$/i.test(key) : /^(OPENAI_(API_.*|BASE_URL|ORGANIZATION|ORG_.*|PROJECT|PROJECT_.*|ACCESS_TOKEN|AUTH_TOKEN|IDENTITY_TOKEN_FILE|FEDERATION_RULE_ID|WORKLOAD_IDENTITY_CONTEXT)|CODEX_(HOME|API_.*|BASE_URL|ACCESS_TOKEN|AUTH_TOKEN|CONNECTORS_TOKEN|AUTHAPI_.*|AGENT_IDENTITY_.*|APP_SERVER_CHATGPT_BASE_URL|CLOUD_TASKS_BASE_URL|REFRESH_TOKEN_URL_OVERRIDE|REVOKE_TOKEN_URL_OVERRIDE)|CHATGPT_BASE_URL)$/i.test(key);
function codexAccountOptions(s) {
  // Leave inference routing to the built-in provider: ChatGPT OAuth and API
  // keys use different official endpoints. An explicit API URL breaks OAuth.
  return s.accountId ? ["-c", 'cli_auth_credentials_store="file"', "-c", 'model_provider="openai"', "-c", 'chatgpt_base_url="https://chatgpt.com/backend-api/"'] : [];
}
function accountEnvironment(s, base = process.env) {
  const env = { ...base };
  if (!s.accountId) return env;
  for (const key of Object.keys(env)) if (authVariable(s.agent, key)) delete env[key];
  if (s.agent === "claude") { env.CLAUDE_CONFIG_DIR = s.claudeHome || s.accountHome; env.ANTHROPIC_CONFIG_DIR = path.join(s.accountHome, "anthropic"); }
  else env.CODEX_HOME = s.accountHome;
  return env;
}
function claudeAccountSettings(s, settings) {
  if (!s.accountId) return settings;
  const env = { ...settings.env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]) env[key] = "";
  env.CLAUDE_CONFIG_DIR = s.claudeHome || s.accountHome;
  env.ANTHROPIC_CONFIG_DIR = path.join(s.accountHome, "anthropic");
  return { ...settings, apiKeyHelper: "", env };
}
const readJson = (file) => fsp.readFile(file, "utf8").then(JSON.parse).catch((e) => { if (e.code === "ENOENT") return {}; throw e; });
const writeJson = async (file, value) => {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fsp.rename(temporary, file);
};
const sourceHome = (agent) => agent === "claude" ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

class Accounts {
  constructor(dataDir, resolveLauncher, notify, inUse = () => false) {
    this.root = path.join(dataDir, "accounts"); this.file = path.join(dataDir, "accounts.json");
    this.resolveLauncher = resolveLauncher; this.notify = notify; this.inUse = inUse;
    this.profiles = []; this.defaults = { claude: "", codex: "" }; this.logins = new Map(); this.authLocks = new Map(); this.saving = Promise.resolve();
  }
  async init() {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    const saved = await readJson(this.file);
    this.profiles = (saved.profiles || []).filter((p) => idPattern.test(p.id) && ["claude", "codex"].includes(p.agent) && typeof p.name === "string");
    for (const agent of ["claude", "codex"]) if (this.profiles.some((p) => p.agent === agent && p.id === saved.defaults?.[agent])) this.defaults[agent] = saved.defaults[agent];
  }
  save() {
    const value = structuredClone({ profiles: this.profiles, defaults: this.defaults });
    const saved = this.saving.catch(() => {}).then(() => writeJson(this.file, value)); this.saving = saved;
    return saved.then(() => this.notify({ type: "changed" }));
  }
  get(id, agent) {
    const profile = this.profiles.find((p) => p.id === id && (!agent || p.agent === agent));
    if (!profile) throw new Error("This saved account is unavailable. Choose an account in Settings → Accounts.");
    return profile;
  }
  home(id) {
    this.get(id); const home = path.join(this.root, id);
    if (fs.existsSync(home)) {
      const relative = path.relative(fs.realpathSync(this.root), fs.realpathSync(home));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Account folder points outside Lumen's account folder.");
    }
    return home;
  }
  select(agent, id) {
    id ??= this.defaults[agent] || "";
    if (typeof id !== "string") throw new Error("Invalid account selection.");
    if (!id) return { accountId: "", accountName: "CLI default", accountHome: "" };
    const profile = this.get(id, agent);
    return { accountId: id, accountName: profile.name, accountHome: this.home(id) };
  }
  async list() {
    const profiles = await Promise.all(this.profiles.map(async (p) => {
      const home = this.home(p.id); let signedIn = false, email = "";
      try {
        const auth = await readJson(path.join(home, p.agent === "claude" ? ".credentials.json" : "auth.json"));
        signedIn = p.agent === "claude" ? !!auth.claudeAiOauth?.accessToken : !!(auth.tokens?.access_token || auth.OPENAI_API_KEY);
        if (p.agent === "claude") email = (await readJson(path.join(home, ".claude.json"))).oauthAccount?.emailAddress || "";
        else if (auth.tokens?.id_token) { const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString()); email = claims.email || ""; }
      } catch {}
      return { id: p.id, agent: p.agent, name: p.name, signedIn, email: typeof email === "string" ? email.slice(0, 300) : "", signingIn: this.logins.has(p.id) && !this.logins.get(p.id).ended, inUse: this.inUse(p.id) };
    }));
    return { profiles, defaults: { ...this.defaults } };
  }
  async add({ agent, name, importCurrent = false }) {
    if (!["claude", "codex"].includes(agent)) throw new Error("Choose Claude Code or Codex.");
    name = this.name(name);
    const profile = { id: crypto.randomUUID(), agent, name, revision: crypto.randomUUID() };
    const home = path.join(this.root, profile.id), source = sourceHome(agent);
    await fsp.mkdir(home, { recursive: true, mode: 0o700 });
    const copy = async (name, from = path.join(source, name)) => fsp.copyFile(from, path.join(home, name)).catch((e) => { if (e.code !== "ENOENT") throw e; });
    if (agent === "claude") {
      for (const name of ["settings.json", "settings.local.json"]) {
        const settings = await readJson(path.join(source, name));
        if (settings.env) for (const key of Object.keys(settings.env)) if (authVariable(agent, key)) delete settings.env[key];
        delete settings.apiKeyHelper;
        await writeJson(path.join(home, name), settings);
      }
      await copy("CLAUDE.md");
      const config = await readJson(process.env.CLAUDE_CONFIG_DIR ? path.join(source, ".claude.json") : path.join(os.homedir(), ".claude.json"));
      if (!importCurrent) delete config.oauthAccount;
      delete config.primaryApiKey; delete config.apiKeyHelper;
      await writeJson(path.join(home, ".claude.json"), config);
      if (importCurrent) await copy(".credentials.json");
    } else {
      const text = await fsp.readFile(path.join(source, "config.toml"), "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
      const config = TOML.parse(text); config.cli_auth_credentials_store = "file";
      if (config.model_provider && config.model_provider !== "openai") { delete config.model_provider; delete config.model; }
      for (const layer of [config, ...Object.values(config.profiles || {})]) {
        if (layer.model_providers) delete layer.model_providers.openai;
        delete layer.openai_base_url; delete layer.chatgpt_base_url;
        delete layer.forced_chatgpt_workspace_id; delete layer.forced_login_method;
        for (const key of Object.keys(layer.shell_environment_policy?.set || {})) if (authVariable(agent, key)) delete layer.shell_environment_policy.set[key];
      }
      await fsp.writeFile(path.join(home, "config.toml"), TOML.stringify(config), { mode: 0o600 });
      for (const name of ["AGENTS.md", "instructions.md"]) await copy(name);
      if (importCurrent) await copy("auth.json");
    }
    // Share installed tools; account credentials and conversation storage stay private.
    for (const name of ["skills", "plugins", "agents", "commands", "hooks", "rules"]) {
      if (await fsp.stat(path.join(source, name)).then((s) => s.isDirectory(), () => false))
        await fsp.symlink(path.join(source, name), path.join(home, name), process.platform === "win32" ? "junction" : "dir");
    }
    this.profiles.push(profile); await this.save();
    return (await this.list()).profiles.find((p) => p.id === profile.id);
  }
  name(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw new Error("Give this account a name of 1–80 characters.");
    return value.trim();
  }
  async change(id, change) {
    const profile = this.get(id);
    if (change.name !== undefined) profile.name = this.name(change.name);
    if (change.default === true) this.defaults[profile.agent] = id;
    await this.save(); return this.list();
  }
  async useSystem(agent) {
    if (!["claude", "codex"].includes(agent)) throw new Error("Invalid account provider.");
    this.defaults[agent] = ""; await this.save(); return this.list();
  }
  async remove(id) {
    this.get(id);
    if (this.inUse(id) || (this.logins.has(id) && !this.logins.get(id).ended)) throw new Error("Close this account's chats and sign-in window before removing it.");
    await this.authLocks.get(id)?.catch(() => {});
    const home = this.home(id);
    const chats = path.join(path.dirname(this.root), "claude");
    for (const entry of await fsp.readdir(chats, { withFileTypes: true }).catch((e) => { if (e.code === "ENOENT") return []; throw e; })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !idPattern.test(entry.name)) continue;
      const folder = path.join(chats, entry.name);
      const relative = path.relative(await fsp.realpath(chats), await fsp.realpath(folder));
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Chat credentials are outside Lumen's chat folder.");
      if (await fsp.readFile(path.join(folder, ".lumen-account-id"), "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; }) === id)
        for (const name of [".credentials.json", "credentials.json"]) await fsp.unlink(path.join(folder, name)).catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
    for (const name of ["auth.json", ".credentials.json", "credentials.json"]) await fsp.unlink(path.join(home, name)).catch((e) => { if (e.code !== "ENOENT") throw e; });
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.logins.delete(id);
    for (const agent of ["claude", "codex"]) if (this.defaults[agent] === id) this.defaults[agent] = "";
    await this.save(); return this.list();
  }
  login(id, command) {
    const p = this.get(id), home = this.home(id);
    if (this.inUse(id)) throw new Error("Close this account's chats before signing in again.");
    if (this.logins.has(id) && !this.logins.get(id).ended) return { id, agent: p.agent, name: p.name };
    if ([...this.logins.values()].some((l) => l.agent === p.agent && !l.ended)) throw new Error("Finish the other sign-in for this provider first.");
    const launcher = this.resolveLauncher(command || p.agent);
    const args = p.agent === "claude" ? ["--dangerously-skip-permissions", "auth", "login"] : [...codexAccountOptions({ accountId: id }), "login"];
    const terminal = require("node-pty").spawn(launcher.file, [...launcher.args, ...args], { name: "xterm-256color", cols: 80, rows: 20, cwd: home,
      env: accountEnvironment({ agent: p.agent, accountId: id, accountHome: home }), });
    const login = { terminal, agent: p.agent, buffer: "", offset: 0 }; this.logins.set(id, login);
    terminal.onData((data) => { login.buffer = (login.buffer + data).slice(-100000); login.offset += data.length; this.notify({ type: "terminal", id, data, offset: login.offset }); });
    terminal.onExit(async ({ exitCode }) => {
      login.ended = true; login.exitCode = exitCode;
      if (exitCode === 0) { p.revision = crypto.randomUUID(); await this.save().catch(() => {}); }
      this.notify({ type: "exit", id, code: exitCode }); this.notify({ type: "changed" });
    });
    return { id, agent: p.agent, name: p.name };
  }
  write(id, data) { if (typeof data !== "string" || data.length > 100000) throw new Error("Invalid sign-in input."); this.logins.get(id)?.terminal.write(data); }
  resize(id, cols, rows) { if (Number.isInteger(cols) && cols > 0 && cols < 1000 && Number.isInteger(rows) && rows > 0 && rows < 1000) this.logins.get(id)?.terminal.resize(cols, rows); }
  buffer(id) { const login = this.logins.get(id); return { text: login?.buffer || "", offset: login?.offset || 0, code: login?.ended ? login.exitCode : null }; }
  cancel(id) { const login = this.logins.get(id); if (!login?.ended) login?.terminal.kill(); else this.logins.delete(id); }
  async syncClaude(s) {
    if (!s.accountId || !s.claudeHome) return;
    const previous = this.authLocks.get(s.accountId) || Promise.resolve();
    const syncing = previous.catch(() => {}).then(async () => {
      const p = this.get(s.accountId, "claude"), central = path.join(this.home(p.id), ".credentials.json"), local = path.join(s.claudeHome, ".credentials.json");
      const [a, b] = await Promise.all([readJson(central), readJson(local)]);
      if (JSON.stringify(a) === JSON.stringify(b)) { await fsp.writeFile(path.join(s.claudeHome, ".lumen-account-revision"), p.revision); return; }
      const currentRevision = await fsp.readFile(path.join(s.claudeHome, ".lumen-account-revision"), "utf8").catch(() => "");
      if (currentRevision === p.revision && Number(b.claudeAiOauth?.expiresAt) > Number(a.claudeAiOauth?.expiresAt || 0)) await writeJson(central, b);
      else if (a.claudeAiOauth?.accessToken) { await writeJson(local, a); await fsp.writeFile(path.join(s.claudeHome, ".lumen-account-revision"), p.revision); }
    });
    this.authLocks.set(s.accountId, syncing); await syncing;
  }
  watchClaude(s) {
    if (!s.accountId || s.accountWatches) return;
    s.accountWatches = [this.home(s.accountId), s.claudeHome].map((folder) => fs.watch(folder, (_event, file) => {
      if (String(file) === ".credentials.json") void this.syncClaude(s).catch(() => {});
    }));
  }
  dispose() { for (const id of this.logins.keys()) this.cancel(id); }
}
module.exports = { Accounts, accountEnvironment, claudeAccountSettings, codexAccountOptions, sourceHome };
