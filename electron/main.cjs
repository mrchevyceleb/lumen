const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require("electron");
const path = require("node:path");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const {
  WorkspaceService,
  Sessions,
  resolveLauncher,
  inside,
} = require("./services.cjs");
const { installZoom } = require("./zoom.cjs");
const { openPaths, resolveOpenPath } = require("./launch.cjs");
const { createUpdates } = require("./updates.cjs");
const { Accounts } = require("./accounts.cjs");
const { DefaultModels } = require("./default-models.cjs");
const { ModelCache } = require("./model-cache.cjs");
const { AgentControl } = require("./agent-control.cjs");
const { createAdministrator, restoreRestartProfile, waitForRestartParent } = require("./administrator.cjs");
const { RecoveryStore } = require("./recovery.cjs");
const { Attachments } = require("./attachments.cjs");
const { BrowserService, browserURL } = require("./browser.cjs");
app.setName("Lumen");
if (process.env.LUMEN_TEST_DATA)
  app.setPath("userData", process.env.LUMEN_TEST_DATA);
restoreRestartProfile(app);
const initialPaths = openPaths(process.argv);
const startup = waitForRestartParent().then(() => {
  if (!app.requestSingleInstanceLock({ openPaths: initialPaths })) { app.exit(0); return false; }
  return true;
});
let window, workspace, sessions, updates, accounts, agentControl, recovery, attachments, browser, defaultModels, modelCache;
let restartForUpdate = false;
let restartForAdministrator = false, administratorRestartPending = false;
const administrator = createAdministrator(app);
let pendingPaths = [...initialPaths];
app.on("second-instance", (_event, argv, cwd, data) => {
  const paths = Array.isArray(data?.openPaths) && data.openPaths.every((value) => typeof value === "string" && path.isAbsolute(value)) ? data.openPaths : openPaths(argv, cwd);
  pendingPaths.push(...paths);
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send("launch:pending");
  }
});
let dirtyEditors = 0;

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// \\server\share and //server/share reach another machine. Nothing in a chat
// link may touch the network before the person agrees to it.
const isNetworkPath = (value) => /^\\\\[^\\?.]/.test(value) || /^\/\/[^/]/.test(value);

// \\?\ and \\.\ name devices and namespaces, never a file in a chat.
const isDevicePath = (value) => /^\\\\[?.]\\/.test(value);

// Whatever an agent wrote becomes one plain path string here. No filesystem
// access and no judgement about which computer it belongs to: copying the path
// of a file on another machine has to work even when opening it here cannot.
function parseLinkPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim())
    throw new Error("That link has no file path.");
  let value = filePath.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.host && parsed.host.toLowerCase() !== "localhost") {
        // file://server/share/x is a UNC path, not a workspace-relative one.
        value = `\\\\${parsed.host}${parsed.pathname.replace(/\//g, "\\")}`;
      } else {
        value = parsed.pathname;
        // file:///C:/x and file://C:/x both mean C:/x on Windows.
        value = value.replace(/^\/([a-zA-Z]:[\\/])/, "$1");
      }
    } catch {
      value = value.replace(/^file:\/\/(?:localhost)?/i, "");
    }
  } else {
    // Markdown links often carry ?raw=1 or #L10; neither is part of the file name.
    value = value.replace(/[?#].*$/, "");
  }
  // Exactly one decode pass, here, for every shape: the renderer passes the raw
  // href through untouched so a literal %2520 does not become a space.
  return decodePath(value);
}

async function resolveLinkPath(filePath, root) {
  let value = parseLinkPath(filePath);
  // Check before anything else: "\\?\C:\Windows" must never turn into a
  // relative path, and a device name is never a file in a chat.
  if (isDevicePath(value))
    throw new Error("Lumen does not open device paths from chat links.");
  // A scheme we do not handle (ftp:, vscode:, ssh:, about:) is not a file path;
  // C:/ and C:\ are drive letters, not schemes.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value))
    throw new Error("Lumen can only open web links and files on this computer.");
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))
    value = path.join(app.getPath("home"), value.slice(1));
  // A drive or UNC path is absolute even when it came from another OS, but a
  // Windows path only resolves on Windows. Saying so beats a misleading "file
  // is gone" for a path that was never on this computer to begin with.
  if (process.platform !== "win32" && (/^[a-zA-Z]:[\\/]/.test(value) || isNetworkPath(value)))
    throw new Error(OTHER_COMPUTER_MESSAGE(value));
  if (!path.isAbsolute(value)) {
    if (!root) throw new Error("Open a workspace before opening its files.");
    value = path.resolve(root, value);
  }
  return path.normalize(value);
}

