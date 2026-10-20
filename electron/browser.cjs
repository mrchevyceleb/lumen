const { WebContentsView, BrowserWindow, session, Menu, clipboard, app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function browserURL(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Enter a web address.");
  const input = value.trim();
  if (!input || input === "about:blank") return "about:blank";
  const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const hostWithPort = /^(?:\[[\da-f:]+\]|[^/?#:\s]+):\d+(?:[/?#]|$)/i.test(input);
  const bareHost = /^[^\s/?#]+(?:\.[^\s/?#]+)+(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (!/^[a-z][\w+.-]*:/i.test(input) && !local && !hostWithPort && !bareHost)
    throw new Error("Try a full address like localhost:3000, or a site like example.com.");
  const url = new URL(/^[a-z][\w+.-]*:/i.test(input) && !local && !hostWithPort ? input : `${local ? "http" : "https"}://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP or HTTPS address without embedded credentials.");
  return url.href;
}
function friendlyLoadError(description, url) {
  if (/ERR_CONNECTION_REFUSED/i.test(description)) return `Nothing answered at ${url}. If this is a local app, start it and try again.`;
  if (/ERR_NAME_NOT_RESOLVED/i.test(description)) return `That address did not resolve. Check the spelling and try again.`;
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i.test(description)) return `That page took too long to answer. Check your connection and try again.`;
  return `This page could not be reached at ${url}. Check the address and try again.`;
}
function webURL(url) { try { return browserURL(url) === url; } catch { return false; } }
function localOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  } catch { return false; }
}
const MAX_TABS = 32;
const CHAT_SCOPE_PREFIX = "chat:";
const validScope = (scope) => typeof scope === "string"
  && (scope === "" || (scope.startsWith(CHAT_SCOPE_PREFIX)
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scope.slice(CHAT_SCOPE_PREFIX.length))));
const chatScope = (chatId) => {
  if (typeof chatId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(chatId))
    throw new Error("Choose a chat before using its browser.");
  return CHAT_SCOPE_PREFIX + chatId.toLowerCase();
};
// Built-in phone widths (CSS px at devicePixelRatio 3, Chrome mobile user agents).
const DEVICE_PROFILES = {
  iphone: { width: 390, height: 844, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },
  pixel: { width: 412, height: 915, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" },
  ipad: { width: 820, height: 1180, userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },
};
const normalizeView = (view) => {
  if (!view || typeof view !== "object" || Array.isArray(view)) return { mode: "desktop" };
  if (view.mode === "desktop") return { mode: "desktop" };
  if (view.mode === "mobile" && typeof DEVICE_PROFILES[view.device] === "object")
    return { mode: "mobile", device: view.device, orientation: view.orientation === "landscape" ? "landscape" : "portrait" };
  return { mode: "desktop" };
};
const sameView = (a, b) => normalizeView(a).mode === normalizeView(b).mode && normalizeView(a).device === normalizeView(b).device && normalizeView(a).orientation === normalizeView(b).orientation;
const MAX_MARKS = 10;
const MARK_COLORS = { red: "#ef4444", orange: "#f59e0b", blue: "#3b82f6", green: "#10b981", purple: "#a855f7" };
// The renderer sends normalized coordinates (0..1, relative to the pictured
// screenshot) so a pin means the same thing at any capture resolution. The
// main process maps them onto the exact bitmap it composes.
const normalizeMarks = (marks) => {
  if (!Array.isArray(marks) || marks.length > MAX_MARKS) throw new Error(`Mark up to ${MAX_MARKS} things on a screenshot.`);
  return marks.map((mark) => {
    if (!mark || typeof mark !== "object" || Array.isArray(mark)) throw new Error("Invalid screenshot markup.");
    const label = typeof mark.label === "string" ? mark.label.trim().slice(0, 80) : "";
    if (!label) throw new Error("Every markup pin needs a short label.");
    const x = Number(mark.x), y = Number(mark.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
      throw new Error("Markup pins must sit inside the screenshot.");
    const color = typeof mark.color === "string" && MARK_COLORS[mark.color] ? mark.color : "red";
    return { label, x, y, color };
  });
};
// Numbered pins are drawn over the frozen capture in a hidden offscreen
// window (Electron has no image-compositing API). Marks stay normalized.
const buildMarkupHTML = (imageDataURL, marks, width, height) => {
  const scale = Math.max(1, Math.min(2, Math.min(width, height) / 700));
  const radius = 15 * scale, font = 12 * scale;
  const pins = marks.map((mark, index) => {
    const x = Math.min(Math.max(mark.x, radius / width), 1 - radius / width);
    const y = Math.min(Math.max(mark.y, radius / height), 1 - radius / height);
    const label = `#${index + 1} ${mark.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`;
    const flip = x * width > width - 180 * scale;
    return `<div class="pin" style="left:${x * 100}%;top:${y * 100}%;--pin:${MARK_COLORS[mark.color]};--r:${radius}px;--font:${font}px;flex-direction:${flip ? "row-reverse" : "row"};text-align:${flip ? "right" : "left"}"><span class="dot">${index + 1}</span><em>${label}</em></div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff;font-family:Segoe UI,Helvetica,Arial,sans-serif}img{display:block;width:${width}px;height:${height}px}.pin{position:absolute;transform:translate(-50%,-50%);display:flex;align-items:center;gap:${7 * scale}px;pointer-events:none}.dot{width:calc(var(--r)*2);height:calc(var(--r)*2);border-radius:50%;background:var(--pin);border:${2.5 * scale}px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);color:#fff;font-size:calc(var(--font) + 2px);font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}.pin em{font-style:normal;font-size:var(--font);font-weight:600;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.95),0 0 2px rgba(0,0,0,.95);max-width:280px}</style><img src="${imageDataURL}">${pins}`;
};
const MARK_TOKEN_TTL_MS = 15 * 60 * 1000;
class BrowserService {
  constructor(window, directory, knownChat = null) {
    this.window = window;
    this.knownChat = typeof knownChat === "function" ? knownChat : null;
    this.markCaptures = new Map();
    this.file = path.join(directory, "browser.json");
    this.groups = new Map();
    this.legacy = new Map();
    this.scope = "";
    this.visible = false;
    this.bounds = null;
    this.attached = null;
    this.popups = new Set();
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
      for (const group of (saved.groups || []).slice(0, 512)) {
        if (!Array.isArray(group.tabs)) continue;
        const scope = validScope(group.scope) && group.scope ? group.scope : "";
        const workspace = typeof group.workspace === "string" ? group.workspace : "";
        const legacy = !scope;
        if (legacy && typeof group.workspace !== "string") continue;
        const tabs = group.tabs.slice(0, Math.min(24, remaining)).flatMap((tab) => {
          try {
            return [{ id: crypto.randomUUID(), url: browserURL(tab.url), title: String(tab.title || "New tab").slice(0, 200), error: "", console: [], view: normalizeView(tab.view), history: this.cleanHistory(tab.history) }];
          } catch { return []; }
        });
        remaining -= tabs.length;
        const store = legacy ? this.legacy : this.groups, key = legacy ? workspace : scope;
        const current = store.get(key);
        if (current) {
          current.tabs.push(...tabs);
          if (!current.activeId) current.activeId = tabs[group.activeIndex]?.id || tabs[0]?.id || "";
        } else store.set(key, { tabs, activeId: tabs[group.activeIndex]?.id || tabs[0]?.id || "" });
      }
    } catch { /* A new profile starts with an empty browser. */ }
    window.webContents.on("did-start-loading", () => this.layout(null));
    window.on("closed", () => this.dispose());
  }
  cleanHistory(history) {
    if (!history || typeof history !== "object") return null;
    const entries = Array.isArray(history.entries)
      ? history.entries.flatMap((entry) => {
        const url = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.url : "";
        if (!webURL(url) || url === "about:blank") return [];
        return [{ title: String(typeof entry?.title === "string" ? entry.title : "").slice(0, 200), url,
          ...(typeof entry?.pageState === "string" && entry.pageState.length ? { pageState: entry.pageState } : {}) }];
      }).slice(-20)
      : [];
    if (entries.length < 2) return null;
    const index = Math.min(Math.max(Number.isInteger(history.index) ? history.index : entries.length - 1, 0), entries.length - 1);
    return { entries, index };
  }
  history(tab) {
    const contents = tab.nativeView?.webContents;
    if (!contents || contents.isDestroyed()) return tab.history || null;
    try {
      const all = contents.navigationHistory.getAllEntries();
      const start = Math.max(0, all.length - 20);
      const entries = all.slice(start).flatMap((entry) => webURL(entry.url) && entry.url !== "about:blank" ? [{ title: String(entry.title || "").slice(0, 200), url: entry.url, ...(typeof entry.pageState === "string" && entry.pageState.length ? { pageState: entry.pageState } : {}) }] : []);
      if (entries.length < 2) return null;
      const dropped = all.slice(0, start).filter((entry) => webURL(entry.url) && entry.url !== "about:blank").length;
      return { entries, index: Math.min(Math.max(contents.navigationHistory.getActiveIndex() - dropped, 0), entries.length - 1) };
    } catch { return tab.history || null; }
  }
  group(scope = this.scope) {
    if (!validScope(scope) || scope.length > 8192) throw new Error("Invalid browser scope.");
    if (!this.groups.has(scope)) {
      for (const [key, group] of this.groups) if (key !== this.scope && !group.tabs.length) this.groups.delete(key);
      if (this.groups.size >= 512) throw new Error("The browser has reached its saved-chat limit.");
      this.groups.set(scope, { tabs: [], activeId: "" });
    }
    return this.groups.get(scope);
  }
  adoptLegacy(scope, workspace) {
    if (!scope || typeof workspace !== "string") return;
    if (workspace.startsWith(CHAT_SCOPE_PREFIX)) return;
    const target = this.groups.get(scope), legacy = this.legacy.get(workspace);
    if (!legacy?.tabs.length || target?.tabs.length) return;
    this.groups.set(scope, legacy);
    this.legacy.delete(workspace);
  }
  metadata(tab) {
    const contents = tab.nativeView?.webContents;
    const live = contents && !contents.isDestroyed();
    return { id: tab.id, title: tab.title, url: tab.url, error: tab.error, unloaded: !live && tab.url !== "about:blank",
      loading: !!live && contents.isLoading(), canGoBack: !!live && contents.navigationHistory.canGoBack(),
      canGoForward: !!live && contents.navigationHistory.canGoForward(), view: tab.view || { mode: "desktop" } };
  }
  state() {
    const group = this.group();
    return { scope: this.scope, activeId: group.activeId, tabs: group.tabs.map((tab) => this.metadata(tab)) };
  }
  snapshot(chatId, workspace = "") {
    const active = this.activate(chatId, workspace);
    const states = [...this.groups].map(([scope, group]) => ({ scope, activeId: group.activeId, tabs: group.tabs.map((tab) => this.metadata(tab)) }));
    return { active, states };
  }
  emit(save = false) {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) this.window.webContents.send("browser:state", this.state());
    if (save) { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 250); }
  }
  createFromPage(scope, url) {
    try { return this.create(scope, url); }
    catch (error) {
      if (!this.window.isDestroyed()) this.window.webContents.send("browser:state", { ...this.state(), error: error.message });
    }
  }
  save() {
    try {
      const groups = [
        ...[...this.groups].filter(([, group]) => group.tabs.length).map(([scope, group]) => ({ scope, activeIndex: group.tabs.findIndex((tab) => tab.id === group.activeId),
          tabs: group.tabs.map((tab) => ({ url: tab.url, title: tab.title, view: tab.view || { mode: "desktop" }, history: this.history(tab) })) })),
        ...[...this.legacy].filter(([, group]) => group.tabs.length).map(([workspace, group]) => ({ workspace, activeIndex: group.tabs.findIndex((tab) => tab.id === group.activeId),
          tabs: group.tabs.map((tab) => ({ url: tab.url, title: tab.title, view: tab.view || { mode: "desktop" }, history: this.history(tab) })) })),
      ];
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ groups }));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (error) { console.warn("Could not save browser tabs:", error.message); }
  }
  activate(chatId, workspace = "") {
    const scope = chatId ? chatScope(chatId) : "";
    this.layout(null);
    if (scope !== this.scope && !this.groups.get(this.scope)?.tabs.length) this.groups.delete(this.scope);
    this.adoptLegacy(scope, workspace);
    this.scope = scope;
    this.group();
    this.emit();
    return this.state();
  }
  discard(chatId) {
    const scope = chatScope(chatId), group = this.groups.get(scope);
    if (!group) return;
    for (const tab of group.tabs) {
      if (this.attached === tab.nativeView) this.detach();
      if (tab.nativeView && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.nativeView);
      if (tab.nativeView && !tab.nativeView.webContents.isDestroyed()) tab.nativeView.webContents.close();
    }
    this.groups.delete(scope);
    if (this.scope === scope) this.layout(null);
    this.emit(true);
  }
  find(id) {
    for (const [scope, group] of this.groups) {
      const tab = group.tabs.find((tab) => tab.id === id);
      if (tab) return { scope, group, tab };
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
  ensure(tab, restoreHistory = true) {
    if (tab.nativeView && !tab.nativeView.webContents.isDestroyed()) return tab.nativeView;
    const view = new WebContentsView({ webPreferences: this.preferences });
    tab.nativeView = view;
    // Background agent previews need a viewport even before the tab is shown.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    view.setBackgroundColor("#ffffff");
    const contents = view.webContents;
    // A regular Chromium user agent avoids sites unnecessarily rejecting Electron.
    this.desktopUserAgent = contents.getUserAgent().replace(/\s(?:Electron|lumen-workspace|Lumen)\/\S+/g, "");
    contents.setUserAgent(this.desktopUserAgent);
    // Saved phone view applies before the first navigation so the server
    // renders the right (mobile) page, not just the right-sized one.
    this.applyEmulation(tab);
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
      tab.error = friendlyLoadError(description, url); this.sync(); this.emit();
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
      ...(params.linkURL && webURL(params.linkURL) ? [{ label: "Open link in new tab", click: () => this.createFromPage(this.find(tab.id).scope, params.linkURL) }] : []),
      { label: "Inspect element", click: () => contents.inspectElement(params.x, params.y) },
    ]).popup({ window: this.window }));
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isComposing) return;
      const key = input.key.toLowerCase(), control = input.control || input.meta;
      if (control && key === "l") { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.send("browser:command", "address"); }
      else if (control && input.shift && key === "b") { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.send("browser:command", "hide"); }
      else if (control && key === "t") { event.preventDefault(); this.window.webContents.focus(); this.createFromPage(this.find(tab.id).scope); }
      else if (control && key === "w") { event.preventDefault(); this.close(tab.id); }
      else if (key === "f12") { event.preventDefault(); contents.openDevTools({ mode: "detach" }); }
      else if (key === "f5" || (control && key === "r")) { event.preventDefault(); input.shift ? contents.reloadIgnoringCache() : contents.reload(); }
      else if (input.alt && key === "arrowleft" && contents.navigationHistory.canGoBack()) { event.preventDefault(); contents.navigationHistory.goBack(); }
      else if (input.alt && key === "arrowright" && contents.navigationHistory.canGoForward()) { event.preventDefault(); contents.navigationHistory.goForward(); }
      else if (control && ["+", "=", "-", "0"].includes(key)) {
        event.preventDefault(); contents.setZoomFactor(key === "0" ? 1 : Math.max(0.5, Math.min(2, contents.getZoomFactor() + (key === "-" ? -0.1 : 0.1))));
      }
    });
    this.load(tab, tab.url, restoreHistory ? this.cleanHistory(tab.history) : null);
    tab.history = null;
    return view;
  }
  deviceSize(view) {
    const normalized = normalizeView(view);
    if (normalized.mode !== "mobile") return null;
    const profile = DEVICE_PROFILES[normalized.device];
    return normalized.orientation === "landscape"
      ? { width: profile.height, height: profile.width } : { width: profile.width, height: profile.height };
  }
  applyEmulation(tab) {
    if (!tab.nativeView || tab.nativeView.webContents.isDestroyed()) return;
    const contents = tab.nativeView.webContents, size = this.deviceSize(tab.view);
    if (!size) {
      try { contents.disableDeviceEmulation(); } catch { /* Already desktop. */ }
      contents.setUserAgent(this.desktopUserAgent || contents.getUserAgent().replace(/\s(?:Electron|lumen-workspace|Lumen)\/\S+/g, ""));
      return;
    }
    const profile = DEVICE_PROFILES[normalizeView(tab.view).device];
    try {
      // No userAgent option on this Electron: set it on the contents itself.
      contents.setUserAgent(profile.userAgent);
      contents.enableDeviceEmulation({ screenPosition: "mobile", screenSize: size, viewPosition: { x: 0, y: 0 }, viewSize: size,
        deviceScaleFactor: 3, scale: 1 });
    } catch { try { contents.disableDeviceEmulation(); } catch { /* Keep desktop rendering. */ } }
  }
  load(tab, url, history = null) {
    tab.url = url; tab.pendingURL = url; tab.error = ""; tab.console = [];
    const generation = tab.generation = (tab.generation || 0) + 1, contents = tab.nativeView.webContents;
    tab.ready = history?.entries?.length > 1
      ? Promise.resolve(contents.navigationHistory.restore({ entries: history.entries, index: history.index }))
      : contents.loadURL(url);
    tab.ready.catch((error) => {
      if (error.code === "ERR_ABORTED" || contents.isDestroyed() || tab.generation !== generation) return;
      tab.error = error.message; this.sync(); this.emit();
    });
  }
  create(scope = this.scope, url = "about:blank") {
    if (!validScope(scope)) throw new Error("Invalid browser scope.");
    if (this.knownChat && scope && !this.knownChat(scope.slice(CHAT_SCOPE_PREFIX.length)))
      throw new Error("That chat is closed, so its browser cannot open new tabs.");
    if ([...this.groups.values(), ...this.legacy.values()].reduce((sum, group) => sum + group.tabs.length, 0) >= MAX_TABS)
      throw new Error(`Close a browser tab before opening another (${MAX_TABS} across all chats).`);
    const normalized = browserURL(url), group = this.group(scope);
    if (group.tabs.length >= 24) throw new Error("Close a browser tab before opening another (24 per chat).");
    const tab = { id: crypto.randomUUID(), url: normalized, title: "New tab", error: "", console: [], view: { mode: "desktop" } };
    group.tabs.push(tab); group.activeId = tab.id;
    if (normalized !== "about:blank") this.ensure(tab);
    this.sync(); this.emit(true);
    return this.metadata(tab);
  }
  select(id) { const { group } = this.find(id); group.activeId = id; this.sync(); this.emit(true); return this.state(); }
  navigate(id, value) {
    const url = browserURL(value), { tab } = this.find(id), existed = !!tab.nativeView;
    tab.url = url; tab.error = "";
    this.ensure(tab);
    if (existed) this.load(tab, url);
    this.sync(); this.emit(true);
    return this.metadata(tab);
  }
  setView(id, view) {
    const { tab } = this.find(id), next = normalizeView(view);
    if (sameView(tab.view, next)) return this.state();
    tab.view = next;
    this.ensure(tab);
    this.applyEmulation(tab);
    if (tab.url !== "about:blank") {
      const contents = tab.nativeView.webContents;
      this.load(tab, tab.url);
      if (!contents.isLoadingMainFrame()) contents.reload();
    }
    this.sync(); this.emit(true);
    return this.state();
  }
  close(id) {
    const { group, tab } = this.find(id), index = group.tabs.indexOf(tab);
    if (this.attached === tab.nativeView) this.detach();
    if (tab.nativeView && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.nativeView);
    group.tabs.splice(index, 1);
    if (group.activeId === id) group.activeId = group.tabs[Math.min(index, group.tabs.length - 1)]?.id || "";
    if (tab.nativeView && !tab.nativeView.webContents.isDestroyed()) tab.nativeView.webContents.close();
    this.sync(); this.emit(true); return this.state();
  }
  detach() {
    if (this.attached && !this.window.isDestroyed()) this.attached.setVisible(false);
    this.attached = null;
  }
  layout(value) {
    if (value && (value.scope !== this.scope || value.id !== this.group().activeId)) return;
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
    // Mobile view: the page is centered at device size inside the panel with a
    // styled backdrop, so a narrow phone never gets squished into a wide pane.
    const device = this.deviceSize(tab.view);
    if (device && this.bounds.width >= device.width && this.bounds.height >= device.height) {
      view.setBounds({ x: this.bounds.x + Math.floor((this.bounds.width - device.width) / 2), y: this.bounds.y, width: device.width, height: Math.min(device.height, this.bounds.height) });
    } else if (device && this.bounds.width >= device.width) {
      view.setBounds({ x: this.bounds.x + Math.floor((this.bounds.width - device.width) / 2), y: this.bounds.y, width: device.width, height: this.bounds.height });
    } else view.setBounds(this.bounds);
    view.setVisible(true);
  }
  async capture(id) {
    const { tab } = this.find(id);
    if (tab.url === "about:blank") throw new Error("Open a page before capturing it.");
    return this.pageOperation(tab, (contents) => contents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
  }
  async beginCapture(id) {
    const { tab } = this.find(id);
    if (tab.url === "about:blank") throw new Error("Open a page before capturing it.");
    const image = await this.capture(id);
    const size = image.getSize();
    if (!size.width || !size.height) throw new Error("The screenshot was empty. Reload the page and try again.");
    const token = crypto.randomUUID();
    this.markCaptures.set(token, { tabId: tab.id, generation: tab.generation, image, createdAt: Date.now() });
    for (const [key, capture] of this.markCaptures) if (Date.now() - capture.createdAt > MARK_TOKEN_TTL_MS) this.markCaptures.delete(key);
    while (this.markCaptures.size > 8) this.markCaptures.delete(this.markCaptures.keys().next().value);
    return { token, image: image.toDataURL(), width: size.width, height: size.height };
  }
  takeCapture(token, id) {
    const capture = typeof token === "string" ? this.markCaptures.get(token) : undefined;
    if (!capture) throw new Error("That screenshot expired. Capture it again.");
    this.markCaptures.delete(token);
    const { tab } = this.find(id);
    if (capture.tabId !== tab.id || capture.generation !== tab.generation)
      throw new Error("The page changed since that screenshot. Capture it again.");
    const size = capture.image.getSize();
    if (!size.width || !size.height) throw new Error("The screenshot was empty. Capture it again.");
    return { tab, image: capture.image, size };
  }
  async composeMarkedImageFor(frozen, marks) {
    const clean = normalizeMarks(marks);
    if (!clean.length) return frozen;
    const { width, height } = frozen.getSize();
    if (width * height > 268435456) throw new Error("That page is too large to mark up. Zoom out or shrink the browser and try again.");
    const markupWindow = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, resizable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    try {
      await markupWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(buildMarkupHTML(frozen.toDataURL(), clean, width, height)));
      await markupWindow.webContents.executeJavaScript("Promise.all([...document.images].map((image) => image.complete ? image.decode().catch(() => {}) : new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; })))");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const image = await markupWindow.webContents.capturePage({ x: 0, y: 0, width, height });
      const size = image.getSize();
      if (size.width !== width || size.height !== height) throw new Error("Could not draw the markup onto the screenshot.");
      return image;
    } finally { if (!markupWindow.isDestroyed()) markupWindow.destroy(); }
  }
  async captureMarked(id, marks, captureToken = "") {
    if (captureToken) {
      const { image } = this.takeCapture(captureToken, id);
      return this.composeMarkedImageFor(image, marks);
    }
    // Agent/legacy callers pass no token: freeze, mark, and return in one go.
    const begun = await this.beginCapture(id);
    try { return await this.composeMarkedImageFor(this.takeCapture(begun.token, id).image, marks); }
    catch (error) { this.markCaptures.delete(begun.token); throw error; }
  }
  async pageOperation(tab, operation) {
    const unloaded = !tab.nativeView || tab.nativeView.webContents.isDestroyed();
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
  async captureContext(id, marks, captureToken = "") {
    const { tab } = this.find(id);
    if (captureToken) {
      const frozen = this.takeCapture(captureToken, id);
      const generation = tab.generation;
      const page = await this.inspect(id);
      if (tab.generation !== generation) throw new Error("The page changed since that screenshot. Capture it again.");
      return { image: await this.composeMarkedImageFor(frozen.image, marks || []), page };
    }
    if (marks !== undefined) {
      const begun = await this.beginCapture(id);
      try {
        const generation = tab.generation;
        const page = await this.inspect(id);
        if (tab.generation !== generation) throw new Error("The page changed since that screenshot. Capture it again.");
        return { image: await this.composeMarkedImageFor(this.takeCapture(begun.token, id).image, marks), page };
      } catch (error) { this.markCaptures.delete(begun.token); throw error; }
    }
    await this.pageOperation(tab, () => undefined);
    const generation = tab.generation;
    const [image, page] = await Promise.all([this.capture(id), this.inspect(id)]);
    if (tab.generation !== generation) throw new Error("The page changed while capturing it. Try again.");
    return { image, page };
  }
  async control(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a browser action object.");
    const { action, id } = body;
    if (action === "list") return { chats: [...this.groups].map(([scope, group]) => ({ scope, chatId: scope.startsWith(CHAT_SCOPE_PREFIX) ? scope.slice(CHAT_SCOPE_PREFIX.length) : "", activeId: group.activeId, tabs: group.tabs.map((tab) => this.metadata(tab)) })) };
    if (action === "open") {
      let scope;
      if (Object.hasOwn(body, "chatId")) scope = chatScope(body.chatId);
      else if (Object.hasOwn(body, "scope")) {
        if (!validScope(body.scope) || !body.scope) throw new Error("Choose a chat before using its browser.");
        scope = body.scope.toLowerCase();
      } else scope = this.scope;
      if (!scope) throw new Error("Choose a chat before using its browser.");
      if (Object.hasOwn(body, "workspace") && typeof body.workspace !== "string") throw new Error("Invalid browser workspace.");
      this.adoptLegacy(scope, typeof body.workspace === "string" ? body.workspace : "");
      return this.create(scope, body.url ?? "about:blank");
    }
    if (action === "navigate") return this.navigate(id, body.url);
    if (action === "select") return this.select(id);
    if (action === "close") return this.close(id);
    if (action === "view") return this.setView(id, body.view);
    if (action === "inspect") return this.inspect(id);
    if (action === "screenshot") return { image: (await this.capture(id)).toDataURL() };
    if (action === "markup-begin") { const begun = await this.beginCapture(id); return { token: begun.token, image: begun.image }; }
    if (action === "screenshot-markup") return { image: (await this.captureMarked(id, body.marks, typeof body.captureToken === "string" ? body.captureToken : "")).toDataURL() };
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
    clearTimeout(this.saveTimer); this.save(); this.detach(); this.markCaptures.clear();
    for (const group of [...this.groups.values(), ...this.legacy.values()]) for (const tab of group.tabs)
      if (tab.nativeView && !tab.nativeView.webContents.isDestroyed()) tab.nativeView.webContents.close();
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.destroy();
  }
}
module.exports = { BrowserService, browserURL, chatScope, friendlyLoadError, normalizeView, sameView, normalizeMarks, buildMarkupHTML, DEVICE_PROFILES };
