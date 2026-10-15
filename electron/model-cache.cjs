const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Only model metadata is saved. Credentials and prompt/conversation data never enter this cache.
class ModelCache {
  constructor(dataDir, accounts) {
    this.file = path.join(dataDir, "model-catalogs.json"); this.accounts = accounts; this.entries = new Map();
    try {
      if (fs.statSync(this.file).size < 8 * 1024 * 1024) {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        for (const [key, entry] of saved.entries || []) if (entry?.value?.models?.length && Date.now() - entry.at < 7 * 86400000 &&
          entry.value.models.every((m) => typeof m.id === "string" && typeof m.name === "string" && Array.isArray(m.efforts))) this.entries.set(key, entry);
      }
    } catch {}
  }
  key(s) {
    const revision = s.accountId ? this.accounts?.get(s.accountId).revision : "";
    return crypto.createHash("sha256").update(JSON.stringify([s.agent, s.command, s.cacheExtraArgs || s.extraArgs, s.loadShellProfile !== false,
      s.shellCommand || "", s.accountId || "", revision, s.projectless ? "" : s.root])).digest("hex");
  }
  read(s) {
    const entry = this.entries.get(this.key(s));
    if (!entry || Date.now() - entry.at > 7 * 86400000) return null;
    const model = s.model || entry.value.currentModel || "";
    const selected = entry.value.models.find((m) => m.id === model);
    const sameDefault = !!model && model === entry.value.currentModel;
    const levels = s.agent === "pi" && sameDefault ? entry.value.currentEfforts || [] : selected?.efforts || [];
    const requested = s.effort || (sameDefault ? entry.value.currentEffort : selected?.defaultEffort) || "";
    const effort = levels.some((e) => e.id === requested) ? requested : levels.some((e) => e.id === selected?.defaultEffort) ? selected.defaultEffort : "";
    return { at: entry.at, value: { ...entry.value, currentModel: model,
      currentEffort: s.agent === "google" ? selected?.defaultEffort || "" : effort,
      currentEfforts: levels, currentMode: s.workMode || "" } };
  }
  remember(s, info) {
    const key = this.key(s), old = this.entries.get(key)?.value;
    const value = { models: info.models, favorites: info.favorites, shortcuts: info.shortcuts,
      currentModel: !s.model ? info.currentModel : old?.currentModel || "",
      currentEffort: !s.model && !s.effort ? info.currentEffort : old?.currentEffort || "",
      currentEfforts: !s.model ? info.currentEfforts : old?.currentEfforts || [] };
    this.entries.delete(key); this.entries.set(key, { agent: s.agent, at: Date.now(), value });
    while (this.entries.size > 20) this.entries.delete(this.entries.keys().next().value);
    clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 200); this.timer.unref();
  }
  invalidate(agent) {
    for (const [key, entry] of this.entries) if (entry.agent === agent) this.entries.delete(key);
    this.flush();
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ entries: [...this.entries] }));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {} // A cache write failure must never prevent a chat or application shutdown.
  }
}
module.exports = { ModelCache };
