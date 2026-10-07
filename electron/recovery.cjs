const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

// The main process owns recovery. Every runtime event is journaled before the
// renderer sees it; closing the window is not a prerequisite for saving a chat.
class RecoveryStore {
  constructor(directory) {
    this.directory = path.join(directory, "recovery");
    fs.mkdirSync(this.directory, { recursive: true });
    this.file = path.join(this.directory, "workspace.json");
    this.journal = path.join(this.directory, "events.jsonl");
    this.state = { version: 1, revision: 0, tabs: [], active: "", root: "", projects: [] };
    this.error = "";
    for (const candidate of [this.file, this.file + ".bak"]) {
      try {
        const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (value.version !== 1 || !Array.isArray(value.tabs)) throw new Error("Invalid recovery snapshot.");
        this.state = value;
        break;
      } catch (error) { if (error.code !== "ENOENT") this.error = "Recovered the last available session snapshot."; }
    }
    try {
      const lines = fs.readFileSync(this.journal, "utf8").split("\n");
      for (const line of lines) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { this.error = "Recovered sessions up to the last complete saved event."; break; }
        if (record.revision <= this.state.revision) continue;
        this.apply(record);
      }
      // Remove an incomplete tail before appending; otherwise the next valid
      // event could be joined to the interrupted record and lost on recovery.
      const complete = lines.filter((line) => { try { return !!line && !!JSON.parse(line); } catch { return false; } }).join("\n");
      fs.writeFileSync(this.journal, complete ? complete + "\n" : "", { mode: 0o600 });
    } catch (error) { if (error.code !== "ENOENT") this.error = error.message; }
    this.fd = fs.openSync(this.journal, "a", 0o600);
    this.bindings = new Map();
  }
  load() {
    return structuredClone({ ...this.state, error: this.error, tabs: this.state.tabs.map((tab) => ({ ...tab,
      interrupted: !!tab.busy || !!tab.interrupted,
      messages: (tab.messages || []).map((message) => ({ ...message, ...(message.deliveryState === "sending" && !(tab.acceptedMessageIds || []).includes(message.id) ? { deliveryState: "uncertain" } : {}) })),
      busy: false, phase: undefined, stopping: false, forceStopAvailable: false,
      queuePaused: !!tab.queuedMessages?.length,
      queuedMessages: (tab.queuedMessages || []).map((message) => ({ ...message, deliveryUncertain: message.state !== "queued" || message.deliveryUncertain, state: "queued" })),
    })) });
  }
  record(kind, data, durable = false) {
    const record = { revision: this.state.revision + 1, kind, data };
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    if (durable) fs.fsyncSync(this.fd);
    if (!this.syncTimer) { this.syncTimer = setTimeout(() => { this.syncTimer = null; try { fs.fsyncSync(this.fd); } catch (error) { this.error = error.message; } }, 100); this.syncTimer.unref(); }
    this.apply(record);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.flush(); } catch (error) { this.error = error.message; } }, 500);
    this.timer.unref();
  }
  bind(session, saved = {}) {
    this.bindings.set(session.id, session.controlId);
    const existing = this.state.tabs.find((tab) => tab.controlId === session.controlId);
    const tab = { ...saved, ...existing, id: session.id, controlId: session.controlId,
      root: session.root, cwd: session.cwd, projectless: session.projectless, scratchId: saved.scratchId || session.scratchId,
      agent: session.agent, mode: session.mode, accountId: session.accountId, accountName: session.accountName,
      command: session.command, model: session.model, effort: session.effort, workMode: session.workMode,
      sessionRef: session.sessionRef, autoCompactTokens: session.autoCompactTokens, mcpOverrides: session.mcpOverrides,
      messages: existing?.messages || saved.messages || [], busy: false,
      interrupted: !!saved.interrupted || !!existing?.busy || !!existing?.interrupted,
      queuedMessages: session.messageQueue.state().queuedMessages, queuePaused: true };
    this.record("tab", tab, true);
  }
  saveWorkspace(value) {
    if (!value || !Array.isArray(value.tabs) || value.tabs.length > 500) throw new Error("Invalid saved workspace.");
    const tabs = value.tabs.filter((tab) => !(this.state.removedControlIds || []).includes(tab.controlId || tab.id)).map((tab) => {
      if (!validId(tab.controlId || tab.id)) throw new Error("Invalid saved chat identifier.");
      const old = this.state.tabs.find((saved) => saved.controlId === (tab.controlId || tab.id));
      // Renderer updates presentation/drafts. Runtime fields already have a
      // newer, authoritative journal entry and must not be overwritten.
      const ui = { name: tab.name, color: tab.color, draft: tab.draft || "", nativeDraft: tab.nativeDraft || "",
        draftAttachments: tab.draftAttachments || [], mode: tab.mode, managedBy: tab.managedBy };
      return old ? { ...old, ...ui } : { ...tab, controlId: tab.controlId || tab.id, messages: tab.messages || [] };
    });
    for (const tab of this.state.tabs) if (!tabs.some((value) => value.controlId === tab.controlId)) tabs.push(tab);
    const compact = tabs.map((tab) => {
      if (!this.state.tabs.some((saved) => saved.controlId === tab.controlId)) return tab;
      return Object.fromEntries(["controlId", "name", "color", "draft", "nativeDraft", "draftAttachments", "mode", "managedBy"].map((key) => [key, tab[key]]));
    });
    this.record("workspace", { tabs: compact, active: value.active || "", root: value.root || "", projects: value.projects || [] }, true);
  }
  update(controlId, changes) {
    if (!validId(controlId) || !this.state.tabs.some((tab) => tab.controlId === controlId)) throw new Error("This saved chat is unavailable.");
    const patch = {};
    for (const key of ["draft", "draftAttachments", "nativeDraft", "name", "color"]) if (Object.hasOwn(changes, key)) patch[key] = key === "nativeDraft" ? changes[key] || "" : changes[key];
    this.record("patch", { controlId, patch }, Object.hasOwn(patch, "draftAttachments") || Object.hasOwn(patch, "nativeDraft"));
  }
  remove(controlId) { this.record("remove", { controlId }, true); for (const [id, binding] of this.bindings) if (binding === controlId) this.bindings.delete(id); }
  event(session, event) {
    if (!this.bindings.has(session.id) || event.type === "terminal") return;
    this.record("event", { controlId: session.controlId, event }, ["session", "start", "done", "queue", "message-delivered", "user-message", "user-message-retracted"].includes(event.type));
  }
  apply(record) {
    this.state.revision = record.revision;
    if (record.kind === "remove") {
      this.state.tabs = this.state.tabs.filter((tab) => tab.controlId !== record.data.controlId);
      this.state.removedControlIds = [...new Set([...(this.state.removedControlIds || []), record.data.controlId])].slice(-1000);
      return;
    }
    if (record.kind === "workspace") {
      const tabs = record.data.tabs.map((ui) => ({ ...this.state.tabs.find((tab) => tab.controlId === ui.controlId), ...ui }));
      Object.assign(this.state, record.data, { tabs }); return;
    }
    if (record.kind === "tab") {
      const index = this.state.tabs.findIndex((tab) => tab.controlId === record.data.controlId);
      if (index < 0) this.state.tabs.push(record.data); else this.state.tabs[index] = record.data;
      return;
    }
    const tab = this.state.tabs.find((tab) => tab.controlId === record.data.controlId);
    if (!tab) return;
    if (record.kind === "patch") { Object.assign(tab, record.data.patch); return; }
    const event = record.data.event;
    if (event.type === "start") { tab.busy = true; tab.interrupted = false; tab.turn = event.turn; tab.started = Date.now(); }
    if (event.type === "done") { tab.busy = false; tab.interrupted = event.code === 130; }
    if (event.type === "session") { tab.sessionRef = event.sessionRef; if (event.piSessionHeader) tab.piSessionHeader = event.piSessionHeader; }
    if (event.type === "history") tab.messages = event.messages;
    if (event.type === "message-delivered") { tab.acceptedMessageIds = [...new Set([...(tab.acceptedMessageIds || []), event.messageId])].slice(-1000); const message = tab.messages.find((item) => item.id === event.messageId); if (message) message.deliveryState = "confirmed"; }
    if (event.type === "message-delivery-state") { const message = tab.messages.find((item) => item.id === event.messageId); if (message) message.deliveryState = event.deliveryState; }
    if (event.type === "view") tab.mode = event.mode;
    if (event.type === "cwd") tab.cwd = event.cwd;
    if (["config", "session-controls"].includes(event.type)) for (const key of ["model", "effort", "workMode", "autoCompactTokens", "mcpOverrides"]) if (Object.hasOwn(event, key)) tab[key] = event[key];
    if (event.type === "queue") { tab.queuedMessages = event.queuedMessages; tab.queuePaused = event.queuePaused; }
    if (event.type === "user-message-retracted") tab.messages = tab.messages.filter((message) => message.id !== event.messageId);
    if (event.type === "user-message" && !tab.messages.some((message) => message.id === event.messageId))
      tab.messages.push({ id: event.messageId, role: "user", text: event.text || "", attachments: event.attachments || [], delivery: event.delivery, deliveryState: event.deliveryState || "confirmed", turn: tab.turn });
    if (["text", "tool", "error", "diagnostic"].includes(event.type)) {
      const id = `${tab.turn || "init"}-${event.key || event.type}`;
      let message = tab.messages.find((value) => value.id === id);
      if (!message) { message = { id, turn: tab.turn, role: event.type === "text" ? "assistant" : event.type === "tool" ? "tool" : event.type === "error" ? "error" : "notice", text: "" }; tab.messages.push(message); }
      message.text = event.type === "tool" ? event.detail || "" : event.type === "error" ? event.message || "" : event.replace ? event.text || "" : message.text + (event.text || "");
      message.title = event.title || message.title; message.state = event.state;
    }
  }
  flush() {
    clearTimeout(this.timer);
    fs.fsyncSync(this.fd);
    const temporary = this.file + "." + crypto.randomUUID() + ".tmp";
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
    fs.renameSync(temporary, this.file);
    if (fs.fstatSync(this.fd).size > 16 * 1024 * 1024 && fs.existsSync(this.file + ".bak")) {
      const backup = JSON.parse(fs.readFileSync(this.file + ".bak", "utf8"));
      const remaining = fs.readFileSync(this.journal, "utf8").split("\n").filter((line) => line && JSON.parse(line).revision > backup.revision);
      const tempJournal = this.journal + ".tmp";
      fs.writeFileSync(tempJournal, remaining.length ? remaining.join("\n") + "\n" : "", { mode: 0o600 });
      fs.closeSync(this.fd);
      try { fs.renameSync(tempJournal, this.journal); } finally { this.fd = fs.openSync(this.journal, "a", 0o600); }
      fs.fsyncSync(this.fd);
    }
  }
  dispose() { clearTimeout(this.timer); clearTimeout(this.syncTimer); this.flush(); fs.closeSync(this.fd); }
}
module.exports = { RecoveryStore };
