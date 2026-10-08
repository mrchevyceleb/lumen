const { WebContentsView, session, Menu, clipboard, app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function browserURL(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Enter a web address.");
  const input = value.trim();
  if (!input || input === "about:blank") return "about:blank";
  const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const hostWithPort = /^(?:\[[\da-f:]+\]|[^/?#:\s]+):\d+(?:[/?#]|$)/i.test(input);
  const url = new URL(/^[a-z][\w+.-]*:/i.test(input) && !local && !hostWithPort ? input : `${local ? "http" : "https"}://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP or HTTPS address without embedded credentials.");
  return url.href;
}
function webURL(url) { try { return browserURL(url) === url; } catch { return false; } }
function localOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  } catch { return false; }
}
const MAX_TABS = 32;

class BrowserService {
  constructor(window, directory, knownWorkspace = () => true) {
    this.window = window;
    this.file = path.join(directory, "browser.json");
    this.groups = new Map();
    this.workspace = "";
    this.visible = false;
    this.bounds = null;
    this.attached = null;
    this.popups = new Set();
    this.knownWorkspace = knownWorkspace;
    this.profile = session.fromPartition("persist:lumen-browser");
    const networks = new Set(["local-network", "local-network-access", "loopback-network"]);
    const permitted = (permission, origin) => permission === "clipboard-sanitized-write" || (networks.has(permission) && localOrigin(origin));
    this.profile.setPermissionCheckHandler((_contents, permission, origin) => permitted(permission, origin));
    this.profile.setPermissionRequestHandler((contents, permission, callback, details) => callback(permitted(permission, details.requestingUrl || contents?.getURL())));
    this.profile.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({ title: "Save browser download", defaultPath: path.join(app.getPath("downloads"), path.basename(item.getFilename())) });
    });
    // Sites get Chromium's normal network/TLS checks and no Lumen preload or Node access.
    this.preferences = { session: this.profile, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      let remaining = MAX_TABS;
      for (const group of (saved.groups || []).slice(0, 128)) {
        if (typeof group.workspace !== "string" || !Array.isArray(group.tabs)) continue;
        const tabs = group.tabs.slice(0, Math.min(24, remaining)).flatMap((tab) => {
          try { return [{ id: crypto.randomUUID(), url: browserURL(tab.url), title: String(tab.title || "New tab").slice(0, 200), error: "", console: [] }]; }
          catch { return []; }
        });
        remaining -= tabs.length;
        this.groups.set(group.workspace, { tabs, activeId: tabs[group.activeIndex]?.id || tabs[0]?.id || "" });
      }
    } catch { /* A new profile starts with an empty browser. */ }
    window.webContents.on("did-start-loading", () => this.layout(null));
    window.on("closed", () => this.dispose());
  }
  group(workspace = this.workspace) {
    if (typeof workspace !== "string" || workspace.length > 8192) throw new Error("Invalid browser workspace.");
    if (!this.groups.has(workspace)) {
      for (const [key, group] of this.groups) if (key !== this.workspace && !group.tabs.length) this.groups.delete(key);
      if (this.groups.size >= 128) throw new Error("The browser has reached its saved-workspace limit.");
      this.groups.set(workspace, { tabs: [], activeId: "" });
    }
    return this.groups.get(workspace);
  }
  metadata(tab) {
    const contents = tab.view?.webContents;
    const live = contents && !contents.isDestroyed();
    return { id: tab.id, title: tab.title, url: tab.url, error: tab.error, unloaded: !live && tab.url !== "about:blank",
      loading: !!live && contents.isLoading(), canGoBack: !!live && contents.navigationHistory.canGoBack(),
      canGoForward: !!live && contents.navigationHistory.canGoForward() };
  }
  state() {
    const group = this.group();
    return { workspace: this.workspace, activeId: group.activeId, tabs: group.tabs.map((tab) => this.metadata(tab)) };
  }
  emit(save = false) {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) this.window.webContents.send("browser:state", this.state());
    if (save) { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 250); }
  }
  createFromPage(workspace, url) {
    try { return this.create(workspace, url); }
    catch (error) {
      if (!this.window.isDestroyed()) this.window.webContents.send("browser:state", { ...this.state(), error: error.message });
    }
  }
  save() {
    try {
      const groups = [...this.groups].filter(([, group]) => group.tabs.length).map(([workspace, group]) => ({ workspace, activeIndex: group.tabs.findIndex((tab) => tab.id === group.activeId),
        tabs: group.tabs.map(({ url, title }) => ({ url, title })) }));
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ groups }));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (error) { console.warn("Could not save browser tabs:", error.message); }
  }
  activate(workspace) {
    this.layout(null);
    if (workspace !== this.workspace && !this.groups.get(this.workspace)?.tabs.length) this.groups.delete(this.workspace);
    this.workspace = workspace;
    this.group();
    this.emit();
    return this.state();
  }
  find(id) {
    for (const [workspace, group] of this.groups) {
      const tab = group.tabs.find((tab) => tab.id === id);
      if (tab) return { workspace, group, tab };
    }
    throw new Error("This browser tab is closed.");
  }
  guard(contents) {
    const prevent = (event, url) => { if (!webURL(url)) event.preventDefault(); };
    contents.on("will-navigate", prevent);
    contents.on("will-redirect", prevent);
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && /^(blob:|data:|about:(blank|srcdoc)$)/.test(event.url)) return;
      if (!webURL(event.url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  }
  ensure(tab) {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = new WebContentsView({ webPreferences: this.preferences });
    tab.view = view;
    // Background agent previews need a viewport even before the tab is shown.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    view.setBackgroundColor("#ffffff");
    const contents = view.webContents;
    // A regular Chromium user agent avoids sites unnecessarily rejecting Electron.
    contents.setUserAgent(contents.getUserAgent().replace(/\s(?:Electron|lumen-workspace|Lumen)\/\S+/g, ""));
    this.guard(contents);
    contents.setWindowOpenHandler(({ url }) => webURL(url) ? { action: "allow", overrideBrowserWindowOptions: {
      parent: this.window, width: 1000, height: 760, autoHideMenuBar: true, webPreferences: this.preferences,
    } } : { action: "deny" });
    contents.on("did-create-window", (popup) => {
      this.popups.add(popup);
      popup.on("closed", () => this.popups.delete(popup));
      this.guard(popup.webContents);
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    });
    const update = (save = false) => {
      if (contents.isDestroyed()) return;
      const url = contents.getURL();
      if (webURL(url) && (!contents.isLoadingMainFrame() || url === tab.pendingURL) && (url !== "about:blank" || tab.url === "about:blank")) tab.url = url;
      tab.title = (contents.getTitle() || (tab.url === "about:blank" ? "New tab" : tab.url)).slice(0, 200);
      this.emit(save);
    };
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      tab.generation = (tab.generation || 0) + 1; tab.pendingURL = details.url;
      if (webURL(details.url)) tab.url = details.url;
      tab.error = "";
    });
    contents.on("did-redirect-navigation", (details) => { if (details.isMainFrame) tab.pendingURL = details.url; });
    contents.on("did-start-loading", () => { tab.error = ""; update(); });
    contents.on("did-stop-loading", () => update(true));
    contents.on("did-navigate", () => update(true));
    contents.on("did-navigate-in-page", () => update(true));
    contents.on("page-title-updated", () => update(true));
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === -3 || url !== tab.pendingURL) return;
      tab.error = `${description} — ${url}`; this.sync(); this.emit();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.error = `Page stopped (${details.reason}). Reload to reopen it.`; this.sync(); this.emit();
    });
    contents.on("console-message", (details) => {
      tab.console.push({ level: details.level, message: String(details.message).slice(0, 2000) });
      if (tab.console.length > 50) tab.console.shift();
    });
    contents.on("context-menu", (_event, params) => Menu.buildFromTemplate([
      { label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: "Reload", click: () => contents.reload() }, { type: "separator" },
      { label: "Copy page address", click: () => clipboard.writeText(tab.url) },
      ...(params.linkURL && webURL(params.linkURL) ? [{ label: "Open link in new tab", click: () => this.createFromPage(this.find(tab.id).workspace, params.linkURL) }] : []),
      { label: "Inspect element", click: () => contents.inspectElement(params.x, params.y) },
    ]).popup({ window: this.window }));
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isComposing) return;
      const key = input.key.toLowerCase(), control = input.control || input.meta;
      if (control && key === "l") { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.send("browser:command", "address"); }
      else if (control && input.shift && key === "b") { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.send("browser:command", "hide"); }
      else if (control && key === "t") { event.preventDefault(); this.window.webContents.focus(); this.createFromPage(this.find(tab.id).workspace); }
      else if (control && key === "w") { event.preventDefault(); this.close(tab.id); }
      else if (key === "f12") { event.preventDefault(); contents.openDevTools({ mode: "detach" }); }
      else if (key === "f5" || (control && key === "r")) { event.preventDefault(); input.shift ? contents.reloadIgnoringCache() : contents.reload(); }
      else if (input.alt && key === "arrowleft" && contents.navigationHistory.canGoBack()) { event.preventDefault(); contents.navigationHistory.goBack(); }
      else if (input.alt && key === "arrowright" && contents.navigationHistory.canGoForward()) { event.preventDefault(); contents.navigationHistory.goForward(); }
      else if (control && ["+", "=", "-", "0"].includes(key)) {
        event.preventDefault(); contents.setZoomFactor(key === "0" ? 1 : Math.max(0.5, Math.min(2, contents.getZoomFactor() + (key === "-" ? -0.1 : 0.1))));
      }
    });
    this.load(tab, tab.url);
    return view;
  }
  load(tab, url) {
    tab.url = url; tab.pendingURL = url; tab.error = ""; tab.console = [];
    const generation = tab.generation = (tab.generation || 0) + 1, contents = tab.view.webContents;
    tab.ready = contents.loadURL(url);
    tab.ready.catch((error) => {
      if (error.code === "ERR_ABORTED" || contents.isDestroyed() || tab.generation !== generation) return;
      tab.error = error.message; this.sync(); this.emit();
    });
  }
  create(workspace = this.workspace, url = "about:blank") {
    if (workspace !== "" && (typeof workspace !== "string" || !path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()))
      throw new Error("Use an existing absolute workspace folder.");
    if (!this.knownWorkspace(workspace)) throw new Error("Open this workspace or worktree in Lumen first.");
    if ([...this.groups.values()].reduce((sum, group) => sum + group.tabs.length, 0) >= MAX_TABS)
      throw new Error(`Close a browser tab before opening another (${MAX_TABS} across all workspaces).`);
    const normalized = browserURL(url), group = this.group(workspace);
    if (group.tabs.length >= 24) throw new Error("Close a browser tab before opening another (24 per workspace).");
    const tab = { id: crypto.randomUUID(), url: normalized, title: "New tab", error: "", console: [] };
    group.tabs.push(tab); group.activeId = tab.id;
    if (normalized !== "about:blank") this.ensure(tab);
    this.sync(); this.emit(true);
    return this.metadata(tab);
  }
  select(id) { const { group } = this.find(id); group.activeId = id; this.sync(); this.emit(true); return this.state(); }
  navigate(id, value) {
    const url = browserURL(value), { tab } = this.find(id), existed = !!tab.view;
    tab.url = url; tab.error = "";
    this.ensure(tab);
    if (existed) this.load(tab, url);
    this.sync(); this.emit(true);
    return this.metadata(tab);
  }
  close(id) {
    const { group, tab } = this.find(id), index = group.tabs.indexOf(tab);
    if (this.attached === tab.view) this.detach();
    if (tab.view && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    group.tabs.splice(index, 1);
    if (group.activeId === id) group.activeId = group.tabs[Math.min(index, group.tabs.length - 1)]?.id || "";
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.sync(); this.emit(true); return this.state();
  }
  detach() {
    if (this.attached && !this.window.isDestroyed()) this.attached.setVisible(false);
    this.attached = null;
  }
  layout(value) {
    if (value && (value.workspace !== this.workspace || value.id !== this.group().activeId)) return;
    this.visible = !!value;
    if (value) {
      if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) throw new Error("Invalid browser bounds.");
      const zoom = this.window.webContents.getZoomFactor(), [width, height] = this.window.getContentSize();
      const x = Math.max(0, Math.min(width, Math.round(value.x * zoom))), y = Math.max(0, Math.min(height, Math.round(value.y * zoom)));
      this.bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round(value.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(value.height * zoom))) };
    }
    this.sync();
  }
  sync() {
    if (this.window.isDestroyed()) return;
    const group = this.group(), tab = group.tabs.find((item) => item.id === group.activeId);
    if (!this.visible || !this.bounds?.width || !this.bounds?.height || !tab || tab.url === "about:blank" || tab.error) { this.detach(); return; }
    const view = this.ensure(tab);
    if (this.attached !== view) {
      this.detach(); this.window.contentView.removeChildView(view); this.window.contentView.addChildView(view); this.attached = view;
    }
    view.setBounds(this.bounds);
    view.setVisible(true);
  }
  async capture(id) {
    const { tab } = this.find(id);
    if (tab.url === "about:blank") throw new Error("Open a page before capturing it.");
    return this.pageOperation(tab, (contents) => contents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
  }
  async pageOperation(tab, operation) {
    const unloaded = !tab.view || tab.view.webContents.isDestroyed();
    const contents = this.ensure(tab).webContents;
    if (unloaded && tab.ready) {
      // loadURL can resolve just before Chromium clears its loading flag.
      // Restored pages must reach that idle state before their first capture.
      await new Promise((resolve, reject) => {
        let done = false;
        const finish = (error) => {
          if (done) return; done = true; clearTimeout(timer);
          contents.removeListener("did-stop-loading", stopped); contents.removeListener("destroyed", destroyed);
          error ? reject(error) : resolve();
        };
        const destroyed = () => finish(new Error("The browser tab was closed."));
        const stopped = () => {
          if (contents.isDestroyed()) destroyed();
          else if (!contents.isLoadingMainFrame()) finish(tab.error ? new Error(tab.error) : null);
        };
        const timer = setTimeout(() => finish(new Error("The page took too long to load.")), 15000);
        contents.on("did-stop-loading", stopped); contents.once("destroyed", destroyed);
        Promise.resolve(tab.ready).then(stopped, finish);
      });
    }
    if (contents.isDestroyed()) throw new Error("The browser tab was closed.");
    if (contents.isLoadingMainFrame()) throw new Error("Wait for the page to finish loading and try again.");
    if (tab.error) throw new Error(tab.error);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => {
        if (done) return; done = true; clearTimeout(timer);
        contents.removeListener("destroyed", destroyed); contents.removeListener("did-start-navigation", navigating);
        error ? reject(error) : resolve(result);
      };
      const destroyed = () => finish(new Error("The browser tab was closed."));
      const navigating = (details) => { if (details.isMainFrame) finish(new Error("The page changed while capturing it. Try again once it finishes loading.")); };
      const timer = setTimeout(() => finish(new Error("The page took too long. Reload it and try again.")), 15000);
      contents.once("destroyed", destroyed); contents.on("did-start-navigation", navigating);
      Promise.resolve().then(() => operation(contents)).then((result) => finish(null, result), (error) => finish(error));
    });
  }
  async inspect(id) {
    const { tab } = this.find(id);
    const text = await this.pageOperation(tab, (contents) => contents.executeJavaScript("document.body?.innerText.slice(0, 16000) || ''"));
    return { url: tab.url, title: tab.title, text, console: tab.console };
  }
  async captureContext(id) {
    const { tab } = this.find(id);
    await this.pageOperation(tab, () => undefined);
    const generation = tab.generation;
    const [image, page] = await Promise.all([this.capture(id), this.inspect(id)]);
    if (tab.generation !== generation) throw new Error("The page changed while capturing it. Try again.");
    return { image, page };
  }
  async control(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a browser action object.");
    const { action, id } = body;
    if (action === "list") return { workspaces: [...this.groups].map(([workspace, group]) => ({ workspace, activeId: group.activeId, tabs: group.tabs.map((tab) => this.metadata(tab)) })) };
    if (action === "open") return this.create(body.workspace ?? this.workspace, body.url ?? "about:blank");
    if (action === "navigate") return this.navigate(id, body.url);
    if (action === "select") return this.select(id);
    if (action === "close") return this.close(id);
    if (action === "inspect") return this.inspect(id);
    if (action === "screenshot") return { image: (await this.capture(id)).toDataURL() };
    const { tab } = this.find(id), contents = this.ensure(tab).webContents;
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === "reload") { tab.error = ""; contents.reload(); this.sync(); }
    else if (action === "stop") contents.stop();
    else if (action === "devtools") contents.openDevTools({ mode: "detach" });
    else if (action === "evaluate") {
      if (typeof body.script !== "string" || body.script.length > 100000) throw new Error("Provide a script under 100,000 characters.");
      return contents.executeJavaScript(body.script, true);
    } else throw new Error("Unsupported browser action.");
    return this.metadata(tab);
  }
  dispose() {
    clearTimeout(this.saveTimer); this.save(); this.detach();
    for (const group of this.groups.values()) for (const tab of group.tabs)
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.destroy();
  }
}
module.exports = { BrowserService, browserURL };
