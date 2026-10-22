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
const { prepareProfile, profiledLaunch } = require("./profile-launcher.cjs");
const { TerminalState } = require("./terminal-state.cjs");
const sharedPrompts = require("./shared-prompts.cjs");
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
// Parent GIT_DIR / GIT_WORK_TREE pins every command to one checkout. Drop only
// those pins so each worktree is the repository its own path says it is.
const GIT_PINS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_NAMESPACE"];
const gitEnv = () => {
  const env = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of GIT_PINS) delete env[key];
  return env;
};
const gitPathKey = (value) => {
  let key = String(value || "").replace(/[\\/]+/g, "/");
  const root = key === "/" || /^[a-zA-Z]:\/$/.test(key);
  if (!root) key = key.replace(/\/+$/, "");
  // Windows paths are case-insensitive. Linux can have distinct folders that differ only by case.
  if (process.platform === "win32") key = key.toLowerCase();
  return key;
};
const pathInside = (child, parent) => {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
};
// Git index paths already use "/". A backslash is a real filename character on Linux.
const gitIndexPath = (value) => process.platform === "win32" ? String(value).replace(/\\/g, "/") : String(value);
const STATUS_LIMIT = 10000;
function parsePorcelain(raw, forceTruncated = false) {
  const parts = String(raw || "").split("\0");
  // A buffer cutoff ends mid-record. Drop that partial field so it is not stored as a path.
  if (forceTruncated) parts.pop();
  const files = [];
  let branch = "", detached = false, upstream = "", ahead = 0, behind = 0, truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i].replace(/\r/g, "");
    if (!record || record === "\n") continue;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) {
        const head = record.slice("# branch.head ".length);
        if (head === "(detached)") { detached = true; branch = "detached HEAD"; }
        else branch = head;
      } else if (record.startsWith("# branch.upstream ")) upstream = record.slice("# branch.upstream ".length);
      else if (record.startsWith("# branch.ab ")) {
        const counts = record.match(/\+(\d+)\s+-(\d+)/);
        if (counts) { ahead = Number(counts[1]); behind = Number(counts[2]); }
      }
      continue;
    }
    if (files.length >= STATUS_LIMIT) { truncated = true; continue; }
    if (record.startsWith("? ")) {
      files.push({ path: gitIndexPath(record.slice(2)), code: "??", staged: false, unstaged: true, conflict: false, untracked: true });
      continue;
    }
    if (record.startsWith("! ")) continue;
    const kind = record[0];
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const tokens = record.split(" ");
    const code = tokens[1] || "  ";
    const pathStart = kind === "u" ? 10 : kind === "2" ? 9 : 8;
    const filePath = gitIndexPath(tokens.slice(pathStart).join(" "));
    if (!filePath) continue;
    const conflict = kind === "u";
    const file = {
      path: filePath,
      code,
      staged: !conflict && code[0] !== " " && code[0] !== "." && code[0] !== "?",
      unstaged: !conflict && code[1] !== " " && code[1] !== "." && code[1] !== "?",
      conflict,
      untracked: false,
    };
    if (kind === "2") {
      const original = gitIndexPath((parts[++i] || "").replace(/\r/g, ""));
      if (original && original !== "\n") file.original = original;
    }
    files.push(file);
  }
  return { branch, detached, upstream, ahead, behind, files, truncated: truncated || forceTruncated };
}
async function linkedWorktree(folder) {
  try {
    const gitPath = path.join(folder, ".git");
    if ((await fs.stat(gitPath)).isDirectory()) return false;
    return /[\\/]worktrees[\\/]/i.test(await fs.readFile(gitPath, "utf8"));
  } catch { return false; }
}

