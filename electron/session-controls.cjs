const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const TOML = require("@iarna/toml");
const net = require("node:net");
const WebSocket = require("ws");
const { cliOptions, speedId } = require("./models.cjs");
const { codexAccountOptions, renameWithRetry } = require("./accounts.cjs");
const uuid = () => crypto.randomUUID();
const withoutNulls = (value) => Array.isArray(value) ? value.map(withoutNulls) : value && typeof value === "object" ?
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)])) : value;
// A local MCP server (Unity's bridge at 127.0.0.1:8091 is the usual one) can be
// closed while its entry stays in Codex's config. Codex then keeps retrying the
// dead socket and the chat stalls behind it. Probe local endpoints before the
// thread starts and leave out only the ones that are not listening; a server
// that is running passes through untouched. Nothing on disk is changed.
const LOCAL_MCP_TIMEOUT_MS = 350;
// Plan mode exists to think before touching anything, so read-only exploration
// should not stop for approval: asking about every Read turns planning into a
// click-through. These Claude Code tools cannot write files or run code, and
// they auto-allow in plan mode when every path they touch sits inside the
// chat's own directories; pointed anywhere else (a credential store, say) they
// ask like everything else. Bash is deliberately absent: a shell command is
// arbitrary code even when it looks read-only. Skill is absent too: skill
// content can run shell lines and pre-approve tools. MCP tools ask: their
// names say nothing about whether they write, and an MCP resource URI is not a
// filesystem path this gate can prove stays inside the workspace. Task
// bookkeeping and plan entry only touch agent-internal state, so they never ask.
const PLAN_READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);
const PLAN_FREE_TOOLS = new Set(["TodoRead", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "EnterPlanMode", "ToolSearch"]);
function toolNeedsPlanConfirm(session, toolName, input) {
  if (toolName === "ExitPlanMode") return true;
  if (session?.workMode !== "plan") return false;
  if (PLAN_FREE_TOOLS.has(toolName)) return false;
  if (PLAN_READ_ONLY_TOOLS.has(toolName)) {
    try { return !planPathsInside(session, input, toolName); }
    catch { return true; } // an unparsable target asks instead of crashing the gate
  }
  return true;
}

