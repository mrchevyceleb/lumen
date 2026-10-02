const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const { discoverCommands, normalize } = require("./commands.cjs");
const { catalog, efforts, piShortcuts, cliOptions, extraOptions } = require("./models.cjs");
const { policy, launchOptions, ensureRuntime, grokHome, claudeHome, resetMcpPreferences, syncNativeMcp } = require("./session-controls.cjs");
const { accountEnvironment } = require("./accounts.cjs");
const { MessageQueue } = require("./message-queue.cjs");
const OMIT = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".venv",
  "__pycache__",
]);
const uuid = () => crypto.randomUUID();
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return (
    !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)
  );
};
const strip = (value) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");

function findExecutable(command) {
  if (path.isAbsolute(command) && fsSync.existsSync(command)) return command;
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), command + ext);
      if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile())
        return candidate;
    }
  }
  if (command === "grok") {
    const candidate = path.join(os.homedir(), ".grok", "bin", "grok.exe");
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${command} was not found. Install it or set its executable in Settings → Agents.`,
  );
}

// Resolve npm and executable forwarding shims without passing prompts through cmd.exe.
function resolveLauncher(command) {
  const file = findExecutable(command);
  if (/\.(js|cjs|mjs)$/i.test(file))
    return { file: findExecutable("node"), args: [file] };
  if (/\.ps1$/i.test(file))
    return {
      file: findExecutable("pwsh"),
      args: ["-NoLogo", "-NoProfile", "-File", file],
    };
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [] };
  const content = fsSync.readFileSync(file, "utf8");
  const direct = content.match(/"([A-Za-z]:[^"\r\n]+\.exe)"\s+%\*/i);
  if (direct && fsSync.existsSync(direct[1]))
    return { file: direct[1], args: [] };
  const script = content.match(/"%dp0%[\\/]([^"\r\n]+\.(?:js|cjs|mjs))"/i);
  if (script)
    return {
      file: findExecutable("node"),
      args: [path.join(path.dirname(file), script[1])],
    };
  throw new Error(
    "Select the underlying .exe or JavaScript CLI file instead of this command shim.",
  );
}

class WorkspaceService {
  constructor(dataDir) {
    this.roots = new Set();
    this.dataDir = dataDir;
    this.recent = [];
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.recent = JSON.parse(
        await fs.readFile(path.join(this.dataDir, "recent.json"), "utf8"),
      );
    } catch {}
  }
  async open(folder) {
    let root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory())
      throw new Error("Choose a folder.");
    try {
      const { stdout } = await execute(
        "git",
        ["-C", root, "rev-parse", "--show-toplevel"],
        { windowsHide: true },
      );
      root = await fs.realpath(stdout.trim());
    } catch {}
    this.roots.add(root);
    this.recent = [root, ...this.recent.filter((x) => x !== root)].slice(0, 12);
    await fs.writeFile(
      path.join(this.dataDir, "recent.json"),
      JSON.stringify(this.recent),
    );
    return { root, name: path.basename(root), git: await this.status(root) };
  }
  async register(folder) {
    const root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Choose a folder.");
    this.roots.add(root);
    return { root, name: path.basename(root), git: { available: false, branch: "", files: [], ahead: 0, behind: 0, worktrees: [], log: [] } };
  }
  root(root) {
    if (!this.roots.has(root)) throw new Error("Open this workspace first.");
    return root;
  }
  async safe(root, relative = "") {
    this.root(root);
    if (typeof relative !== "string" || path.isAbsolute(relative))
      throw new Error("Use a repository-relative path.");
    const candidate = path.resolve(root, relative);
    if (!inside(root, candidate))
      throw new Error("This path is outside the workspace.");
    const real = await fs.realpath(candidate);
    if (!inside(root, real))
      throw new Error("This link points outside the workspace.");
    return real;
  }
  async tree(root, relative = "") {
    const dir = await this.safe(root, relative);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !OMIT.has(e.name) && !e.isSymbolicLink())
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .map((e) => ({
        name: e.name,
        path: path.join(relative, e.name).replace(/\\/g, "/"),
        directory: e.isDirectory(),
      }));
  }
  async read(root, relative) {
    const file = await this.safe(root, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error("The editor opens text files up to 2 MB.");
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) throw new Error("This is a binary file.");
    return {
      path: relative,
      content: buffer.toString("utf8"),
      version: `${stat.mtimeMs}:${stat.size}`,
    };
  }
  async save(root, relative, content, version) {
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content) > 2 * 1024 * 1024
    )
      throw new Error("File exceeds the 2 MB editor limit.");
    const file = await this.safe(root, relative);
    const stat = await fs.stat(file);
    if (`${stat.mtimeMs}:${stat.size}` !== version)
      throw new Error(
        "This file changed on disk. Reload it before saving to avoid overwriting those changes.",
      );
    const temp = `${file}.lumen-${uuid()}.tmp`;
    try {
      await fs.writeFile(temp, content, { mode: stat.mode });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    const saved = await fs.stat(file);
    return { version: `${saved.mtimeMs}:${saved.size}` };
  }
  async create(root, relative) {
    this.root(root);
    if (!relative || path.isAbsolute(relative))
      throw new Error("Enter a relative file path.");
    const file = path.resolve(root, relative);
    if (!inside(root, file))
      throw new Error("This path is outside the workspace.");
    const parent = await fs.realpath(path.dirname(file));
    if (!inside(root, parent))
      throw new Error("This path is outside the workspace.");
    await fs.writeFile(file, "", { flag: "wx" });
    return this.read(root, relative);
  }
  async searchFiles(root, query) {
    this.root(root);
    const result = [];
    let visited = 0;
    const visit = async (rel, depth) => {
      if (depth > 12 || visited >= 15000 || result.length >= 100) return;
      for (const entry of await this.tree(root, rel)) {
        visited++;
        if (entry.directory) await visit(entry.path, depth + 1);
        else if (entry.path.toLowerCase().includes(query.toLowerCase()))
          result.push(entry);
        if (visited >= 15000 || result.length >= 100) break;
      }
    };
    await visit("", 0);
    return result.slice(0, 100);
  }
  async git(root, args) {
    this.root(root);
    try {
      const { stdout } = await execute("git", ["-C", root, ...args], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120000,
      });
      return stdout;
    } catch (error) {
      throw new Error(strip(error.stderr || error.message).trim());
    }
  }
  async status(root) {
    this.root(root);
    try {
      await this.git(root, ["rev-parse", "--show-toplevel"]);
      const [raw, branch, log, remote, worktree] = await Promise.all([
        this.git(root, ["status", "--porcelain=v1", "-z"]),
        this.git(root, ["branch", "--show-current"]),
        this.git(root, ["log", "-8", "--format=%h%x00%s%x00%an%x00%ar"]).catch(
          () => "",
        ),
        this.git(root, ["remote", "get-url", "origin"]).catch(() => ""),
        this.git(root, ["worktree", "list", "--porcelain", "-z"]),
      ]);
      const records = raw.split("\0");
      const files = [];
      for (let i = 0; i < records.length; i++) {
        if (!records[i]) continue;
        const code = records[i].slice(0, 2);
        const file = {
          path: records[i].slice(3),
          code,
          staged: code[0] !== " " && code[0] !== "?",
          unstaged: code[1] !== " ",
        };
        if (/[RC]/.test(code)) file.original = records[++i];
        files.push(file);
      }
      let ahead = 0,
        behind = 0;
      let upstream = "";
      try {
        upstream = (
          await this.git(root, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
          ])
        ).trim();
        const counts = (
          await this.git(root, [
            "rev-list",
            "--left-right",
            "--count",
            "HEAD...@{u}",
          ])
        )
          .trim()
          .split(/\s+/);
        ahead = Number(counts[0]);
        behind = Number(counts[1]);
      } catch {}
      const worktrees = [];
      let current;
      for (const line of worktree.split("\0")) {
        if (line.startsWith("worktree ")) {
          current = { path: line.slice(9), branch: "detached" };
          worktrees.push(current);
        } else if (line.startsWith("branch ") && current)
          current.branch = line.slice(7).replace("refs/heads/", "");
      }
      return {
        available: true,
        branch: branch.trim() || "detached HEAD",
        files,
        ahead,
        behind,
        upstream,
        remote: remote.trim(),
        worktrees,
        log: log
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, subject, author, when] = line.split("\0");
            return { hash, subject, author, when };
          }),
      };
    } catch (error) {
      return {
        available: false,
        error: error.message,
        files: [],
        worktrees: [],
        log: [],
        branch: "",
        ahead: 0,
        behind: 0,
      };
    }
  }
  async action(root, action, payload = {}) {
    this.root(root);
    const paths = payload.paths;
    if (
      paths &&
      (!Array.isArray(paths) ||
        paths.some(
          (p) =>
            typeof p !== "string" ||
            path.isAbsolute(p) ||
            !inside(root, path.resolve(root, p)),
        ))
    )
      throw new Error("Invalid file paths.");
    if (action === "stage")
      await this.git(
        root,
        paths?.length ? ["add", "--", ...paths] : ["add", "-A"],
      );
    else if (action === "unstage") {
      const hasHead = await this.git(root, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]).then(
        () => true,
        () => false,
      );
      await this.git(
        root,
        hasHead
          ? ["restore", "--staged", "--", ...(paths?.length ? paths : ["."])]
          : ["rm", "--cached", "-r", "--", ...(paths?.length ? paths : ["."])],
      );
    } else if (action === "commit") {
      if (!payload.message?.trim())
        throw new Error("Write a commit message first.");
      await this.git(root, ["commit", "-m", payload.message]);
    } else if (action === "pull") await this.git(root, ["pull", "--ff-only"]);
    else if (action === "fetch")
      await this.git(root, ["fetch", "--all", "--prune"]);
    else if (action === "push") {
      const status = await this.status(root);
      if (!status.branch || status.branch === "detached HEAD")
        throw new Error("Create a branch before pushing.");
      if (status.upstream) await this.git(root, ["push"]);
      else {
        const remotes = (await this.git(root, ["remote"]))
          .trim()
          .split("\n")
          .filter(Boolean);
        const name = remotes.includes("origin")
          ? "origin"
          : remotes.length === 1
            ? remotes[0]
            : "";
        if (!name) throw new Error("Add an origin remote before pushing.");
        await this.git(root, ["push", "--set-upstream", name, status.branch]);
      }
    } else throw new Error("Unknown Git action.");
    return this.status(root);
  }
  async diff(root, file, staged) {
    await this.safe(root, file).catch(async (error) => {
      if (!inside(root, path.resolve(root, file))) throw error;
    });
    const output = await this.git(root, [
      "diff",
      ...(staged ? ["--cached"] : []),
      "--no-ext-diff",
      "--",
      file,
    ]);
    if (output) return output;
    const status = await this.status(root);
    if (status.files.find((x) => x.path === file)?.code === "??")
      return `New file: ${file}\n\n${(await this.read(root, file)).content}`;
    return "No changes in this view.";
  }
  async worktree(root, branch, base) {
    if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-"))
      throw new Error("Enter a branch name.");
    await this.git(root, ["check-ref-format", "--branch", branch]);
    const ref = typeof base === "string" && base.trim() ? base.trim() : "HEAD";
    if (ref.startsWith("-")) throw new Error("Invalid base reference.");
    await this.git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const folder = path.join(
      path.dirname(root),
      `${path.basename(root)}.worktrees`,
      branch.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    );
    await this.git(root, ["worktree", "add", "-b", branch, folder, ref]);
    return this.open(folder);
  }
  async prs(root) {
    this.root(root);
    const { stdout } = await execute(
      "gh",
      [
        "pr",
        "list",
        "--limit",
        "15",
        "--json",
        "number,title,url,state,isDraft,headRefName",
      ],
      { cwd: root, windowsHide: true, timeout: 20000 },
    );
    return JSON.parse(stdout);
  }
}

class Sessions {
  constructor(workspaces, dataDir, emit, accounts = null) {
    this.workspaces = workspaces;
    this.dataDir = dataDir;
    this.emit = emit;
    this.sessions = new Map();
    this.accounts = accounts;
  }
  create({
    root = "",
    cwd = "",
    agent,
    mode = "rich",
    command,
    model = "",
    effort = "",
    workMode = "",
    extraArgs = [],
    sessionRef = "",
    scratchId = "",
    controlId = "",
    autoCompactTokens = null,
    mcpOverrides = {},
    accountId,
    queuedMessages = [],
  }) {
    if (
      !["shell", "pi", "codex", "claude", "grok"].includes(agent) ||
      !["rich", "native"].includes(mode)
    )
      throw new Error("Invalid session type.");
    if (
      !Array.isArray(extraArgs) ||
      extraArgs.some((x) => typeof x !== "string")
    )
      throw new Error("Extra arguments must be a JSON array of strings.");
    if ([model, effort, workMode].some((value) => typeof value !== "string" || value.length > 300 || /[\x00-\x1f]/.test(value)))
      throw new Error("Invalid session controls.");
    if (workMode && (!["claude", "grok"].includes(agent) || !["plan", "default"].includes(workMode))) throw new Error("Invalid planning mode.");
    if (sessionRef && agent !== "pi" && !/^[0-9a-f-]{36}$/i.test(sessionRef))
      throw new Error("Invalid CLI session identifier.");
    if (
      sessionRef &&
      agent === "pi" &&
      !inside(path.join(this.dataDir, "pi"), path.resolve(sessionRef))
    )
      throw new Error("Pi session is outside Lumen’s session folder.");
    if (
      sessionRef &&
      [...this.sessions.values()].some(
        (s) => s.agent === agent && s.sessionRef === sessionRef,
      )
    )
      throw new Error("This CLI conversation is already open in another tab.");
    const id = uuid();
    controlId ||= id;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(controlId)) throw new Error("Invalid session controls identifier.");
    const controls = policy({ autoCompactTokens, mcpOverrides });
    if (!this.accounts && accountId) throw new Error("Saved accounts are unavailable.");
    const account = this.accounts?.select(agent, accountId) || { accountId: "", accountName: "CLI default", accountHome: "" };
    if (agent === "claude" && controls.autoCompactTokens && (controls.autoCompactTokens < 100000 || controls.autoCompactTokens > 1000000))
      throw new Error("Claude's native auto-compact threshold supports 100,000–1,000,000 tokens.");
    const projectless = root === "";
    if (projectless) {
      scratchId ||= id;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scratchId))
        throw new Error("Invalid scratch chat identifier.");
      const scratchRoot = path.join(this.dataDir, "chats");
      fsSync.mkdirSync(scratchRoot, { recursive: true });
      const folder = path.join(scratchRoot, scratchId);
      fsSync.mkdirSync(folder, { recursive: true });
      root = fsSync.realpathSync(folder);
      if (!inside(fsSync.realpathSync(scratchRoot), root))
        throw new Error("Scratch chat folder points outside Lumen’s chat folder.");
    } else this.workspaces.root(root);
    if (cwd) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Use an absolute working folder.");
      cwd = fsSync.realpathSync(cwd);
      if ((!projectless && !inside(root, cwd)) || !fsSync.statSync(cwd).isDirectory()) throw new Error("Working folder is outside the workspace.");
    }
    const s = {
      id,
      root,
      cwd: cwd || root,
      projectless,
      agent,
      mode,
      command: command || agent,
      model,
      effort,
      workMode,
      extraArgs,
      sessionRef,
      controlId,
      ...account,
      ...controls,
      busy: false,
      output: "",
    };
    s.messageQueue = new MessageQueue(this, s, queuedMessages);
    this.sessions.set(id, s);
    return { id, agent, mode, root, cwd: s.cwd, projectless, scratchId, model, effort, workMode, controlId, ...controls, accountId: s.accountId, accountName: s.accountName, ...s.messageQueue.state() };
  }
  async sessionControls(id) {
    const s = this.get(id);
    if (s.agent === "shell") throw new Error("Choose an agent to use MCP and context controls.");
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode !== "rich") throw new Error("Finish this turn in readable view to inspect its session controls.");
    s.setting = true;
    try { return await this.readControls(s); } finally { s.setting = false; }
  }
  async readControls(s) {
    let servers, contextTokens = null, contextWindow = null, warning = "";
    if (s.agent === "pi") {
      await this.ensurePiPolicy(s);
      const info = await this.piMcp(s);
      servers = info.servers;
      warning = info.warning;
      const stats = await this.piRpc(s, "get_session_stats");
      contextTokens = stats.contextUsage?.tokens ?? null;
      contextWindow = stats.contextUsage?.contextWindow ?? null;
    } else {
      const runtime = await ensureRuntime(this, s);
      servers = await runtime.servers(); contextTokens = await runtime.contextUsage();
      contextWindow = runtime.contextWindow ?? null;
      if (s.agent === "grok") warning = "Grok controls tool access for connected MCPs; transports stay cached. Auto-compact runs between prompts at your token threshold. Grok's native compaction also protects long running turns.";
      if (s.agent === "codex") warning = "Codex reconnects this thread to apply MCP changes. Disabling a plugin MCP disables that plugin for this chat's future turns.";
    }
    this.event(s, { type: "context", contextTokens, contextWindow });
    return { servers, contextTokens, contextWindow, autoCompactTokens: s.autoCompactTokens, mcpOverrides: s.mcpOverrides, warning,
      minimumTokens: s.agent === "claude" ? 100000 : 1000, maximumTokens: s.agent === "claude" ? 1000000 : 2000000 };
  }
  async changeControls(id, change) {
    const s = this.get(id);
    if (s.agent === "shell" || s.mode !== "rich" || s.busy || s.stopping || s.transitioning || s.setting)
      throw new Error("Finish this turn in readable view before changing session controls.");
    s.setting = true;
    let reconnectWarning = "";
    try {
      if (change.resetMcps === true) {
        await this.resetRuntime(s);
        await resetMcpPreferences(s);
        s.mcpRecovery = null;
        s.mcpOverrides = {};
      } else if (Object.hasOwn(change, "autoCompactTokens")) {
        const next = policy({ ...s, autoCompactTokens: change.autoCompactTokens });
        if (s.agent === "claude" && next.autoCompactTokens && (next.autoCompactTokens < 100000 || next.autoCompactTokens > 1000000))
          throw new Error("Claude's native auto-compact threshold supports 100,000–1,000,000 tokens.");
        if (s.agent === "pi") await this.piBridge(s, "autocompact", { tokens: next.autoCompactTokens, reset: true });
        else await this.resetRuntime(s);
        if (s.agent === "grok" && s.grokHome) await fs.writeFile(path.join(s.grokHome, "lumen-context.json"), JSON.stringify({ lastCompactedUsage: null }));
        s.autoCompactTokens = next.autoCompactTokens;
      } else if (change.reconnect === true || change.reconnectAll === true) {
        if (s.agent !== "claude" || (change.reconnectAll !== true && typeof change.server !== "string")) throw new Error("Use this CLI's native MCP controls to reconnect.");
        const info = await this.readControls(s);
        const targets = change.reconnectAll === true ? info.servers.filter((r) => r.canReconnect && r.enabled && s.mcpOverrides[r.name] !== false && ["failed", "needs-auth", "disconnected", "session-token-rejected"].includes(r.status)) : info.servers.filter((r) => r.name === change.server);
        if (targets.some((r) => !r.canReconnect || !r.enabled || s.mcpOverrides[r.name] === false) || (change.reconnectAll !== true && !targets.length)) throw new Error("Enable this MCP for this chat before reconnecting it.");
        const results = await Promise.allSettled(targets.map((server) => s.runtime.request("mcp_reconnect", { serverName: server.name })));
        const failures = results.flatMap((r, i) => r.status === "rejected" ? [`${targets[i].name}: ${r.reason.message}`] : []);
        if (failures.length) reconnectWarning = "Some MCPs still need attention. " + failures.join(" · ");
      } else {
        if (typeof change.server !== "string" || typeof change.enabled !== "boolean") throw new Error("Choose an MCP and its connection state.");
        const info = await this.readControls(s);
        const server = info.servers.find((r) => r.name === change.server);
        if (!server?.canToggle) throw new Error("This MCP requires its native CLI controls or authentication first.");
        if (s.agent === "pi") await this.piMcp(s, change.server, change.enabled);
        else if (s.agent === "codex") await this.resetRuntime(s);
        else await s.runtime.toggle(change.server, change.enabled);
        s.mcpOverrides = { ...s.mcpOverrides, [change.server]: change.enabled };
      }
      this.event(s, { type: "session-controls", autoCompactTokens: s.autoCompactTokens, mcpOverrides: s.mcpOverrides });
      const next = await this.readControls(s);
      return reconnectWarning ? { ...next, warning: [next.warning, reconnectWarning].filter(Boolean).join(" ") } : next;
    } finally { s.setting = false; }
  }
  async resetRuntime(s) {
    if (["claude", "codex"].includes(s.agent) && s.runtime && !s.runtime.hadPrompt) {
      s.sessionRef = "";
      this.event(s, { type: "session", sessionRef: "" });
    }
    s.runtime?.close("Session controls changed.");
    if (s.process) { await this.kill(s.process); s.process = null; }
  }
  async piMcp(s, name, enabled) {
    if (s.piMcpSupported === undefined) s.piMcpSupported = (await this.piRpc(s, "get_commands")).commands?.some((c) => c.name === "mcp") || false;
    if (!s.piMcpSupported) return { servers: [], warning: "Pi's MCP manager extension is not installed or enabled. Configure it in native Pi, then restart this chat." };
    if (name !== undefined && (!/^[\w.-]+$/.test(name) || ["add", "remove", "list"].includes(name.toLowerCase())))
      throw new Error("This Pi MCP needs its native controls.");
    const list = async () => {
      s.piMcpNotification = "";
      await this.piRpc(s, "prompt", { message: "/mcp list" });
      const message = s.piMcpNotification;
      if (!message) return { servers: [], warning: "Pi's MCP manager did not return a server list. Install or enable your MCP extension in native Pi." };
      const servers = [...message.matchAll(/^\s*([^\s:]+):\s*(global|project),\s*(connected|disabled|disconnected)\s*\((\d+) tools?\)/gm)]
        .map((m) => ({ name: m[1], source: m[2], status: m[3], tools: Number(m[4]), enabled: m[3] !== "disabled", canToggle: /^[\w.-]+$/.test(m[1]) && !["add", "remove", "list"].includes(m[1].toLowerCase()) }));
      return { servers, warning: "Pi uses its MCP manager's runtime switches. Tool exposure still follows your Pi mode." };
    };
    const info = await list();
    if (name === undefined) return info;
    const server = info.servers.find((r) => r.name === name);
    if (!server) throw new Error("This Pi MCP is no longer available. Refresh the list.");
    if (server.enabled !== enabled) await this.piRpc(s, "prompt", { message: `/mcp ${name}` });
    const next = await list();
    if (next.servers.find((r) => r.name === name)?.enabled !== enabled) throw new Error("Pi did not change this MCP. Check its connection in native view.");
    return next;
  }
  async ensurePiPolicy(s) {
    this.ensurePi(s);
    if (s.piPolicyReady) return;
    if (s.autoCompactTokens) await this.piBridge(s, "autocompact", { tokens: s.autoCompactTokens });
    for (const [name, enabled] of Object.entries(s.mcpOverrides)) await this.piMcp(s, name, enabled);
    s.piPolicyReady = true;
  }
  get(id) {
    const s = this.sessions.get(id);
    if (!s)
      throw new Error("This session is no longer available. Open a new tab.");
    return s;
  }
  async commands(id, refresh = false) {
    const s = this.get(id);
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before refreshing commands.");
    if (s.agent === "shell") return { commands: [], origin: "Shell" };
    if (s.discoveryPromise) return s.discoveryPromise;
    if (!refresh && s.commands && Date.now() - s.commandsAt < 60000) return s.commands;
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode === "native") {
      if (s.commands) return s.commands;
      throw new Error("Finish this turn or return to readable view to discover commands.");
    }
    s.discoveryPromise = (async () => {
      let result;
      if (s.agent === "pi" && s.process) {
        // Query the actual persistent session, including extensions reloaded there.
        const data = await this.piRpc(s, "get_commands");
        result = { commands: normalize(data.commands, "pi"), origin: "Pi RPC" };
      } else {
        if (s.agent === "claude") await claudeHome(this, s);
        if (s.agent === "grok") await grokHome(this, s);
        result = await discoverCommands(s, resolveLauncher(s.command), (child) => this.kill(child));
      }
      if (!this.sessions.has(id) || s.stopping || s.transitioning) throw new Error("Command discovery was canceled.");
      s.commands = result;
      s.commandsAt = Date.now();
      return result;
    })();
    try { return await s.discoveryPromise; }
    finally { s.discoveryPromise = null; }
  }
  async cancelDiscovery(s) {
    this.rejectPiCommands(s, "Command discovery was canceled.");
    if (s.discoveryChild) await this.kill(s.discoveryChild);
    if (s.discoveryPromise) await s.discoveryPromise.catch(() => {});
  }
  rejectPiCommands(s, message) {
    for (const request of s.piRequests?.values() || []) { clearTimeout(request.timer); request.reject(new Error(message)); }
    s.piRequests?.clear();
    if (!s.piCommands) return;
    const request = s.piCommands;
    s.piCommands = null;
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  ensurePi(s) {
    if (this.accounts?.signingIn(s)) throw new Error("Finish Pi's sign-in, then retry your message.");
    if (s.process) return;
    s.piCompacting = false;
    const extensionFile = this.piExtension();
    const args = ["--mode", "rpc", "--session-dir", path.join(this.dataDir, "pi"), ...cliOptions(s),
      "--extension", extensionFile];
    if (s.sessionRef) args.push("--session", s.sessionRef);
    const child = this.child(s, args, { LUMEN_RPC_CONTROLS: "1", LUMEN_COMPACT_STATE_FILE: this.compactStateFile(s) });
    this.jsonStream(s, child, (e) => this.piEvent(s, e));
  }
  piExtension() {
    // External Node processes cannot read Electron's virtual .asar filesystem.
    const extension = fsSync.readFileSync(path.join(__dirname, "pi-controls.mjs"));
    const runtime = path.join(this.dataDir, "runtime");
    fsSync.mkdirSync(runtime, { recursive: true });
    const extensionFile = path.join(runtime, `pi-controls-${crypto.createHash("sha256").update(extension).digest("hex").slice(0, 16)}.mjs`);
    if (!fsSync.existsSync(extensionFile)) fsSync.writeFileSync(extensionFile, extension);
    return extensionFile;
  }
  compactStateFile(s) {
    const folder = path.join(this.dataDir, "context"); fsSync.mkdirSync(folder, { recursive: true });
    return path.join(folder, `${s.controlId}.json`);
  }
  piRpc(s, type, data = {}) {
    if (s.stopping || s.transitioning || !this.sessions.has(s.id)) return Promise.reject(new Error("Pi controls were canceled."));
    this.ensurePi(s);
    return new Promise((resolve, reject) => {
      const id = uuid();
      s.piRequests ||= new Map();
      const timer = setTimeout(() => { s.piRequests.delete(id); reject(new Error("Pi did not finish this control. Try again or open native view.")); }, 30000);
      s.piRequests.set(id, { resolve, reject, timer });
      s.process.stdin.write(JSON.stringify({ id, type, ...data }) + "\n", (error) => {
        if (error && s.piRequests.has(id)) { clearTimeout(timer); s.piRequests.delete(id); reject(error); }
      });
    });
  }
  async piBridge(s, action, data = {}) {
    this.ensurePi(s);
    const id = uuid();
    const result = new Promise((resolve, reject) => {
      s.piRequests ||= new Map();
      const timer = setTimeout(() => { s.piRequests.delete(id); reject(new Error("Pi's Lumen controls did not load. Try native view.")); }, 30000);
      s.piRequests.set(id, { resolve, reject, timer });
    });
    // The registered extension consumes this command without invoking an agent.
    const ack = this.piRpc(s, "prompt", { message: `/__lumen_controls ${JSON.stringify({ ...data, id, action })}` });
    try { const [info] = await Promise.all([result, ack]); return info; }
    finally {
      const pending = s.piRequests.get(id);
      if (pending) { clearTimeout(pending.timer); s.piRequests.delete(id); pending.reject(new Error("Pi control canceled.")); }
    }
  }
  async models(id, refresh = false) {
    const s = this.get(id);
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before refreshing models.");
    if (s.agent === "shell") throw new Error("Choose an agent to use model controls.");
    if (s.catalogPromise) return s.catalogPromise;
    if (!refresh && s.catalog && Date.now() - s.catalogAt < 60000) return s.catalog;
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode !== "rich") {
      if (s.catalog) return s.catalog;
      throw new Error("Finish this turn to load model controls.");
    }
    s.catalogPromise = (async () => {
      let info;
      if (s.agent === "pi") {
        const [available, state, levels, bridge] = await Promise.all([
          this.piRpc(s, "get_available_models"), this.piRpc(s, "get_state"),
          this.piRpc(s, "get_available_thinking_levels"), this.piBridge(s, "state"),
        ]);
        info = catalog("pi", available.models, { currentModel: state.model ? `${state.model.provider}/${state.model.id}` : "",
          currentEffort: state.thinkingLevel || "", currentEfforts: efforts(levels.levels), favorites: bridge.favorites,
          shortcuts: piShortcuts() });
      } else info = (await this.commands(id, refresh)).catalog;
      if (!info || !this.sessions.has(id) || s.stopping || s.transitioning) throw new Error("Model discovery was canceled.");
      s.catalog = info; s.catalogAt = Date.now();
      return info;
    })();
    try { return await s.catalogPromise; } finally { s.catalogPromise = null; }
  }
  async configure(id, change) {
    const s = this.get(id);
    const previousModel = s.model;
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode !== "rich") throw new Error("Finish this turn before changing its controls.");
    const info = await this.models(id);
    if (s.busy || s.stopping || s.transitioning || s.setting || !this.sessions.has(id)) throw new Error("This chat is busy or closing.");
    s.setting = true;
    try {
      if (change.cycle && s.agent !== "pi") throw new Error("Native cycling is available for Pi.");
      if (change.cycle) {
        if (change.cycle === "backward") await this.piBridge(s, "backward");
        else if (change.cycle === "forward") await this.piRpc(s, "cycle_model");
        else if (change.cycle === "effort") await this.piRpc(s, "cycle_thinking_level");
        else throw new Error("Invalid cycle action.");
      } else {
        if (change.model !== undefined) {
          const model = info.models.find((m) => m.id === change.model);
          if (!model) throw new Error("This model is no longer available. Refresh the picker.");
          if (s.agent === "pi") await this.piBridge(s, "select", { model: model.id });
          s.model = model.id;
          if (s.agent !== "pi" && !model.efforts.some((e) => e.id === s.effort)) s.effort = model.defaultEffort || "";
        }
        if (change.effort !== undefined) {
          const levels = s.agent === "pi" ? efforts((await this.piRpc(s, "get_available_thinking_levels")).levels) :
            info.models.find((m) => m.id === (s.model || info.currentModel))?.efforts || [];
          if (change.effort !== "" && !levels.some((e) => e.id === change.effort)) throw new Error("This effort level is not supported by the selected model.");
          if (s.agent === "pi") {
            if (!change.effort) throw new Error("Choose a thinking level for Pi.");
            await this.piRpc(s, "set_thinking_level", { level: change.effort });
          }
          s.effort = change.effort;
        }
        if (change.workMode !== undefined) {
          if (!["claude", "grok"].includes(s.agent) || !["plan", "default"].includes(change.workMode)) throw new Error("Use this agent's native planning workflow.");
          s.workMode = change.workMode;
        }
      }
      if (s.agent === "pi") {
        const state = await this.piRpc(s, "get_state");
        s.model = state.model ? `${state.model.provider}/${state.model.id}` : "";
        s.effort = state.thinkingLevel || "";
        s.catalog = { ...info, currentModel: s.model, currentEffort: s.effort,
          currentEfforts: efforts((await this.piRpc(s, "get_available_thinking_levels")).levels) };
      } else s.catalog = { ...info, currentModel: s.model || info.currentModel, currentEffort: s.effort, currentMode: s.workMode || info.currentMode };
      if (s.agent !== "pi" && s.runtime) await this.resetRuntime(s);
      if (s.model !== previousModel) this.event(s, { type: "context", contextTokens: null, contextWindow: null });
      this.event(s, { type: "config", model: s.model, effort: s.effort, workMode: s.workMode });
      return { model: s.model, effort: s.effort, workMode: s.workMode, catalog: s.catalog };
    } finally { s.setting = false; }
  }
  event(s, event) {
    if (event.type === "context") {
      s.contextTokens = Number.isFinite(event.contextTokens) && event.contextTokens >= 0 ? event.contextTokens : null;
      if (Object.hasOwn(event, "contextWindow")) s.contextWindow = Number.isFinite(event.contextWindow) && event.contextWindow > 0 ? event.contextWindow : null;
      event = { ...event, contextTokens: s.contextTokens, contextWindow: s.contextWindow ?? null };
    }
    this.emit({ id: s.id, ...event });
  }
  async startNative(id) {
    const s = this.get(id);
    if (s.nativeStart) return s.nativeStart;
    const starting = this.openNative(id); s.nativeStart = starting;
    try { return await starting; } finally { if (s.nativeStart === starting) s.nativeStart = null; }
  }
  async openNative(id) {
    const s = this.get(id);
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before opening native view.");
    if (s.pty) return;
    if (s.agent === "pi" && Object.keys(s.mcpOverrides).length)
      throw new Error("Use CLI MCP defaults before opening native Pi. Its terminal cannot inherit Lumen's runtime MCP switches.");
    const sessionEnv = {};
    if (s.agent === "grok") sessionEnv.GROK_HOME = await grokHome(this, s);
    if (s.agent === "claude") sessionEnv.CLAUDE_CONFIG_DIR = await claudeHome(this, s);
    await syncNativeMcp(s);
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before opening native view.");
    if (s.agent === "codex" && Object.keys(s.mcpOverrides).length && !s.codexLocalServers) {
      await (await ensureRuntime(this, s)).servers();
      await this.resetRuntime(s);
    }
    if (s.stopping || !this.sessions.has(id)) throw new Error("This terminal was closed before it finished starting.");
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before opening native view.");
    const pty = require("node-pty");
    const shell =
      process.platform === "win32"
        ? (() => {
            try {
              return findExecutable("pwsh");
            } catch {
              return findExecutable("powershell");
            }
          })()
        : process.env.SHELL || "/bin/bash";
    const launch =
      s.agent === "shell"
        ? { file: shell, args: process.platform === "win32" ? ["-NoLogo"] : [] }
        : resolveLauncher(s.command);
    if (s.agent !== "shell") {
      if (s.sessionRef)
        launch.args.push(
          ...(s.agent === "codex"
            ? ["resume", s.sessionRef]
            : [s.agent === "pi" ? "--session" : "--resume", s.sessionRef]),
        );
      launch.args.push(
        ...cliOptions(s),
        ...extraOptions(s),
        ...launchOptions(s),
      );
      if (s.agent === "pi") { launch.args.push("--extension", this.piExtension()); sessionEnv.LUMEN_AUTO_COMPACT_TOKENS = String(s.autoCompactTokens || ""); sessionEnv.LUMEN_COMPACT_STATE_FILE = this.compactStateFile(s); }
    } else if (process.platform === "win32") {
      // Keep the existing PowerShell prompt, adding its real folder as an OSC event.
      launch.args.push("-NoExit", "-Command", '$global:lumenPromptBlock=(Get-Item function:prompt).ScriptBlock; function global:prompt { [Console]::Write([char]27+\']9;9;"\'+(Get-Location).Path+\'"\'+[char]7); & $global:lumenPromptBlock }');
    }
    s.pty = pty.spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cwd: s.cwd || s.root,
      cols: 100,
      rows: 30,
      env: { ...accountEnvironment(s), TERM: "xterm-256color", COLORTERM: "truecolor", ...sessionEnv },
    });
    s.pty.onData((data) => {
      s.cwdOscBuffer = (s.cwdOscBuffer || "") + data;
      const osc = /\x1b\](?:9;9;([^\x07\x1b]*)|7;([^\x07\x1b]*))(?:\x07|\x1b\\)/g;
      let match;
      while ((match = osc.exec(s.cwdOscBuffer))) {
        try {
          const cwd = match[1] ? match[1].replace(/^"|"$/g, "") : decodeURIComponent(new URL(match[2]).pathname).replace(/^\/([A-Za-z]:)/, "$1");
          if (path.isAbsolute(cwd)) { s.cwd = cwd; this.event(s, { type: "cwd", cwd }); }
        } catch {}
      }
      const lastEscape = s.cwdOscBuffer.lastIndexOf("\x1b]");
      s.cwdOscBuffer = lastEscape >= 0 && !/(?:\x07|\x1b\\)/.test(s.cwdOscBuffer.slice(lastEscape)) ? s.cwdOscBuffer.slice(lastEscape).slice(-10000) : "";
      s.output = (s.output + data).slice(-500000);
      this.event(s, { type: "terminal", data });
    });
    s.pty.onExit(({ exitCode }) => {
      s.pty = null;
      this.event(s, { type: "exit", code: exitCode });
    });
  }
  write(id, data) {
    const s = this.get(id);
    if (!s.pty) throw new Error("Terminal has exited. Start a new terminal.");
    s.pty.write(data);
  }
  resize(id, cols, rows) {
    const s = this.get(id);
    if (s.pty)
      s.pty.resize(
        Math.max(20, Math.min(500, Math.floor(cols))),
        Math.max(5, Math.min(200, Math.floor(rows))),
      );
  }
  terminalBuffer(id) {
    return this.get(id).output;
  }
  async send(id, prompt, queuedMessage) {
    const s = this.get(id);
    if (s.stopping || s.transitioning || s.setting || s.catalogPromise)
      throw new Error(
        "This session is stopping. Wait a moment before continuing.",
      );
    if (s.busy)
      throw new Error("Wait for this turn to finish or stop it first.");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 200000)
      throw new Error("Enter a message under 200,000 characters.");
    if (s.mode === "native")
      throw new Error("Type directly into the terminal.");
    if (queuedMessage) this.event(s, { type: "user-message", messageId: queuedMessage.id, text: prompt, delivery: "send" });
    s.busy = true;
    s.phase = undefined;
    s.activeTools = new Set();
    s.turn = uuid();
    s.hadText = false;
    s.messageStreams = new Map();
    s.piRunActive = false;
    s.piCompletionStateId = undefined;
    s.piPromptId = undefined;
    this.event(s, { type: "start", turn: s.turn });
    try {
      if (s.agent === "shell") await this.shellTurn(s, prompt);
      else await this.agentTurn(s, prompt);
    } catch (error) {
      if (queuedMessage) this.event(s, { type: "user-message-retracted", messageId: queuedMessage.id });
      this.event(s, { type: "error", message: error.message });
      this.finish(s, 1);
      if (queuedMessage) throw error;
    }
  }
  finish(s, code = 0) {
    if (s.stopping) return;
    if (!s.busy) return;
    clearTimeout(s.progressTimer);
    s.busy = false;
    s.phase = undefined;
    this.event(s, { type: "done", code, sessionRef: s.sessionRef });
    s.messageQueue?.finish(code);
  }
  submit(id, message) { return this.get(id).messageQueue.submit(message); }
  queueAction(id, messageId, action) { return this.get(id).messageQueue.action(messageId, action); }
  async steer(s, message) {
    if (!s.busy || s.mode !== "rich" || s.stopping || s.transitioning || s.setting || s.phase === "compacting") throw new Error("This turn cannot accept steering right now.");
    if (message.text.trimStart().startsWith("/") || (s.agent === "codex" && message.text.trimStart().startsWith("$"))) throw new Error("Steer with a normal message. Run CLI commands after this turn finishes.");
    if (s.agent === "pi") { if (!s.process) throw new Error("Pi is still starting."); await this.piRpc(s, "steer", { message: message.text }); }
    else { if (!s.runtime || s.runtime.closed) throw new Error("The CLI is still starting or closing."); await s.runtime.steer(message); }
  }
  grokPhase(s, phase) {
    if (s.agent !== "grok" || !s.busy || s.stopping || s.phase === phase) return;
    s.phase = phase;
    this.event(s, { type: "phase", phase });
  }
  child(s, args, env = {}) {
    const launch = resolveLauncher(s.command);
    const child = spawn(
      launch.file,
      [...launch.args, ...args, ...extraOptions(s)],
      {
        cwd: s.cwd || s.root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...accountEnvironment(s), NO_COLOR: "1", ...env },
      },
    );
    s.process = child;
    child.stdin.on("error", (error) => {
      if (s.process === child) this.event(s, { type: "error", message: error.message });
    });
    child.on("error", (error) => {
      if (s.process !== child) return;
      this.rejectPiCommands(s, error.message);
      this.event(s, { type: "error", message: error.message });
      this.finish(s, 1);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) =>
      this.event(s, { type: "diagnostic", text: strip(data).slice(-10000) }),
    );
    return child;
  }
  jsonStream(s, child, handler) {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      buffer += data;
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos).replace(/\r$/, "");
        buffer = buffer.slice(pos + 1);
        if (!line.trim()) continue;
        try {
          handler(JSON.parse(line));
        } catch (error) {
          this.event(s, { type: "diagnostic", text: line.slice(0, 2000) });
        }
      }
      if (buffer.length > 8 * 1024 * 1024) {
        this.event(s, {
          type: "error",
          message: "The CLI produced an oversized record.",
        });
        this.stop(s.id).catch((error) =>
          this.event(s, { type: "error", message: error.message }),
        );
      }
    });
    child.on("close", (code) => {
      if (s.process !== child) return;
      if (buffer.trim()) {
        try {
          handler(JSON.parse(buffer));
        } catch {
          this.event(s, { type: "diagnostic", text: buffer.slice(-2000) });
        }
      }
      s.process = null;
      s.piPolicyReady = false;
      s.piMcpSupported = undefined;
      s.piCompacting = false;
      this.rejectPiCommands(s, "Pi closed before returning its commands. Refresh to discover them again.");
      this.finish(s, code ?? 1);
    });
  }
  text(s, text, key = "answer", replace = false) {
    if (text === undefined || text === null) return;
    if (s.agent === "grok" && s.busy && !s.stopping) {
      clearTimeout(s.progressTimer);
      this.grokPhase(s, undefined);
      const turn = s.turn;
      s.progressTimer = setTimeout(() => {
        if (s.turn === turn && !s.activeTools?.size) this.grokPhase(s, "waiting");
      }, 1500);
    }
    s.hadText = true;
    this.event(s, { type: "text", text, key, replace });
  }
  tool(s, key, title, detail = "", state = "running") {
    if (s.agent === "grok") {
      s.activeTools ||= new Set();
      if (["done", "error", "completed", "failed"].includes(state)) s.activeTools.delete(key);
      else s.activeTools.add(key);
      clearTimeout(s.progressTimer);
      this.grokPhase(s, undefined);
    }
    this.event(s, {
      type: "tool",
      key,
      title,
      detail: String(detail).slice(-30000),
      state,
    });
  }
  async shellTurn(s, prompt) {
    // Keep a non-interactive shell alive for command blocks. Native tabs use a full PTY.
    if (!s.shell) {
      const win = process.platform === "win32";
      const shell = win
        ? (() => {
            try {
              return findExecutable("pwsh");
            } catch {
              return findExecutable("powershell");
            }
          })()
        : process.env.SHELL || "/bin/bash";
      s.shell = spawn(
        shell,
        win
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
          : ["--noprofile", "--norc"],
        {
          cwd: s.cwd || s.root,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb", NO_COLOR: "1", PS1: "" },
        },
      );
      const shellChild = s.shell;
      const output = (data) => {
        if (!s.busy || s.shell !== shellChild) return;
        s.shellBuffer += data;
        const clean = strip(s.shellBuffer);
        const match = clean.match(
          new RegExp(`${s.marker}:(-?\\d+):([^\\n]*)\\n`),
        );
        if (match) {
          this.text(s, clean.slice(0, match.index).trimEnd(), "shell", true);
          try {
            s.cwd = Buffer.from(match[2].trim(), "base64").toString("utf8");
            this.event(s, { type: "cwd", cwd: s.cwd });
          } catch {}
          this.finish(s, Number(match[1]));
        } else this.text(s, clean, "shell", true);
      };
      s.shell.stdout.setEncoding("utf8");
      s.shell.stderr.setEncoding("utf8");
      s.shell.stdout.on("data", output);
      s.shell.stderr.on("data", output);
      s.shell.on("error", (error) => {
        this.event(s, { type: "error", message: error.message });
        this.finish(s, 1);
      });
      s.shell.on("close", (code) => {
        if (s.shell !== shellChild) return;
        s.shell = null;
        this.finish(s, code ?? 1);
      });
    }
    s.shellBuffer = "";
    s.marker = `LUMEN_DONE_${uuid().replace(/-/g, "")}`;
    const win = process.platform === "win32";
    // Prompts never pass through command-line shell quoting.
    if (win) {
      const encoded = Buffer.from(prompt, "utf8").toString("base64");
      const wrapper = `$global:LASTEXITCODE=0; try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); $lumenOK=$?; $lumenCode=if($lumenOK){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1} } catch { Write-Output $_; $lumenCode=1 }; Write-Output ('${s.marker}'+':'+$lumenCode+':'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path)))\n`;
      s.shell.stdin.write(wrapper);
    } else {
      s.shell.stdin.write(
        `eval "$(printf %s '${Buffer.from(prompt).toString("base64")}' | base64 -d)"; lumen_code=$?; printf '\\n${s.marker}:%s:%s\\n' "$lumen_code" "$(pwd | tr -d '\\n' | base64 | tr -d '\\n')"\n`,
      );
    }
  }
  async agentTurn(s, prompt) {
    if (s.agent === "pi") {
      await this.ensurePiPolicy(s);
      s.process.stdin.write(JSON.stringify({ id: uuid(), type: "get_state" }) + "\n");
      s.piPromptId = uuid();
      s.piSlashPrompt = prompt.startsWith("/");
      s.process.stdin.write(
        JSON.stringify({ id: s.piPromptId, type: "prompt", message: prompt }) + "\n",
      );
      return;
    }
    await (await ensureRuntime(this, s)).prompt(prompt);
  }
  codexEvent(s, e) {
    if (e.type === "thread.started") {
      s.sessionRef = e.thread_id;
      this.event(s, { type: "session", sessionRef: s.sessionRef });
    }
    const item = e.item;
    if (item?.type === "agent_message")
      this.text(s, item.text, item.id || "answer", true);
    else if (item?.type === "reasoning")
      this.tool(s, item.id, "Thinking", item.text, "done");
    else if (item?.type === "command_execution")
      this.tool(
        s,
        item.id,
        item.command,
        item.aggregated_output,
        item.status || "running",
      );
    else if (item?.type === "file_change")
      this.tool(
        s,
        item.id,
        "Updated files",
        (item.changes || []).map((c) => `${c.kind}: ${c.path}`).join("\n"),
        item.status || "done",
      );
    else if (item)
      this.tool(
        s,
        item.id || uuid(),
        item.type.replace(/_/g, " "),
        JSON.stringify(item),
        e.type === "item.completed" ? "done" : "running",
      );
    if (e.type === "error" || e.type === "turn.failed")
      this.event(s, {
        type: "error",
        message: e.message || e.error?.message || "Agent turn failed.",
      });
    if (e.type === "turn.completed")
      this.event(s, { type: "usage", usage: e.usage });
  }
  messagesEvent(s, e) {
    if (e.session_id) {
      s.sessionRef = e.session_id;
      this.event(s, { type: "session", sessionRef: s.sessionRef });
    }
    const event = e.type === "stream_event" ? e.event : e;
    if (s.agent === "grok") {
      if (["message_start", "content_block_start"].includes(event?.type) ||
          (event?.type === "content_block_delta" && event.delta?.type !== "text_delta")) {
        clearTimeout(s.progressTimer);
        this.grokPhase(s, undefined);
      }
    }
    s.messageStreams ||= new Map();
    const streamScope = e.parent_tool_use_id || "";
    if (event?.type === "message_start") {
      s.messageId = event.message?.id || uuid();
      s.messageStreams.set(streamScope, { id: s.messageId });
    }
    const stream = s.messageStreams.get(streamScope);
    if (stream && event?.type === "content_block_start") {
      stream.index = event.index ?? 0;
      stream.type = event.content_block?.type;
    }
    if (
      event?.type === "content_block_delta" &&
      event.delta?.type === "text_delta"
    ) {
      if (stream) { stream.index = event.index ?? 0; stream.type = "text"; }
      this.text(
        s,
        event.delta.text,
        `${stream?.id || s.messageId || "answer"}:${event.index ?? 0}`,
      );
    }
    if (e.type === "assistant" && e.message?.content)
      for (let i = 0; i < e.message.content.length; i++) {
        const block = e.message.content[i];
        if (block.type === "text") {
          // Newer Claude sends one completed block per assistant record, before
          // its content_block_stop. Its array index is not the stream's index.
          const matching = [...s.messageStreams.values()].find((value) => value.id === e.message.id);
          const index = e.message.content.length === 1 && matching?.type === "text" ? matching.index ?? i : i;
          this.text(
            s,
            block.text,
            `${e.message.id || stream?.id || s.messageId || "answer"}:${index}`,
            true,
          );
        }
        if (block.type === "tool_use")
          this.tool(
            s,
            block.id,
            block.name,
            JSON.stringify(block.input, null, 2),
          );
      }
    if (e.type === "user" && Array.isArray(e.message?.content))
      for (const block of e.message.content)
        if (block.type === "tool_result")
          this.tool(
            s,
            block.tool_use_id,
            "Tool result",
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
            block.is_error ? "error" : "done",
          );
    if (e.type === "result") {
      if (!s.hadText && e.result) this.text(s, e.result, "answer", true);
      if (e.is_error)
        this.event(s, {
          type: "error",
          message:
            e.result || (e.errors || []).join("\n") || "Agent turn failed.",
        });
      if (e.permission_denials?.length)
        this.event(s, {
          type: "diagnostic",
          text: "Some tools require permission. Use a native CLI tab to approve them interactively, or configure explicit CLI permission arguments in Settings.",
        });
      this.event(s, { type: "usage", usage: e.usage, cost: e.total_cost_usd });
    }
    if (e.type === "error")
      this.event(s, {
        type: "error",
        message: e.message || JSON.stringify(e.error),
      });
    if (s.agent === "grok" && !e.parent_tool_use_id &&
        (e.type === "result" || (e.type === "assistant" && e.message?.stop_reason === "end_turn") ||
         (event?.type === "message_delta" && event.delta?.stop_reason === "end_turn"))) {
      clearTimeout(s.progressTimer);
      this.grokPhase(s, "finishing");
    }
  }
  piEvent(s, e) {
    if (e.type === "extension_ui_request" && e.method === "notify" && /^MCP Servers:|^No MCP servers configured/.test(e.message || "")) {
      s.piMcpNotification = e.message; return;
    }
    if (e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("LUMEN_CONTEXT:")) {
      try {
        const usage = JSON.parse(e.message.slice("LUMEN_CONTEXT:".length)); this.event(s, { type: "context", contextTokens: usage.contextTokens, contextWindow: usage.contextWindow });
        if (usage.compacting !== undefined) {
          s.piCompacting = usage.compacting;
          this.event(s, { type: "phase", phase: usage.compacting ? "compacting" : undefined });
          if (usage.error) this.event(s, { type: "diagnostic", key: "auto-compact", text: "Auto-compact: " + usage.error + ". The CLI's normal context protection remains active." });
          if (!usage.compacting && !s.piRunActive) this.finish(s, 0);
        }
      } catch {}
      return;
    }
    if (["auto_compaction_start", "compaction_start"].includes(e.type)) this.event(s, { type: "phase", phase: "compacting" });
    if (["auto_compaction_end", "compaction_end"].includes(e.type)) this.event(s, { type: "phase", phase: undefined });
    const control = e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("LUMEN_CONTROLS:");
    if (control) {
      try {
        const data = JSON.parse(e.message.slice("LUMEN_CONTROLS:".length));
        const pending = s.piRequests?.get(data.id);
        if (pending) {
          clearTimeout(pending.timer); s.piRequests.delete(data.id);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data);
        }
      } catch {}
      return;
    }
    if (e.type === "response" && s.piRequests?.has(e.id)) {
      const pending = s.piRequests.get(e.id);
      clearTimeout(pending.timer); s.piRequests.delete(e.id);
      e.success ? pending.resolve(e.data || {}) : pending.reject(new Error(e.error || "Pi control failed."));
      if (e.command !== "get_state") return;
    }
    if (e.type === "response" && e.command === "get_commands" && e.id === s.piCommands?.id) {
      const request = s.piCommands;
      s.piCommands = null;
      clearTimeout(request.timer);
      try {
        if (!e.success) throw new Error(e.error || "Pi could not list commands.");
        request.resolve({ commands: normalize(e.data?.commands, "pi"), origin: "Pi RPC" });
      } catch (error) { request.reject(error); }
      return;
    }
    if (e.type === "agent_start") s.piRunActive = true;
    if (e.type === "response" && e.command === "prompt" && e.id === s.piPromptId && e.success && s.piSlashPrompt) {
      // Extensions may finish without running the agent. Check the authoritative
      // state after their acknowledgement, rather than timing out a completed command.
      s.piCompletionStateId = uuid();
      s.process?.stdin.write(JSON.stringify({ id: s.piCompletionStateId, type: "get_state" }) + "\n");
    }
    if (e.type === "response" && e.command === "get_state" && e.id === s.piCompletionStateId && e.success &&
        !s.piRunActive && !e.data?.isStreaming && !e.data?.isCompacting && !e.data?.pendingMessageCount) {
      if (s.busy && !s.hadText) this.text(s, "Command completed.", "command-result", true);
      this.finish(s, 0);
    }
    if (
      e.type === "response" &&
      e.command === "get_state" &&
      e.data?.sessionFile
    ) {
      s.sessionRef = e.data.sessionFile;
      this.event(s, { type: "session", sessionRef: s.sessionRef });
    }
    if (e.type === "response" && e.command === "get_state" && e.success && e.data?.model) {
      const model = `${e.data.model.provider}/${e.data.model.id}`;
      if (s.model !== model || s.effort !== e.data.thinkingLevel) {
        s.model = model; s.effort = e.data.thinkingLevel || ""; s.catalogAt = 0;
        this.event(s, { type: "config", model: s.model, effort: s.effort, workMode: s.workMode });
      }
    }
    if (e.type === "response" && e.success === false) {
      this.event(s, { type: "error", message: e.error });
      if (e.command === "prompt") this.finish(s, 1);
    }
    if (e.type === "message_start" && e.message?.role === "assistant")
      s.messageId = uuid();
    if (e.type === "message_update") {
      const a = e.assistantMessageEvent;
      if (a?.type === "text_delta")
        this.text(
          s,
          a.delta,
          `${s.messageId || "answer"}:${a.contentIndex || 0}`,
        );
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (let i = 0; i < (e.message.content || []).length; i++) {
        const b = e.message.content[i];
        if (b.type === "text")
          this.text(s, b.text, `${s.messageId || "answer"}:${i}`, true);
      }
      if (e.message.errorMessage)
        this.event(s, { type: "error", message: e.message.errorMessage });
    }
    if (e.type === "tool_execution_start")
      this.tool(s, e.toolCallId, e.toolName, JSON.stringify(e.args, null, 2));
    if (e.type === "tool_execution_end")
      this.tool(
        s,
        e.toolCallId,
        e.toolName,
        (e.result?.content || []).map((c) => c.text || "").join("\n"),
        e.isError ? "error" : "done",
      );
    if (e.type === "extension_ui_request")
      this.event(s, { type: "pi_ui", request: e });
    if (e.type === "agent_settled") {
      s.piRunActive = false;
      if (!s.piCompacting) this.finish(s, 0);
      s.process?.stdin.write(
        JSON.stringify({ id: uuid(), type: "get_state" }) + "\n",
      );
    }
  }
  piResponse(id, response) {
    const s = this.get(id);
    if (s.agent !== "pi" && s.runtime) return s.runtime.reply(response);
    if (s.agent !== "pi" || !s.process)
      throw new Error("Pi session has ended.");
    s.process.stdin.write(
      JSON.stringify({ type: "extension_ui_response", ...response }) + "\n",
    );
  }
  async setMode(id, mode) {
    const s = this.get(id);
    if (!["rich", "native"].includes(mode))
      throw new Error("Invalid session view.");
    if (s.busy || s.stopping || s.transitioning || s.setting)
      throw new Error("Stop or finish this turn before changing views.");
    if (s.mode === mode) return { mode: s.mode, sessionRef: s.sessionRef };
    if (mode === "native" && s.agent === "pi" && Object.keys(s.mcpOverrides).length)
      throw new Error("Use CLI MCP defaults in this chat's controls before opening native view. Pi cannot carry Lumen's runtime MCP switches into its native terminal.");
    s.transitioning = true;
    s.messageQueue?.pause();
    try {
      await this.cancelDiscovery(s);
      if (s.runtime && !s.runtime.hadPrompt && ["codex", "claude"].includes(s.agent)) s.sessionRef = "";
      s.runtime?.close("Switching session views.");
      if (s.process) {
        await this.kill(s.process);
        s.process = null;
      }
      if (mode === "native") await syncNativeMcp(s);
      if (s.shell) {
        await this.kill(s.shell);
        s.shell = null;
      }
      if (s.pty) {
        const native = s.pty;
        const exited = new Promise((resolve) => native.onExit(resolve));
        native.kill();
        let timer;
        try {
          await Promise.race([
            exited,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Terminal is still closing. Try again shortly."),
                  ),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        s.pty = null;
      }
      s.output = "";
      s.mode = mode;
      return { mode: s.mode, sessionRef: s.sessionRef };
    } finally {
      s.transitioning = false;
    }
  }
  async stop(id) {
    const s = this.get(id);
    if (s.stopping) return;
    clearTimeout(s.progressTimer);
    s.stopping = true;
    s.messageQueue?.pause();
    try {
      await this.cancelDiscovery(s);
      s.runtime?.close("Turn stopped.");
      if (s.shell) {
        await this.kill(s.shell);
        s.shell = null;
      }
      if (s.process) {
        await this.kill(s.process);
        s.process = null;
      }
    } finally {
      s.stopping = false;
    }
    this.finish(s, 130);
  }
  async kill(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    let timer, killError;
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
      if (process.platform === "win32") {
        try {
          await execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 15000,
          });
        } catch (error) {
          // taskkill can report a descendant error while successfully stopping
          // the CLI. Let its exit event arrive before treating that as failure.
          killError = error;
        }
      } else child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(killError ? "Could not stop the process tree: " + strip(killError.stderr || killError.message) : "Process did not exit after stopping.")),
              5000,
            );
          }),
        ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.progressTimer);
    s.stopping = true;
    s.messageQueue?.close();
    await this.cancelDiscovery(s);
    s.runtime?.close("Chat closed.");
    s.pty?.kill();
    if (s.shell) await this.kill(s.shell);
    if (s.process) await this.kill(s.process);
    for (const watch of s.accountWatches || []) watch.close();
    await this.accounts?.syncClaude(s);
    await this.accounts?.syncGrok(s);
    this.sessions.delete(id);
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
module.exports = {
  WorkspaceService,
  Sessions,
  findExecutable,
  resolveLauncher,
  inside,
  strip,
};