function findExecutable(command, environment = process.env) {
  if (path.isAbsolute(command) && fsSync.existsSync(command)) return command;
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (environment.PATH || environment.Path || "").split(path.delimiter)) {
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
  if (command === "agy") {
    const candidate = path.join(environment.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${command} was not found. Install it or set its executable in Settings → Agents.`,
  );
}

// Resolve npm and executable forwarding shims without passing prompts through cmd.exe or PowerShell.
function resolveLauncher(command, environment = process.env, powerShell) {
  const file = findExecutable(command, environment);
  const dir = path.dirname(file);
  const node = () => {
    const local = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    return fsSync.existsSync(local) ? local : findExecutable("node", environment);
  };
  if (/\.(js|cjs|mjs)$/i.test(file))
    return { file: node(), args: [file] };
  if (/\.ps1$/i.test(file)) {
    const content = fsSync.readFileSync(file, "utf8");
    const script = content.match(/^\s*(?:\$input\s*\|\s*)?&\s*"?(?:\$basedir[\\/])?node(?:\$exe|\.exe)?"?\s+"\$basedir[\\/]([^"\r\n]+\.(?:js|cjs|mjs))"\s+\$args\s*$/im);
    if (script && fsSync.existsSync(path.join(dir, script[1])))
      return { file: node(), args: [path.join(dir, script[1])] };
    const bundled = content.match(/^\s*(?:\$input\s*\|\s*)?&\s*"\$basedir[\\/]([^"\r\n]+\.exe)"\s+\$args\s*$/im);
    if (bundled && fsSync.existsSync(path.join(dir, bundled[1])))
      return { file: path.join(dir, bundled[1]), args: [] };
    const direct = content.match(/^\s*(?:\$input\s*\|\s*)?&\s*"([A-Za-z]:[^"\r\n]+\.exe)"\s+\$args\s*$/im);
    if (direct && fsSync.existsSync(direct[1]))
      return { file: direct[1], args: [] };
    for (const ext of [".cmd", ".bat"]) {
      const sibling = file.replace(/\.ps1$/i, ext);
      if (fsSync.existsSync(sibling)) {
        try { return resolveLauncher(sibling, environment, powerShell); } catch {}
      }
    }
    const shell = powerShell || (() => {
      try { return findExecutable("pwsh", environment); }
      catch { return findExecutable("powershell", environment); }
    })();
    return {
      file: shell,
      args: ["-NoLogo", "-NoProfile", "-File", file],
    };
  }
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [] };
  const content = fsSync.readFileSync(file, "utf8");
  const script = content.match(/(?:^\s*@?\s*|&\s*@?\s*)"(?:%_prog%|%(?:~?dp0%?)[\\/]node(?:\.exe)?|node(?:\.exe)?)"\s+"%(?:~?dp0%?)[\\/]([^"\r\n]+\.(?:js|cjs|mjs))"\s+%\*\s*$/im);
  if (script && fsSync.existsSync(path.join(dir, script[1])))
    return {
      file: node(),
      args: [path.join(dir, script[1])],
    };
  const bundled = content.match(/^\s*@?\s*"%(?:~?dp0%?)[\\/]([^"\r\n]+\.exe)"\s+%\*\s*$/im);
  if (bundled && fsSync.existsSync(path.join(dir, bundled[1])))
    return { file: path.join(dir, bundled[1]), args: [] };
  const direct = content.match(/^\s*@?\s*"([A-Za-z]:[^"\r\n]+\.exe)"\s+%\*\s*$/im);
  if (direct && fsSync.existsSync(direct[1]))
    return { file: direct[1], args: [] };
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
  async resolveFolder(folder, remember) {
    let root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory())
      throw new Error("Choose a folder.");
    try {
      const { stdout } = await execute(
        "git",
        ["-C", root, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", env: gitEnv(), windowsHide: true },
      );
      root = await fs.realpath(stdout.trim());
    } catch {}
    this.roots.add(root);
    if (remember) {
      this.recent = [root, ...this.recent.filter((x) => x !== root)].slice(0, 12);
      await fs.writeFile(
        path.join(this.dataDir, "recent.json"),
        JSON.stringify(this.recent),
      );
    }
    return { root, name: path.basename(root), git: await this.status(root) };
  }
  open(folder) { return this.resolveFolder(folder, true); }
  inspect(folder) { return this.resolveFolder(folder, false); }
  async register(folder) {
    const root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Choose a folder.");
    this.roots.add(root);
    return { root, name: path.basename(root), git: { available: false, branch: "", files: [], ahead: 0, behind: 0, worktrees: [], log: [] } };
  }
  root(root) {
    if (this.roots.has(root)) return root;
    if (process.platform === "win32") {
      const key = gitPathKey(root);
      for (const known of this.roots) if (gitPathKey(known) === key) return known;
    }
    throw new Error("Open this workspace first.");
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
  // Repo entries (files and folders) for @ mentions in the composer. Fuzzy subsequence
  // matching on the relative path, with exact substring matches ranked first, then shorter
  // paths. One BFS pass fills the pool; the walk is capped so huge repos stay responsive.
  async mentionFiles(root, query) {
    this.root(root);
    const q = String(query || "").toLowerCase();
    const pool = [];
    let visited = 0;
    let truncated = false;
    const queue = [""];
    while (queue.length) {
      const rel = queue.shift();
      if (rel && rel.split("/").length > 12) continue;
      for (const entry of await this.tree(root, rel)) {
        if (++visited > 30000) { truncated = true; break; }
        pool.push(entry);
        if (entry.directory) queue.push(entry.path);
      }
      if (truncated) break;
    }
    const fuzzy = (path) => {
      let i = 0;
      for (const ch of path) if (ch === q[i]) i++;
      return i === q.length;
    };
    const ranked = q
      ? pool.map((entry) => ({ entry, hit: entry.path.toLowerCase().includes(q) ? 0 : fuzzy(entry.path.toLowerCase()) ? 1 : 2 })).filter((row) => row.hit < 2)
      : pool.map((entry) => ({ entry, hit: 0 }));
    ranked.sort((a, b) => a.hit - b.hit || Number(a.entry.directory) - Number(b.entry.directory) || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
    return { entries: ranked.slice(0, 40).map((row) => row.entry), truncated };
  }
  gitAt(cwd, args, options = {}) {
    const maxBuffer = options.maxBuffer || 8 * 1024 * 1024;
    return execute("git", ["-C", cwd, ...args], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      windowsHide: true,
      maxBuffer,
      timeout: 120000,
    }).then(
      ({ stdout }) => stdout,
      (error) => {
        const overflow = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(String(error.message || ""));
        if (options.partial && overflow && error.stdout) {
          const partial = new Error("Git status is too large to read in full.");
          partial.partial = String(error.stdout);
          partial.truncated = true;
          throw partial;
        }
        throw new Error(strip(error.stderr || error.message).trim());
      },
    );
  }
  async worktreeRoot(folder) {
    const registered = this.root(folder);
    try {
      const toplevel = (await this.gitAt(registered, ["rev-parse", "--show-toplevel"])).trim();
      const root = await fs.realpath(toplevel);
      this.roots.add(root);
      return root;
    } catch {
      return registered;
    }
  }
  async git(root, args) {
    return this.gitAt(await this.worktreeRoot(root), args);
  }
  async listWorktrees(cwd) {
    const raw = await this.gitAt(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const worktrees = [];
    let current;
    for (const line of raw.split("\0")) {
      const text = line.replace(/\r/g, "");
      if (!text || text === "\n") continue;
      if (text.startsWith("worktree ")) {
        current = { path: text.slice("worktree ".length), branch: "detached HEAD", detached: true, primary: true, current: false };
        worktrees.push(current);
      } else if (!current) continue;
      else if (text.startsWith("branch ")) {
        current.branch = text.slice("branch ".length).replace(/^refs\/heads\//, "");
        current.detached = false;
      } else if (text === "detached") {
        current.detached = true;
        current.branch = "detached HEAD";
      }
    }
    const here = gitPathKey(cwd);
    await Promise.all(worktrees.map(async (tree) => {
      try { tree.path = await fs.realpath(tree.path); } catch {}
      tree.primary = !(await linkedWorktree(tree.path));
      tree.current = gitPathKey(tree.path) === here;
    }));
    return worktrees;
  }
  async status(root) {
    try {
      const cwd = await this.worktreeRoot(root);
      const insideWorktree = (await this.gitAt(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
      if (insideWorktree !== "true") throw new Error("This folder is not a Git worktree.");
      let porcelain = "";
      let overflow = false;
      const [statusText, log, remote, worktrees] = await Promise.all([
        this.gitAt(cwd, ["status", "--porcelain=v2", "--branch", "-z", "-uall"], { maxBuffer: 32 * 1024 * 1024, partial: true }).catch((error) => {
          if (!error.truncated || !error.partial) throw error;
          overflow = true;
          return error.partial;
        }),
        this.gitAt(cwd, ["log", "-8", "--format=%h%x00%s%x00%an%x00%ar"]).catch(() => ""),
        this.gitAt(cwd, ["remote", "get-url", "origin"]).catch(() => ""),
        this.listWorktrees(cwd).catch(() => []),
      ]);
      porcelain = statusText;
      const parsed = parsePorcelain(porcelain, overflow);
      const here = gitPathKey(cwd);
      const otherTrees = worktrees
        .map((tree) => gitPathKey(tree.path))
        .filter((tree) => tree && tree !== here && !pathInside(here, tree));
      const files = parsed.files.filter((file) => {
        const full = gitPathKey(path.resolve(cwd, file.path));
        return !otherTrees.some((tree) => pathInside(full, tree));
      });
      return {
        available: true,
        root: cwd,
        branch: parsed.branch || (parsed.detached ? "detached HEAD" : ""),
        detached: parsed.detached,
        files,
        truncated: parsed.truncated,
        ahead: parsed.ahead,
        behind: parsed.behind,
        upstream: parsed.upstream,
        remote: remote.trim(),
        worktrees,
        log: log.trim().split("\n").filter(Boolean).map((line) => {
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
  async gitPaths(cwd, prefix, paths) {
    const batch = [];
    let size = prefix.reduce((sum, arg) => sum + arg.length + 1, 0);
    const flush = async () => {
      if (!batch.length) return;
      await this.gitAt(cwd, [...prefix, ...batch]);
      batch.length = 0;
      size = prefix.reduce((sum, arg) => sum + arg.length + 1, 0);
    };
    for (const file of paths) {
      if (batch.length && size + file.length + 1 > 24000) await flush();
      batch.push(file);
      size += file.length + 1;
    }
    await flush();
  }
  async action(root, action, payload = {}) {
    const cwd = await this.worktreeRoot(root);
    const paths = payload.paths;
    if (
      paths &&
      (!Array.isArray(paths) ||
        paths.some(
          (p) =>
            typeof p !== "string" ||
            path.isAbsolute(p) ||
            !inside(cwd, path.resolve(cwd, p)),
        ))
    )
      throw new Error("Invalid file paths.");
    if (action === "stage") {
      let targets = paths;
      if (!targets?.length) {
        const current = await this.status(cwd);
        targets = current.files.filter((file) => !file.conflict).map((file) => file.path);
      }
      if (targets.length) await this.gitPaths(cwd, ["add", "--"], targets);
    } else if (action === "unstage") {
      const hasHead = await this.gitAt(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
      await this.gitPaths(cwd, hasHead ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "--"], paths?.length ? paths : ["."]);
    } else if (action === "commit") {
      if (!payload.message?.trim()) throw new Error("Write a commit message first.");
      await this.gitAt(cwd, ["commit", "-m", payload.message]);
    } else if (action === "pull") await this.gitAt(cwd, ["pull", "--ff-only"]);
    else if (action === "fetch") await this.gitAt(cwd, ["fetch", "--all", "--prune"]);
    else if (action === "push") {
      const status = await this.status(cwd);
      if (!status.branch || status.branch === "detached HEAD")
        throw new Error("Create a branch before pushing.");
      if (status.upstream) await this.gitAt(cwd, ["push"]);
      else {
        const remotes = (await this.gitAt(cwd, ["remote"])).trim().split("\n").filter(Boolean);
        const name = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
        if (!name) throw new Error("Add an origin remote before pushing.");
        await this.gitAt(cwd, ["push", "--set-upstream", name, status.branch]);
      }
    } else throw new Error("Unknown Git action.");
    return this.status(cwd);
  }
  async diff(root, file, staged, original) {
    const cwd = await this.worktreeRoot(root);
    const valid = (value) => typeof value === "string" && !!value && !path.isAbsolute(value) && inside(cwd, path.resolve(cwd, value));
    if (!valid(file)) throw new Error("Invalid file path.");
    const spec = valid(original) ? [file, original] : [file];
    const output = await this.gitAt(cwd, ["diff", "-M", "--no-ext-diff", ...(staged ? ["--cached"] : []), "--", ...spec]);
    if (output) return output;
    const status = await this.status(cwd);
    const entry = status.files.find((item) => item.path === file);
    if (entry?.untracked) return `New file: ${file}\n\n${(await this.read(cwd, file)).content}`;
    return "No changes in this view.";
  }
  async worktree(root, branch, base) {
    if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-"))
      throw new Error("Enter a branch name.");
    const cwd = await this.worktreeRoot(root);
    await this.gitAt(cwd, ["check-ref-format", "--branch", branch]);
    const ref = typeof base === "string" && base.trim() ? base.trim() : "HEAD";
    if (ref.startsWith("-")) throw new Error("Invalid base reference.");
    await this.gitAt(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const trees = await this.listWorktrees(cwd).catch(() => []);
    const primary = trees.find((tree) => tree.primary)?.path || cwd;
    const folder = path.join(
      path.dirname(primary),
      `${path.basename(primary)}.worktrees`,
      branch.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    );
    await this.gitAt(cwd, ["worktree", "add", "-b", branch, folder, ref]);
    return this.open(folder);
  }
  async prs(root) {
    const cwd = await this.worktreeRoot(root);
    const { stdout } = await execute(
      "gh",
      ["pr", "list", "--limit", "15", "--json", "number,title,url,state,isDraft,headRefName"],
      { cwd, encoding: "utf8", env: gitEnv(), windowsHide: true, timeout: 20000 },
    );
    return JSON.parse(stdout);
  }
}

class Sessions {
  constructor(workspaces, dataDir, emit, accounts = null, recovery = null, attachments = null, modelCache = null) {
    this.workspaces = workspaces;
    this.dataDir = dataDir;
    this.emit = emit;
    this.sessions = new Map();
    this.accounts = accounts;
    this.recovery = recovery;
    this.attachments = attachments;
    this.modelCache = modelCache;
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
    loadShellProfile = true,
    shellCommand = "",
    savedTab = {},
  }) {
    if (
      !["shell", "pi", "codex", "claude", "grok", "google"].includes(agent) ||
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
    if (workMode && (!["claude", "grok", "codex", "google"].includes(agent) || !["plan", "default"].includes(workMode))) throw new Error("Invalid planning mode.");
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
    if ([...this.sessions.values()].some((session) => session.controlId === controlId)) throw new Error("This saved chat is already open.");
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
      if (!fsSync.statSync(cwd).isDirectory()) throw new Error("Working folder is unavailable.");
    }
    if (agent === "google") effort = require("./google.cjs").variant(model).effort;
    const s = {
      id,
      root,
      cwd: cwd || (projectless && agent === "shell" ? os.homedir() : root),
      projectless,
      agent,
      mode,
      command: command || (agent === "google" ? "agy" : agent),
      shellCommand: agent === "shell" ? (command === "shell" ? "" : command || shellCommand) : shellCommand,
      loadShellProfile: loadShellProfile !== false,
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
      scratchId,
      sessionStarted: !!sessionRef,
      savedTab,
      piSessionHeader: savedTab.piSessionHeader,
      contextTokens: Number.isFinite(savedTab.contextTokens) && savedTab.contextTokens >= 0 ? savedTab.contextTokens : null,
      contextWindow: Number.isFinite(savedTab.contextWindow) && savedTab.contextWindow > 0 ? savedTab.contextWindow : null,
    };
    s.messageQueue = new MessageQueue(this, s, queuedMessages);
    this.sessions.set(id, s);
    this.recovery?.bind(s, savedTab);
    return { id, agent, mode, root, cwd: s.cwd, projectless, scratchId, model, effort, workMode, controlId, contextTokens: s.contextTokens, contextWindow: s.contextWindow, ...controls, accountId: s.accountId, accountName: s.accountName, ...s.messageQueue.state() };
  }
  async sessionControls(id) {
    const s = this.get(id);
    if (s.agent === "shell") throw new Error("Choose an agent to use MCP and context controls.");
    if (s.agent === "google") throw new Error("Antigravity manages MCPs and automatic compaction in its CLI. Use Settings → Agents for its configuration and native controls.");
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
      if (change.compact === true) {
        // Claude compacts through its own /compact prompt turn; see Conversation's /compact.
        if (s.agent === "claude" || s.agent === "google") throw new Error("Use /compact in this chat to compact with the CLI's own summary.");
        if (s.agent === "pi") {
          this.event(s, { type: "phase", phase: "compacting" });
          try { await this.piBridge(s, "compact", {}); } catch (error) { this.event(s, { type: "phase", phase: undefined }); throw error; }
        } else await (await ensureRuntime(this, s)).compactNow();
        return await this.readControls(s);
      }
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
    if (s.agent === "codex") {
      if (s.pty) throw new Error("Exit Codex's native CLI before changing MCP or compaction settings. Its shared runtime will keep running.");
      if ((await s.runtime?.request("thread/backgroundTerminals/list", { threadId: s.sessionRef }))?.data?.length) throw new Error("Background terminals are still running. Finish them before changing these settings.");
      s.codexReconfigure = true; return;
    }
    await this.releaseRuntime(s);
  }
  async piMcp(s, name) {
    if (name !== undefined) throw new Error("This Pi MCP manager uses native widgets. Open /mcp in the terminal to change its connections.");
    return { servers: [], warning: "Open Pi’s MCP manager below to inspect or change connections in Readable." };
  }
  async ensurePiPolicy(s) {
    await this.ensurePi(s);
    if (s.piPolicyReady) return;
    if (s.autoCompactTokens) await this.piBridge(s, "autocompact", { tokens: s.autoCompactTokens });

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
    const shared = await sharedPrompts.commands();
    const withShared = (result) => ({ ...result, commands: sharedPrompts.merge(shared, result.commands) });
    if (s.agent === "google") return withShared({ commands: [], origin: "Shared prompts and Antigravity CLI" });
    if (s.discoveryPromise) return s.discoveryPromise;
    if (!refresh && s.commands && Date.now() - s.commandsAt < 60000) return withShared(s.commands);
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode === "native") {
      if (s.commands) return withShared(s.commands);
      if (shared.length) return withShared({ commands: [], origin: "Shared prompts" });
      throw new Error("Finish this turn or return to readable view to discover commands.");
    }
    s.discoveryPromise = (async () => {
      let result;
      await this.prepareLaunch(s);
      if (s.agent === "pi") {
        await this.ensurePi(s);
        // Query the actual persistent session, including extensions reloaded there.
        const data = await this.piRpc(s, "get_commands");
        result = { commands: normalize(data.commands, "pi"), origin: "Pi terminal bridge" };
      } else {
        if (s.agent === "claude") await claudeHome(this, s);
        if (s.agent === "grok") await grokHome(this, s);
        result = await discoverCommands(s, (args) => profiledLaunch(s, args, resolveLauncher), (child) => this.kill(child));
      }
      if (!this.sessions.has(id) || s.stopping || s.transitioning) throw new Error("Command discovery was canceled.");
      if (result.contextUsage) {
        const hasExistingHistory = !!s.sessionStarted || !!s.savedTab?.messages?.some((m) => m.role === "user");
        this.event(s, {
          type: "context",
          contextTokens: s.contextTokens !== null || hasExistingHistory ? s.contextTokens : result.contextUsage.contextTokens,
          contextWindow: result.contextUsage.contextWindow ?? s.contextWindow,
        });
      }
      s.commands = result;
      s.commandsAt = Date.now();
      return withShared(result);
    })();
    try { return await s.discoveryPromise; }
    catch (error) {
      if (shared.length) return withShared({ commands: [], origin: "Shared prompts", warning: `Native command discovery failed: ${error.message}` });
      throw error;
    }
    finally { s.discoveryPromise = null; }
  }
  async cancelDiscovery(s) {
    this.rejectPiCommands(s, "Command discovery was canceled.");
    if (s.discoveryChild) await this.kill(s.discoveryChild, true);
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
  async ensurePi(s) {
    if (this.accounts?.signingIn(s)) throw new Error("Finish Pi's sign-in, then retry your message.");
    if (s.piClosing) await s.piClosing;
    if (s.piStarting) return s.piStarting;
    if (s.piNativeBridge && (s.pty || s.piRpcProcess)) return;
    s.piStarting = (async () => {
      await this.prepareLaunch(s);
      if (!s.sessionRef) {
        const folder = path.join(this.dataDir, "pi"); await fs.mkdir(folder, { recursive: true });
        s.sessionRef = path.join(folder, `lumen-${uuid()}.jsonl`);
        await fs.writeFile(s.sessionRef, "", { flag: "wx", mode: 0o600 });
        this.event(s, { type: "session", sessionRef: s.sessionRef });
      } else await fs.access(s.sessionRef).catch(async () => {
        const saved = this.recovery?.state.tabs.find((tab) => tab.controlId === s.controlId) || s.savedTab;
        if (!s.piSessionHeader || saved?.messages?.some((message) => message.role === "user")) throw new Error("Pi's saved session file is unavailable. This chat has been retained.");
        await fs.writeFile(s.sessionRef, JSON.stringify(s.piSessionHeader) + "\n", { flag: "wx", mode: 0o600 });
      });
      let readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      // Bridge setup can fail before we reach the readiness await.
      void ready.catch(() => {});
      const timer = setTimeout(() => readyReject(new Error("Pi's terminal bridge did not initialize. Open its terminal to finish startup or project trust.")), 30000);
      s.piBridgeState = "starting";
      try {
        const bridge = await require("./local-bridge.cjs").localBridge((event) => {
          if (s.piNativeBridge !== bridge) return;
          if (event.type === "bridge_ready") { s.piBridgeState = "ready"; s.sessionRef = event.sessionFile || s.sessionRef; s.piSessionHeader = event.sessionHeader; s.sessionStarted = true; this.event(s, { type: "session", sessionRef: s.sessionRef, piSessionHeader: s.piSessionHeader }); readyResolve(event); }
          if (event.type === "bridge_closed") {
            this.failPiBridge(s, "Pi's terminal bridge disconnected. Retry to reconnect its saved session.");
            if (!s.stopping && s.pty) this.event(s, { type: "terminal-needed", title: "Pi terminal bridge disconnected" });
            readyReject(new Error("Pi's terminal bridge disconnected. Open its terminal to continue."));
            return;
          }
          if (event.type === "agent_ui_cancel") { s.piDialogs?.delete(event.id); this.event(s, { type: "agent_ui_cancel", request: { id: event.id } }); return; }
          if (event.type === "native_command") { s.messageQueue?.pause(); this.event(s, { type: "terminal-needed", title: "Pi command", nativeDraft: event.text }); this.finish(s, 0); return; }
          // Readable custom controls are handled by the bridge, without opening a terminal panel.
          if (event.type === "extension_ui_request" && event.method === "setWidget" && event.native) {
            if (s.piRpcProcess) { s.piCommandFailed = true; this.event(s, { type: "error", message: "This command uses a custom Pi terminal widget. Select Native CLI explicitly, then rerun the command there." }); }
            else this.event(s, { type: "terminal-needed", title: "Pi custom widget" });
          }
          if (event.type === "agent_start" && !s.busy) { s.busy = true; s.turn = uuid(); this.event(s, { type: "start", turn: s.turn }); }
          this.piEvent(s, event);
        });
        s.piNativeBridge = bridge;
        const args = ["--session-dir", path.join(this.dataDir, "pi"), ...cliOptions(s), "--extension", this.piExtension()];
        if (s.sessionRef) args.push("--session", s.sessionRef);
        const env = {
          LUMEN_PI_BRIDGE: s.piNativeBridge.endpoint, LUMEN_PI_BRIDGE_TOKEN: s.piNativeBridge.token,
          LUMEN_PI_VIEW: s.mode,
          LUMEN_RPC_CONTROLS: "1", LUMEN_AUTO_COMPACT_TOKENS: String(s.autoCompactTokens || ""), LUMEN_COMPACT_STATE_FILE: this.compactStateFile(s),
        };
        if (s.mode === "rich") {
          s.piRpcProcess = this.child(s, ["--mode", "rpc", ...args], env);
          const child = s.piRpcProcess;
          let startupError = "";
          child.stderr.on("data", (text) => { startupError = (startupError + strip(text)).slice(-2000); });
          child.once("error", (error) => readyReject(error));
          this.jsonStream(s, child, (event) => { if (s.process === child) this.piEvent(s, event); });
          child.once("close", () => {
            if (s.piRpcProcess !== child) return;
            readyReject(new Error(startupError.trim() || `Pi exited before its bridge was ready (${child.exitCode ?? "unknown"}).`));
            s.piRpcProcess = null; s.process = null;
            s.piNativeBridge?.close(); s.piNativeBridge = null;
            this.rejectPiCommands(s, "Pi session closed.");
            this.finish(s, child.exitCode ?? 130);
          });
        } else this.spawnTerminal(s, profiledLaunch(s, [...args, ...extraOptions(s)], resolveLauncher), env);
        const state = await ready;
        this.piEvent(s, { type: "response", command: "get_state", success: true, data: state });
      } catch (error) {
        if (s.piRpcProcess) {
          const child = s.piRpcProcess; s.piRpcProcess = null; s.process = null;
          s.piNativeBridge?.close(); s.piNativeBridge = null;
          await this.kill(child, true);
        }
        if (!s.pty && !s.piRpcProcess) { s.piNativeBridge?.close(); s.piNativeBridge = null; }
        s.piBridgeState = "failed";
        if (!s.stopping && s.pty) this.event(s, { type: "terminal-needed", title: "Pi startup needs attention" });
        throw error;
      } finally { clearTimeout(timer); }
    })();
    try { return await s.piStarting; } finally { s.piStarting = null; }
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
  async piRpc(s, type, data = {}) {
    if (s.stopping || s.transitioning || !this.sessions.has(s.id)) throw new Error("Pi controls were canceled.");
    await this.ensurePi(s);
    const id = uuid();
    if (s.piRpcProcess && type === "prompt") await this.piRpc(s, "track_prompt", { ...data, deliveryId: id });
    return new Promise((resolve, reject) => {
      s.piRequests ||= new Map();
      const timer = setTimeout(() => { s.piRequests.delete(id); reject(new Error("Pi did not finish this control.")); }, type === "prompt" ? 24 * 60 * 60 * 1000 : 30000);
      s.piRequests.set(id, { resolve, reject, timer });
      const failed = (error) => {
        if (type === "prompt") this.writePiBridge(s, { id: uuid(), type: "prompt_preflight", deliveryId: id, failed: true });
        clearTimeout(timer); s.piRequests.delete(id); reject(error);
      };
      try {
        if (s.piRpcProcess && ["prompt", "steer"].includes(type)) {
          if (type === "prompt") { s.piPromptId = id; s.piSlashPrompt = data.message?.trimStart().startsWith("/"); }
          s.piRpcProcess.stdin.write(JSON.stringify({ id: type === "prompt" ? `preflight:${id}` : id, type, ...data, message: s.piSlashPrompt && type === "prompt" ? data.message.trimStart() : data.message }) + "\n", (error) => {
            if (error) failed(error);
          });
        } else this.writePiBridge(s, { id, type, ...data });
      }
      catch (error) { failed(error); }
    });
  }
  async piBridge(s, action, data = {}) {
    await this.ensurePi(s);
    const id = uuid();
    const result = new Promise((resolve, reject) => {
      s.piRequests ||= new Map();
      const timer = setTimeout(() => { s.piRequests.delete(id); reject(new Error("Pi's Lumen controls did not respond.")); }, 30000);
      s.piRequests.set(id, { resolve, reject, timer });
    });
    const ack = this.piRpc(s, "controls", { action, data: { ...data, id, action } });
    try { const [info] = await Promise.all([result, ack]); return info; }
    finally { const pending = s.piRequests.get(id); if (pending) { clearTimeout(pending.timer); s.piRequests.delete(id); pending.reject(new Error("Pi control canceled.")); } }
  }
  async models(id, refresh = false) {
    const s = this.get(id);
    if (this.accounts?.signingIn(s)) throw new Error("Finish sign-in before refreshing models.");
    if (s.agent === "shell") throw new Error("Choose an agent to use model controls.");
    if (!refresh && s.catalogCached && s.catalog) return s.catalog;
    if (!refresh && !s.catalog) {
      const cached = this.modelCache?.read(s);
      if (cached) {
        const fresh = s.agent === "google" && Date.now() - cached.at < 60000;
        s.catalog = { ...cached.value, warning: fresh ? undefined : "Using saved models. Checking the CLI for updates…" };
        s.catalogCached = !fresh; s.catalogAt = cached.at;
        // Let the renderer paint the saved list before spawning a potentially slow CLI.
        if (!fresh) s.catalogWarmTimer = setTimeout(() => {
          if (!this.sessions.has(id) || s.stopping) return;
          void this.models(id, true).catch((error) => {
            if (!this.sessions.has(id) || s.stopping) return;
            s.catalog = { ...s.catalog, warning: "Using saved models. " + error.message };
            this.emit({ id, type: "models", catalog: s.catalog });
          });
        }, 100);
        return s.catalog;
      }
    }
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
      } else if (s.agent === "google") {
        await this.prepareLaunch(s);
        try { info = await require("./google.cjs").modelCatalog(s, profiledLaunch(s, ["models"], resolveLauncher), (child) => this.kill(child, true)); }
        catch (error) {
          if (!s.catalog) throw error;
          info = { ...s.catalog, warning: "Using the last available model list. " + error.message };
        }
        s.effort = info.currentEffort;
        this.event(s, { type: "config", model: s.model, effort: s.effort, workMode: s.workMode });
      } else if (s.agent === "codex") {
        const runtime = await ensureRuntime(this, s);
        info = catalog("codex", (await runtime.request("model/list")).data, { currentModel: s.model, currentEffort: s.effort, currentMode: s.workMode });
      } else info = (await this.commands(id, refresh)).catalog;
      if (!info || !this.sessions.has(id) || s.stopping || s.transitioning) throw new Error("Model discovery was canceled.");
      s.catalog = info; s.catalogAt = Date.now(); s.catalogCached = !!info.warning;
      if (!info.warning) this.modelCache?.remember(s, info);
      this.emit({ id, type: "models", catalog: info });
      return info;
    })();
    try { return await s.catalogPromise; } finally { s.catalogPromise = null; }
  }
  async configure(id, change) {
    const s = this.get(id);
    const previousModel = s.model;
    if (s.busy || s.stopping || s.transitioning || s.setting || s.mode !== "rich") throw new Error("Finish this turn before changing its controls.");
    const info = await this.models(id, !!s.catalogCached && s.agent !== "google");
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
        if (s.agent === "google" && change.effort && !info.models.find((m) => m.id === (change.model ?? s.model))?.efforts.some((e) => e.id === change.effort))
          throw new Error("This effort level is not supported by the selected model.");
        if (change.model !== undefined) {
          const model = info.models.find((m) => m.id === change.model);
          if (!model) throw new Error("This model is no longer available. Refresh the picker.");
          if (s.agent === "pi") await this.piBridge(s, "select", { model: model.id });
          s.model = model.id;
          if (s.agent === "google" || s.agent !== "pi" && !model.efforts.some((e) => e.id === s.effort)) s.effort = model.defaultEffort || "";
        }
        if (change.effort !== undefined) {
          const levels = s.agent === "pi" ? efforts((await this.piRpc(s, "get_available_thinking_levels")).levels) :
            info.models.find((m) => m.id === (s.model || info.currentModel))?.efforts || [];
          if (change.effort !== "" && !levels.some((e) => e.id === change.effort)) throw new Error("This effort level is not supported by the selected model.");
          if (s.agent === "pi") {
            if (!change.effort) throw new Error("Choose a thinking level for Pi.");
            await this.piRpc(s, "set_thinking_level", { level: change.effort });
          }
          if (s.agent === "google") {
            if (change.effort) s.model = levels.find((e) => e.id === change.effort).modelId;
            s.effort = info.models.find((m) => m.id === s.model)?.defaultEffort || "";
          } else s.effort = change.effort;
        }
        if (change.workMode !== undefined) {
          if (!["claude", "grok", "codex", "google"].includes(s.agent) || !["plan", "default"].includes(change.workMode)) throw new Error("Use this agent's native planning workflow.");
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
      if (s.agent !== "pi" && s.model !== previousModel) {
        if (s.runtime) s.runtime.contextWindow = null;
        this.event(s, { type: "context", contextTokens: s.contextTokens, contextWindow: null, resetContextWindow: true });
      }
      if (s.agent === "codex" && s.runtime) {
        const model = s.model || info.currentModel || info.models[0]?.id;
        await s.runtime.request("thread/settings/update", { threadId: s.sessionRef, ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}),
          ...(s.workMode ? { collaborationMode: { mode: s.workMode, settings: { model, reasoning_effort: s.effort || null, developer_instructions: null } } } : {}) });
        if (s.model !== previousModel) await s.runtime.contextUsage().catch(() => {});
      } else if (s.agent !== "pi" && s.runtime) await this.resetRuntime(s);
      if (["claude", "grok"].includes(s.agent) && s.model !== previousModel) {
        void ensureRuntime(this, s).catch(() => {});
      }
      this.event(s, { type: "config", model: s.model, effort: s.effort, workMode: s.workMode });
      return { model: s.model, effort: s.effort, workMode: s.workMode, catalog: s.catalog };
    } finally { s.setting = false; }
  }
  event(s, event) {
    if (event.type === "history") {
      const saved = this.recovery?.state.tabs.find((tab) => tab.controlId === s.controlId)?.messages || s.savedTab?.messages;
      event = { ...event, messages: require("./session-history.cjs").preserveAttachments(event.messages, saved) };
    }
    if (event.type === "context") {
      s.contextTokens = Number.isFinite(event.contextTokens) && event.contextTokens >= 0 ? event.contextTokens : null;
      if (Object.hasOwn(event, "contextWindow") && ((Number.isFinite(event.contextWindow) && event.contextWindow > 0) || event.resetContextWindow))
        s.contextWindow = Number.isFinite(event.contextWindow) && event.contextWindow > 0 ? event.contextWindow : null;
      event = { ...event, contextTokens: s.contextTokens, contextWindow: s.contextWindow ?? null };
    }
    this.recovery?.event(s, event);
    this.emit({ id: s.id, ...event });
  }
  prepareLaunch(s) {
    return s.launchPreparation ||= prepareProfile(s, this.dataDir, findExecutable, resolveLauncher).finally(() => { s.launchPreparation = null; });
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
    await this.prepareLaunch(s);
    if (s.agent === "pi") { await this.ensurePi(s); return; }
    let launch, sessionEnv = {};
    if (s.agent === "google") {
      if (!s.sessionRef) throw new Error("Send a message in Readable first so Google can open the same saved conversation in Native CLI. Use the account picker to sign in.");
      launch = profiledLaunch(s, ["--conversation", s.sessionRef, ...cliOptions(s), ...extraOptions(s)], resolveLauncher);
      s.nativeOwned = true; this.spawnTerminal(s, launch); return;
    }
    if (s.agent === "shell") {
      const shell = s.shellExecutable || s.shellCommand || (process.platform === "win32" ? findExecutable("powershell") : process.env.SHELL || "/bin/bash");
      launch = { file: shell, args: [...s.extraArgs] };
      if (process.platform === "win32" && s.powerShell) {
        launch.args.unshift("-NoLogo", ...(s.loadShellProfile ? [] : ["-NoProfile"]), "-NoExit", "-EncodedCommand",
          Buffer.from(`$global:lumenPromptBlock=(Get-Item function:prompt).ScriptBlock; function global:prompt { [Console]::Write([char]27+']9;9;"'+(Get-Location).Path+'"'+[char]7); & $global:lumenPromptBlock }`, "utf16le").toString("base64"));
      } else if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) {
        s.cmdShell = true;
        launch.args.unshift("/Q", "/K", 'prompt $E]9;9;"$P"\x07$P$G ');
      }
    } else {
      if (s.agent === "codex") {
        const runtime = await ensureRuntime(this, s);
        if (!runtime.remoteAddress) throw new Error("This Codex version cannot share its terminal runtime. Update Codex to use Native CLI without restarting the conversation.");
        sessionEnv = { LUMEN_CODEX_REMOTE_TOKEN: runtime.remoteToken };
        launch = profiledLaunch(s, ["resume", s.sessionRef, "--remote", runtime.remoteAddress, "--remote-auth-token-env", "LUMEN_CODEX_REMOTE_TOKEN", ...cliOptions(s), ...extraOptions(s)], resolveLauncher);
      } else {
        if (s.agent === "grok") sessionEnv.GROK_HOME = await grokHome(this, s);
        if (s.agent === "claude") sessionEnv.CLAUDE_CONFIG_DIR = await claudeHome(this, s);
        await syncNativeMcp(s);
        if (!s.sessionRef) { s.sessionRef = uuid(); this.event(s, { type: "session", sessionRef: s.sessionRef }); }
        const history = await require("./session-history.cjs").readHistory(s);
        // Claude needs at least one message: an empty transcript is exactly what "No conversation
        // found" looks like. Grok keeps the whole conversation behind its file, so any history is
        // resumable and an empty message list must not throw away its session.
        const resumable = s.agent === "claude" ? !!history?.messages.length : !!history;
        // A missing transcript used to block this chat forever. Start a fresh conversation in
        // the same chat instead and say so, so the terminal is usable again.
        if (!resumable && s.sessionStarted)
          this.event(s, { type: "diagnostic", title: "Started a fresh conversation", text: "Claude no longer had this chat's saved conversation, so the terminal starts a new one. Your earlier messages stay in the chat view." });
        s.sessionStarted = resumable;
        if (Number.isFinite(history?.contextTokens) && history.contextTokens >= 0) this.event(s, { type: "context", contextTokens: history.contextTokens });
        launch = profiledLaunch(s, [s.sessionStarted ? "--resume" : "--session-id", s.sessionRef, ...cliOptions(s), ...extraOptions(s), ...launchOptions(s)], resolveLauncher);
        s.nativeOwned = true;
      }
    }
    if (s.stopping || !this.sessions.has(id)) throw new Error("This terminal was closed before it finished starting.");
    this.spawnTerminal(s, launch, sessionEnv);
  }
  spawnTerminal(s, launch, sessionEnv = {}) {
    const pty = require("node-pty");
    s.terminalState ||= new TerminalState(100, 30, (data) => s.pty?.write(data));
    const terminal = pty.spawn(launch.file, launch.args, {
      name: "xterm-256color", cwd: s.cwd || s.root, cols: 100, rows: 30,
      useConptyDll: process.platform === "win32",
      env: { ...accountEnvironment(s, s.profileEnvironment || process.env), TERM: "xterm-256color", COLORTERM: "truecolor", ...sessionEnv },
    });
    s.pty = terminal;
    if (s.agent === "claude") {
      clearInterval(s.nativeHistoryTimer);
      s.nativeHistoryTimer = setInterval(() => void this.importNativeHistory(s).catch(() => {}), 2000);
      s.nativeHistoryTimer.unref();
    }
    this.event(s, { type: "terminal-ready" });
    terminal.onData((data) => {
      if (s.pty !== terminal) return;
      s.cwdOscBuffer = (s.cwdOscBuffer || "") + data;
      const osc = /\x1b\](?:9;9;([^\x07\x1b]*)|7;([^\x07\x1b]*))(?:\x07|\x1b\\)/g;
      let match;
      while ((match = osc.exec(s.cwdOscBuffer))) {
        try {
          const cwd = match[1] ? match[1].replace(/^"|"$/g, "") : decodeURIComponent(new URL(match[2]).pathname).replace(/^\/([A-Za-z]:)/, "$1");
          if (path.isAbsolute(cwd)) { s.cwd = cwd; this.event(s, { type: "cwd", cwd }); }
          if (s.stopRequested && s.agent === "shell") this.finish(s, 130);
        } catch {}
      }
      const lastEscape = s.cwdOscBuffer.lastIndexOf("\x1b]");
      s.cwdOscBuffer = lastEscape >= 0 && !/(?:\x07|\x1b\\)/.test(s.cwdOscBuffer.slice(lastEscape)) ? s.cwdOscBuffer.slice(lastEscape).slice(-10000) : "";
      if (s.agent === "shell") this.shellOutput(s, data);
      s.output = (s.output + data).slice(-500000);
      s.terminalState.write(data, (chunk) => this.event(s, { type: "terminal", ...chunk }));
      // Pi's readable bridge keeps its TUI running; alternate-screen output
      // alone does not mean it needs input. Its bridge reports native prompts.
      if ((s.agent !== "pi" || !["starting", "ready"].includes(s.piBridgeState)) && /\x1b\[\?(?:1049|1047|47)h/.test(data)) this.event(s, { type: "terminal-needed", title: "Interactive terminal" });
    });
    terminal.onExit(({ exitCode }) => {
      if (s.pty !== terminal) return;
      s.pty = null;
      clearInterval(s.nativeHistoryTimer); s.nativeHistoryTimer = null;
      s.piBridgeState = "disconnected";
      s.piNativeBridge?.close(); s.piNativeBridge = null;
      this.event(s, { type: "exit", code: exitCode });
      if (s.nativeOwned) {
        s.nativeOwned = false; clearInterval(s.nativeHistoryTimer);
        this.event(s, { type: "native-owner", nativeOwned: false });
        void this.importNativeHistory(s).then(() => s.mode === "rich" && !s.stopping ? this.reconnect(s.id) : undefined).catch((error) => this.event(s, { type: "error", message: error.message }));
      }
      if (s.busy && s.agent !== "codex") this.finish(s, exitCode || 130);
    });
    return terminal;
  }
  write(id, data, terminalId) {
    const s = this.get(id);
    if (typeof data !== "string" || data.length > 2 * 1024 * 1024) throw new Error("Invalid terminal input.");
    if (terminalId) { const item = s.toolTerminals?.get(terminalId); if (!item || item.exitStatus) throw new Error("This tool terminal has exited."); item.pty.write(data); return; }
    if (!s.pty) throw new Error("Terminal has exited. Start a new terminal.");
    s.pty.write(data);
  }
  resize(id, cols, rows, terminalId) {
    const s = this.get(id);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error("Invalid terminal size.");
    if (terminalId) { const item = s.toolTerminals?.get(terminalId); if (item && !item.exitStatus) { item.state.resize(Math.max(20, Math.min(500, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows)))); item.pty.resize(Math.max(20, Math.min(500, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows)))); } return; }
    if (s.pty) {
      s.terminalState?.resize(Math.max(20, Math.min(500, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows))));
      s.pty.resize(
        Math.max(20, Math.min(500, Math.floor(cols))),
        Math.max(5, Math.min(200, Math.floor(rows))),
      );
    }
  }
  terminalBuffer(id, terminalId) {
    const s = this.get(id);
    if (terminalId) { const item = s.toolTerminals?.get(terminalId); if (!item) throw new Error("This tool terminal has been released."); return item.state.snapshot(); }
    return s.terminalState ? s.terminalState.snapshot() : { data: s.output || "", offset: 0 };
  }
  async send(id, prompt, queuedMessage) {
    const s = this.get(id);
    if (s.stopping || s.stopRequested || s.transitioning || s.setting || (s.catalogPromise && s.agent !== "google"))
      throw new Error(
        "This session is stopping. Wait a moment before continuing.",
      );
    if (s.busy)
      throw new Error("Wait for this turn to finish or stop it first.");
    if (typeof prompt !== "string" || (!prompt.trim() && !queuedMessage?.attachments?.length) || prompt.length > 200000)
      throw new Error("Enter a message under 200,000 characters.");
    if (s.mode === "native")
      throw new Error("Type directly into the terminal.");
    if (s.nativeOwned && s.pty) throw new Error("The native CLI still owns this conversation. Exit it when ready; Readable will reconnect to the same saved session.");
    await this.validateMessage(s, queuedMessage || { text: prompt });
    s.busy = true;
    s.phase = undefined;
    s.activeTools = new Set();
    s.turn = uuid();
    s.hadText = false;
    s.messageStreams = new Map();
    s.piRunActive = false;
    s.piCompletionStateId = undefined;
    s.piPromptId = undefined;
    s.piCommandFailed = false;
    this.event(s, { type: "start", turn: s.turn });
    this.event(s, { type: "user-message", messageId: queuedMessage?.id || uuid(), text: prompt, attachments: queuedMessage?.attachments || [], delivery: "send", deliveryState: "sending" });
    try {
      if (s.agent === "shell") await this.shellTurn(s, prompt);
      else await this.agentTurn(s, await sharedPrompts.expand(prompt), queuedMessage);
      if (queuedMessage) this.event(s, { type: "message-delivered", messageId: queuedMessage.id });
    } catch (error) {
      if (queuedMessage) this.event(s, { type: "user-message-retracted", messageId: queuedMessage.id });
      this.event(s, { type: "error", message: error.message });
      this.finish(s, 1);
      throw error;
    }
  }
  finish(s, code = 0) {
    if (s.stopping) return;
    if (!s.busy) return;
    if (s.stopRequested && code === 0) code = 130;
    clearTimeout(s.progressTimer);
    s.busy = false;
    s.phase = undefined;
    s.stopRequested = false;
    clearTimeout(s.stopTimer);
    this.event(s, { type: "stop-state", stopping: false, forceStopAvailable: false });
    this.event(s, { type: "done", code, sessionRef: s.sessionRef });
    s.messageQueue?.finish(code);
    if (s.pendingMode) { const mode = s.pendingMode; s.pendingMode = null; void this.setMode(s.id, mode).then((value) => this.event(s, { type: "view", ...value }), (error) => this.event(s, { type: "diagnostic", text: error.message })); }
  }
  async validateMessage(s, message) {
    if (s.nativeOwned && s.pty) throw new Error("Exit the native CLI when ready to reconnect this conversation in Readable.");
    if (!message.attachments?.length) return;
    if (!this.attachments) throw new Error("Image attachments are unavailable.");
    if (s.agent === "pi") { await this.piRpc(s, "validate_images"); await this.attachments.resolve(s.controlId, message.attachments); }
    else if (s.agent === "shell") throw new Error("Use an agent chat for image attachments.");
    else if (s.agent === "google") await this.attachments.resolve(s.controlId, message.attachments);
    else await (await ensureRuntime(this, s)).validateImages(message.attachments);
  }
  submit(id, message) { return this.get(id).messageQueue.submit(message); }
  queueAction(id, messageId, action) { return this.get(id).messageQueue.action(messageId, action); }
  async steer(s, message) {
    if (!s.busy || s.mode !== "rich" || s.stopping || s.transitioning || s.setting || s.phase === "compacting") throw new Error("This turn cannot accept steering right now.");
    if (s.agent === "google") throw new Error("Google accepts follow-ups through the queue after this turn finishes.");
    if (message.text.trimStart().startsWith("/") || (s.agent === "codex" && message.text.trimStart().startsWith("$"))) throw new Error("Steer with a normal message. Run CLI commands after this turn finishes.");
    if (s.agent === "pi") { const images = (await this.attachments.resolve(s.controlId, message.attachments || [])).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })); await this.piRpc(s, "steer", { message: message.text, clientId: message.id, images }); }
    else { if (!s.runtime || s.runtime.closed) throw new Error("The CLI is still starting or closing."); await s.runtime.steer(message); }
  }
  grokPhase(s, phase) {
    if (s.agent !== "grok" || !s.busy || s.stopping || s.phase === phase) return;
    s.phase = phase;
    this.event(s, { type: "phase", phase });
  }
  child(s, args, env = {}) {
    const launch = profiledLaunch(s, [...args, ...extraOptions(s)], resolveLauncher);
    const child = spawn(
      launch.file,
      launch.args,
      {
        cwd: s.cwd || s.root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...accountEnvironment(s, s.profileEnvironment || process.env), NO_COLOR: "1", ...env },
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
    child.stderr.on("data", (data) => {
      if (s.agent === "pi" && !s.busy) return;
      this.event(s, { type: "diagnostic", text: strip(data).slice(-10000) });
    });
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
    await this.startNative(s.id);
    s.marker = uuid().replace(/-/g, "");
    s.shellCapture = { buffer: "", started: false };
    if (process.platform === "win32" && s.powerShell) {
      const payload = Buffer.from(prompt, "utf8").toString("base64");
      const wrapper = `[Console]::Write([char]27+']633;LumenBegin;${s.marker}'+[char]7); $global:LASTEXITCODE=0; try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))); $lumenOK=$?; $lumenCode=if($lumenOK){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1} } catch { Write-Output $_; $lumenCode=1 }; [Console]::Write([char]27+']633;LumenEnd;${s.marker};'+$lumenCode+';'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))+[char]7)\r`;
      s.pty.write(wrapper);
    } else if (s.cmdShell) {
      s.pty.write(`echo \x1b]633;LumenBegin;${s.marker}\x07\r${prompt}\recho \x1b]633;LumenEnd;${s.marker};%ERRORLEVEL%;raw:%CD%\x07\r`);
    } else {
      s.pty.write(String.raw`printf '\033]633;LumenBegin;${s.marker}\007'; eval "$(printf %s '${Buffer.from(prompt).toString("base64")}' | base64 -d)"; lumen_code=$?; printf '\033]633;LumenEnd;${s.marker};%s;%s\007' "$lumen_code" "$(pwd | base64 | tr -d '\n')"` + "\r");
    }
  }
  shellOutput(s, data) {
    const capture = s.shellCapture;
    if (!capture) return;
    capture.buffer += data;
    const begin = `\x1b]633;LumenBegin;${s.marker}\x07`;
    if (!capture.started) {
      const index = capture.buffer.indexOf(begin);
      if (index < 0) { capture.buffer = capture.buffer.slice(-begin.length * 2); return; }
      capture.buffer = capture.buffer.slice(index + begin.length); capture.started = true;
    }
    const end = new RegExp(`\x1b\\]633;LumenEnd;${s.marker};(-?\\d+);([^\x07]*)\x07`);
    const match = capture.buffer.match(end);
    this.text(s, strip(match ? capture.buffer.slice(0, match.index) : capture.buffer).slice(-200000).trimEnd(), "shell", true);
    if (match) {
      s.shellCapture = null;
      s.cwd = match[2].startsWith("raw:") ? match[2].slice(4) : Buffer.from(match[2], "base64").toString("utf8").trimEnd();
      this.event(s, { type: "cwd", cwd: s.cwd });
      this.finish(s, Number(match[1]));
    }
  }
  async agentTurn(s, prompt, message = {}) {
    if (s.agent === "google") {
      await this.prepareLaunch(s);
      return require("./google.cjs").turn(this, s, prompt, message);
    }
    if (s.agent === "pi") {
      await this.ensurePiPolicy(s);
      const images = (await this.attachments?.resolve(s.controlId, message.attachments || []) || []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      await this.piRpc(s, "prompt", { message: prompt, clientId: message?.id, images });
      return;
    }
    await (await ensureRuntime(this, s)).prompt(prompt, message);
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
    if (e.type === "assistant" && e.message?.content) {
      const { isNarrationThinking } = require("./session-history.cjs");
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
        } else if (isNarrationThinking(block, e.narration_block_indexes, i)) {
          this.text(
            s,
            block.thinking,
            `${e.message.id || stream?.id || s.messageId || "answer"}:${e.uuid || "narration"}:${i}`,
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
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      const { formatToolDetail } = require("./session-history.cjs");
      for (const block of e.message.content)
        if (block.type === "tool_result")
          this.tool(
            s,
            block.tool_use_id,
            "Tool result",
            formatToolDetail(block.content),
            block.is_error ? "error" : "done",
          );
    }
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
    if (e.type === "extension_error") {
      s.piCommandFailed = true;
      this.event(s, { type: "error", message: e.error || "Pi extension failed." });
      return;
    }
    if (s.piRpcProcess && e.type === "extension_ui_request" && e.method === "notify" && (e.notificationType || e.notifyType) === "error") {
      s.piCommandFailed = true;
      this.event(s, { type: "error", message: strip(e.message || "Pi command failed.") });
      return;
    }
    if (e.type === "response" && e.command === "prompt" && e.id?.startsWith("preflight:")) {
      const id = e.id.slice(10);
      if (!this.writePiBridge(s, { id: uuid(), type: "prompt_preflight", deliveryId: id, failed: !e.success })) return;
      if (!e.success) this.piEvent(s, { ...e, id });
      return;
    }
    if (e.type === "extension_ui_request" && e.method === "notify" && /^MCP Servers:|^No MCP servers configured/.test(e.message || "")) {
      s.piMcpNotification = e.message;
      const lines = strip(e.message).split("\n");
      this.text(s, [lines[0], "", ...lines.slice(1).map((line) => `- ${line}`)].join("\n"), "mcp-list", true); return;
    }
    if (e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("LUMEN_CONTEXT:")) {
      try {
        const usage = JSON.parse(e.message.slice("LUMEN_CONTEXT:".length)); this.event(s, { type: "context", contextTokens: usage.contextTokens, contextWindow: usage.contextWindow });
        if (usage.compacting !== undefined) {
          s.piCompacting = usage.compacting;
          this.event(s, { type: "phase", phase: usage.compacting ? "compacting" : undefined });
          if (usage.error) this.event(s, { type: "diagnostic", key: "auto-compact", text: "Auto-compact: " + usage.error + ". The CLI's normal context protection remains active." });
          if (!usage.compacting && !s.piRunActive) this.finish(s, s.piCommandFailed ? 1 : 0);
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
      // A saved user message acknowledges delivery, not completion of its model run.
      if (e.command === "prompt" && e.success && e.data?.commandCompleted) {
        s.piCompletionStateId = uuid();
        this.writePiBridge(s, { id: s.piCompletionStateId, type: "get_state" });
      }
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
    if (e.type === "response" && e.command === "get_state" && s.piCompletionStateId && e.id === s.piCompletionStateId && e.success &&
        !s.piRunActive && !e.data?.isStreaming && !e.data?.isCompacting && !e.data?.pendingMessageCount) {
      if (s.busy && !s.hadText && !s.piCommandFailed) this.text(s, "Command completed.", "command-result", true);
      this.finish(s, s.piCommandFailed ? 1 : 0);
    }
    if (
      e.type === "response" &&
      e.command === "get_state" &&
      e.data?.sessionFile
    ) {
      s.sessionRef = e.data.sessionFile;
      this.event(s, { type: "session", sessionRef: s.sessionRef });
    }
    if (e.type === "response" && e.command === "get_state" && e.success && e.data?.contextUsage) {
      this.event(s, { type: "context", contextTokens: e.data.contextUsage.tokens, contextWindow: e.data.contextUsage.contextWindow });
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
      if (e.command === "prompt" || (s.piCompletionStateId && e.id === s.piCompletionStateId)) this.finish(s, 1);
    }
    if (e.type === "message_start" && e.message?.role === "assistant")
      s.messageId = uuid();
    if (!s.piRpcProcess && e.type === "message_start" && e.message?.role === "user") this.event(s, { type: "user-message", messageId: e.clientId || uuid(), text: e.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "", delivery: "send" });
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
    if (e.type === "extension_ui_request") {
      if (e.method === "setWidget") {
        s.piWidgets ||= new Set();
        const hasLines = Array.isArray(e.widgetLines) && e.widgetLines.some((line) => strip(line).trim());
        if (hasLines) s.piWidgets.add(e.widgetKey);
        else if (s.piWidgets.has(e.widgetKey)) s.piWidgets.delete(e.widgetKey);
        else return;
      }
      if (["select", "confirm", "input", "editor", "custom"].includes(e.method)) { s.piDialogs ||= new Set(); s.piDialogs.add(e.id); }
      this.event(s, { type: "pi_ui", request: { ...e, ...(typeof e.message === "string" ? { message: strip(e.message) } : {}), ...(e.lines ? { lines: e.lines.map(strip) } : {}), ...(e.widgetLines ? { widgetLines: e.widgetLines.map(strip) } : {}) } });
    }
    if (e.type === "agent_settled") {
      s.piRunActive = false;
      if (!s.piCompacting) this.finish(s, s.piCommandFailed ? 1 : 0);
      this.writePiBridge(s, { id: uuid(), type: "get_state" });
    }
  }
  failPiBridge(s, message) {
    s.piBridgeState = "disconnected";
    s.piCommandFailed = true;
    this.rejectPiCommands(s, message);
    for (const id of s.piDialogs || []) this.event(s, { type: "agent_ui_cancel", request: { id } });
    s.piDialogs?.clear();
    if (s.stopping) return;
    const child = s.piRpcProcess;
    if (child) {
      const bridge = s.piNativeBridge;
      s.piNativeBridge = null; s.piRpcProcess = null;
      if (s.process === child) s.process = null;
      bridge?.close();
      const closing = this.kill(child, true);
      s.piClosing = closing; s.piClosingChild = child;
      const cleared = () => { if (s.piClosingChild === child) { s.piClosing = null; s.piClosingChild = null; } };
      child.once("exit", cleared);
      void closing.then(cleared, (error) => { if (child.exitCode !== null || child.signalCode !== null) cleared(); this.event(s, { type: "diagnostic", text: "Pi could not close its disconnected runtime: " + error.message }); });
    }
    if (s.busy) { this.event(s, { type: "error", message }); this.finish(s, 1); }
  }
  writePiBridge(s, request) {
    try {
      if (!s.piNativeBridge) throw new Error("The terminal bridge is disconnected.");
      s.piNativeBridge.write(request);
      return true;
    } catch (error) {
      this.failPiBridge(s, "Pi's terminal bridge failed. Retry to reconnect its saved session. " + error.message);
      return false;
    }
  }
  piResponse(id, response) {
    const s = this.get(id);
    if (s.agent !== "pi" && s.runtime) return s.runtime.reply(response);
    if (!this.writePiBridge(s, { type: "extension_ui_response", ...response })) throw new Error("Pi's dialog could not receive the answer. Retry the command after reconnecting.");
    if (response.input === undefined) s.piDialogs?.delete(response.id);
  }
  async importNativeHistory(s) {
    if (!["claude", "grok", "pi"].includes(s.agent) || !s.sessionRef) return;
    if (s.importingNativeHistory) return s.importingNativeHistory;
    s.importingNativeHistory = (async () => {
      const historyMod = require("./session-history.cjs");
      const file = await historyMod.sessionFile(s);
      if (!file) return;
      const stat = await fsp.stat(file).catch(() => null);
      const updatesStat = s.agent === "grok" ? await fsp.stat(path.join(path.dirname(file), "updates.jsonl")).catch(() => null) : null;
      const statKey = stat ? `${file}:${stat.size}:${stat.mtimeMs}:${updatesStat?.size || 0}:${updatesStat?.mtimeMs || 0}` : "";
      if (statKey && statKey === s.nativeHistoryStatKey) return;
      const history = await historyMod.readHistory(s);
      if (history) {
        s.nativeHistoryStatKey = statKey;
        s.sessionStarted = true;
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(history.messages)).digest("hex");
        if (fingerprint !== s.historyFingerprint) { s.historyFingerprint = fingerprint; this.event(s, { type: "history", messages: history.messages }); }
        if (Number.isFinite(history.contextTokens) && history.contextTokens >= 0 && history.contextTokens !== s.contextTokens) {
          this.event(s, { type: "context", contextTokens: history.contextTokens });
        }
      }
    })().finally(() => { s.importingNativeHistory = null; });
    return s.importingNativeHistory;
  }
  async reconnect(id) {
    const s = this.get(id);
    if (s.nativeOwned && s.pty) return;
    await this.prepareLaunch(s);
    if (s.agent === "shell") { await this.startNative(id); return; }
    if (s.agent === "pi") {
      await this.ensurePi(s);
      const saved = this.recovery?.state.tabs.find((tab) => tab.controlId === s.controlId);
      const history = await require("./session-history.cjs").readHistory(s);
      if (Number.isFinite(history?.contextTokens) && history.contextTokens >= 0 && s.contextTokens === null) {
        this.event(s, { type: "context", contextTokens: history.contextTokens });
      }
      s.messageQueue.reconcile(history?.messages || [], saved?.acceptedMessageIds || []);
      this.event(s, { type: "reconnected" }); return;
    }
    if (["claude", "grok"].includes(s.agent) && s.sessionRef) {
      if (s.agent === "claude") await claudeHome(this, s); else await grokHome(this, s);
      const history = await require("./session-history.cjs").readHistory(s);
      const saved = this.recovery?.state.tabs.find((tab) => tab.controlId === s.controlId) || s.savedTab;
      // Reopening a chat whose transcript vanished used to throw and block it permanently.
      // Start fresh in the same chat instead: the retained messages stay on screen.
      const resumable = s.agent === "claude" ? !!history?.messages.length : !!history;
      if (!resumable && s.sessionStarted)
        this.event(s, { type: "diagnostic", title: "Started a fresh conversation", text: "Claude no longer had this chat's saved conversation, so this chat starts a new one. Your earlier messages stay visible here." });
      s.sessionStarted = resumable;
      if (history?.messages.length) this.event(s, { type: "history", messages: history.messages });
      if (Number.isFinite(history?.contextTokens) && history.contextTokens >= 0) {
        this.event(s, { type: "context", contextTokens: history.contextTokens });
      }
      s.messageQueue.reconcile(history?.messages || [], saved?.acceptedMessageIds || []);
    }
    if (s.agent !== "google") await ensureRuntime(this, s);
    this.event(s, { type: "reconnected" });
  }
  async releaseRuntime(s) {
    const runtime = s.runtime, child = s.process;
    if (!child) return;
    if (runtime?.terminals?.running || s.nativeBackgroundWork) throw new Error("Background work still belongs to this CLI. Keep its current runtime open until that work finishes.");
    const exited = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end();
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The CLI has not exited gracefully. Its session remains open; wait or use Force stop.")), 10000); })]); }
    finally { clearTimeout(timer); }
    runtime?.close("Transferring conversation ownership.");
    if (s.process === child) s.process = null;
  }
  async setMode(id, mode) {
    const s = this.get(id);
    if (!["rich", "native"].includes(mode)) throw new Error("Invalid session view.");
    if (s.stopping || s.transitioning || s.setting) throw new Error("Wait for the current session action to finish.");
    if (s.mode === mode) return { mode, sessionRef: s.sessionRef, nativeOwned: !!s.nativeOwned };
    if (["claude", "grok", "pi", "google"].includes(s.agent) && s.busy) {
      s.pendingMode = mode;
      return { mode: s.mode, sessionRef: s.sessionRef, pending: true };
    }
    s.messageQueue?.pause();
    s.transitioning = true;
    try {
      if (s.agent === "google") {
        if (mode === "native") { await this.releaseRuntime(s); await this.startNative(id); }
        else if (s.pty) this.event(s, { type: "terminal-needed", title: "Google CLI · exit when ready to reconnect Readable" });
      } else if (["shell", "pi", "codex"].includes(s.agent)) {
        if (s.agent === "shell") await this.startNative(id);
        else if (s.agent === "pi") {
          this.rejectPiCommands(s, "Pi view changed.");
          if (s.piRpcProcess) { const child = s.piRpcProcess; s.piRpcProcess = null; s.process = null; await this.kill(child, true); }
          if (mode === "rich" && s.pty) {
            // A native command or dialog can own the terminal while the agent is idle.
            // Retain that owner until Pi exits itself, then reconnect its saved session.
            s.nativeOwned = true;
            await this.importNativeHistory(s);
            clearInterval(s.nativeHistoryTimer);
            s.nativeHistoryTimer = setInterval(() => void this.importNativeHistory(s).catch(() => {}), 1500);
            s.nativeHistoryTimer.unref();
            this.event(s, { type: "terminal-needed", title: "Pi CLI · exit when ready to reconnect Readable" });
          } else if (!s.pty) {
            s.piNativeBridge?.close(); s.piNativeBridge = null;
            s.mode = mode;
            await this.ensurePi(s);
            if (mode === "rich") await this.importNativeHistory(s);
          }
        }
        else { await ensureRuntime(this, s); if (mode === "native") await this.startNative(id); }
      } else if (mode === "native") {
        // A runtime that was still running may not have flushed its transcript yet, so its chat
        // keeps the retry guard. A chat with no live runtime has nothing pending: if its
        // transcript is gone it starts fresh instead of blocking the switch forever.
        const owned = !!s.runtime;
        await this.releaseRuntime(s);
        await syncNativeMcp(s);
        if (s.sessionRef) {
          if (s.agent === "claude") await claudeHome(this, s); else await grokHome(this, s);
          const history = await require("./session-history.cjs").readHistory(s);
          const saved = this.recovery?.state.tabs.find((tab) => tab.controlId === s.controlId);
          const resumable = s.agent === "claude" ? !!history?.messages.length : !!history;
          if (!resumable && owned && saved?.messages?.some((message) => message.role === "user")) throw new Error("The CLI has not saved this conversation yet. Its identity is retained; retry once its history is available.");
          if (!resumable && s.sessionStarted)
            this.event(s, { type: "diagnostic", title: "Started a fresh conversation", text: "Claude no longer had this chat's saved conversation, so the terminal starts a new one. Your earlier messages stay in the chat view." });
          s.sessionStarted = resumable;
        }
        await this.startNative(id);
      } else if (s.pty) {
        // Keep the native CLI and any editor draft alive. Its saved history can
        // be read now; protocol ownership transfers only after it exits itself.
        await this.importNativeHistory(s);
        clearInterval(s.nativeHistoryTimer);
        s.nativeHistoryTimer = setInterval(() => void this.importNativeHistory(s).catch(() => {}), 1500);
        s.nativeHistoryTimer.unref();
        this.event(s, { type: "terminal-needed", title: "Native CLI · exit when ready to reconnect Readable" });
      }
      s.mode = mode;
      if (mode === "native" && s.agent !== "claude") { clearInterval(s.nativeHistoryTimer); s.nativeHistoryTimer = null; }
      this.event(s, { type: "native-owner", nativeOwned: !!s.nativeOwned && !!s.pty });
      this.event(s, { type: "view", mode, sessionRef: s.sessionRef });
      return { mode, sessionRef: s.sessionRef, nativeOwned: !!s.nativeOwned && !!s.pty };
    } finally { s.transitioning = false; }
  }
  async stop(id, force = false) {
    const s = this.get(id);
    s.messageQueue?.pause();
    s.pendingMode = null;
    if (force) {
      s.stopping = true;
      clearTimeout(s.stopTimer);
      try {
        s.runtime?.close("Force stopped. Conversation history is retained.");
        if (s.piClosingChild) await this.kill(s.piClosingChild, true);
        if (s.process) { await this.kill(s.process, true); s.process = null; s.piRpcProcess = null; }
        if (s.pty) { const terminal = s.pty; s.pty = null; terminal.kill(); }
        s.nativeOwned = false; clearInterval(s.nativeHistoryTimer);
        this.event(s, { type: "native-owner", nativeOwned: false });
        s.piNativeBridge?.close(); s.piNativeBridge = null;
        this.rejectPiCommands(s, "Force stopped.");
      } finally { s.stopping = false; s.stopRequested = false; }
      this.finish(s, 130);
      this.event(s, { type: "stop-state", stopping: false, forceStopAvailable: false });
      return;
    }
    if (s.stopRequested || !s.busy) return;
    s.stopRequested = true;
    this.event(s, { type: "stop-state", stopping: true, forceStopAvailable: false });
    s.stopTimer = setTimeout(() => { if (s.stopRequested) this.event(s, { type: "stop-state", stopping: true, forceStopAvailable: true }); }, 10000);
    try {
      if (s.agent === "pi" && s.piNativeBridge) { this.writePiBridge(s, { id: uuid(), type: "abort" }); s.pty?.write("\x1b"); }
      else if (s.agent === "shell" || s.nativeOwned) s.pty?.write("\x03");
      else if (s.runtime) await s.runtime.cancel();
    } catch (error) { this.event(s, { type: "diagnostic", text: "Cancellation is still pending. " + error.message }); }
  }
  async kill(child, forceTree = false) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    let timer, killError;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      if (process.platform === "win32" && forceTree) {
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
    clearTimeout(s.catalogWarmTimer);
    clearTimeout(s.stopTimer);
    clearInterval(s.nativeHistoryTimer);
    s.stopping = true;
    s.messageQueue?.close();
    await this.cancelDiscovery(s);
    if (s.piClosing) await s.piClosing.catch((error) => this.event(s, { type: "diagnostic", text: error.message }));
    s.runtime?.close("Chat closed.");
    s.pty?.kill();
    s.piNativeBridge?.close();
    s.terminalState?.dispose();
    if (s.shell) await this.kill(s.shell, true);
    if (s.process) await this.kill(s.process, true);
    if (s.piClosingChild) await this.kill(s.piClosingChild, true).catch((error) => this.event(s, { type: "diagnostic", text: "Pi's disconnected process could not be stopped: " + error.message }));
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
