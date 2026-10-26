const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const pathKey = (value) => {
  let key = path.resolve(value).replace(/[\\/]+/g, "/");
  if (process.platform === "win32") key = key.toLowerCase();
  return key.replace(/\/$/, "");
};
const samePath = (a, b) => pathKey(a) === pathKey(b);
const normalizeBase = (base) => typeof base === "string" && base.trim() ? base.trim() : "HEAD";
const syncDirectory = async (folder) => {
  if (process.platform === "win32") return;
  const directory = await fs.open(folder, "r");
  try { await directory.sync(); } finally { await directory.close(); }
};
const publishExclusive = async (file, contents) => {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close(); handle = null;
    // A hard link publishes the complete synced file atomically without replacing a
    // repository identity another Lumen process may have published first.
    await fs.link(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
};

// One native journal owns both the reservation and the Git operation. Renderer state is
// deliberately not part of the safety contract: it can disappear independently of Git.
class WorktreeJobs {
  constructor(workspace, dataDir) {
    this.workspace = workspace;
    this.file = path.join(dataDir, "worktree-jobs.json");
    this.jobs = Object.create(null);
    this.queue = Promise.resolve();
    this.loadError = "";
  }
  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!saved || saved.version !== 2 || !saved.jobs || typeof saved.jobs !== "object" || Array.isArray(saved.jobs)) throw new Error("unsupported journal format");
      for (const binding of Object.values(saved.jobs)) {
        if (!binding || binding.version !== 2 || typeof binding.root !== "string" || typeof binding.repoId !== "string" ||
            typeof binding.branch !== "string" || typeof binding.base !== "string" || typeof binding.baseCommit !== "string" ||
            typeof binding.folder !== "string" || typeof binding.ready !== "boolean") throw new Error("invalid job binding");
      }
      this.jobs = Object.assign(Object.create(null), saved.jobs);
    } catch (error) {
      if (error.code !== "ENOENT") this.loadError = error.message;
    }
  }
  binding(id) {
    if (this.loadError) throw new Error(`Lumen cannot safely read its worktree job journal: ${this.loadError}`);
    return Object.hasOwn(this.jobs, id) ? { ...this.jobs[id] } : null;
  }
  create(id, root, branch, base) {
    const run = this.queue.then(() => this.perform(id, root, branch, base));
    this.queue = run.catch(() => {});
    return run;
  }
  async write(next) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(JSON.stringify({ version: 2, jobs: next }));
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, this.file);
      this.jobs = next;
      await syncDirectory(path.dirname(this.file));
    } catch (error) {
      throw new Error(`Lumen could not persist worktree job state: ${error.message}. Retry the same task ID; do not start a different job for this request.`);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async save(id, binding) {
    const next = Object.assign(Object.create(null), this.jobs);
    next[id] = binding;
    await this.write(next);
  }
  async release(id) {
    const next = Object.assign(Object.create(null), this.jobs);
    delete next[id];
    await this.write(next);
  }
  async repoIdentity(cwd) {
    const common = (await this.workspace.gitAt(cwd, ["rev-parse", "--git-common-dir"])).trim();
    const commonDir = await fs.realpath(path.resolve(cwd, common));
    const file = path.join(commonDir, "lumen-worktree-job-repository.json");
    const read = async () => {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!value || typeof value.id !== "string" || !value.id) throw new Error("invalid repository identity");
      return value.id;
    };
    try { return await read(); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Lumen cannot verify this repository's worktree job identity: ${error.message}`);
      try {
        await publishExclusive(file, JSON.stringify({ id: crypto.randomUUID() }));
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
      }
      return read();
    }
  }
  async branchExists(cwd, branch) {
    return this.workspace.gitAt(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
      () => true,
      (error) => { if (error.exitCode === 1) return false; throw error; },
    );
  }
  async folderExists(folder) {
    try { await fs.lstat(folder); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  assertRequest(binding, request) {
    if (binding.root !== request.root || binding.repoId !== request.repoId || binding.branch !== request.branch ||
        binding.base !== request.base || binding.folder !== request.folder)
      throw new Error("This task ID is already bound to a different worktree request or repository. Use a new task ID for a different job.");
  }
  async perform(id, root, branch, base) {
    if (this.loadError) throw new Error(`Lumen cannot safely read its worktree job journal: ${this.loadError}`);
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new Error("A worktree job needs a valid task ID.");
    id = id.trim();
    if (typeof root !== "string" || !root.trim()) throw new Error("A worktree job needs a root folder.");
    if (typeof branch !== "string") throw new Error("Enter a branch name.");
    branch = branch.trim(); base = normalizeBase(base);
    if (!branch || branch.startsWith("-")) throw new Error("Enter a branch name.");
    if (base.startsWith("-")) throw new Error("Invalid base reference.");
    const source = await this.workspace.inspect(root);
    if (!source.git.available) throw new Error("Open a Git repository with at least one commit first.");
    const cwd = await this.workspace.worktreeRoot(source.root);
    await this.workspace.gitAt(cwd, ["check-ref-format", "--branch", branch]);
    const trees = await this.workspace.listWorktrees(cwd);
    const primary = trees.find((tree) => tree.primary)?.path || cwd;
    const folder = path.join(path.dirname(primary), `${path.basename(primary)}.worktrees`, branch.replace(/[^a-zA-Z0-9_.-]/g, "-"));
    const repoId = await this.repoIdentity(cwd);
    const request = { root: cwd, repoId, branch, base, folder };
    let binding = this.binding(id);
    if (binding) this.assertRequest(binding, request);
    else {
      const conflict = Object.values(this.jobs).find((other) => other.repoId === repoId && (other.branch === branch || samePath(other.folder, folder)));
      if (conflict) throw new Error("This worktree branch or destination is already reserved by another task ID.");
      if (await this.branchExists(cwd, branch) || trees.some((tree) => tree.branch === branch)) throw new Error(`Branch ${branch} already exists.`);
      if (trees.some((tree) => samePath(tree.path, folder)) || await this.folderExists(folder)) throw new Error(`The worktree destination already exists: ${folder}`);
      const baseCommit = (await this.workspace.gitAt(cwd, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
      binding = { version: 2, ...request, baseCommit, ready: false };
      // This must reach disk before Git is touched. A failure here creates nothing.
      await this.save(id, binding);
    }
    return this.resume(id, binding, source, cwd);
  }
  async complete(binding, source, cwd) {
    const [opened, freshSource] = await Promise.all([this.workspace.open(binding.folder), this.workspace.inspect(cwd)]);
    return { workspace: opened, source: freshSource };
  }
  async resume(id, binding, source, cwd) {
    const { branch, folder } = binding;
    if (binding.ready) {
      const trees = await this.workspace.listWorktrees(cwd);
      const exact = trees.find((tree) => samePath(tree.path, folder));
      if (!exact || exact.branch !== branch) throw new Error("This job's original worktree is missing or changed. Restore it before retrying this task ID, or use a new task ID for a new job.");
      return this.complete(binding, source, cwd);
    }
    try {
      const trees = await this.workspace.listWorktrees(cwd);
      const exact = trees.find((tree) => samePath(tree.path, folder));
      const target = trees.find((tree) => tree.branch === branch);
      let branchExists = await this.branchExists(cwd, branch);
      if (target) {
        if (!exact || !samePath(target.path, folder)) throw new Error(`Branch ${branch} is checked out at an unexpected location: ${target.path}`);
      } else {
        if (exact && !exact.detached) throw new Error("This job's worktree was replaced by a different checkout. Lumen will not attach it to the requested branch.");
        if (!exact && branchExists) throw new Error("The requested branch exists without the job's original worktree. Its ownership cannot be proven, so Lumen will not attach or reuse it.");
        if (exact) {
          const head = (await this.workspace.gitAt(folder, ["rev-parse", "HEAD"])).trim();
          if (head !== binding.baseCommit) throw new Error("The interrupted worktree does not match this job's recorded starting commit. Lumen will not modify it.");
        } else {
          if (await this.folderExists(folder)) throw new Error(`The interrupted job's destination now exists but is not its registered worktree: ${folder}`);
          await this.workspace.gitAt(cwd, ["worktree", "add", "--detach", folder, binding.baseCommit]);
          const head = (await this.workspace.gitAt(folder, ["rev-parse", "HEAD"])).trim();
          if (head !== binding.baseCommit) throw new Error("The new worktree does not match the job's recorded starting commit.");
        }
        // Creating the worktree detached first makes a branch-only crash state impossible.
        // A foreign branch that appeared meanwhile still fails closed.
        branchExists = await this.branchExists(cwd, branch);
        if (branchExists) throw new Error(`Branch ${branch} appeared while this job was being recovered. Lumen will not attach it.`);
        await this.workspace.gitAt(folder, ["checkout", "-b", branch]);
      }
      if ((await this.workspace.gitAt(folder, ["branch", "--show-current"])).trim() !== branch) throw new Error("The worktree did not attach to the requested branch.");
      binding = { ...binding, ready: true };
      await this.save(id, binding);
      return await this.complete(binding, source, cwd);
    } catch (error) {
      // A killed or timed-out Git process may still have an uncertain on-disk outcome.
      // Never release its reservation based on a momentary absence of Git state.
      if (!binding.ready && !error.processKilled) await this.reconcileFailure(id, binding, error);
      throw error;
    }
  }
  async reconcileFailure(id, binding, original) {
    let trees, branch, folder;
    try {
      [trees, branch, folder] = await Promise.all([
        this.workspace.listWorktrees(binding.root),
        this.branchExists(binding.root, binding.branch),
        this.folderExists(binding.folder),
      ]);
    } catch { return; } // Uncertain inspection always keeps the reservation.
    if (branch || folder || trees.some((tree) => samePath(tree.path, binding.folder))) return;
    try { await this.release(id); }
    catch (error) { throw new Error(`${original.message} The job created no branch, worktree, or destination folder, but Lumen could not clear its reservation: ${error.message}`); }
  }
}

module.exports = { WorktreeJobs, normalizeBase };
