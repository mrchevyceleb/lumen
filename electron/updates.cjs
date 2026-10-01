const fs = require("node:fs");
const path = require("node:path");

function createUpdates({ app, notify, updater, installed }) {
  installed ??= process.platform === "win32" && app.isPackaged &&
    !process.env.PORTABLE_EXECUTABLE_FILE &&
    fs.existsSync(path.join(path.dirname(app.getPath("exe")), "Uninstall Lumen.exe"));
  let state = { phase: installed ? "idle" : "portable", version: app.getVersion(), latest: "", percent: 0, checkedAt: 0, message: "" };
  let pending, startup, interval;
  const emit = (change) => { state = { ...state, ...change }; notify({ ...state }); };
  if (installed) {
    updater ??= require("electron-updater").autoUpdater;
    updater.logger = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on("checking-for-update", () => emit({ phase: "checking", message: "" }));
    updater.on("update-available", (info) => emit({ phase: "downloading", latest: info.version, percent: 0 }));
    updater.on("download-progress", (progress) => emit({ phase: "downloading", percent: Math.round(progress.percent) }));
    updater.on("update-downloaded", (info) => emit({ phase: "downloaded", latest: info.version, percent: 100 }));
    updater.on("update-not-available", () => emit({ phase: "current", message: "", checkedAt: Date.now() }));
    updater.on("error", () => emit({ phase: "error", message: "Could not reach or download the update. Check your connection and try again." }));
  }
  const check = async () => {
    if (!installed || state.phase === "downloaded") return { ...state };
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await updater.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
        emit({ checkedAt: Date.now() });
      } catch {
        emit({ phase: "error", message: "Could not reach or download the update. Check your connection and try again." });
      } finally { pending = null; }
      return { ...state };
    })();
    return pending;
  };
  return {
    status: () => ({ ...state }),
    check,
    start() {
      if (!installed || startup || interval) return;
      startup = setTimeout(check, 15000);
      interval = setInterval(check, 6 * 60 * 60 * 1000);
      startup.unref(); interval.unref();
    },
    dispose() { clearTimeout(startup); clearInterval(interval); },
    install() {
      if (state.phase !== "downloaded") return false;
      updater.quitAndInstall(true, true);
      return true;
    },
  };
}
module.exports = { createUpdates };
