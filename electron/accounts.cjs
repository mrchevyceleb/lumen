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
// Every process Lumen spawns for a chat (the CLI itself, its tool shells and
// tool terminals, all of which build their environment here) learns how to
// reach Lumen's own local agent control: its stable task id, the connection
// file, the helper CLI, the guide, and a `lumen` shim on PATH. That is what
// lets an agent inside a chat list, create, message and orchestrate the
// other chats, and drive this chat's browser, with no setup from the user.
function lumenEnvironment(s, env) {
  if (!s?.controlId || !s.lumenDataDir) return env;
  env.LUMEN_TASK_ID = s.controlId;
  env.LUMEN_CONTROL_FILE = path.join(s.lumenDataDir, "agent-control.json");
  env.LUMEN_AGENT_CLI = path.join(s.lumenDataDir, "lumen-agent.cjs");
  env.LUMEN_GUIDE = path.join(s.lumenDataDir, "lumen-agent-guide.md");
  const bin = path.join(s.lumenDataDir, "bin");
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
  const parts = String(env[pathKey] || "").split(path.delimiter).filter(Boolean);
  if (!parts.some((part) => path.resolve(part) === path.resolve(bin))) env[pathKey] = [bin, ...parts].join(path.delimiter);
  return env;
}
function accountEnvironment(s, base = process.env) {
  const env = { ...base };
  if (!s.accountId) {
    if (s.agent === "claude" && s.claudeHome) env.CLAUDE_CONFIG_DIR = s.claudeHome;
    return lumenEnvironment(s, env);
  }
  for (const key of Object.keys(env)) if (authVariable(s.agent, key)) delete env[key];
  if (s.agent === "claude") { env.CLAUDE_CONFIG_DIR = s.claudeHome || s.accountHome; env.ANTHROPIC_CONFIG_DIR = path.join(s.accountHome, "anthropic"); }
  else env.CODEX_HOME = s.accountHome;
  return lumenEnvironment(s, env);
}
// Codex reads its MCP servers from config.toml, and an account's private home gets a one-time copy
// of that table when the account is created. A server the user later removed, or one that never
// answered, therefore lived on in every account home and Codex retried it on every prompt. Re-read
// the source table before each launch so account copies follow the user's config instead of
// freezing whatever was there the day the account was made.
const ordered = (value) => Array.isArray(value) ? value.map(ordered) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const atomicWrite = async (file, text) => {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, text, { mode: 0o600 });
  await fsp.rename(temporary, file);
};
async function syncCodexServers(accountHome) {
  if (!accountHome) return;
  const source = path.join(sourceHome("codex"), "config.toml"), target = path.join(accountHome, "config.toml");
  // Only a distinct regular file may be rewritten. A symlink or junction here would carry the write
  // into the user's own config, so refuse anything that is not what it looks like.
  const [sourceStat, targetStat] = await Promise.all([fsp.lstat(source).catch(() => null), fsp.lstat(target).catch(() => null)]);
  if (!sourceStat?.isFile() || !targetStat?.isFile()) return;
  if (Number.isInteger(sourceStat.ino) && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev) return;
  const real = (file) => fsp.realpath(file).catch(() => path.resolve(file));
  const [sourceReal, targetReal] = await Promise.all([real(source), real(target)]);
  // Windows casing and drive-letter aliases point at the same file without matching as strings.
  if (sourceReal.toLowerCase() === targetReal.toLowerCase()) return;
  const read = (file) => fsp.readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const [sourceText, targetText] = await Promise.all([read(source), read(target)]);
  // Never create an account's config here: it carries the sign-in and provider settings.
  if (sourceText === null || targetText === null) return;
  let from, to;
  try { from = TOML.parse(sourceText); to = TOML.parse(targetText); } catch { return; }
  const wanted = from.mcp_servers && typeof from.mcp_servers === "object" ? from.mcp_servers : {};
  const current = to.mcp_servers && typeof to.mcp_servers === "object" ? to.mcp_servers : {};
  // Lumen only owns the entries it mirrored in. A server added straight into this account's own
  // config is the user's and stays put. Accounts made before this shipped have no record yet, so
  // their existing table counts as mirrored once, which is what removes an entry that went stale.
  const recordFile = path.join(accountHome, ".lumen-mcp-servers.json");
  const record = await fsp.readFile(recordFile, "utf8").then(JSON.parse, () => null);
  const mirrored = new Set(Array.isArray(record?.names) ? record.names : Object.keys(current));
  const next = { ...current };
  for (const name of mirrored) if (!Object.hasOwn(wanted, name)) delete next[name];
  for (const [name, server] of Object.entries(wanted)) next[name] = server;
  if (!same(current, next)) {
    if (Object.keys(next).length) to.mcp_servers = next; else delete to.mcp_servers;
    // Atomic: another chat can be launching against this same account at the same time, and Codex
    // must never read a half-written config.
    await atomicWrite(target, TOML.stringify(to));
  }
  const names = Object.keys(wanted);
  if (!record || !same([...record.names || []].sort(), [...names].sort()))
    await atomicWrite(recordFile, JSON.stringify({ names })).catch(() => {});
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
const locked = (error) => ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
// Windows refuses to replace a file another process has open, and the Claude CLI
// keeps this chat's .claude.json open while it runs. The lock clears in
// milliseconds, so a replace waits it out. Before this, a first message could
// fail outright with EPERM while Lumen synced the account config.
const renameWithRetry = async (from, to, stillWanted) => {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(from, to); return true; }
    catch (error) {
      if (!locked(error) || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      // The lock means another writer may have replaced the file while this
      // one waited. Ask again before trying to overwrite it.
      if (stillWanted && !await stillWanted()) return false;
    }
  }
};
const writeJson = async (file, value, expected) => {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  if (expected !== undefined && signature(await readJson(file)) !== expected) { await fsp.unlink(temporary); return false; }
  const written = await renameWithRetry(temporary, file, expected === undefined ? undefined : async () => {
    if (signature(await readJson(file)) === expected) return true;
    await fsp.unlink(temporary).catch(() => {});
    return false;
  });
  return written !== false;
};
const agentNames = { claude: "Claude Code", codex: "Codex", grok: "Grok", pi: "Pi", google: "Google Antigravity" };
const sourceHome = (agent) => {
  const home = { claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), codex: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), grok: process.env.GROK_HOME || path.join(os.homedir(), ".grok"), pi: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), google: path.join(os.homedir(), ".gemini", "antigravity-cli") }[agent];
  if (!home) throw new Error("Choose an agent to sign in.");
  return home.startsWith("~/") || home.startsWith("~\\") ? path.join(os.homedir(), home.slice(2)) : home;
};
const signature = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

