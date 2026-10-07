const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const literal = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
const loadProfiles = `$lumenProfiles=@($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost); foreach($lumenProfile in $lumenProfiles){if($lumenProfile -and (Test-Path -LiteralPath $lumenProfile)){try{. $lumenProfile *>&1 | ForEach-Object {[Console]::Error.WriteLine([string]$_)}}catch{[Console]::Error.WriteLine($_.ToString())}}}`;
async function prepareProfile(session, dataDir, findExecutable, resolveLauncher) {
  if (session.launchPrepared) return;
  if (process.platform !== "win32") { session.launchPrepared = true; session.profileEnvironment = { ...process.env }; return; }
  const shell = session.shellCommand || (() => { try { return findExecutable("pwsh"); } catch { return findExecutable("powershell"); } })();
  const executable = findExecutable(shell);
  session.shellExecutable = executable;
  session.powerShell = /(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(executable));
  if (session.agent === "shell") { session.profileEnvironment = { ...process.env }; session.launchPrepared = true; return; }
  if (!session.powerShell) { session.profileEnvironment = { ...process.env }; session.launchPrepared = true; return; }
  if (session.loadShellProfile === false) { session.profileEnvironment = { ...process.env }; session.launchPrepared = true; return; }
  const folder = path.join(dataDir, "launchers");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, crypto.randomUUID() + ".json");
  const command = session.agent === "shell" ? "" : session.command;
  const script = `${loadProfiles}; $lumenEnvironment=@{}; Get-ChildItem Env: | ForEach-Object {$lumenEnvironment[$_.Name]=$_.Value}; $lumenCommand=$null; ${command ? `$lumenCommand=Get-Command -Name ${literal(command)} -ErrorAction SilentlyContinue | Select-Object -First 1; while($lumenCommand -and $lumenCommand.CommandType -eq 'Alias'){$lumenCommand=$lumenCommand.ResolvedCommand};` : ""} $lumenResult=@{environment=$lumenEnvironment; command=if($lumenCommand){@{type=[string]$lumenCommand.CommandType; path=$lumenCommand.Path; name=$lumenCommand.Name}}else{$null}}; [IO.File]::WriteAllText(${literal(file)},($lumenResult | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))`;
  try {
    await execute(executable, ["-NoLogo", "-NoProfile", "-OutputFormat", "Text", "-EncodedCommand", encoded(script)], { cwd: session.cwd, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const captured = JSON.parse(await fs.readFile(file, "utf8"));
    session.profileEnvironment = captured.environment;
    if (captured.command?.type === "Function" || captured.command?.type === "Filter") session.profileFunction = captured.command.name;
    else if (captured.command?.path) session.preparedLauncher = resolveLauncher(captured.command.path, session.profileEnvironment, session.shellExecutable);
    session.launchPrepared = true;
  } catch (error) {
    throw new Error("PowerShell profile or configured command failed to initialize. Use Settings → Workspace to disable profile loading for troubleshooting. " + (error.stderr || error.message).slice(-2000));
  } finally { await fs.unlink(file).catch(() => {}); }
}
function profiledLaunch(session, args, resolveLauncher) {
  if (!session.profileFunction) {
    const launch = session.preparedLauncher || resolveLauncher(session.command, session.profileEnvironment, session.powerShell ? session.shellExecutable : undefined);
    return { file: launch.file, args: [...launch.args, ...args] };
  }
  // Functions need the PowerShell scope which defines their dependencies. Save
  // the already-filtered environment before loading profiles and restore it
  // afterward so a profile cannot override the selected account's credentials.
  const restore = session.accountId ? `$lumenOriginal=@{}; Get-ChildItem Env: | ForEach-Object {$lumenOriginal[$_.Name]=$_.Value};` : "";
  const filter = session.accountId ? `Get-ChildItem Env: | ForEach-Object {if(!$lumenOriginal.ContainsKey($_.Name)){Remove-Item -LiteralPath ('Env:'+ $_.Name)}}; foreach($lumenKey in $lumenOriginal.Keys){[Environment]::SetEnvironmentVariable($lumenKey,$lumenOriginal[$lumenKey],'Process')};` : "";
  return { file: session.shellExecutable, args: ["-NoLogo", "-NoProfile", "-OutputFormat", "Text", "-EncodedCommand", encoded(`${restore} ${loadProfiles}; ${filter} & ${literal(session.profileFunction)} ${args.map(literal).join(" ")}`)] };
}
module.exports = { prepareProfile, profiledLaunch, loadProfiles, literal, encoded };
