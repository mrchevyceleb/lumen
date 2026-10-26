const { contextBridge, ipcRenderer, webUtils } = require("electron");
const channels = new Set([
  "bootstrap", "agents:install-google", "agents:models",
  "browser:activate", "browser:snapshot", "browser:layout", "browser:action", "browser:attach", "browser:link-menu", "browser:discard",
  "administrator:status", "administrator:restart",
  "recovery:load", "recovery:save", "recovery:update", "attachments:paste", "attachments:choose", "attachments:import", "session:reconnect",
  "agent-control:status", "agent-control:change", "agent-control:ready", "agent-control:reply", "agent-control:claim",
  "chat:export",
  "workspace:choose",
  "workspace:open",
  "workspace:register",
  "workspace:inspect",
  "launch:take",
  "launch:resolve",
  "files:tree",
  "files:read",
  "files:save",
  "files:create",
  "files:search",
  "files:mentions",
  "git:status",
  "git:action",
  "git:diff",
  "git:worktree", "git:worktree-job", "git:worktree-job:binding",
  "git:prs",
  "session:create",
  "session:start",
  "session:send",
  "session:submit", "session:queue-action",
  "session:stop",
  "session:close",
  "session:write",
  "session:resize",
  "session:buffer",
  "session:pi-response",
  "session:mode",
  "session:commands",
  "session:models",
  "session:configure",
  "session:controls",
  "session:controls-change",
  "session:shortcuts",
  "editor:dirty",
  "settings:load",
  "settings:save",
  "dictation:status", "dictation:set-key", "dictation:chunk",
  "external:open",
  "file:open-link", "file:link-menu",
  "window:action",
  "updates:status",
  "updates:check",
  "updates:install",
  "accounts:list", "accounts:add", "accounts:change", "accounts:system", "accounts:remove",
  "accounts:login", "accounts:login-default", "accounts:login-session", "accounts:verify", "accounts:write", "accounts:resize", "accounts:buffer", "accounts:cancel",
]);
contextBridge.exposeInMainWorld("lumen", {
  filePath: (file) => webUtils.getPathForFile(file),
  invoke: async (channel, ...args) => {
    if (!channels.has(channel)) throw new Error("Unknown action.");
    const result = await ipcRenderer.invoke(channel, ...args);
    if (result.error) {
      const error = new Error(result.error);
      if (result.code) error.code = result.code;
      throw error;
    }
    return result.data;
  },
  onSession: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
  hideBrowserNow: () => ipcRenderer.sendSync("browser:hide-now"),
  switchBrowserNow: (chatId, workspace, box, paint) => ipcRenderer.sendSync("browser:switch-now", chatId, workspace, box, paint),
  onBrowser: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onBrowserCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("browser:command", listener);
    return () => ipcRenderer.removeListener("browser:command", listener);
  },
  onAgentControl: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("agent-control:request", listener);
    return () => ipcRenderer.removeListener("agent-control:request", listener);
  },
  onAgentControlStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("agent-control:status", listener);
    return () => ipcRenderer.removeListener("agent-control:status", listener);
  },
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
  onAccounts: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("accounts:event", listener);
    return () => ipcRenderer.removeListener("accounts:event", listener);
  },
  onOpenPaths: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("launch:pending", listener);
    return () => ipcRenderer.removeListener("launch:pending", listener);
  },
  onClosing: (callback) => {
    const listener = () => {
      Promise.resolve(callback()).finally(() =>
        ipcRenderer.send("app:ready-to-close"),
      );
    };
    ipcRenderer.on("app:closing", listener);
    return () => ipcRenderer.removeListener("app:closing", listener);
  },
});
