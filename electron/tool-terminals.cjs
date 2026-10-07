const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TerminalState } = require("./terminal-state.cjs");
const { profiledLaunch } = require("./profile-launcher.cjs");
class AcpTerminals {
  constructor(owner, session) { this.owner = owner; this.session = session; this.items = new Map(); session.toolTerminals = this.items; }
  async handle(method, params) {
    const { owner, session } = this;
    if (params.sessionId !== session.sessionRef) throw new Error("Terminal belongs to another conversation.");
    if (method === "terminal/create") {
      if (typeof params.command !== "string" || !params.command || !Array.isArray(params.args || []) || (params.args || []).some((arg) => typeof arg !== "string")) throw new Error("Invalid terminal command.");
      const cwd = params.cwd || session.cwd;
      if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Terminal working directory is unavailable.");
      const env = { ...require("./accounts.cjs").accountEnvironment(session, session.profileEnvironment || process.env), TERM: "xterm-256color" };
      for (const variable of params.env || []) {
        if (!variable || typeof variable.name !== "string" || typeof variable.value !== "string" || /[=\x00]/.test(variable.name)) throw new Error("Invalid terminal environment.");
        env[variable.name] = variable.value;
      }
      const launch = profiledLaunch({ ...session, command: params.command, profileFunction: undefined, preparedLauncher: undefined }, params.args || [], require("./services.cjs").resolveLauncher);
      const terminalId = crypto.randomUUID();
      const pty = require("node-pty").spawn(launch.file, launch.args, { name: "xterm-256color", cols: 100, rows: 30, cwd, env, useConptyDll: process.platform === "win32" });
      const item = { terminalId, pty, output: "", truncated: false, limit: Number.isSafeInteger(params.outputByteLimit) && params.outputByteLimit > 0 ? Math.min(params.outputByteLimit, 20 * 1024 * 1024) : 1024 * 1024 };
      item.state = new TerminalState(100, 30, (data) => pty.write(data));
      item.exited = new Promise((resolve) => { item.resolveExit = resolve; });
      this.items.set(terminalId, item);
      pty.onData((data) => {
        item.output += data;
        const bytes = Buffer.from(item.output);
        if (bytes.length > item.limit) { item.output = bytes.subarray(bytes.length - item.limit).toString("utf8"); item.truncated = true; }
        item.state.write(data, (chunk) => owner.event(session, { type: "terminal", terminalId, ...chunk }));
      });
      pty.onExit(({ exitCode, signal }) => { item.exitStatus = { exitCode, ...(signal ? { signal: String(signal) } : {}) }; item.resolveExit(item.exitStatus); owner.event(session, { type: "tool-terminal-exit", terminalId }); });
      owner.event(session, { type: "terminal-needed", terminalId, title: params.command });
      return { terminalId };
    }
    const item = this.items.get(params.terminalId);
    if (!item) throw new Error("This terminal is no longer available.");
    if (method === "terminal/output") return { output: item.output, truncated: item.truncated, ...(item.exitStatus ? { exitStatus: item.exitStatus } : {}) };
    if (method === "terminal/wait_for_exit") return item.exited;
    if (method === "terminal/kill") { if (!item.exitStatus) item.pty.kill(); await item.exited; return {}; }
    if (method === "terminal/release") { if (!item.exitStatus) { item.pty.kill(); await item.exited; } this.items.delete(item.terminalId); item.state.dispose(); owner.event(session, { type: "tool-terminal-release", terminalId: item.terminalId }); return {}; }
    throw new Error("Unsupported terminal operation.");
  }
  get running() { return [...this.items.values()].some((item) => !item.exitStatus); }
  close() { for (const item of this.items.values()) { if (!item.exitStatus) item.pty.kill(); item.state.dispose(); this.owner.event(this.session, { type: "tool-terminal-release", terminalId: item.terminalId }); } this.items.clear(); }
}
module.exports = { AcpTerminals };
