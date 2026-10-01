const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function validate(message) {
  if (!message || !uuid.test(message.id) || typeof message.text !== "string" || !message.text.trim() || message.text.length > 200000)
    throw new Error("Enter a message under 200,000 characters.");
  return { id: message.id, text: message.text, state: "queued" };
}
class MessageQueue {
  constructor(owner, session, saved = []) {
    if (!Array.isArray(saved) || saved.length > 50) throw new Error("Invalid message queue.");
    this.owner = owner; this.s = session; this.items = saved.map(validate); this.paused = !!saved.length;
    if (this.items.reduce((n, m) => n + m.text.length, 0) > 1000000) throw new Error("The saved message queue is too large.");
    if (new Set(this.items.map((m) => m.id)).size !== this.items.length) throw new Error("Duplicate queued message.");
    this.pending = false; this.closed = false;
  }
  state() { return { queuedMessages: this.items.map((m) => ({ ...m })), queuePaused: this.paused }; }
  emit() { this.owner.event(this.s, { type: "queue", ...this.state() }); }
  submit(message) {
    if (this.closed || this.s.mode !== "rich" || this.s.agent === "shell") throw new Error("Use the readable agent chat to queue messages.");
    const entry = validate(message);
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
    this.pending = true;
    const entry = this.items[0]; entry.state = "sending"; this.emit();
    try { await this.owner.send(s.id, entry.text, entry); this.items = this.items.filter((m) => m.id !== entry.id); }
    catch (error) { entry.state = "queued"; this.paused = true; this.owner.event(s, { type: "diagnostic", text: "Queued message was not sent: " + error.message }); }
    finally { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
  }
  async action(id, action) {
    if (this.closed || this.pending || this.s.stopping || this.s.transitioning) throw new Error("Wait for the current message action to finish.");
    if (action === "resume") { if (this.s.mode !== "rich") throw new Error("Return to readable view to send queued messages."); this.paused = false; this.emit(); void this.drain(); return this.state(); }
    const entry = this.items.find((m) => m.id === id);
    if (!entry) throw new Error("This message has already left the queue.");
    if (action === "remove") { this.items = this.items.filter((m) => m !== entry); this.emit(); return this.state(); }
    if (action !== "steer") throw new Error("Unknown queue action.");
    if (!this.s.busy) { this.items = [entry, ...this.items.filter((m) => m !== entry)]; this.paused = false; this.emit(); void this.drain(); return this.state(); }
    this.pending = true; entry.state = "steering"; this.emit();
    try {
      await this.owner.steer(this.s, entry);
      this.items = this.items.filter((m) => m !== entry);
      this.owner.event(this.s, { type: "user-message", messageId: entry.id, text: entry.text, delivery: "steer" });
    } catch (error) { entry.state = "queued"; this.paused = true; throw new Error("Steering was not confirmed; the message is still queued. " + error.message); }
    finally { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
    return this.state();
  }
  finish(code) { if (code !== 0) this.pause(); else void this.drain(); }
  pause() { this.paused = true; clearTimeout(this.timer); this.emit(); }
  close() { this.closed = true; clearTimeout(this.timer); }
}
module.exports = { MessageQueue };