// Extensions that are never text even when their first bytes have no NUL:
// PDFs, Office/OpenDocument files, media containers and 3D binaries all belong
// with their viewer, not in the Monaco buffer.
const NEVER_TEXT_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".docm", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".pptm", ".odt", ".ods", ".odp",
  ".zip", ".7z", ".rar", ".gz", ".tgz", ".tar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".heic", ".tif", ".tiff", ".avif",
  ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus",
  ".glb", ".fbx", ".stl", ".ply", ".dae", ".usdz",
]);

async function isTextFile(file, size) {
  if (size > 2 * 1024 * 1024) return false;
  if (NEVER_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    // Binary files without a NUL in the first block (small PDFs, some formats)
    // still give themselves away by the share of control bytes they carry.
    let control = 0;
    for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control++;
    return sample.length === 0 || control / sample.length < 0.02;
  } finally {
    await handle.close();
  }
}

// A chat link is agent output, so a left click only ever hands PASSIVE file
// types to the OS: media, plain documents, archives and 3D assets. Active
// document formats (HTML, SVG, XML, macro-capable Office files), scripts,
// installers, shortcuts, .app bundles and unknown extensions are revealed in
// the file manager instead; the right-click menu can still open them after an
// explicit confirmation.
const PASSIVE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".heic", ".tif", ".tiff", ".avif",
  ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus",
  ".pdf", ".txt", ".md", ".markdown", ".csv", ".tsv", ".rtf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz",
  ".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply", ".dae", ".usdz",
  ".json", ".yaml", ".yml", ".toml", ".log", ".css",
]);
const UNSUPPORTED_MESSAGE = "Lumen does not launch this file type from a chat link. Right-click it and choose Open in default app if you trust it.";

// Types the OS runs instead of rendering. A chat link never starts one of
// these, not even through the right-click menu's confirmation: the person can
// open it from their own file manager, where they can see what it really is.
const ACTIVE_EXTENSIONS = new Set([
  ".exe", ".com", ".scr", ".pif", ".msi", ".msp", ".msix", ".msixbundle", ".appx", ".appxbundle", ".application",
  ".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".wsf", ".wsh", ".hta", ".js", ".jse", ".cpl", ".msc",
  ".lnk", ".url", ".scf", ".reg", ".jar", ".gadget", ".dll", ".ocx",
  ".sh", ".bash", ".zsh", ".command", ".desktop", ".run", ".bin", ".so", ".dylib",
  ".py", ".pyw", ".rb", ".pl", ".php", ".deb", ".rpm", ".pkg", ".dmg",
]);
const ACTIVE_MESSAGE = "Lumen will not run this file type from a chat link. It is selected in your file manager; open it from there if you trust it.";

function isPassiveTarget(target, stat) {
  if (stat.isDirectory()) return !target.toLowerCase().endsWith(".app");
  // Sockets, pipes and devices are never something a chat link should launch.
  if (!stat.isFile()) return false;
  return PASSIVE_EXTENSIONS.has(path.extname(target).toLowerCase());
}

function isActiveTarget(target, stat) {
  if (stat.isDirectory()) return target.toLowerCase().endsWith(".app");
  if (!stat.isFile()) return true;
  return ACTIVE_EXTENSIONS.has(path.extname(target).toLowerCase());
}

const OTHER_COMPUTER_MESSAGE = (target) =>
  `That file is on another computer, not on this one: ${target}. Right-click the link and choose Copy path to use it there.`;