// Note: recursive search below a proven base relies on Claude's own directory
// confinement. `realTarget` canonicalises the base itself (so a symlinked base
// pointing outside refuses), but a symlinked directory deeper inside the search
// tree is Claude's traversal decision, the same boundary it enforces in native
// CLI use. The gate check and Claude's later read are separate syscalls, so a
// path swapped for a symlink between them is the same race native CLI use has.
function planPathsInside(session, input, toolName) {
  const rawPaths = [];      // explicit file or directory targets from the input
  const scopePaths = [];    // explicit search roots (Grep/Grep `path`) that Claude resolves
  const patterns = [];      // Glob pattern and `glob` filter directories to prove inside
  const relativeValues = []; // relative targets whose meaning depends on Claude's cwd
  let sawPath = false;
  let needsSpawnBase = false;
  // Claude expands a leading ~ to the home directory. Keep that meaning here;
  // resolving it as a workspace child would silently approve credential reads.
  const expandHome = (value) => value === "~" ? os.homedir() : value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(2)) : value;
  const isAbsoluteCandidate = (value) => path.isAbsolute(value) || /^[A-Za-z]:/.test(value);
  const isDriveRelative = (value) => /^[A-Za-z]:(?![\\/])/.test(value);
  // A single leading separator is relative to the current drive on Windows.
  // Double separators are absolute UNC or device paths and can be proven
  // canonically like any other absolute target.
  const isRootRelative = (value) => process.platform === "win32" && /^[\\/]/.test(value) && !/^[\\/]{2}/.test(value) && !/^[A-Za-z]:/.test(value);
  const addTarget = (value) => {
    if (typeof value !== "string" || !value) return;
    sawPath = true;
    const expanded = expandHome(value);
    if (isDriveRelative(expanded) || isRootRelative(expanded)) throw new Error("drive-relative");
    if (isAbsoluteCandidate(expanded)) rawPaths.push(expanded);
    else relativeValues.push(expanded);
  };
  const addScope = (value) => {
    if (typeof value !== "string" || !value) return;
    sawPath = true;
    const expanded = expandHome(value);
    if (isDriveRelative(expanded) || isRootRelative(expanded)) throw new Error("drive-relative");
    scopePaths.push(expanded);
    // An explicit search root pins the search's meaning: relative targets under
    // it are anchored there instead of Claude's spawn folder.
  };
  for (const key of ["file_path", "cwd", "notebook_path"]) addTarget(input?.[key]);
  if (Array.isArray(input?.paths)) for (const value of input.paths) addTarget(value);
  if (toolName === "Read") addTarget(input?.path);
  else addScope(input?.path);
  // Grep's `pattern` is a regex, not a path. Only Glob's pattern and either
  // tool's explicit `glob` filter describe where files may be read from.
  const patternKeys = toolName === "Glob" ? ["pattern", "glob"] : ["glob"];
  for (const key of patternKeys) {
    const rawValue = input?.[key];
    if (typeof rawValue !== "string" || !rawValue) continue;
    const value = expandHome(rawValue);
    sawPath = true;
    if (isDriveRelative(value) || isRootRelative(value)) return false;
    // A `..` segment after a wildcard can still walk out after the wildcard
    // matches, so any parent traversal in a search pattern asks. A brace group
    // can hide one ({../..}), so the segment check alone is not enough: refuse
    // braces whose expansion could reach outside the named base.
    if (value.split(/[\\/]+/).includes("..")) return false;
    if (value.includes("{") || value.includes("}")) return false;
    if (!/[\\/]/.test(value)) {
      // A slash-free pattern searches Claude's current folder (pinned by an
      // explicit `path` when the call has one, otherwise its spawn folder).
      if (!scopePaths.length) needsSpawnBase = true;
      continue;
    }
    // Peel the last segment unconditionally: a wildcard-free absolute pattern
    // like "/etc/*.conf" (or "/etc/passwd" pasted as a pattern) would otherwise
    // lose its parent directory and resolve inside the workspace.
    if (!/[\[\]*?]/.test(value) && !/^[A-Za-z]:/.test(value) && !path.isAbsolute(value)) relativeValues.push(value.replace(/[\\/]+$/, "") || value);
    if (value.includes("*") || value.includes("?") || value.includes("{") || value.includes("[") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
      const prefix = value.split(/[*?[{]/)[0];
      // A relative glob's base is the text before the first wildcard. Peel one
      // segment only for an absolute pattern; a relative pattern's base is its
      // whole pre-wildcard text (Globs anchor leading ** to the search root).
      const dir = path.isAbsolute(value) || /^[A-Za-z]:/.test(value) ? prefix.replace(/[\\/][^\\/]*$/, "") : prefix.replace(/[\\/]$/, "");
      // A drive-absolute pattern is outside on a non-Windows host even though
      // this platform's path parser treats it as a relative workspace child.
      if (/^[A-Za-z]:/.test(dir) && process.platform !== "win32") return false;
      // A root-anchored pattern peels to the filesystem root (or a bare drive
      // letter). Push that root so the inside check below refuses it instead
      // of falling through to the spawn-folder-only check.
      patterns.push(dir || path.parse(value).root || value);
      if (!isAbsoluteCandidate(dir || value)) needsSpawnBase = true;
    }
  }
  // Read and Glob name the thing to read. If neither a path nor a usable search
  // pattern was supplied, there is nothing this gate can prove is inside.
  if ((toolName === "Read" || toolName === "Glob") && !sawPath) return false;
  const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const canonicalRoot = (value) => { try { return comparable(fsSync.realpathSync.native(value)); } catch { return comparable(path.resolve(value)); } };
  // The workspace root is fixed for the chat and never travels with terminal
  // OSC output. A home or filesystem root is never a safe auto-allow boundary
  // by itself.
  const workspaceRoot = typeof session?.root === "string" && session.root ? canonicalRoot(session.root) : null;
  if (!workspaceRoot || workspaceRoot === comparable(path.parse(workspaceRoot).root) || workspaceRoot === canonicalRoot(os.homedir())) return false;
  // A workspace that CONTAINS the home folder (C:\\Users, /home, a parent of it)
  // would make ~ an in-workspace path, so it refuses as a boundary too.
  const homeDir = canonicalRoot(os.homedir());
  if (homeDir === workspaceRoot || homeDir.startsWith(workspaceRoot + path.sep)) return false;
  const insideWorkspace = (candidate) => candidate === workspaceRoot || candidate.startsWith(workspaceRoot + path.sep);
  const realTarget = (candidate, base) => {
    const target = path.resolve(base, candidate);
    // Follow links on the deepest existing ancestor, then re-append any tail
    // that does not exist yet. A symlinked directory inside the workspace must
    // not smuggle a read to its real target outside it.
    let existing = target;
    const tail = [];
    while (true) {
      try { const real = comparable(fsSync.realpathSync.native(existing)); return tail.length ? path.join(real, ...tail.reverse()) : real; }
      catch {
        const parent = path.dirname(existing);
        if (parent === existing) return comparable(target);
        tail.push(path.basename(existing));
        existing = parent;
      }
    }
  };
  // Relative targets are anchored by the input's own explicit search root when
  // the call has one. Only relative targets with no anchor, and searches with no
  // anchor at all, depend on the folder Claude was really spawned in. The live
  // cwd can be rewritten by terminal OSC output, so it is never an anchor; the
  // spawn folder is recorded when the runtime starts. If it is unknown (a
  // session object built before the runtime recorded it) or outside the
  // workspace, relative targets ask.
  // A Grep whose input names no path at all (including one that only carries
  // a `glob` filter) searches Claude's current folder, so it needs the proven
  // spawn folder before anything else. Checked up front because `glob` adds a
  // pattern, which would hide the bareness from later checks.
  const hasUsablePaths = Array.isArray(input?.paths) && input.paths.some((value) => typeof value === "string" && !!value);
  const isBareGrepEarly = toolName === "Grep" && ![input?.path, input?.file_path, input?.cwd, input?.notebook_path].some((v) => typeof v === "string" && v) && !hasUsablePaths;
  // The spawn folder is recorded when the runtime starts and never travels
  // with terminal OSC output. There is no live-cwd fallback: when it is unknown
  // or outside the workspace, anything relative asks.
  const spawnFolder = () => typeof session?.spawnCwd === "string" && session.spawnCwd ? canonicalRoot(session.spawnCwd) : null;
  let spawnBase = null;
  const needsSpawnFolder = relativeValues.length || needsSpawnBase || scopePaths.length || isBareGrepEarly;
  if (needsSpawnFolder) {
    const spawn = spawnFolder();
    // Anchored searches (an explicit absolute path, or a relative one proven
    // below) let Claude search exactly the named folder, so an outside spawn
    // folder does not block them. Anything that searches Claude's current
    // folder instead needs that folder proven inside the workspace.
    const searchesCurrentFolder = !(scopePaths.length || rawPaths.length || patterns.length);
    if (!spawn || (searchesCurrentFolder && !insideWorkspace(spawn))) return false;
    if (relativeValues.length && !scopePaths.length && !insideWorkspace(spawn)) return false;
    spawnBase = spawn;
  }
  const anchoredBase = (value) => {
    const scope = scopePaths.find((candidate) => !isAbsoluteCandidate(candidate));
    if (scope) {
      // A relative search root is itself resolved against Claude's spawn folder,
      // the one base Claude really uses, never the OSC-rewritten live cwd.
      if (!spawnBase) return false;
      return realTarget(scope, spawnBase);
    }
    const absoluteScope = scopePaths.find((candidate) => isAbsoluteCandidate(candidate));
    if (absoluteScope) return realTarget(absoluteScope, path.parse(workspaceRoot).root);
    return spawnBase;
  };
  const inside = (candidate, base) => {
    if (!base) return false;
    const target = realTarget(candidate, base);
    return target === workspaceRoot || target.startsWith(workspaceRoot + path.sep);
  };
  if (!rawPaths.every((candidate) => inside(candidate, workspaceRoot))) return false;
  if (!patterns.every((candidate) => {
    const base = isAbsoluteCandidate(candidate) ? null : anchoredBase();
    return isAbsoluteCandidate(candidate) ? inside(candidate, workspaceRoot) : inside(candidate, base);
  })) return false;
  // Every explicit search root must itself sit inside the workspace.
  for (const candidate of scopePaths) {
    if (isAbsoluteCandidate(candidate)) { if (!inside(candidate, workspaceRoot)) return false; }
    else {
      if (!spawnBase || !inside(candidate, spawnBase)) return false;
    }
  }
  if (!insideWorkspace(anchoredBase() || workspaceRoot) && scopePaths.length) return false;
  if (relativeValues.length) {
    const base = anchoredBase();
    if (!base || !insideWorkspace(base)) return false;
    if (!relativeValues.every((candidate) => inside(candidate, base))) return false;
  }
  // A search with no anchor at all, including a Grep with no path, searches
  // Claude's spawn folder, so it only auto-allows when that folder is proven
  // inside the workspace. A workspace that CONTAINS the home folder (C:\Users,
  // /home) turns ~ into an in-workspace path, so it is refused as a boundary.
  if (needsSpawnBase && !spawnBase) return false;
  if (isBareGrepEarly && !(spawnBase && insideWorkspace(spawnBase))) return false;
  return true;
}
function localMcpAddress(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
  let host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/^::ffff:/, "");
  if (host === "localhost") {
    // Most servers answer on one family only; let the resolver try both.
  } else if (host === "0.0.0.0") host = "127.0.0.1";
  else if (!/^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/.test(host)) return null;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = Number(url.port || (secure ? 443 : 80));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
function mcpListening({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, autoSelectFamily: true });
    const finish = (listening) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(LOCAL_MCP_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function withoutClosedLocalServers(servers) {
  const result = { ...servers }, skipped = [];
  await Promise.all(Object.entries(servers).map(async ([name, server]) => {
    if (!server || typeof server !== "object" || server.enabled === false) return;
    const address = localMcpAddress(server.url);
    if (!address || await mcpListening(address)) return;
    result[name] = { ...server, enabled: false };
    skipped.push(name);
  }));
  return { servers: result, skipped: skipped.sort() };
}
async function codexThreadServers(s, loaded) {
  const probed = await withoutClosedLocalServers(loaded);
  const servers = probed.servers;
  for (const [name, enabled] of Object.entries(s.mcpOverrides)) if (servers[name]) servers[name] = { ...servers[name], enabled };
  // The probe is current and an override is a memory, so a server that is not
  // listening now stays out even if it was switched on in an earlier visit.
  for (const name of probed.skipped) if (servers[name]) servers[name] = { ...servers[name], enabled: false };
  return { servers, skipped: probed.skipped, any: Object.keys(s.mcpOverrides).length > 0 || probed.skipped.length > 0 };
}
const exists = (file) => fs.stat(file).then(() => true, () => false);
// A rich agent can move its own working folder mid-turn (EnterWorktree, or a
// `git worktree add` followed by cd in a tool). Its process cwd never changes,
// but its transcript records the real cwd: Claude stamps every entry, Codex
// stamps session/turn-context rows. Walk backwards in bounded chunks until a
// cwd record is found, so a long tool-heavy tail cannot hide the last one.
async function tailCwd(file, agent) {
  if (!file) return "";
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size: total } = await handle.stat();
    const CHUNK = 256 * 1024, MAX = 8 * 1024 * 1024;
    let end = total, scanned = 0, remainder = "";
    while (end > 0 && scanned < MAX) {
      const size = Math.min(CHUNK, end, MAX - scanned);
      const start = end - size;
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, start);
      scanned += size; end = start;
      const lines = (buffer.toString("utf8") + remainder).split("\n");
      remainder = start > 0 ? lines.shift() || "" : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.includes('"cwd"')) continue;
        try {
          const row = JSON.parse(line);
          const cwd = typeof row.cwd === "string" ? row.cwd : agent === "codex" && typeof row.payload?.cwd === "string" ? row.payload.cwd : "";
          if (cwd && path.isAbsolute(cwd)) return cwd;
        } catch { /* A partial line at a chunk seam is retried whole via remainder. */ }
      }
    }
    return "";
  } finally { await handle.close().catch(() => {}); }
}
const jsonFile = (file) => fs.readFile(file, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
const atomicWrite = async (file, text) => { const temporary = file + "." + uuid() + ".tmp"; await fs.writeFile(temporary, text, { mode: 0o600 }); await renameWithRetry(temporary, file); };
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
  if (owner.accounts?.signingIn(s)) throw new Error("Finish Grok's sign-in, then retry your message.");
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
  await owner.accounts?.syncGrok(s);
  owner.accounts?.watchGrok(s);
  return target;
}
async function claudeHome(owner, s) {
  if (owner.accounts?.signingIn(s)) throw new Error("Finish Claude's sign-in, then retry your message.");
  const source = s.accountHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const target = path.join(owner.dataDir, "claude", s.controlId);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const initialized = await exists(path.join(target, ".lumen-initialized"));
  const binding = await fs.readFile(path.join(target, ".lumen-account-id"), "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
  if (initialized && binding !== (s.accountId || "")) throw new Error("This Claude chat belongs to another account. Start a new chat to switch accounts.");
  if (!initialized) {
  for (const name of ["settings.json", "settings.local.json", "CLAUDE.md", ".credentials.json", "credentials.json"])
    await fs.copyFile(path.join(source, name), path.join(target, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const config = s.accountId || process.env.CLAUDE_CONFIG_DIR ? path.join(source, ".claude.json") : path.join(os.homedir(), ".claude.json");
  await fs.copyFile(config, path.join(target, ".claude.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await fs.writeFile(path.join(target, ".lumen-initialized"), "1", { mode: 0o600 });
  await fs.writeFile(path.join(target, ".lumen-account-id"), s.accountId || "", { mode: 0o600 });
  }
  // Keep installed skills/plugins and conversation storage available without
  // copying their large caches. The private .claude.json owns MCP preferences.
  for (const name of ["plugins", "skills", "agents", "commands", "projects", "hooks", "memory-bank", "plans"])
    if (!await fs.stat(path.join(target, name)).then(() => true, () => false) && await fs.stat(path.join(source, name)).then((st) => st.isDirectory(), () => false))
      await fs.symlink(path.join(source, name), path.join(target, name), process.platform === "win32" ? "junction" : "dir");
  await fs.chmod(path.join(target, ".claude.json"), 0o600).catch(() => {});
  s.claudeHome = target;
  await owner.accounts?.syncClaude(s);
  owner.accounts?.watchClaude(s);
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
    const source = s.accountHome ? path.join(s.accountHome, ".claude.json") : process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
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
    this.serverUiRequests = new Map();
    this.userAcks = new Map();
    this.hadPrompt = !!s.sessionRef;
    this.context = s.contextTokens ?? null;
    this.contextWindow = s.contextWindow ?? null;
  }
  write(message, onWritten) {
    if (this.closed || this.child !== this.s.process) throw new Error("The CLI session closed. Try again.");
    if (this.socket) this.socket.send(JSON.stringify(message), onWritten);
    else this.child.stdin.write(JSON.stringify(message) + "\n", onWritten);
  }
  request(method, params = {}, timeout = 45000, onWritten) {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The CLI did not finish ${method}. Try again or use native view.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(this.s.agent === "claude" ? { type: "control_request", request_id: id, request: { subtype: method, ...params } } :
          { jsonrpc: "2.0", id, method, params }, (error) => {
            if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(error); }
            onWritten?.(error);
          });
      } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(message = "The CLI session closed.") {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    for (const id of this.uiRequests.keys()) this.owner.event(this.s, { type: "agent_ui_cancel", request: { id } });
    this.uiRequests.clear();
    this.serverUiRequests.clear();
    for (const ack of this.userAcks.values()) { clearTimeout(ack.timer); ack.reject(new Error(message)); }
    this.userAcks.clear();
    this.socket?.close();
    this.terminals?.close();
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
      if (error && require("./auth.cjs").authError(JSON.stringify(error))) { this.authFailed = true; s.authInvalid = true; }
      let result = claude ? response.response : response.result;
      if (s.agent === "grok" && result?.result !== undefined) result = result.result;
      error ? pending.reject(new Error(typeof error === "string" ? error : error.message || "CLI control failed.")) : pending.resolve(result || {});
      return;
    }
    // Lumen runs with the user's explicitly requested full local access. Questions
    // still need a real answer; tool approvals must never be silently denied here.
    if ((claude && e.type === "control_request") || (!claude && e.method && e.id !== undefined)) {
      if (s.agent === "codex" && s.mode === "native") return;
      this.currentServerRequestId = e.id;
      if (claude && e.request?.subtype === "can_use_tool") {
        const reply = (response) => this.write({ type: "control_response", response: { subtype: "success", request_id: e.request_id, response } });
        if (e.request.tool_name === "AskUserQuestion") this.ask({ title: "Claude Code needs your input", questions: e.request.input?.questions?.map((q) => ({ ...q, id: q.question })) || [] },
          (answer) => reply(answer.cancelled ? { behavior: "deny", message: "The user cancelled this question." } : { behavior: "allow", updatedInput: { ...e.request.input, answers: answer.answers } }));
        else if (toolNeedsPlanConfirm(s, e.request.tool_name, e.request.input)) this.ask({ method: "confirm", title: "Claude Code · plan mode", message: `Allow ${e.request.tool_name}?\n${JSON.stringify(e.request.input || {}, null, 2)}` },
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
      } else if (s.agent === "codex" && e.method === "mcpServer/elicitation/request") {
        const params = e.params || {};
        if (params.mode === "url" || params.url) this.ask({ method: "confirm", title: params.message || "Complete MCP authorization", message: params.message || "Open the authorization page and then confirm.", url: params.url },
          (answer) => this.write({ id: e.id, result: { action: answer.confirmed ? "accept" : "cancel", content: null } }));
        else this.ask({ method: "form", title: params.message || "MCP needs your input", schema: params.requestedSchema },
          (answer) => this.write({ id: e.id, result: { action: answer.cancelled ? "cancel" : "accept", content: answer.cancelled ? null : answer.content } }));
      } else if (s.agent === "grok" && e.method.startsWith("terminal/") && this.terminals) {
        void this.terminals.handle(e.method, e.params || {}).then((result) => this.write({ id: e.id, result }), (error) => this.write({ id: e.id, error: { code: -32602, message: error.message } }));
      } else {
        const name = claude ? e.request?.subtype : e.method;
        this.ask({ method: "native", title: "Native CLI required", message: `${s.agent} requested ${name}. Cancel this request and retry it in Native CLI. Your conversation is retained.` },
          () => {
            if (claude) this.write({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: "This interface needs native controls. The conversation is retained." } });
            else this.write({ id: e.id, error: { code: -32601, message: "This interface needs native controls. The conversation is retained." } });
          });
      }
      return;
    }
    if (claude) {
      if (e.session_id && e.session_id !== s.sessionRef) { o.event(s, { type: "error", message: "Claude returned a different conversation identifier. Reconnect the saved chat before sending more messages." }); return; }
      if (typeof e.cwd === "string" && path.isAbsolute(e.cwd) && path.resolve(e.cwd) !== path.resolve(s.cwd || s.root)) {
        void fs.realpath(e.cwd).then((cwd) => fs.stat(cwd).then((stat) => {
          if (this.closed || !stat.isDirectory() || path.resolve(cwd) === path.resolve(s.cwd || s.root)) return;
          s.cwd = cwd;
          o.event(s, { type: "cwd", cwd });
        })).catch(() => {});
      }
      if (e.type === "user" && this.userAcks.has(e.uuid)) { const ack = this.userAcks.get(e.uuid); clearTimeout(ack.timer); this.userAcks.delete(e.uuid); ack.resolve(); }
      if (e.type === "system") {
        s.nativeBackgroundTasks ||= new Set();
        if (e.subtype === "background_tasks_changed") { s.nativeBackgroundTasks = new Set((e.tasks || []).map((task) => task.task_id)); this.backgroundSnapshot = true; }
        else if (!this.backgroundSnapshot && ["task_started", "task_updated"].includes(e.subtype) && e.is_backgrounded !== false) s.nativeBackgroundTasks.add(e.task_id);
        else if (!this.backgroundSnapshot && e.subtype === "task_notification") s.nativeBackgroundTasks.delete(e.task_id);
        s.nativeBackgroundWork = s.nativeBackgroundTasks.size > 0;
      }
      o.messagesEvent(s, e);
      if (e.type === "system" && e.session_id) { s.sessionStarted = true; o.event(s, { type: "session", sessionRef: s.sessionRef }); }
      const messageModel = e.message?.model || e.event?.message?.model;
      const messageUsage = !e.parent_tool_use_id && messageModel !== "<synthetic>" ? (e.type === "assistant" ? e.message?.usage : e.event?.type === "message_start" ? e.event.message?.usage : null) : null;
      if (messageUsage) {
        this.claudeUsage = { ...messageUsage };
        if (messageModel) this.contextModel = messageModel;
        const used = claudeContext(this.claudeUsage);
        if (used !== null) { this.context = used; this.reportContext(); }
      } else if (!e.parent_tool_use_id && messageModel === "<synthetic>") {
        this.claudeUsage = null;
      }
      if (!e.parent_tool_use_id && e.event?.type === "message_delta" && e.event.usage && this.claudeUsage) {
        Object.assign(this.claudeUsage, e.event.usage);
        const used = claudeContext(this.claudeUsage);
        if (used !== null) { this.context = used; this.reportContext(); }
      }
      if (e.type === "system" && e.subtype === "compact_boundary") {
        this.phase(false);
        const postTokens = e.compactMetadata?.postTokens;
        if (Number.isFinite(postTokens) && postTokens > 0) {
          this.claudeUsage = { input_tokens: postTokens };
          this.context = postTokens;
          this.reportContext();
        }
        void this.contextUsage().catch(() => {});
      }
      if (e.type === "system" && e.subtype === "status") this.phase(e.status === "compacting");
      if (e.type === "result") {
        void this.syncCwd().catch(() => {});
        if (e.is_error && (e.error_code === "authentication_failed" || /failed to authenticate|OAuth session expired|invalid authentication credentials|OAuth access token (?:has been )?(?:revoked|expired)/i.test([e.result, ...(e.errors || [])].join("\n")))) { this.authFailed = true; s.claudeAuthInvalid = true; }
        // Belt and braces for the pre-launch transcript check: if Claude still says the
        // conversation is missing, stop resuming it so the next send starts fresh.
        if (e.is_error && /No conversation found with session ID/i.test([e.result, ...(e.errors || [])].join("\n")) && s.sessionStarted) {
          s.sessionStarted = false;
          o.event(s, { type: "diagnostic", title: "Conversation reset", text: "Claude could not find this chat's saved conversation. Send your message again and Lumen will start a fresh one." });
        }
        const usage = e.modelUsage?.[this.contextModel] || (Object.keys(e.modelUsage || {}).length === 1 ? Object.values(e.modelUsage)[0] : null);
        if (!this.contextWindow && usage?.contextWindow) this.contextWindow = usage.contextWindow;
        this.reportContext();
        void this.contextUsage().catch(() => {});
        o.finish(s, e.is_error ? 1 : 0);
      }
    } else if (s.agent === "codex") this.codexEvent(e);
    else this.grokEvent(e);
  }
  // The phase is the live status the composer shows under a running turn. It is
  // separate from messages on purpose: a transport hiccup that Codex retries
  // belongs in the status line, not in the transcript as a failure card.
  phase(value, text) {
    const next = value === true ? "compacting" : value || undefined;
    this.s.phase = ["compacting", "retrying", "waiting", "finishing"].includes(next) ? next : undefined;
    this.s.phaseText = this.s.phase && typeof text === "string" ? text : undefined;
    this.owner.event(this.s, { type: "phase", phase: this.s.phase, text: this.s.phaseText });
  }
  async initialize() {
    const { owner: o, s } = this;
    await o.prepareLaunch(s);
    // The plan-mode gate resolves relative tool paths against the folder this
    // child was really spawned in. The live cwd can be rewritten by terminal
    // OSC output, so record the spawn folder here and never update it.
    s.spawnCwd = s.cwd || s.root;
    let args, env;
    if (s.agent === "claude") {
      s.nativeBackgroundTasks = new Set(); s.nativeBackgroundWork = false;
      // Keep Claude's tool working directory pinned to the spawn folder: Bash
      // `cd` must not silently move where Read/Glob/Grep resolve, which is also
      // what the plan-mode gate proves inside the workspace.
      env = { CLAUDE_CONFIG_DIR: await claudeHome(o, s), CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" };
      args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", ...cliOptions(s), ...launchOptions(s)];
      if (!s.sessionRef) { s.sessionRef = uuid(); o.event(s, { type: "session", sessionRef: s.sessionRef }); }
      else if (s.sessionStarted && !await require("./session-history.cjs").sessionFile(s).then(async (file) => {
        // An empty transcript file is not resumable either: it is what a first launch that died
        // leaves behind, and --resume on it fails exactly like a missing one.
        if (!file) return null;
        const stat = await fs.stat(file).catch(() => null);
        return stat && stat.size > 64 ? file : null;
      })) {
        // A chat keeps its conversation id across restarts, but Claude Code's transcript can be
        // gone: cleaned up, deleted, or never written when the first launch died. Resuming a
        // missing transcript makes every send fail with "No conversation found", so start a
        // new conversation in the same chat instead of wedging it.
        s.sessionStarted = false;
        o.event(s, { type: "diagnostic", title: "Started a fresh conversation", text: "Claude no longer had this chat's saved conversation, so Lumen started a new one. Your earlier messages stay visible here." });
      }
      args.push(s.sessionStarted ? "--resume" : "--session-id", s.sessionRef);
    } else if (s.agent === "codex") {
      // MCP servers come from the user's Codex config, and an account's private home only copies
      // them once, at creation. Without this, a server the user deleted (or one that never
      // answered) stays in the account copy forever and Codex retries it on every prompt.
      await require("./accounts.cjs").syncCodexServers(s.accountId ? s.accountHome : "").catch(() => {});
      const port = await new Promise((resolve, reject) => { const listener = net.createServer(); listener.once("error", reject); listener.listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
      this.remoteAddress = `ws://127.0.0.1:${port}`;
      this.remoteToken = crypto.randomBytes(32).toString("hex");
      args = ["app-server", "--listen", this.remoteAddress, "--ws-auth", "capability-token", "--ws-token-sha256", crypto.createHash("sha256").update(this.remoteToken).digest("hex"), ...codexAccountOptions(s)];
    }
    else {
      env = { GROK_HOME: await grokHome(o, s) };
      const watermark = (await jsonFile(path.join(s.grokHome, "lumen-context.json"))).lastCompactedUsage;
      this.lastCompactedUsage = Number.isFinite(watermark) && watermark >= 0 ? watermark : null;
      args = [...cliOptions({ ...s, workMode: "" }), "agent", "--no-leader", "stdio"];
    }
    this.child = o.child(s, args, env);
    if (s.agent === "codex") {
      this.child.stdout.resume();
      const deadline = Date.now() + 15000;
      while (!this.socket) {
        if (this.closed || this.child.exitCode !== null) throw new Error("Codex app-server could not start. Its installed CLI must support --listen and remote TUI connections.");
        try {
          this.socket = await new Promise((resolve, reject) => {
            const socket = new WebSocket(this.remoteAddress, { headers: { Authorization: `Bearer ${this.remoteToken}` }, handshakeTimeout: 1000 });
            socket.once("open", () => resolve(socket)); socket.once("error", (error) => { socket.terminate(); reject(error); });
          });
        } catch (error) { if (Date.now() >= deadline) throw new Error("Codex's shared server did not become ready. " + error.message); await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      this.socket.on("message", (message) => { try { this.receive(JSON.parse(message.toString())); } catch (error) { o.event(s, { type: "diagnostic", text: "Codex protocol: " + error.message }); } });
      this.socket.on("close", () => this.close("Codex disconnected. Reconnect this saved conversation."));
      this.socket.on("error", () => {});
    } else o.jsonStream(s, this.child, (e) => this.receive(e));
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
      await this.request("initialize", { clientInfo: { name: "lumen", version: require("../package.json").version }, capabilities: { experimentalApi: true } });
      this.write({ method: "initialized" });
      const loaded = withoutNulls((await this.request("config/read", { cwd: s.cwd, includeLayers: false })).config?.mcp_servers || {});
      this.loadedServers = loaded;
      this.localServers = Object.keys(loaded);
      s.codexLocalServers = this.localServers;
      const servers = await codexThreadServers(s, loaded);
      this.threadServers = servers.servers;
      this.skippedServers = servers.skipped;
      if (servers.skipped.length) this.noteClosedServers(servers.skipped);
      const params = { cwd: s.cwd, approvalPolicy: "never", sandbox: "danger-full-access", config: { ...codexConfig(s), ...(servers.any ? { mcp_servers: servers.servers } : {}) }, ...(s.model ? { model: s.model } : {}), ...(s.serviceTier ? { serviceTier: s.serviceTier } : {}) };
      const resuming = !!s.sessionRef;
      // The installed daemon's paginated-history implementation does not yet
      // persist empty threads reliably. Legacy history can materialize an empty
      // conversation without sending a model prompt.
      const result = await this.request(resuming ? "thread/resume" : "thread/start", { ...params, ...(s.sessionRef ? { threadId: s.sessionRef, excludeTurns: true } : { historyMode: "legacy" }) });
      if (s.sessionRef && result.thread.id !== s.sessionRef) throw new Error("Codex returned a different conversation. The saved chat has been retained.");
      s.sessionRef = result.thread.id;
      s.sessionStarted = true;
      s.model ||= result.model;
      s.effort ||= result.reasoningEffort || "";
      // The thread echoes the tier it actually runs at (config default included,
      // unknown tiers dropped to null). Adopt the echo, but an explicit Standard
      // pick must survive a server that reports standard speed as null. Older
      // CLIs may omit the field entirely, in which case keep the request.
      if (result.serviceTier !== undefined)
        s.serviceTier = result.serviceTier ? speedId(result.serviceTier) : s.serviceTier === "default" ? "default" : "";
      else s.serviceTier = speedId(s.serviceTier || "");
      o.event(s, { type: "session", sessionRef: s.sessionRef });
      o.event(s, { type: "config", model: s.model, effort: s.effort, workMode: s.workMode, serviceTier: s.serviceTier });
      this.rolloutPath = result.thread.path;
      if (!resuming) {
        await this.request("thread/name/set", { threadId: s.sessionRef, name: s.savedTab?.name || "Lumen · " + path.basename(s.cwd) });
        await this.waitForRollout();
      }
      if (resuming) await this.hydrateCodex();
    } else {
      const { AcpTerminals } = require("./tool-terminals.cjs");
      this.terminals = new AcpTerminals(o, s);
      const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: { terminal: true }, clientInfo: { name: "lumen", version: require("../package.json").version } });
      this.agentCapabilities = init.agentCapabilities || {};
      const methodId = process.env.XAI_API_KEY && init.authMethods?.some((a) => a.id === "xai.api_key") ? "xai.api_key" : init.authMethods?.find((a) => a.id === "cached_token")?.id || init.authMethods?.find((a) => a.id === "xai.api_key")?.id;
      if (methodId) await this.request("authenticate", { methodId, _meta: { headless: true } });
      this.metadata = await this.request(s.sessionRef ? "session/load" : "session/new", { cwd: s.cwd, mcpServers: [], ...(s.sessionRef ? { sessionId: s.sessionRef } : {}) });
      if (s.sessionRef && this.metadata.sessionId && this.metadata.sessionId !== s.sessionRef) throw new Error("Grok returned a different conversation. The saved chat has been retained.");
      s.sessionRef = this.metadata.sessionId || s.sessionRef;
      s.sessionStarted = true;
      if (!sessionId(s.sessionRef)) throw new Error("Grok did not return a valid session ID.");
      o.event(s, { type: "session", sessionRef: s.sessionRef });
      await this.request("session/set_mode", { sessionId: s.sessionRef, modeId: s.workMode === "plan" ? "plan" : "default" });
    }
    if (["claude", "grok"].includes(s.agent)) await this.applyOverrides();
    void this.contextUsage().catch(() => {});
    return this;
  }
  async servers() {
    const s = this.s;
    let raw;
    if (s.agent === "claude") {
      raw = (await this.request("mcp_status")).mcpServers || [];
      this.rawServers = raw;
      return raw.map((r) => ({ name: r.name, status: r.status || "unknown", enabled: r.status !== "disabled", tools: r.tools?.length ?? null,
        source: r.scope || r.config?.scope || "Claude", canToggle: true, canReconnect: true,
        error: typeof r.error === "string" ? r.error : "", authUrl: r.scope === "claudeai" || r.config?.type === "claudeai-proxy" ? "https://claude.ai/customize/connectors" : "" }));
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
        enabled: this.skippedServers?.includes(r.name) ? false : s.mcpOverrides[r.name] ?? r.runtimeStatus !== "disabled", tools: r.tools ? Object.keys(r.tools).length : null, source: r.pluginId ? "Plugin" : "Codex", canToggle: r.name === "codex_apps" || !!r.pluginId || this.localServers.includes(r.name) }));
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
    if (this.s.agent === "codex") this.serverUiRequests.set(id, this.currentServerRequestId);
    this.owner.event(this.s, { type: "agent_ui", request: { method: "questions", ...request, id } });
  }
  reply(response) {
    const reply = this.uiRequests.get(response.id);
    if (!reply) throw new Error("This CLI question is no longer pending.");
    reply(response);
    this.uiRequests.delete(response.id);
    this.serverUiRequests.delete(response.id);
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
    if (this.s.agent === "claude") {
      const info = await this.request("get_context_usage", {}, 5000).catch(() => null);
      if (info) {
        if (Number.isFinite(info.totalTokens) && info.totalTokens >= 0) this.context = info.totalTokens;
        const limit = info.maxTokens ?? info.rawMaxTokens;
        if (Number.isFinite(limit) && limit > 0) this.contextWindow = limit;
        this.reportContext();
      }
    } else if (this.s.agent === "codex") {
      if (this.rolloutPath) {
        if (this.rolloutCachedPath !== this.rolloutPath) {
          this.rolloutCachedPath = this.rolloutPath;
          this.rolloutOffset = 0;
          this.rolloutRemainder = "";
          this.rolloutUsed = null;
          this.rolloutLimit = null;
          this.rolloutModel = null;
        }
        const handle = await fs.open(this.rolloutPath, "r").catch(() => null);
        if (handle) {
          try {
            const stat = await handle.stat();
            if (stat.size < this.rolloutOffset) {
              this.rolloutOffset = 0;
              this.rolloutRemainder = "";
              this.rolloutUsed = null;
              this.rolloutLimit = null;
              this.rolloutModel = null;
            }
            const length = stat.size - this.rolloutOffset;
            if (length > 0) {
              const buffer = Buffer.alloc(length);
              const { bytesRead } = await handle.read(buffer, 0, length, this.rolloutOffset);
              this.rolloutOffset += bytesRead;
              const chunk = this.rolloutRemainder + buffer.subarray(0, bytesRead).toString("utf8");
              const lines = chunk.split(/\r?\n/);
              this.rolloutRemainder = lines.pop() || "";
              for (const line of lines) {
                if (!line) continue;
                try {
                  const row = JSON.parse(line);
                  if ((row.type === "turn_context" || row.type === "session_meta") && typeof row.payload?.model === "string" && row.payload.model) {
                    this.rolloutModel = row.payload.model;
                    if (this.s.model && this.rolloutModel !== this.s.model) this.rolloutLimit = null;
                  } else if (row.type === "event_msg" && row.payload?.type === "token_count") {
                    const total = row.payload.info?.last_token_usage?.total_tokens;
                    const win = row.payload.info?.model_context_window;
                    if (Number.isFinite(total) && total >= 0) this.rolloutUsed = total;
                    if (Number.isFinite(win) && win > 0) this.rolloutLimit = win;
                  } else if (row.type === "token_usage_record") {
                    const total = row.payload?.usage?.total_tokens;
                    if (Number.isFinite(total) && total >= 0) this.rolloutUsed = total;
                  }
                } catch {}
              }
            }
          } finally {
            await handle.close().catch(() => {});
          }
        }
      }
      const used = this.rolloutUsed ?? null;
      let limit = !this.s.model || !this.rolloutModel || this.rolloutModel === this.s.model ? (this.rolloutLimit ?? null) : null;
      if (!limit && this.s.model) {
        const codexHome = this.s.profileEnvironment?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
        const cache = await jsonFile(path.join(codexHome, "models_cache.json"));
        const entry = Array.isArray(cache.models) ? cache.models.find((m) => m.slug === this.s.model) : null;
        if (Number.isFinite(entry?.context_window) && entry.context_window > 0) {
          limit = Number.isFinite(entry.effective_context_window_percent) && entry.effective_context_window_percent > 0
            ? Math.floor((entry.context_window * entry.effective_context_window_percent) / 100)
            : entry.context_window;
        }
      }
      if (used !== null) this.context = used;
      else if (this.context === null && limit !== null) this.context = 0;
      if (limit !== null) this.contextWindow = limit;
      if (this.context !== null || this.contextWindow !== null) this.reportContext();
    } else if (this.s.agent === "grok") {
      const info = await this.request("_x.ai/session/info", { sessionId: this.s.sessionRef }, 5000), context = info.context || info.data?.context;
      if (Number.isFinite(context?.used) && context.used >= 0) this.context = context.used;
      const limit = context?.total ?? context?.limit;
      if (Number.isFinite(limit) && limit > 0) this.contextWindow = limit;
      this.reportContext();
    }
    return this.context ?? null;
  }
  reportContext() { this.owner.event(this.s, { type: "context", contextTokens: this.context ?? null, contextWindow: this.contextWindow ?? null }); }
  // Follow a worktree the agent entered during a turn: the CLI process cwd is
  // fixed at launch, but its transcript tail names the folder it is working in.
  // Adopting it updates s.cwd, which the status bar and Source Control follow.
  async syncCwd() {
    const { s, owner: o } = this;
    if (!["claude", "codex"].includes(s.agent) || s.projectless) return;
    const file = s.agent === "codex" ? this.rolloutPath : await require("./session-history.cjs").sessionFile(s).catch(() => null);
    const found = await tailCwd(file, s.agent).catch(() => "");
    if (!found || this.closed) return;
    const cwd = await fs.realpath(found).catch(() => "");
    if (!cwd || this.closed) return;
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) return;
    if (path.resolve(cwd) === path.resolve(s.cwd || s.root)) return;
    s.cwd = cwd;
    o.event(s, { type: "cwd", cwd });
    return cwd;
  }
  async content(text, attachments = []) {
    const images = await this.owner.attachments?.resolve(this.s.controlId, attachments) || [];
    return [{ type: "text", text }, ...images.map((image) => this.s.agent === "codex" ? { type: "localImage", path: image.path } : this.s.agent === "claude" ?
      { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } } : { type: "image", data: image.data, mimeType: image.mimeType })];
  }
  async validateImages(attachments) {
    if (!attachments?.length) return;
    if (this.s.agent === "grok" && !this.agentCapabilities?.promptCapabilities?.image) throw new Error("This Grok interface does not accept images. Keep the attachments or choose another agent.");
    if (this.s.agent === "codex") {
      const models = (await this.request("model/list")).data || [];
      const model = models.find((model) => model.model === this.s.model) || models.find((model) => model.isDefault);
      if (model?.inputModalities && !model.inputModalities.includes("image")) throw new Error("The selected model does not accept images. Choose a model with image input.");
    }
    await this.owner.attachments.resolve(this.s.controlId, attachments);
  }
  async userInput(text, id, attachments = []) {
    const content = attachments.length ? await this.content(text, attachments) : text;
    id ||= uuid();
    await new Promise((resolve, reject) => {
      const fail = (error) => { const ack = this.userAcks.get(id); if (!ack) return; clearTimeout(ack.timer); this.userAcks.delete(id); reject(error); };
      const timer = setTimeout(() => fail(new Error("Claude did not acknowledge this message. Inspect the saved conversation before resending.")), 45000);
      this.userAcks.set(id, { resolve, reject, timer });
      try { this.write({ type: "user", uuid: id, session_id: this.s.sessionRef || "", parent_tool_use_id: null, message: { role: "user", content } }, (error) => { if (error) fail(error); }); }
      catch (error) { fail(error); }
    });
  }
  async steer(message) {
    if (this.closed || !this.s.busy) throw new Error("This turn has finished.");
    if (this.s.agent === "codex") {
      if (!this.activeTurnId) throw new Error("Codex is still starting its turn.");
      await this.request("turn/steer", { threadId: this.s.sessionRef, clientUserMessageId: message.id, expectedTurnId: this.activeTurnId, input: await this.content(message.text, message.attachments) });
    } else if (this.s.agent === "grok") {
      if (!this.grokPromptActive) throw new Error("Grok has not started its turn or is finishing it.");
      if (message.attachments?.length) throw new Error("Grok interjections accept text only. Keep this image message queued for the next turn.");
      const result = await this.request("_x.ai/interject", { sessionId: this.s.sessionRef, text: message.text, interjectionId: message.id });
      if (result.status !== "queued") throw new Error("Grok did not acknowledge the interjection.");
    } else {
      // Native streaming input is consumed by Claude at its next loop boundary.
      // Keep the current process/tools alive; never emulate steering by killing it.
      const turn = this.s.turn;
      await this.userInput(message.text, message.id, message.attachments);
      if (this.closed || !this.s.busy || this.s.turn !== turn || this.s.stopping)
        throw new Error("Claude finished before steering was confirmed. The correction may have reached the CLI; review it before retrying.");
    }
  }
  async prompt(text, message = {}) {
    const { s, owner: o } = this;
    this.hadPrompt = true;
    if (s.agent === "codex") o.event(s, { type: "session", sessionRef: s.sessionRef });
    if (s.agent === "claude") await this.userInput(text, message.id, message.attachments);
    else if (s.agent === "codex") {
      await this.servers();
      const disabledPluginIds = [...new Set(this.rawServers.filter((r) => r.pluginId && s.mcpOverrides[r.name] === false).map((r) => r.pluginId))];
      const collaborationMode = s.workMode ? { mode: s.workMode, settings: { model: s.model || (await this.request("model/list")).data?.find((model) => model.isDefault)?.model, reasoning_effort: s.effort || null, developer_instructions: null } } : undefined;
      const result = await this.request("turn/start", { threadId: s.sessionRef, clientUserMessageId: message.id, input: await this.content(text, message.attachments), disabledPluginIds, ...(collaborationMode ? { collaborationMode } : {}), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}), ...(s.serviceTier ? { serviceTier: s.serviceTier } : {}) });
      if (s.busy && result.turn?.status === "inProgress") this.activeTurnId = result.turn.id;
    }
    else {
      await new Promise((resolve, reject) => {
        let dispatched = false;
        void this.grokPrompt(text, () => { dispatched = true; resolve(); }, message.attachments).catch((error) => {
          if (!dispatched) { reject(error); return; }
          if (this.closed || s.stopping || s.process !== this.child) return;
          o.event(s, { type: "error", message: error.message }); o.finish(s, 1);
        });
      });
    }
  }
  async grokPrompt(text, onDispatch, attachments = []) {
    const { s, owner: o } = this;
    const turn = s.turn;
    this.messageId = uuid();
    await this.grokCompact();
    if (this.closed || !s.busy || s.turn !== turn || s.stopping) throw new Error("Grok stopped before this message was sent.");
    let result;
    this.grokPromptActive = true;
    try {
      const { readHistory } = require("./session-history.cjs");
      const before = new Set(((await readHistory(s))?.messages || []).filter((message) => message.role === "user").map((message) => message.id));
      const pending = this.request("session/prompt", { sessionId: s.sessionRef, prompt: await this.content(text, attachments) }, 24 * 60 * 60 * 1000);
      let completed = false;
      const response = pending.finally(() => { completed = true; }); response.catch(() => {});
      const acknowledge = async () => {
        const deadline = Date.now() + 45000;
        while (!this.closed) {
          const messages = (await readHistory(s))?.messages || [];
          if (messages.some((message) => message.role === "user" && !before.has(message.id) && message.text === text)) { onDispatch(); return; }
          if (completed) { const answer = await response; if (answer.stopReason === "end_turn") { onDispatch(); return; } throw new Error("Grok did not confirm this message. Inspect its saved history before resending."); }
          if (Date.now() >= deadline) { this.write({ method: "session/cancel", params: { sessionId: s.sessionRef } }); throw new Error("Grok did not save this message in time. Cancellation requested; inspect history before resending."); }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Grok closed before recording this message. Inspect its saved history before resending.");
      };
      [result] = await Promise.all([response, acknowledge()]);
    }
    finally { this.grokPromptActive = false; }
    if (result.stopReason !== "cancelled") await this.grokCompact();
    else await this.contextUsage().catch(() => {});
    if (result.stopReason && !["end_turn", "cancelled"].includes(result.stopReason)) o.event(s, { type: "diagnostic", text: `Grok finished: ${result.stopReason}.` });
    o.finish(s, result.stopReason === "cancelled" ? 130 : 0);
  }
  // Manual compact from the /compact command and the Compact button. Claude runs its own
  // /compact as a normal prompt turn (the renderer sends it); Pi goes through its bridge and
  // Codex/Grok expose real RPCs, driven from here.
  async compactNow() {
    const { s, owner: o } = this;
    if (this.compacting) throw new Error("Compaction is already running for this chat.");
    if (s.agent === "grok") {
      if (!s.sessionRef) throw new Error("Start the conversation before compacting.");
      this.compacting = true;
      try {
        const used = await this.contextUsage().catch(() => null);
        this.phase(true);
        try {
          await this.request("_x.ai/compact_conversation", { sessionId: s.sessionRef }, 300000);
          this.lastCompactedUsage = await this.contextUsage() ?? used;
          await atomicWrite(path.join(s.grokHome, "lumen-context.json"), JSON.stringify({ lastCompactedUsage: this.lastCompactedUsage }));
          o.event(s, { type: "diagnostic", key: "auto-compact", text: "Context compacted. This conversation is ready to continue." });
        } finally { this.phase(false); }
      } finally { this.compacting = false; }
      return;
    }
    if (s.agent === "codex") {
      if (!s.sessionRef) throw new Error("Start the conversation before compacting.");
      this.compacting = true;
      this.phase(true);
      try {
        await this.request("thread/compact/start", { threadId: s.sessionRef }, 300000);
        // Codex emits contextCompaction item started/completed around the actual work;
        // the item handler owns clearing this live phase once the start is accepted.
      } catch (error) {
        // If Codex rejected the start RPC, its item handler may never run, so the live
        // compacting phase must be cleared here instead of stranding the chat.
        this.phase(false);
        throw error;
      } finally { this.compacting = false; }
      return;
    }
    throw new Error("This agent compacts from its own controls.");
  }
  async grokCompact() {
    const { s, owner: o } = this;
    if (this.compacting || this.autoCompacting) return;
    this.autoCompacting = true;
    try {
      const used = await this.contextUsage().catch(() => null);
      if (!s.autoCompactTokens) return;
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
    } finally { this.autoCompacting = false; }
  }
  // One calm line in the chat when a configured local MCP server was closed, so
  // an agent that suddenly lacks a tool has a visible reason.
  noteClosedServers(names) {
    const list = names.join(", ");
    this.owner.event(this.s, { type: "diagnostic", key: "mcp-closed", replace: true, title: "MCP server not running",
      text: `${list} ${names.length > 1 ? "are" : "is"} not running, so this chat started without ${names.length > 1 ? "them" : "it"}. Start ${names.length > 1 ? "them" : "it"} and ${names.length > 1 ? "they come" : "it comes"} back on your next message.` });
  }
  // A chat that was already running when a local MCP server closed keeps
  // retrying it. Probe once on the first retry; if a server that this thread
  // actually had is closed now, the next message reconfigures without it. A
  // server that was already left out is not a new problem and stays quiet.
  async replanClosedServers() {
    const { s } = this;
    if (this.closed || s.codexReconfigure || !this.threadServers || this.probingServers) return;
    this.probingServers = true;
    try {
      const { skipped } = await withoutClosedLocalServers(this.threadServers);
      if (!skipped.length) return;
      s.codexReconfigure = true;
      this.owner.event(s, { type: "diagnostic", key: "mcp-closed", replace: true, title: "MCP server not running",
        text: `${skipped.join(", ")} ${skipped.length > 1 ? "are" : "is"} not running. Your next message continues without ${skipped.length > 1 ? "them" : "it"}.` });
    } finally { this.probingServers = false; }
  }
  // Before a turn, a server that was left out because it was closed gets
  // another look: if it is listening now, the thread is rebuilt with it.
  async reopenedServers() {
    if (!this.skippedServers?.length || !this.loadedServers) return;
    for (const name of this.skippedServers) {
      const address = localMcpAddress(this.loadedServers[name]?.url);
      if (address && await mcpListening(address)) { this.s.codexReconfigure = true; return; }
    }
  }
  codexEvent(e) {
    const { owner: o, s } = this, p = e.params || {};
    if (p.threadId && p.threadId !== s.sessionRef) return;
    // Codex retries a dropped model stream on its own. The first real output of
    // this turn means the stream is back, so the retrying status has done its
    // job. Only this turn's output counts: a late event from an older turn is
    // rejected below and must not hide an in-progress reconnect.
    const turnId = p.turn?.id || p.turnId;
    if (s.phase === "retrying" && turnId && turnId === this.activeTurnId &&
      ["item/started", "item/completed", "item/agentMessage/delta", "item/reasoning/textDelta"].includes(e.method)) this.phase(false);
    if (e.method === "serverRequest/resolved") for (const [id, requestId] of this.serverUiRequests) if (requestId === p.requestId) {
      this.serverUiRequests.delete(id); this.uiRequests.delete(id); o.event(s, { type: "agent_ui_cancel", request: { id } });
    }
    if (e.method === "thread/closed") this.threadClosed?.();
    if (e.method === "turn/started") { this.activeTurnId = p.turn?.id; if (!s.busy) { s.busy = true; s.turn = p.turn?.id; o.event(s, { type: "start", turn: s.turn }); } }
    if (e.method === "item/agentMessage/delta") o.text(s, p.delta, p.itemId || "answer");
    if (["item/started", "item/completed"].includes(e.method)) {
      const item = p.item;
      if (item?.type === "userMessage" && e.method === "item/started") o.event(s, { type: "user-message", messageId: item.clientId || item.id, text: item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "", delivery: "send" });
      else if (item?.type === "agentMessage" && e.method === "item/completed") o.text(s, item.text, item.id, true);
      else if (item && !["agentMessage", "userMessage"].includes(item.type)) o.tool(s, item.id, item.type === "commandExecution" ? item.command : item.type.replace(/([A-Z])/g, " $1"),
        item.aggregatedOutput || item.text || JSON.stringify(item), e.method === "item/completed" ? "done" : "running");
      if (item?.type === "contextCompaction") this.phase(e.method === "item/started");
    }
    if (e.method === "thread/tokenUsage/updated") { this.context = p.tokenUsage?.last?.totalTokens ?? null; this.contextWindow = p.tokenUsage?.modelContextWindow ?? null; this.reportContext(); }
    if (e.method === "error") {
      if (require("./auth.cjs").authError(JSON.stringify(p.error))) { this.authFailed = true; s.authInvalid = true; }
      const message = p.error?.message || "Codex turn failed.";
      // willRetry means Codex is reconnecting by itself and the turn is still
      // alive. A red failure card for each attempt buried real answers under
      // "Something needs attention" whenever the connection blinked.
      if (p.willRetry) {
        this.phase("retrying", message);
        o.event(s, { type: "diagnostic", key: "codex-retry", replace: true, title: "Codex is reconnecting", text: message });
        void this.replanClosedServers().catch(() => {});
      } else { this.phase(false); o.event(s, { type: "error", message }); }
    }
    if (e.method === "turn/completed") {
      if (p.turn?.id && this.activeTurnId && p.turn.id !== this.activeTurnId) return;
      this.activeTurnId = null;
      if (p.turn?.error) { if (require("./auth.cjs").authError(JSON.stringify(p.turn.error))) { this.authFailed = true; s.authInvalid = true; } o.event(s, { type: "error", message: p.turn.error.message }); }
      void this.syncCwd().catch(() => {}).finally(() => o.finish(s, p.turn?.status === "failed" ? 1 : p.turn?.status === "interrupted" ? 130 : 0));
    }
  }
  async hydrateCodex() {
    const messages = [], saved = this.owner.recovery?.state.tabs.find((tab) => tab.controlId === this.s.controlId)?.messages || [];
    let cursor;
    do {
      let page;
      try { page = await this.request("thread/items/list", { threadId: this.s.sessionRef, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) }); }
      catch (error) {
        if (!/not supported|unknown method|method not found/i.test(error.message)) throw error;
        let history;
        try { history = await this.request("thread/read", { threadId: this.s.sessionRef, includeTurns: true }); }
        catch (historyError) {
          if (!/not supported|not materialized|unknown method|method not found/i.test(historyError.message)) throw historyError;
          this.owner.event(this.s, { type: "diagnostic", key: "recovery-history", text: "This Codex version cannot list saved history. Lumen retained its transcript and paused uncertain messages; inspect native history before resending them." });
          break;
        }
        page = { data: (history.thread?.turns || []).flatMap((turn) => (turn.items || []).map((item) => ({ item, turnId: turn.id }))) };
      }
      for (const entry of page.data || []) {
        const item = entry.item;
        if (!item) continue;
        if (item.type === "userMessage") {
          const id = item.clientId || item.id, previous = saved.find((message) => message.id === id);
          messages.push({ ...previous, id, providerMessageId: item.clientId, role: "user", text: item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "", turn: entry.turnId });
        } else if (item.type === "agentMessage") messages.push({ id: `${entry.turnId}-${item.id}`, role: "assistant", text: item.text || "", turn: entry.turnId });
        else if (item.type === "commandExecution") messages.push({ id: `${entry.turnId}-${item.id}`, role: "tool", title: item.command, text: item.aggregatedOutput || "", state: item.status, turn: entry.turnId });
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (messages.length) this.owner.event(this.s, { type: "history", messages });
    this.s.messageQueue?.reconcile(messages, this.owner.recovery?.state.tabs.find((tab) => tab.controlId === this.s.controlId)?.acceptedMessageIds || []);
  }
  async waitForRollout() {
    if (!this.rolloutPath) throw new Error("Codex did not provide a durable conversation path. This chat is retained; update the CLI before continuing.");
    const deadline = Date.now() + 10000;
    while (!await exists(this.rolloutPath)) {
      if (this.closed || Date.now() >= deadline) throw new Error("Codex has not saved this conversation yet. Its identity is retained; reconnect before continuing.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async reconfigureCodex() {
    const { s } = this;
    await this.waitForRollout();
    const loaded = withoutNulls((await this.request("config/read", { cwd: s.cwd, includeLayers: false })).config?.mcp_servers || {});
    this.loadedServers = loaded;
    const servers = await codexThreadServers(s, loaded);
    this.threadServers = servers.servers;
    this.skippedServers = servers.skipped;
    if (servers.skipped.length) this.noteClosedServers(servers.skipped);
    await this.request("thread/unsubscribe", { threadId: s.sessionRef });
    const result = await this.request("thread/resume", { threadId: s.sessionRef, cwd: s.cwd, approvalPolicy: "never", sandbox: "danger-full-access", excludeTurns: true,
      config: { ...codexConfig(s), ...(servers.any ? { mcp_servers: servers.servers } : {}) }, ...(s.model ? { model: s.model } : {}), ...(s.serviceTier ? { serviceTier: s.serviceTier } : {}) });
    if (result.thread.id !== s.sessionRef) throw new Error("Codex returned a different conversation. The saved chat has been retained.");
    this.rolloutPath = result.thread.path;
    s.codexReconfigure = false;
  }
  async cancel() {
    for (const [id, reply] of this.uiRequests) { reply({ cancelled: true, confirmed: false }); this.owner.event(this.s, { type: "agent_ui_cancel", request: { id } }); }
    this.uiRequests.clear();
    this.serverUiRequests.clear();
    if (this.s.agent === "codex" && this.activeTurnId) await this.request("turn/interrupt", { threadId: this.s.sessionRef, turnId: this.activeTurnId }, 10000);
    else if (this.s.agent === "claude") await this.request("interrupt", {}, 10000);
    else if (this.s.agent === "grok") this.write({ method: "session/cancel", params: { sessionId: this.s.sessionRef } });
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
    if (e.method?.includes("context") && p.used !== undefined) { this.context = p.used; this.contextWindow = p.total ?? p.limit ?? this.contextWindow; this.reportContext(); }
  }
}
function claudeContext(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens)) return null;
  const total = usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
  return total > 0 ? total : null;
}
async function ensureRuntime(owner, s) {
  if (owner.accounts?.signingIn(s)) throw new Error("Finish this account's sign-in, then retry your message.");
  await recoverGrokMcp(s);
  if (s.agent === "claude") {
    if (owner.accounts?.signingIn(s)) throw new Error("Finish Claude's sign-in, then retry your message.");
    if (s.runtime?.authFailed || s.claudeAuthChanged) {
      if (s.runtime?.authFailed) s.claudeAuthInvalid = true;
      if (s.runtime) {
        const child = s.runtime.child;
        s.runtime.close("Claude's login changed. Reconnecting this conversation.");
        if (s.process === child) { s.process = null; await owner.kill(child); }
      }
    }
    await claudeHome(owner, s);
    if (s.runtime && s.claudeAuthChanged) {
      const child = s.runtime.child; s.runtime.close("Claude's login changed. Reconnecting this conversation.");
      if (s.process === child) { s.process = null; await owner.kill(child); }
    }
    s.claudeAuthChanged = false;
  }
  if (s.agent === "grok") await grokHome(owner, s);
  if (s.agent !== "claude" && s.runtime && (s.runtime.authFailed || s.authChanged)) {
    const child = s.runtime.child; s.runtime.close("Login changed. Reconnecting this conversation.");
    if (s.process === child) { s.process = null; await owner.kill(child); }
  }
  s.authChanged = false;
  if (s.runtime) {
    await s.runtime.ready;
    if (s.agent === "codex" && !s.codexReconfigure) await s.runtime.reopenedServers().catch(() => {});
    if (s.agent !== "codex" || !s.codexReconfigure) return s.runtime;
    await s.runtime.reconfigureCodex();
    return s.runtime;
  }
  const runtime = new Runtime(owner, s); s.runtime = runtime;
  runtime.ready = runtime.initialize().catch(async (error) => { runtime.close(error.message); if (runtime.child === s.process) await owner.kill(runtime.child); throw error; });
  await runtime.ready;
  if (s.agent === "claude") s.claudeAuthInvalid = false;
  s.authInvalid = false;
  return runtime;
}
module.exports = { policy, launchOptions, ensureRuntime, grokHome, claudeHome, resetMcpPreferences, syncNativeMcp, tailCwd, toolNeedsPlanConfirm };
