const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { load } = require("js-yaml");
const pkg = require("../package.json");
const root = path.join(__dirname, "..", "release");
const metadata = load(fs.readFileSync(path.join(root, "latest.yml"), "utf8"));
const config = load(fs.readFileSync(path.join(root, "win-unpacked", "resources", "app-update.yml"), "utf8"));
assert.equal(metadata.version, pkg.version);
assert.equal(config.provider, "github");
assert.equal(config.owner, "mrchevyceleb");
assert.equal(config.repo, "lumen");
assert.ok(!config.private && !config.token);
assert.equal(metadata.files.length, 1);
const artifact = metadata.files[0];
assert.equal(artifact.url, `Lumen-Setup-${pkg.version}.exe`);
const installer = fs.readFileSync(path.join(root, artifact.url));
assert.equal(crypto.createHash("sha512").update(installer).digest("base64"), artifact.sha512);
assert.equal(installer.length, artifact.size);
assert.ok(fs.statSync(path.join(root, artifact.url + ".blockmap")).size > 0);
// Use the packaged Electron runtime and packaged native dependency, not Node's
// ABI. A successful PTY is essential for releases built on another computer.
const code = `const pty=require(${JSON.stringify(path.join(root, "win-unpacked", "resources", "app.asar", "node_modules", "node-pty"))});const p=pty.spawn('powershell.exe',['-NoLogo','-NoProfile','-Command','Write-Output LumenReleaseSmoke'],{cols:80,rows:24,cwd:process.cwd(),env:process.env});let text='';p.onData(d=>text+=d);const timer=setTimeout(()=>{p.kill();process.exit(2)},15000);p.onExit(e=>{clearTimeout(timer);if(e.exitCode!==0||!text.includes('LumenReleaseSmoke'))process.exit(1);console.log('Packaged PTY passed');process.exit(0)});`;
const child = spawn(path.join(root, "win-unpacked", "Lumen.exe"), ["-e", code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; if (code === 0) console.log("Release metadata, installer checksum, update feed, and native runtime passed."); });
