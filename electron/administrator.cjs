const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const powershellPath = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
// Start-Process joins ArgumentList into a command line. Quote for Windows argv,
// then put that entire line in a literal PowerShell string.
const commandLine = (args) => args.map((arg) => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`).join(" ");
function run(script, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)],
      { windowsHide: true, timeout }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

function restoreRestartProfile(app) {
  if (process.argv.includes("--lumen-restart-dev")) process.env.LUMEN_DEV = "1";
  const data = process.argv.find((arg) => arg.startsWith("--lumen-restart-data="))?.split("=").slice(1).join("=");
  if (data) {
    const directory = Buffer.from(data, "base64").toString("utf8");
    if (!path.isAbsolute(directory)) throw new Error("Invalid Lumen restart profile.");
    app.setPath("userData", directory);
  }
}

async function waitForRestartParent() {
  const value = process.argv.find((arg) => arg.startsWith("--lumen-restart-parent="))?.split("=")[1];
  if (!value) return;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid Lumen restart process.");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The previous Lumen window did not finish closing. Try restarting again.");
}

function createAdministrator(app) {
  const supported = process.platform === "win32";
  let pending;
  const status = async () => {
    if (!supported) return { supported, elevated: false, error: "" };
    pending ??= run("$ErrorActionPreference = 'Stop'; $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)")
      .then((value) => {
        if (!["True", "False"].includes(value)) throw new Error("Unexpected Windows elevation status.");
        return { supported, elevated: value === "True", error: "" };
      }).catch(() => { pending = null; return { supported, elevated: null, error: "Could not check Windows administrator access. Try again." }; });
    return pending;
  };
  return {
    status,
    async restart() {
      const current = await status();
      if (!supported) throw new Error("Administrator mode is available on Windows.");
      if (current.error) throw new Error(current.error);
      if (current.elevated) return { started: false, cancelled: false };
      // Portable releases must relaunch their original wrapper, not the temporary
      // extracted executable which is removed when the old instance exits.
      const executable = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath("exe");
      if (!fs.existsSync(executable)) throw new Error("Lumen's executable could not be found.");
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]),
        ...(process.env.LUMEN_DEV === "1" ? ["--lumen-restart-dev"] : []),
        `--lumen-restart-parent=${process.pid}`, `--lumen-restart-data=${Buffer.from(app.getPath("userData")).toString("base64")}`];
      const result = await run(`$ErrorActionPreference = 'Stop'; try {
        Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(commandLine(args))} -WorkingDirectory ${literal(path.dirname(executable))} -Verb RunAs -WindowStyle Normal | Out-Null
        Write-Output 'started'
      } catch {
        $failure = $_.Exception
        while ($failure) { if ($failure.NativeErrorCode -eq 1223) { Write-Output 'cancelled'; exit 0 }; $failure = $failure.InnerException }
        [Console]::Error.WriteLine($_.Exception.Message); exit 1
      }`, 0);
      if (!["started", "cancelled"].includes(result)) throw new Error("Windows did not confirm the administrator restart.");
      return { started: result === "started", cancelled: result === "cancelled" };
    },
  };
}

module.exports = { createAdministrator, restoreRestartProfile, waitForRestartParent };
