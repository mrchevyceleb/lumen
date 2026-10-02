const { contextBridge, ipcRenderer } = require("electron");
const channels = new Set([
  "bootstrap",
  "agent-control:status", "agent-control:change", "agent-control:ready", "agent-control:reply", "agent-control:claim",
  "workspace:choose",
  "workspace:open",
  "workspace:register",
  "launch:take",
  "launch:resolve",
  "files:tree",
  "files:read",
  "files:save",
  "files:create",
  "files:search",
  "git:status",
  "git:action",
  "git:diff",
  "git:worktree",
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
  "external:open",
  "window:action",
  "updates:status",
  "updates:check",
  "updates:install",
  "accounts:list", "accounts:add", "accounts:change", "accounts:system", "accounts:remove",
  "accounts:login", "accounts:login-default", "accounts:login-session", "accounts:write", "accounts:resize", "accounts:buffer", "accounts:cancel",
]);
contextBridge.exposeInMainWorld("lumen", {
  invoke: async (channel, ...args) => {
    if (!channels.has(channel)) throw new Error("Unknown action.");
    const result = await ipcRenderer.invoke(channel, ...args);
    if (result.error) throw new Error(result.error);
    return result.data;
  },
  onSession: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
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
