const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TerminalState } = require("./terminal-state.cjs");
const { profiledLaunch, encoded, loadProfiles, importAgentModule, literal } = require("./profile-launcher.cjs");
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
        if (!variable || typeof variable.name !== "string" || !variable.name || typeof variable.value !== "string" || /[=\x00]/.test(variable.name) || variable.value.includes("\x00")) throw new Error("Invalid terminal environment.");
        if (process.platform === "win32") for (const key of Object.keys(env)) if (key.toUpperCase() === variable.name.toUpperCase()) delete env[key];
        env[variable.name] = variable.value;
      }
      const { findExecutable, resolveLauncher } = require("./services.cjs");
      let launch;
      if (process.platform === "win32" && (params.args || []).length && /^(?:lumen|Invoke-Lumen)$/i.test(params.command)) {
        const shell = session.shellExecutable || findExecutable("powershell", env);
        if (/(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell))) {
          // Structured ACP calls do not pass through shell-source parsing. Read
          // exact arguments from disk so long prompts never hit a command-line
          // or environment limit, then splat them into the binary cmdlet.
          const folder = path.join(session.lumenDataDir, "terminal-args");
          const argumentFile = path.join(folder, crypto.randomUUID() + ".json");
          fs.mkdirSync(folder, { recursive: true });
          try { fs.writeFileSync(argumentFile, JSON.stringify(params.args), { mode: 0o600 }); }
          catch (error) { fs.rmSync(argumentFile, { force: true }); throw error; }
          const script = `${session.loadShellProfile ? loadProfiles + "; " : ""}$lumenArgsFile=${literal(argumentFile)}; try { $lumenStructuredArgs=[string[]](([IO.File]::ReadAllText($lumenArgsFile,[Text.Encoding]::UTF8)) | ConvertFrom-Json); ${importAgentModule}; Invoke-Lumen @lumenStructuredArgs -ErrorAction Continue; $lumenSucceeded=$?; $lumenExitCode=$LASTEXITCODE } finally { Remove-Item -LiteralPath $lumenArgsFile -Force -ErrorAction SilentlyContinue }; if (!$lumenSucceeded) { if ($lumenExitCode) { exit $lumenExitCode }; exit 1 }`;
          launch = { file: shell, args: ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded(script)], cleanup: [argumentFile] };
        }
      }
      if (!launch && (params.args || []).length) {
        launch = profiledLaunch({ ...session, profileEnvironment: env, command: params.command, profileFunction: undefined, preparedLauncher: undefined }, params.args, resolveLauncher);
      }
      if (!launch && process.platform === "win32") {
        // Grok sends shell source (including pipelines and builtins) as command.
        const shell = session.shellExecutable || findExecutable("powershell", env);
        if (/(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell))) {
          launch = { file: shell, args: ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded(`${session.loadShellProfile ? loadProfiles + "; " : ""}${importAgentModule}; $LASTEXITCODE=0; try { ${params.command}\nif (!$?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 } } catch { if ($LASTEXITCODE) { exit $LASTEXITCODE }; throw }`)] };
        } else if (/^cmd(?:\.exe)?$/i.test(path.basename(shell))) launch = { file: shell, args: ["/D", "/S", "/C", params.command] };
        else if (/^wsl(?:\.exe)?$/i.test(path.basename(shell))) {
          // WSL does not inherit arbitrary Windows environment variables. Keep
          // credentials in the environment, and let WSL translate directory values.
          const windowsOnly = /^(?:PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|ALLUSERSPROFILE|PROGRAMDATA|OS|WSLENV|WSL_INTEROP|WSL_DISTRO_NAME|ELECTRON_RUN_AS_NODE)$/i;
          const shared = new Map((env.WSLENV || "").split(":").filter(Boolean).map((entry) => [entry.split("/")[0].toUpperCase(), entry]));
          const explicit = new Set((params.env || []).map((variable) => variable.name.toUpperCase()));
          if ((params.env || []).some((variable) => /[:/]/.test(variable.name))) throw new Error("WSL environment names cannot contain ':' or '/'.");
          for (const name of [...Object.keys(env).filter((name) => !windowsOnly.test(name) && !/[:/]/.test(name)), ...(params.env || []).map((variable) => variable.name)]) {
            if (name.toUpperCase() === "WSLENV") continue;
            const pathVariable = /(?:^PATH$|(?:^|_)(?:HOME|DIR|PATH|PATHS)$|^PYTHONPATH$|^GOPATH$|^GOBIN$)/i.test(name);
            const windowsPath = pathVariable && /(?:^|;)(?:[a-z]:[\\/]|\\\\)/i.test(env[name]);
            const metadata = shared.get(name.toUpperCase())?.match(/\/.*$/)?.[0];
            const flags = metadata ? metadata.replace(/w/g, "u") : windowsPath ? (env[name].includes(";") ? "/lp" : "/p") : "";
            if (explicit.has(name.toUpperCase()) || !shared.has(name.toUpperCase())) shared.set(name.toUpperCase(), name + flags);
          }
          env.WSLENV = [...shared.values()].join(":");
          launch = { file: shell, args: ["--exec", "sh", "-lc", params.command] };
        }
        else launch = { file: shell, args: [session.loadShellProfile ? "-lc" : "-c", params.command] };
      } else if (!launch) launch = { file: session.shellExecutable || env.SHELL || "/bin/sh", args: [session.loadShellProfile ? "-lc" : "-c", params.command] };
      const terminalId = crypto.randomUUID();
      const cleanup = () => { for (const file of launch.cleanup || []) { try { fs.rmSync(file, { force: true }); } catch { /* PowerShell may already have removed it. */ } } };
      let pty;
      try { pty = require("node-pty").spawn(launch.file, launch.args, { name: "xterm-256color", cols: 100, rows: 30, cwd, env, useConptyDll: process.platform === "win32" }); }
      catch (error) { cleanup(); throw error; }
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
      pty.onExit(({ exitCode, signal }) => { cleanup(); item.exitStatus = { exitCode, ...(signal ? { signal: String(signal) } : {}) }; item.resolveExit(item.exitStatus); owner.event(session, { type: "tool-terminal-exit", terminalId }); });
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
