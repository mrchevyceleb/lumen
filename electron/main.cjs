const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const {
  WorkspaceService,
  Sessions,
  resolveLauncher,
} = require("./services.cjs");
const { installZoom } = require("./zoom.cjs");
const { openPaths, resolveOpenPath } = require("./launch.cjs");
const { createUpdates } = require("./updates.cjs");
const { Accounts } = require("./accounts.cjs");
const { AgentControl } = require("./agent-control.cjs");
const { createAdministrator, restoreRestartProfile, waitForRestartParent } = require("./administrator.cjs");
const { RecoveryStore } = require("./recovery.cjs");
const { Attachments } = require("./attachments.cjs");
app.setName("Lumen");
if (process.env.LUMEN_TEST_DATA)
  app.setPath("userData", process.env.LUMEN_TEST_DATA);
restoreRestartProfile(app);
const initialPaths = openPaths(process.argv);
const startup = waitForRestartParent().then(() => {
  if (!app.requestSingleInstanceLock({ openPaths: initialPaths })) { app.exit(0); return false; }
  return true;
});
let window, workspace, sessions, updates, accounts, agentControl, recovery, attachments;
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
let allowClose = false,
  closeTimer;
const devURL = process.env.LUMEN_DEV === "1" ? "http://127.0.0.1:5173" : "";
const fileURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    if ((name.startsWith("agent-control:") || name.startsWith("administrator:") || name.startsWith("attachments:") || name.startsWith("recovery:")) && (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame))
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
  accounts = new Accounts(dataDir, resolveLauncher, (event) => {
    if (window && !window.isDestroyed()) window.webContents.send("accounts:event", event);
  }, (id) => [...(sessions?.sessions.values() || [])].some((s) => s.accountId === id));
  await accounts.init();
  recovery = new RecoveryStore(dataDir);
  attachments = new Attachments(dataDir);
  sessions = new Sessions(workspace, dataDir, (event) => {
    if (window && !window.isDestroyed())
      window.webContents.send("session:event", event);
  }, accounts, recovery, attachments);
  handle("recovery:load", () => recovery.load());
  handle("recovery:save", (value) => recovery.saveWorkspace(value));
  handle("recovery:update", (controlId, changes) => recovery.update(controlId, changes));
  handle("attachments:paste", (id) => attachments.paste(sessions.get(id).controlId));
  handle("attachments:choose", (id) => attachments.choose(window, sessions.get(id).controlId));
  handle("attachments:import", (id, files) => attachments.import(sessions.get(id).controlId, files));
  agentControl = new AgentControl({ dataDir, window: () => window, notify: (status) => {
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
    if (!["claude", "codex", "grok", "pi"].includes(agent)) throw new Error("Choose an agent to sign in.");
    const chats = [...sessions.sessions.values()].filter((s) => s.agent === agent && (s.accountId || "") === accountId);
    if (chats.some((s) => s.busy || s.stopping || s.transitioning || s.setting || s.nativeStart || s.mode === "native"))
      throw new Error("Finish this account's running turns and switch its native terminals to readable view before signing in.");
    const release = accounts.reserveLogin(agent, accountId);
    for (const s of chats) { s.authInvalid = true; s.authChanged = true; s.claudeAuthInvalid = true; s.claudeAuthChanged = true; s.setting = true; }
    try {
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
  handle("bootstrap", async () => ({
    recent: workspace.recent,
    platform: process.platform,
    administrator: await administrator.status(),
    agents: Object.fromEntries(
      ["pi", "codex", "claude", "grok"].map((agent) => {
        try {
          const launcher = resolveLauncher(agent);
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
  handle("git:diff", (root, file, staged) =>
    workspace.diff(root, file, staged),
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
  handle("external:open", async (url) => {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error("Only web links can open externally.");
    await shell.openExternal(url);
  });
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
    minWidth: 900,
    minHeight: 650,
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
    await sessions?.closeAll();
  } catch {}
  try { recovery?.flush(); } catch {}
  updates?.dispose();
  if (restartForUpdate && updates?.install()) return;
  app.quit();
});