class Accounts {
  constructor(dataDir, resolveLauncher, notify, inUse = () => false, installGoogle = null) {
    this.root = path.join(dataDir, "accounts"); this.file = path.join(dataDir, "accounts.json");
    this.resolveLauncher = resolveLauncher; this.notify = notify; this.inUse = inUse; this.installGoogle = installGoogle;
    this.profiles = []; this.defaults = { claude: "", codex: "" }; this.logins = new Map(); this.loginStarts = new Map(); this.loginReservations = new Map(); this.authLocks = new Map(); this.saving = Promise.resolve();
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
  login(id, command, allowIdleReauth = false) {
    const p = this.get(id), home = this.home(id);
    if (this.inUse(id) && !allowIdleReauth) throw new Error("Close this account's chats before signing in again.");
    return this.startLogin(p, home, command, id);
  }
  loginDefault(agent, command) {
    const home = sourceHome(agent), p = { id: `cli-default-${agent}`, agent, name: `${agentNames[agent]} · CLI default` };
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return this.startLogin(p, home, command, "");
  }
  signingIn(s) { const id = s.accountId || `cli-default-${s.agent}`, login = this.logins.get(id); return this.loginReservations.has(id) || this.loginStarts.has(id) || !!login && !login.ended; }
  reserveLogin(agent, accountId) {
    const id = accountId || `cli-default-${agent}`;
    if ([...this.loginReservations.values(), ...this.loginStarts.values(), ...this.logins.values()].some((l) => l.agent === agent && !l.ended)) throw new Error("Finish the other sign-in for this provider first.");
    this.loginReservations.set(id, { agent });
    return () => this.loginReservations.delete(id);
  }
  startLogin(p, home, command, accountId) {
    if (this.loginStarts.has(p.id)) return this.loginStarts.get(p.id).promise;
    if ([...this.loginStarts.values()].some((l) => l.agent === p.agent)) throw new Error("Finish the other sign-in for this provider first.");
    const promise = this.launchLogin(p, home, command, accountId);
    this.loginStarts.set(p.id, { agent: p.agent, promise });
    const clear = () => this.loginStarts.delete(p.id); promise.then(clear, clear);
    return promise;
  }
  async launchLogin(p, home, command, accountId) {
    const id = p.id;
    if (this.logins.has(id) && !this.logins.get(id).ended) return { id, agent: p.agent, name: p.name };
    if ([...this.logins.values()].some((l) => l.agent === p.agent && !l.ended)) throw new Error("Finish the other sign-in for this provider first.");
    const cliCommand = command || (p.agent === "google" ? "agy" : p.agent);
    let launcher;
    try { launcher = this.resolveLauncher(cliCommand); } catch (error) {
      if (p.agent !== "google" || cliCommand !== "agy" || !this.installGoogle) throw error;
      this.notify({ type: "login-status", id, text: "Installing Google Antigravity CLI…" });
      await this.installGoogle(); launcher = this.resolveLauncher(cliCommand);
    }
    // Invalidate the persisted generation before credentials can change, even
    // when a login is interrupted or Lumen exits before it finishes.
    if (accountId) { p.revision = crypto.randomUUID(); await this.save(); }
    const args = { claude: ["--dangerously-skip-permissions", "auth", "login"], codex: [...codexAccountOptions({ accountId }), "login"], grok: ["login"], pi: ["--no-session"], google: ["--dangerously-skip-permissions"] }[p.agent];
    const terminal = require("node-pty").spawn(launcher.file, [...launcher.args, ...args], { name: "xterm-256color", cols: 80, rows: 20, cwd: home,
      env: accountEnvironment({ agent: p.agent, accountId, accountHome: home }), });
    const login = { terminal, launcher, home, accountId, agent: p.agent, buffer: "", offset: 0, authenticated: false }; this.logins.set(id, login);
    const checkPiLogin = () => {
      const output = login.buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (!login.ended && !login.authenticated && login.authWritten && /(?:Logged in to|Saved API key for)[\s\S]*(?:Credentials saved|Selected)/i.test(output)) {
        login.authenticated = true; this.notify({ type: "authenticated", id });
      }
    };
    if (p.agent === "pi") login.watch = fs.watch(home, (_event, file) => {
      if (String(file) !== "auth.json") return;
      clearTimeout(login.timer);
      login.timer = setTimeout(async () => {
        const auth = await readJson(path.join(home, "auth.json")).catch(() => null);
        if (login.ended || !auth) return;
        if (Object.values(auth).some((value) => value && typeof value === "object" && (value.access || value.accessToken || value.key))) {
          login.authWritten = true; checkPiLogin();
        }
      }, 100);
    });
    terminal.onData((data) => {
      login.buffer = (login.buffer + data).slice(-100000); login.offset += data.length; this.notify({ type: "terminal", id, data, offset: login.offset }); if (p.agent === "pi") checkPiLogin();
      if (p.agent === "google" && !login.oauthSelected && /Select login method:[\s\S]*>\s*1\.\s*Google OAuth/.test(login.buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))) {
        login.oauthSelected = true; terminal.write("\r");
      }
    });
    terminal.onExit(async ({ exitCode }) => {
      login.ended = true; login.exitCode = exitCode;
      login.watch?.close(); clearTimeout(login.timer);
      if (exitCode === 0 && accountId) { p.revision = crypto.randomUUID(); await this.save().catch(() => {}); }
      if (p.agent === "google") {
        login.ended = false; login.exitCode = 1;
        try { await this.verify(id); } catch { login.authenticated = false; }
        login.exitCode = login.authenticated ? 0 : 1; login.ended = true;
      }
      this.notify({ type: "exit", id, code: ["pi", "google"].includes(p.agent) ? login.authenticated ? 0 : 1 : exitCode }); this.notify({ type: "changed" });
    });
    return { id, agent: p.agent, name: p.name };
  }
  async verify(id) {
    const login = this.logins.get(id);
    if (!login || login.agent !== "google") throw new Error("Open Google’s sign-in screen first.");
    if (login.verification) return login.verification;
    login.verification = (async () => {
      await require("node:util").promisify(require("node:child_process").execFile)(login.launcher.file, [...login.launcher.args, "models"], { cwd: login.home, env: accountEnvironment({ agent: login.agent, accountId: login.accountId, accountHome: login.home }), windowsHide: true, timeout: 20000 });
      if (this.logins.get(id) !== login) throw new Error("This sign-in was closed.");
      login.authenticated = true; this.notify({ type: "authenticated", id }); return true;
    })().finally(() => { login.verification = null; });
    return login.verification;
  }
  write(id, data) { if (typeof data !== "string" || data.length > 100000) throw new Error("Invalid sign-in input."); this.logins.get(id)?.terminal.write(data); }
  resize(id, cols, rows) { if (Number.isInteger(cols) && cols > 0 && cols < 1000 && Number.isInteger(rows) && rows > 0 && rows < 1000) this.logins.get(id)?.terminal.resize(cols, rows); }
  buffer(id) { const login = this.logins.get(id); return { text: login?.buffer || "", offset: login?.offset || 0, code: login?.ended ? login.agent === "pi" ? login.authenticated ? 0 : 1 : login.exitCode : null, authenticated: !!login?.authenticated }; }
  cancel(id) { const login = this.logins.get(id); if (!login?.ended) login?.terminal?.kill(); else this.logins.delete(id); }
  async syncClaude(s) {
    if (!s.claudeHome) return;
    // The running CLI keeps the chat's .claude.json open on Windows, so a
    // replace can stay locked. That file only mirrors the account block in the
    // source config; credentials and revision markers below must still sync,
    // and a real permission problem must still surface.
    const syncChatConfig = async (file, value) => {
      try { await writeJson(file, value); }
      catch (error) { if (!locked(error)) throw error; }
    };
    const key = s.accountId || `claude-default:${path.resolve(sourceHome("claude"))}`;
    const previous = this.authLocks.get(key) || Promise.resolve();
    const syncing = previous.catch(() => {}).then(async () => {
      if (this.signingIn(s)) return;
      const publish = () => !s.claudeAuthInvalid && !s.runtime?.authFailed && !this.signingIn(s);
      if (!s.accountId) {
        const central = path.join(sourceHome("claude"), ".credentials.json"), local = path.join(s.claudeHome, ".credentials.json"), marker = path.join(s.claudeHome, ".lumen-auth-source");
        const [a, b] = await Promise.all([readJson(central), readJson(local)]);
        const sourceConfig = process.env.CLAUDE_CONFIG_DIR ? path.join(sourceHome("claude"), ".claude.json") : path.join(os.homedir(), ".claude.json");
        const localConfig = path.join(s.claudeHome, ".claude.json"), [config, chatConfig] = await Promise.all([readJson(sourceConfig), readJson(localConfig)]);
        const signature = (value) => crypto.createHash("sha256").update(JSON.stringify(value.claudeAiOauth || null)).digest("hex");
        let baseline = await fsp.readFile(marker, "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
        let current = signature(a);
        // Only publish a refresh derived from the source we last copied. A new
        // terminal login or logout wins over an older chat, even with less expiry.
        const sameAccount = typeof config.oauthAccount?.accountUuid === "string" && !!config.oauthAccount.accountUuid && config.oauthAccount.accountUuid === chatConfig.oauthAccount?.accountUuid;
        if (this.signingIn(s)) return;
        if (publish() && sameAccount && baseline === current && a.claudeAiOauth?.accessToken && b.claudeAiOauth?.accessToken && b.claudeAiOauth?.refreshToken && Number(b.claudeAiOauth.expiresAt) > Number(a.claudeAiOauth.expiresAt || 0)) {
          a.claudeAiOauth = b.claudeAiOauth; await writeJson(central, a); current = signature(a);
        } else if (signature(b) !== current) {
          if (a.claudeAiOauth) b.claudeAiOauth = a.claudeAiOauth; else delete b.claudeAiOauth;
          await writeJson(local, b);
          s.claudeAuthChanged = true;
        }
        if (JSON.stringify(chatConfig.oauthAccount) !== JSON.stringify(config.oauthAccount)) {
          if (config.oauthAccount) chatConfig.oauthAccount = config.oauthAccount; else delete chatConfig.oauthAccount;
          await syncChatConfig(localConfig, chatConfig);
        }
        if (baseline !== current) await fsp.writeFile(marker, current, { mode: 0o600 });
        return;
      }
      const p = this.get(s.accountId, "claude"), central = path.join(this.home(p.id), ".credentials.json"), local = path.join(s.claudeHome, ".credentials.json");
      const config = await readJson(path.join(this.home(p.id), ".claude.json")), localConfig = path.join(s.claudeHome, ".claude.json"), chatConfig = await readJson(localConfig);
      const sameAccount = typeof config.oauthAccount?.accountUuid === "string" && !!config.oauthAccount.accountUuid && config.oauthAccount.accountUuid === chatConfig.oauthAccount?.accountUuid;
      if (JSON.stringify(config.oauthAccount) !== JSON.stringify(chatConfig.oauthAccount)) {
        if (config.oauthAccount) chatConfig.oauthAccount = config.oauthAccount; else delete chatConfig.oauthAccount;
        await syncChatConfig(localConfig, chatConfig);
      }
      const [a, b] = await Promise.all([readJson(central), readJson(local)]);
      if (JSON.stringify(a) === JSON.stringify(b)) { await fsp.writeFile(path.join(s.claudeHome, ".lumen-account-revision"), p.revision); return; }
      const currentRevision = await fsp.readFile(path.join(s.claudeHome, ".lumen-account-revision"), "utf8").catch(() => "");
      if (this.signingIn(s)) return;
      if (publish() && sameAccount && currentRevision === p.revision && Number(b.claudeAiOauth?.expiresAt) > Number(a.claudeAiOauth?.expiresAt || 0)) await writeJson(central, b);
      else { await writeJson(local, a); await fsp.writeFile(path.join(s.claudeHome, ".lumen-account-revision"), p.revision); s.claudeAuthChanged = true; }
    });
    this.authLocks.set(key, syncing); await syncing;
  }
  watchClaude(s) {
    if (!s.claudeHome || s.accountWatches) return;
    s.accountWatches = [s.accountId ? this.home(s.accountId) : sourceHome("claude"), s.claudeHome].filter((folder) => fs.existsSync(folder)).map((folder) => fs.watch(folder, (_event, file) => {
      if (String(file) === ".credentials.json") void this.syncClaude(s).catch(() => {});
    }));
  }
  async syncGrok(s) {
    if (!s.grokHome) return;
    const key = `grok:${path.resolve(sourceHome("grok"))}`;
    const syncing = (this.authLocks.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.signingIn(s)) return;
      const central = path.join(sourceHome("grok"), "auth.json"), local = path.join(s.grokHome, "auth.json"), marker = path.join(s.grokHome, ".lumen-auth-source");
      let [a, b] = await Promise.all([readJson(central), readJson(local)]);
      const baseline = await fsp.readFile(marker, "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
      const current = signature(a);
      let published = false;
      if (!s.authInvalid && !s.runtime?.authFailed && baseline === current) {
        for (const [issuer, value] of Object.entries(a)) {
          const refresh = b[issuer];
          const expiry = (v) => typeof v === "number" ? v : Date.parse(v || "");
          if (value?.user_id && refresh?.user_id === value.user_id && refresh.principal_id === value.principal_id && value.key && refresh.key && refresh.refresh_token && expiry(refresh.expires_at) > expiry(value.expires_at)) {
            a[issuer] = refresh; published = true;
          }
        }
      }
      if (published && !await writeJson(central, a, current)) a = await readJson(central);
      if (signature(b) !== signature(a)) { await writeJson(local, a); s.authChanged = true; }
      await fsp.writeFile(marker, signature(a), { mode: 0o600 });
    });
    this.authLocks.set(key, syncing); await syncing;
  }
  watchGrok(s) {
    if (!s.grokHome || s.accountWatches) return;
    s.accountWatches = [sourceHome("grok"), s.grokHome].filter((folder) => fs.existsSync(folder)).map((folder) => fs.watch(folder, (_event, file) => {
      if (String(file) === "auth.json") void this.syncGrok(s).catch(() => {});
    }));
  }
  dispose() { for (const id of this.logins.keys()) this.cancel(id); }
}
module.exports = { Accounts, accountEnvironment, claudeAccountSettings, codexAccountOptions, sourceHome, syncCodexServers, renameWithRetry };
