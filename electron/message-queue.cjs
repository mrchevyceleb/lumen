const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function validate(message) {
  if (!message || !uuid.test(message.id) || typeof message.text !== "string" || (!message.text.trim() && !message.attachments?.length) || message.text.length > 200000)
    throw new Error("Enter a message under 200,000 characters.");
  if (!Array.isArray(message.attachments || []) || (message.attachments || []).length > 8 || (message.attachments || []).some((attachment) => !uuid.test(attachment?.id))) throw new Error("Invalid image attachments.");
  return { id: message.id, text: message.text, attachments: message.attachments || [], createdAt: message.createdAt || Date.now(), deliveryUncertain: !!message.deliveryUncertain || ["sending", "steering"].includes(message.state), state: "queued" };
}
class MessageQueue {
  constructor(owner, session, saved = []) {
    if (!Array.isArray(saved) || saved.length > 50) throw new Error("Invalid message queue.");
    this.owner = owner; this.s = session; this.items = saved.map(validate); this.paused = !!saved.length;
    if (this.items.reduce((n, m) => n + m.text.length, 0) > 1000000) throw new Error("The saved message queue is too large.");
    if (new Set(this.items.map((m) => m.id)).size !== this.items.length) throw new Error("Duplicate queued message.");
    this.pending = false; this.closed = false;
  }
  state() {
    const s = this.s;
    const dispatchReady = !this.closed && !this.pending && !this.paused && !s.busy && !s.stopping && !s.transitioning &&
      !s.setting && !s.catalogPromise && !s.discoveryPromise && !s.nativeOwned && s.mode === "rich";
    return { queuedMessages: this.items.map((m, i) => ({ ...m, dispatchReady: i === 0 && !m.deliveryUncertain && dispatchReady })), queuePaused: this.paused };
  }
  emit() { this.owner.event(this.s, { type: "queue", ...this.state() }); }
  async submit(message) {
    if (this.closed || this.s.mode !== "rich" || this.s.agent === "shell") throw new Error("Use the readable agent chat to queue messages.");
    const entry = validate(message);
    await this.owner.validateMessage(this.s, entry);
    if (this.items.some((m) => m.id === entry.id)) return this.state();
    if (this.items.length >= 50 || this.items.reduce((n, m) => n + m.text.length, entry.text.length) > 1000000) throw new Error("The message queue is full. Remove or send a queued message first.");
    if (!this.items.length && !this.pending && !this.s.busy) this.paused = false;
    this.items.push(entry); this.emit(); void this.drain(); return this.state();
  }
  async drain() {
    clearTimeout(this.timer);
    const s = this.s;
    if (this.closed || this.pending || this.paused || s.busy || s.stopping || s.transitioning || s.mode !== "rich" || !this.items.length) return;
    if (s.setting || s.catalogPromise || s.discoveryPromise) { this.timer = setTimeout(() => void this.drain(), 100); return; }
    const entry = this.items[0];
    if (entry.deliveryUncertain) { this.paused = true; this.emit(); return; }
    this.pending = true;
    entry.state = "sending"; this.emit();
    try { await this.owner.send(s.id, entry.text, entry); this.items = this.items.filter((m) => m.id !== entry.id); }
    catch (error) { entry.state = "queued"; entry.deliveryUncertain = true; this.paused = true; this.owner.event(s, { type: "diagnostic", text: "Message delivery was not confirmed. Inspect history before retrying: " + error.message }); }
    finally { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
  }
  async action(id, action) {
    if (this.closed || this.pending || this.s.stopping || this.s.transitioning) throw new Error("Wait for the current message action to finish.");
    if (action === "resume") { if (this.s.mode !== "rich") throw new Error("Return to readable view to send queued messages."); this.paused = false; this.emit(); void this.drain(); return this.state(); }
    const entry = this.items.find((m) => m.id === id);
    if (!entry) throw new Error("This message has already left the queue.");
    if (action === "remove") { if (entry.deliveryUncertain) this.owner.event(this.s, { type: "message-delivery-state", messageId: entry.id, deliveryState: "uncertain" }); this.items = this.items.filter((m) => m !== entry); this.emit(); return this.state(); }
    if (action !== "steer") throw new Error("Unknown queue action.");
    if (!this.s.busy) { this.items = [entry, ...this.items.filter((m) => m !== entry)]; this.paused = false; this.emit(); void this.drain(); return this.state(); }
    this.pending = true; entry.state = "steering"; this.emit();
    try {
      await this.owner.steer(this.s, entry);
      this.owner.event(this.s, { type: "message-delivered", messageId: entry.id });
      this.items = this.items.filter((m) => m !== entry);
      this.owner.event(this.s, { type: "user-message", messageId: entry.id, text: entry.text, attachments: entry.attachments, delivery: "steer" });
    } catch (error) { entry.state = "queued"; entry.deliveryUncertain = true; this.paused = true; throw new Error("Steering was not confirmed; inspect history before resending this queued message. " + error.message); }
    finally { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
    return this.state();
  }
  finish(code) { if (code !== 0) this.pause(); else void this.drain(); }
  reconcile(messages, accepted = []) {
    this.items = this.items.filter((entry) => !entry.deliveryUncertain || !(accepted.includes(entry.id) || messages.some((message) =>
      message.role === "user" && (message.id === entry.id || message.providerMessageId === entry.id || (!entry.attachments.length && message.timestamp >= entry.createdAt && message.text === entry.text)))));
    this.paused = !!this.items.length;
    this.emit();
  }
  pause() { this.paused = true; clearTimeout(this.timer); this.emit(); }
  close() { this.closed = true; clearTimeout(this.timer); }
}
module.exports = { MessageQueue };
