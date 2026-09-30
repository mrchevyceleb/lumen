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
app.setName("Lumen");
if (process.env.LUMEN_TEST_DATA)
  app.setPath("userData", process.env.LUMEN_TEST_DATA);
const initialPaths = openPaths(process.argv);
if (!app.requestSingleInstanceLock({ openPaths: initialPaths })) app.exit(0);
let window, workspace, sessions;
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
app.whenReady().then(async () => {
  const dataDir = app.getPath("userData");
  workspace = new WorkspaceService(dataDir);
  await workspace.init();
  sessions = new Sessions(workspace, dataDir, (event) => {
    if (window && !window.isDestroyed())
      window.webContents.send("session:event", event);
  });
  handle("bootstrap", async () => ({
    recent: workspace.recent,
    platform: process.platform,
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
  handle("session:create", (options) => sessions.create(options));
  handle("session:start", (id) => sessions.startNative(id));
  handle("session:send", (id, message) => sessions.send(id, message));
  handle("session:stop", (id) => sessions.stop(id));
  handle("session:close", (id) => sessions.close(id));
  handle("session:write", (id, data) => sessions.write(id, data));
  handle("session:resize", (id, cols, rows) => sessions.resize(id, cols, rows));
  handle("session:buffer", (id) => sessions.terminalBuffer(id));
  handle("session:pi-response", (id, response) =>
    sessions.piResponse(id, response),
  );
  handle("session:mode", (id, mode) => sessions.setMode(id, mode));
  handle("session:commands", (id, refresh) => sessions.commands(id, refresh));
  handle("session:models", (id, refresh) => sessions.models(id, refresh));
  handle("session:configure", (id, change) => sessions.configure(id, change));
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
    },
  });
  window.removeMenu();
  installZoom(window.webContents, dataDir);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== fileURL && !(devURL && url.startsWith(`${devURL}/`)))
      event.preventDefault();
  });
  window.on("close", (event) => {
    if (allowClose) return;
    if (
      dirtyEditors ||
      [...sessions.sessions.values()].some((s) => s.busy || s.pty)
    ) {
      const response = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["Keep working", "Close and stop sessions"],
        defaultId: 0,
        cancelId: 0,
        message: dirtyEditors
          ? "Some files have unsaved changes."
          : "An agent, command, or native terminal is still open.",
        detail:
          "Closing Lumen discards unsaved editor changes and stops its processes. Saved files and CLI session history remain available.",
      });
      if (response === 0) {
        event.preventDefault();
        return;
      }
    }
    event.preventDefault();
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
});
app.on("window-all-closed", async () => {
  try {
    await sessions?.closeAll();
  } catch {}
  app.quit();
});
