const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Windows PowerShell loads this binary module directly. No script execution
// policy change, signed script, system Node install, or .NET SDK is required.
if (process.platform === "win32") {
  const windows = process.env.WINDIR || "C:\\Windows";
  const frameworks = path.join(windows, "Microsoft.NET");
  const csc = [path.join(frameworks, "Framework64", "v4.0.30319", "csc.exe"), path.join(frameworks, "Framework", "v4.0.30319", "csc.exe")].find((file) => fs.existsSync(file));
  const automation = path.join(frameworks, "assembly", "GAC_MSIL", "System.Management.Automation", "v4.0_3.0.0.0__31bf3856ad364e35", "System.Management.Automation.dll");
  if (!csc || !fs.existsSync(automation)) throw new Error("Windows PowerShell's .NET compiler is required to build the Lumen command.");
  const output = path.join(__dirname, "..", "build", "lumen-agent", "LumenAgent", "LumenAgent.dll");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(csc, ["/nologo", "/target:library", `/out:${output}`, "/optimize+", "/platform:anycpu", `/reference:${automation}`, path.join(__dirname, "lumen-agent-command.cs")], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