async function statTarget(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    // Only a missing file is gone; permissions and I/O failures say what
    // actually happened so a real problem is not hidden behind "gone".
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) throw new Error(`That file is gone: ${target}`);
    if (["EACCES", "EPERM"].includes(error?.code)) throw new Error(`Lumen does not have permission to open ${target}.`);
    throw new Error(`Lumen could not open ${target}: ${error?.message || "unknown error"}`);
  }
}

// Walk a path one component at a time, following links with readlink only.
// Nothing on the far side is opened or stat-ed, so a local shortcut that points
// at a network share is caught before a single packet leaves this machine.
async function resolveLinkTargets(target) {
  let pending = path.resolve(target);
  for (let hops = 0; ; ) {
    const rootPart = path.parse(pending).root;
    const parts = pending.slice(rootPart.length).split(path.sep).filter(Boolean);
    let current = rootPart;
    let link = "";
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        // Keep the rest of the path so the "file is gone" message names what
        // the person actually clicked, not the last folder that exists.
        if (["ENOENT", "ENOTDIR"].includes(error?.code)) return pending;
        throw error;
      }
      if (!info.isSymbolicLink()) continue;
      if (++hops > 16)
        throw new Error(`Lumen could not follow that link: too many levels of shortcuts (${target}).`);
      link = path.resolve(path.dirname(current), await fs.readlink(current), ...parts.slice(index + 1));
      break;
    }
    if (!link) return current;
    // Hand a network destination back for confirmation before touching it.
    if (isNetworkPath(link)) return link;
    pending = link;
  }
}

// Resolve twice: first the path the person thinks they clicked, then the file
// it really is. A link named report.pdf that points at an executable is judged
// by what it points at, so the confirmation rules cannot be sidestepped. A
// real path that cannot be established fails closed: nothing is opened.
async function settleTarget(target) {
  const stat = await statTarget(target);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Lumen cannot open ${target}: it is not a file or folder.`);
  let real;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    throw new Error(`Lumen could not verify ${target}: ${error?.message || "unknown error"}`);
  }
  const realStat = real === target ? stat : await statTarget(real);
  if (!realStat.isFile() && !realStat.isDirectory())
    throw new Error(`Lumen cannot open ${real}: it is not a file or folder.`);
  return { stat, real, realStat };
}

async function confirmNetwork(...targets) {
  const network = targets.find((target) => typeof target === "string" && isNetworkPath(target));
  if (!network) return true;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["Cancel", "Open"],
    defaultId: 0,
    cancelId: 0,
    title: "Open a network path?",
    message: network,
    detail: "This path is on another computer. Opening it contacts that machine first.",
  });
  return response === 1;
}

// Linux reports success from openPath even when no application is registered,
// so ask the same lookup the desktop uses. Elsewhere the string is reliable.
function hasFileHandler(target) {
  if (process.platform !== "linux") return Promise.resolve(true);
  const query = (args) => new Promise((resolve) =>
    execFile("xdg-mime", args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : String(stdout).trim())));
  return query(["query", "filetype", target]).then((mime) => mime ? query(["query", "default", mime]).then(Boolean) : false);
}

async function revealTarget(target, stat, error) {
  shell.showItemInFolder(target);
  return { kind: "unsupported", error, folder: stat.isDirectory() ? target : path.dirname(target) };
}

// Resolve the link without touching its destination, ask before any network
// access, then settle the target. Everything that opens uses the canonical
// path, so a link swapped mid-flight cannot redirect the launch.
async function settleLink(filePath, root) {
  const target = await resolveLinkPath(filePath, root);
  if (!await confirmNetwork(target)) return null;
  const resolved = await resolveLinkTargets(target);
  if (resolved !== target && !await confirmNetwork(resolved)) return null;
  return settleTarget(resolved);
}

async function openLink(filePath, root) {
  const settled = await settleLink(filePath, root);
  if (!settled) return { kind: "cancel" };
  const { real, realStat } = settled;
  const rootPath = typeof root === "string" && root ? path.resolve(root) : "";
  if (realStat.isFile() && rootPath) {
    // Compare real paths on both sides so a workspace opened through a symlink
    // still counts as the workspace.
    const realRoot = await fs.realpath(rootPath).catch(() => rootPath);
    if (inside(realRoot, real) && await isTextFile(real, realStat.size))
      return { kind: "editor", relative: path.relative(realRoot, real).split(path.sep).join("/") };
  }
  if (isActiveTarget(real, realStat))
    return revealTarget(real, realStat, ACTIVE_MESSAGE);
  if (!isPassiveTarget(real, realStat))
    return revealTarget(real, realStat, UNSUPPORTED_MESSAGE);
  if (!await hasFileHandler(real))
    return revealTarget(real, realStat, `No app on this computer opens ${path.extname(real) || "this file type"}. Open it from the folder below, or pick a default app in your settings.`);
  const error = await shell.openPath(real);
  if (!error) return { kind: "external" };
  // No app registered for this type: put it on screen instead of leaving the
  // click dead.
  return revealTarget(real, realStat, error);
}

async function showInFolder(filePath, root) {
  const target = await resolveLinkPath(filePath, root);
  if (!await confirmNetwork(target)) return { kind: "cancel" };
  const resolved = await resolveLinkTargets(target);
  if (resolved !== target && !await confirmNetwork(resolved)) return { kind: "cancel" };
  const stat = await statTarget(resolved);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Lumen cannot show ${resolved} in a file manager.`);
  shell.showItemInFolder(resolved);
  return { kind: "done" };
}

async function openLinkExplicitly(filePath, root) {
  // The right-click menu path: the person pointed at this file themselves.
  // Executables and scripts still do not launch from a chat link; passive and
  // unknown formats open after a confirmation.
  const settled = await settleLink(filePath, root);
  if (!settled) return { kind: "cancel" };
  const { real, realStat } = settled;
  if (isActiveTarget(real, realStat))
    return revealTarget(real, realStat, ACTIVE_MESSAGE);
  if (!isPassiveTarget(real, realStat)) {
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["Cancel", "Open anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Open this file?",
      message: path.basename(real),
      detail: "Agent-provided files can run code. Only open it if you trust what produced it.",
      noLink: true,
    });
    if (response !== 1) return { kind: "cancel" };
  }
  const error = await shell.openPath(real);
  if (!error) return { kind: "external" };
  return revealTarget(real, realStat, error);
}
let allowClose = false,
  closeTimer;
const devURL = process.env.LUMEN_DEV === "1" ? "http://127.0.0.1:5173" : "";
const fileURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame)
      return { error: "Only Lumen's main app frame can manage this action." };
    if (
      event.senderFrame?.url !== fileURL &&
      !(devURL && event.senderFrame?.url.startsWith(`${devURL}/`))
    )
      return { error: "Untrusted frame." };
    try {
      return { data: await callback(...args) };
    } catch (error) {
      return { error: error.message };
    }
  });
}
startup.then(async (start) => {
  if (!start) return;
  await app.whenReady();
  const dataDir = app.getPath("userData");
  workspace = new WorkspaceService(dataDir);
  await workspace.init();
  let googleInstall;
  const installGoogle = () => googleInstall ||= require("./google.cjs").install(dataDir, resolveLauncher).finally(() => { googleInstall = null; });
  accounts = new Accounts(dataDir, resolveLauncher, (event) => {
    if (window && !window.isDestroyed()) window.webContents.send("accounts:event", event);
  }, (id) => [...(sessions?.sessions.values() || [])].some((s) => s.accountId === id), installGoogle);
  await accounts.init();
  recovery = new RecoveryStore(dataDir);
  attachments = new Attachments(dataDir);
  modelCache = new ModelCache(dataDir, accounts);
  sessions = new Sessions(workspace, dataDir, (event) => {
    if (window && !window.isDestroyed())
      window.webContents.send("session:event", event);
  }, accounts, recovery, attachments, modelCache);
  defaultModels = new DefaultModels(sessions, accounts, resolveLauncher, modelCache);
  handle("agents:models", (config, refresh) => defaultModels.list(config, refresh));
  handle("recovery:load", () => recovery.load());
  handle("recovery:save", (value) => recovery.saveWorkspace(value));
  handle("recovery:update", (controlId, changes) => recovery.update(controlId, changes));
  handle("attachments:paste", (id) => attachments.paste(sessions.get(id).controlId));
  handle("attachments:choose", (id) => attachments.choose(window, sessions.get(id).controlId));
  handle("attachments:import", (id, files) => attachments.import(sessions.get(id).controlId, files));
  agentControl = new AgentControl({ dataDir, window: () => window, browser: (body) => {
    if (!browser) throw new Error("Lumen's browser is starting.");
    return browser.control(body);
  }, notify: (status) => {
    if (window && !window.isDestroyed()) window.webContents.send("agent-control:status", status);
  } });
  handle("agent-control:status", () => agentControl.status());
  handle("agent-control:change", (enabled) => agentControl.change(enabled));
  handle("agent-control:ready", (ready) => agentControl.setReady(ready === true));
  handle("agent-control:reply", (id, result) => agentControl.reply(id, result));
  handle("agent-control:claim", (id) => !!agentControl.server && agentControl.ready && agentControl.pending.has(id));
  try { await agentControl.init(); } catch (e) { agentControl.error = e.message; }
  handle("accounts:list", () => accounts.list());
  handle("accounts:add", (value) => accounts.add(value));
  handle("accounts:change", (id, value) => accounts.change(id, value));
  handle("accounts:system", (agent) => accounts.useSystem(agent));
  handle("accounts:remove", (id) => accounts.remove(id));
  handle("accounts:login", (id, command) => accounts.login(id, command));
  const signInAgent = async (agent, accountId, command) => {
    if (!["claude", "codex", "grok", "pi", "google"].includes(agent)) throw new Error("Choose an agent to sign in.");
    const chats = [...sessions.sessions.values()].filter((s) => s.agent === agent && (s.accountId || "") === accountId);
    if (chats.some((s) => s.busy || s.stopping || s.transitioning || s.setting || s.nativeStart || s.mode === "native"))
      throw new Error("Finish this account's running turns and switch its native terminals to readable view before signing in.");
    const release = accounts.reserveLogin(agent, accountId);
    modelCache.invalidate(agent);
    for (const s of chats) { clearTimeout(s.catalogWarmTimer); s.catalog = null; s.catalogAt = 0; s.catalogCached = false; }
    for (const s of chats) { s.authInvalid = true; s.authChanged = true; s.claudeAuthInvalid = true; s.claudeAuthChanged = true; s.setting = true; }
    try {
      await defaultModels.invalidate(agent);
      for (const s of chats) {
        await sessions.cancelDiscovery(s);
        const child = s.process;
        s.runtime?.close("Signing in. Reconnecting on the next turn.");
        if (child && s.process === child) { s.process = null; await sessions.kill(child); }
        s.piPolicyReady = false; s.piMcpSupported = undefined; s.piCompacting = false;
        await accounts.syncClaude(s);
        await accounts.syncGrok(s);
      }
      return await (accountId ? accounts.login(accountId, command, true) : accounts.loginDefault(agent, command));
    } finally { release(); for (const s of chats) s.setting = false; }
  };
  handle("accounts:login-default", (agent, command) => signInAgent(agent, "", command));
  handle("accounts:login-session", (id) => {
    const s = sessions.get(id);
    return signInAgent(s.agent, s.accountId || "", s.command);
  });
  handle("accounts:verify", (id) => accounts.verify(id));
  handle("accounts:write", (id, data) => accounts.write(id, data));
  handle("accounts:resize", (id, cols, rows) => accounts.resize(id, cols, rows));
  handle("accounts:buffer", (id) => accounts.buffer(id));
  handle("accounts:cancel", (id) => accounts.cancel(id));
  updates = createUpdates({ app, notify: (status) => {
    if (window && !window.isDestroyed()) window.webContents.send("updates:status", status);
  } });
  handle("updates:status", () => updates.status());
  handle("updates:check", () => updates.check());
  handle("updates:install", () => {
    if (administratorRestartPending || restartForAdministrator) return false;
    if (updates.status().phase !== "downloaded") return false;
    restartForUpdate = true;
    window.close();
    return restartForUpdate;
  });
  handle("agents:install-google", installGoogle);
  handle("bootstrap", async () => ({
    recent: workspace.recent,
    platform: process.platform,
    administrator: await administrator.status(),
    agents: Object.fromEntries(
      ["pi", "codex", "claude", "grok", "google"].map((agent) => {
        try {
          const launcher = resolveLauncher(agent === "google" ? "agy" : agent);
          return [agent, { available: true, file: launcher.file }];
        } catch (error) {
          return [agent, { available: false, error: error.message }];
        }
      }),
    ),
  }));
  handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "Open a workspace",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : workspace.open(result.filePaths[0]);
  });
  handle("workspace:open", (root) => workspace.open(root));
  handle("workspace:inspect", (root) => workspace.inspect(root));
  handle("workspace:register", (root) => workspace.register(root));
  handle("launch:take", () => pendingPaths.splice(0));
  handle("launch:resolve", (target) => resolveOpenPath(workspace, target));
  handle("files:tree", (root, relative) => workspace.tree(root, relative));
  handle("files:read", (root, file) => workspace.read(root, file));
  handle("files:save", (root, file, content, version) =>
    workspace.save(root, file, content, version),
  );
  handle("files:create", (root, file) => workspace.create(root, file));
  handle("files:search", (root, query) => workspace.searchFiles(root, query));
  handle("git:status", (root) => workspace.status(root));
  handle("git:action", (root, action, payload) =>
    workspace.action(root, action, payload),
  );
  handle("git:diff", (root, file, staged, original) =>
    workspace.diff(root, file, staged, original),
  );
  handle("git:worktree", (root, branch, base) =>
    workspace.worktree(root, branch, base),
  );
  handle("git:prs", (root) => workspace.prs(root));
  handle("session:create", (options) => { const created = sessions.create(options); accounts.notify({ type: "changed" }); return created; });
  handle("session:start", (id) => sessions.startNative(id));
  handle("session:send", (id, message, metadata) => sessions.send(id, message, metadata));
  handle("session:submit", (id, message) => sessions.submit(id, message));
  handle("session:queue-action", (id, messageId, action) => sessions.queueAction(id, messageId, action));
  handle("session:stop", (id, force) => sessions.stop(id, force === true));
  handle("session:reconnect", (id) => sessions.reconnect(id));
  handle("session:close", async (id) => {
    const session = sessions.sessions.get(id);
    const controlId = session?.controlId || recovery.state.tabs.find((tab) => tab.id === id || tab.controlId === id)?.controlId;
    if (session) await sessions.close(id);
    if (controlId) browser?.discard(controlId);
    if (controlId) recovery.remove(controlId);
    accounts.notify({ type: "changed" });
  });
  handle("session:write", (id, data, terminalId) => sessions.write(id, data, terminalId));
  handle("session:resize", (id, cols, rows, terminalId) => sessions.resize(id, cols, rows, terminalId));
  handle("session:buffer", (id, terminalId) => sessions.terminalBuffer(id, terminalId));
  handle("session:pi-response", (id, response) =>
    sessions.piResponse(id, response),
  );
  handle("session:mode", (id, mode) => sessions.setMode(id, mode));
  handle("session:commands", (id, refresh) => sessions.commands(id, refresh));
  handle("session:models", (id, refresh) => sessions.models(id, refresh));
  handle("session:configure", (id, change) => sessions.configure(id, change));
  handle("session:controls", (id) => sessions.sessionControls(id));
  handle("session:controls-change", (id, change) => sessions.changeControls(id, change));
  handle("session:shortcuts", (id) => sessions.get(id).agent === "pi" ? require("./models.cjs").piShortcuts() : {});
  handle("editor:dirty", (count) => {
    dirtyEditors = Number(count) || 0;
  });
  handle("settings:load", async () => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(dataDir, "settings.json"), "utf8"),
      );
    } catch {
      return null;
    }
  });
  handle("settings:save", (settings) =>
    fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify(settings)),
  );
  handle("chat:export", async ({ name, text } = {}) => {
    if (typeof text !== "string" || !text.trim())
      throw new Error("This chat has nothing to export yet.");
    let base = String(name || "Chat")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Chat";
    // Windows refuses CON, NUL, COM1 and friends as file names even with an
    // extension, so a chat named after one still saves.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base.split(".")[0])) base = `Chat ${base}`;
    const result = await dialog.showSaveDialog(window, {
      title: "Export chat",
      defaultPath: path.join(app.getPath("downloads"), `${base}.md`),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Plain text", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) return { kind: "canceled" };
    await fs.writeFile(result.filePath, text, "utf8");
    return { kind: "saved", path: result.filePath };
  });
  handle("external:open", async (url) => {
    const parsed = new URL(url);
    if (!["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol))
      throw new Error("Lumen opens web, email and phone links externally.");
    await shell.openExternal(url);
  });
  // Chat file links: resolve whatever the agent wrote (Windows or POSIX absolute,
  // ~, file:// URL, or workspace-relative) and open it the right way. Text files
  // inside the workspace go to the editor; everything else goes to the OS.
  handle("file:open-link", (filePath, root) => openLink(filePath, root));
  handle("file:link-menu", (filePath, root) => new Promise((resolve) => {
    let pending = null;
    const task = (work) => { pending = Promise.resolve().then(work); };
    const menu = Menu.buildFromTemplate([
      { label: "Open", click: () => task(() => openLink(filePath, root)) },
      { label: "Open in default app", click: () => task(() => openLinkExplicitly(filePath, root)) },
      { label: "Show in folder", click: () => task(() => showInFolder(filePath, root)) },
      { type: "separator" },
      // Copy the path as written, even when it belongs to another computer:
      // resolving it here is exactly what failed for a path that is not local.
      { label: "Copy path", click: () => task(async () => {
        const value = parseLinkPath(filePath);
        clipboard.writeText(path.isAbsolute(value) || !root ? value : path.resolve(root, value));
        return { kind: "done" };
      }) },
    ]);
    menu.popup({
      window,
      callback: () => { Promise.resolve(pending).then(resolve, (error) => resolve({ kind: "error", error: error.message })); },
    });
  }));
  handle("window:action", (action) => {
    if (action === "minimize") window.minimize();
    else if (action === "maximize")
      window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === "close") window.close();
  });
  handle("administrator:status", () => administrator.status());
  handle("administrator:restart", async () => {
    if (administratorRestartPending || restartForAdministrator || restartForUpdate || allowClose) return { started: false, cancelled: false };
    // Save edits explicitly; a privilege change must not discard work.
    if (dirtyEditors) throw new Error("Save your unsaved files before restarting as administrator.");
    if (!confirmClose(true)) return { started: false, cancelled: true };
    administratorRestartPending = true;
    try {
      const result = await administrator.restart();
      if (result.started) {
        restartForAdministrator = true;
        updates.suspendInstall();
        window.close();
      }
      return result;
    } finally { administratorRestartPending = false; }
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 420,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: "#17191e",
    icon: path.join(__dirname, "../dist/lumen.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.removeMenu();
  browser = new BrowserService(window, dataDir, (chatId) => [...sessions.sessions.values()].some((session) => session.controlId.toLowerCase() === String(chatId).toLowerCase())
    || recovery.state.tabs.some((tab) => tab.controlId.toLowerCase() === String(chatId).toLowerCase()));
  handle("browser:activate", (chatId, workspace) => browser.activate(chatId, workspace));
  handle("browser:snapshot", (chatId, workspace) => browser.snapshot(chatId, workspace));
  handle("browser:discard", (chatId) => browser.discard(chatId));
  handle("browser:link-menu", (value) => {
    const url = browserURL(value);
    if (url === "about:blank") throw new Error("Choose a web link.");
    return new Promise((resolve) => {
      let choice = null;
      const menu = Menu.buildFromTemplate([
        { label: "Open in Lumen browser", click: () => { choice = "embedded"; } },
        { label: "Open in main browser", click: () => { choice = "external"; } },
        { type: "separator" },
        { label: "Copy link address", click: () => clipboard.writeText(url) },
      ]);
      menu.popup({ window, callback: () => resolve(choice) });
    });
  });
  handle("browser:layout", (bounds) => browser.layout(bounds));
  // Synchronous hide: the renderer calls this while committing a chat or tab switch so
  // the previous page is gone before the next frame paints, not a few frames later.
  ipcMain.on("browser:hide-now", (event) => {
    const trusted = event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame
      && (event.senderFrame?.url === fileURL || (devURL && event.senderFrame?.url.startsWith(`${devURL}/`)));
    // This call blocks the renderer until returnValue is set: never leave it hanging, even if
    // the browser throws.
    try { if (trusted) browser.hideNow(); } catch { /* keep the renderer moving */ }
    event.returnValue = trusted;
  });
  ipcMain.on("browser:switch-now", (event, chatId, workspace, box, paint) => {
    const trusted = event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame
      && (event.senderFrame?.url === fileURL || (devURL && event.senderFrame?.url.startsWith(`${devURL}/`)));
    try { if (trusted) browser.switchNow(chatId, workspace, box, paint === true); } catch { /* keep the renderer moving */ }
    event.returnValue = trusted;
  });
  handle("browser:action", (body) => {
    if (body?.action === "evaluate") throw new Error("Page scripts use the authenticated local agent API.");
    return browser.control(body);
  });
  handle("browser:attach", async (id, sessionId, marks, captureToken = "") => {
    const chat = sessions.get(sessionId);
    const { image, page } = await browser.captureContext(id, marks, captureToken);
    return { attachment: await attachments.save(chat.controlId, image, marks?.length ? "Browser screenshot (markup).png" : "Browser screenshot.png"), page };
  });
  installZoom(window.webContents, dataDir);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("did-start-loading", () => agentControl.setReady(false));
  window.webContents.on("render-process-gone", () => agentControl.setReady(false));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== fileURL && !(devURL && url.startsWith(`${devURL}/`)))
      event.preventDefault();
  });
  window.on("close", (event) => {
    if (allowClose) return;
    if (!restartForAdministrator && (administratorRestartPending || !confirmClose())) {
      restartForUpdate = false;
      event.preventDefault();
      return;
    }
    event.preventDefault();
    agentControl.setReady(false);
    window.webContents.send("app:closing");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      allowClose = true;
      window.close();
    }, 2500);
  });
  ipcMain.on("app:ready-to-close", (event) => {
    if (event.sender !== window.webContents) return;
    clearTimeout(closeTimer);
    allowClose = true;
    window.close();
  });
  window.once("ready-to-show", () => {
    if (process.env.LUMEN_HIDDEN !== "1") window.show();
  });
  await window.loadURL(devURL || fileURL);
  updates.start();
}).catch((error) => { dialog.showErrorBox("Lumen could not start", error.message); app.exit(1); });
function confirmClose(restarting = false) {
  if (!dirtyEditors && ![...sessions.sessions.values()].some((s) => s.busy || s.pty)) return true;
  return dialog.showMessageBoxSync(window, {
    type: "question",
    buttons: ["Keep working", restarting ? "Restart and stop sessions" : "Close and stop sessions"],
    defaultId: 0, cancelId: 0,
    message: dirtyEditors ? "Some files have unsaved changes." : "An agent, command, or native terminal is still open.",
    detail: restarting
      ? "Restarting as administrator stops running sessions. Your chats and CLI session history will be restored; continue agents with your next message. Windows will ask for administrator access."
      : "Closing Lumen discards unsaved editor changes and stops its processes. Saved files and CLI session history remain available.",
  }) === 1;
}
app.on("window-all-closed", async () => {
  await agentControl?.stop().catch(() => {});
  accounts?.dispose();
  try {
    await defaultModels?.close();
    await sessions?.closeAll();
  } catch {}
  try { recovery?.flush(); } catch {}
  modelCache?.flush();
  updates?.dispose();
  if (restartForUpdate && updates?.install()) return;
  app.quit();
});
