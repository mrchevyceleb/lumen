const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function validate(message) {
  if (!message || !uuid.test(message.id) || typeof message.text !== "string" || (!message.text.trim() && !message.attachments?.length) || message.text.length > 200000)
    throw new Error("Enter a message under 200,000 characters.");
  if (!Array.isArray(message.attachments || []) || (message.attachments || []).length > 8 || (message.attachments || []).some((attachment) => !uuid.test(attachment?.id))) throw new Error("Invalid image attachments.");
  return { id: message.id, text: message.text, attachments: message.attachments || [], createdAt: message.createdAt || Date.now(), deliveryUncertain: !!message.deliveryUncertain || ["sending", "steering"].includes(message.state), state: "queued", ...(typeof message.steerTurnId === "string" && message.steerTurnId.length <= 300 ? { steerTurnId: message.steerTurnId } : {}) };
}
class MessageQueue {
  constructor(owner, session, saved = []) {
    if (!Array.isArray(saved) || saved.length > 50) throw new Error("Invalid message queue.");
    this.owner = owner; this.s = session; this.items = saved.map(validate); this.paused = !!saved.length;
    if (this.items.reduce((n, m) => n + m.text.length, 0) > 1000000) throw new Error("The saved message queue is too large.");
    if (new Set(this.items.map((m) => m.id)).size !== this.items.length) throw new Error("Duplicate queued message.");
    this.pending = false; this.closed = false; this.steeringGeneration = 0; this.steered = new Map();
  }
  state() {
    const s = this.s;
    const dispatchReady = !this.closed && !this.pending && !this.paused && !s.busy && !s.piCompacting && !s.stopping && !s.transitioning &&
      !s.setting && !s.nativeOwned && s.mode === "rich";
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
    if (this.closed || this.pending || this.paused || s.busy || s.piCompacting || s.stopping || s.transitioning || s.mode !== "rich" || !this.items.length) return;
    // Discovery only populates pickers. Message delivery shares the runtime's
    // own single-flight startup, so it must not inherit a catalog loading lock.
    if (s.setting) { this.timer = setTimeout(() => void this.drain(), 100); return; }
    const entry = this.items[0];
    if (entry.deliveryUncertain) { this.paused = true; this.emit(); return; }
    this.pending = true;
    delete entry.steerTurnId;
    entry.state = "sending"; this.emit();
    try { await this.owner.send(s.id, entry.text, entry); this.items = this.items.filter((m) => m.id !== entry.id); }
    catch (error) { entry.state = "queued"; entry.deliveryUncertain = true; this.paused = true; this.owner.event(s, { type: "diagnostic", text: "Message delivery was not confirmed. Inspect history before retrying: " + error.message }); }
    finally { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
  }
  async action(id, action) {
    if (this.closed || this.pending || this.s.stopping || this.s.transitioning) throw new Error("Wait for the current message action to finish.");
    if (action === "resume") {
      if (this.s.mode !== "rich") throw new Error("Return to readable view to send queued messages.");
      // Resume is the explicit retry: the user has seen the delivery warning and
      // chose to send this message again. Without clearing the flag, drain paused
      // straight back and the button could never do anything.
      const head = this.items[0];
      if (head?.deliveryUncertain) { head.deliveryUncertain = false; head.state = "queued"; delete head.steerTurnId; }
      this.paused = false; this.emit(); void this.drain(); return this.state();
    }
    const entry = this.items.find((m) => m.id === id);
    if (!entry) throw new Error("This message has already left the queue.");
    if (action === "remove") { if (entry.deliveryUncertain) this.owner.event(this.s, { type: "message-delivery-state", messageId: entry.id, deliveryState: "uncertain" }); this.items = this.items.filter((m) => m !== entry); this.emit(); return this.state(); }
    if (action !== "steer") throw new Error("Unknown queue action.");
    if (!this.s.busy) { this.items = [entry, ...this.items.filter((m) => m !== entry)]; this.paused = false; this.emit(); void this.drain(); return this.state(); }
    if (this.s.agent === "google") throw new Error("Gemini does not support steering. This message stays queued for after the current turn.");
    this.pending = true; entry.state = "steering"; this.emit();
    const generation = ++this.steeringGeneration;
    try {
      await this.owner.steer(this.s, entry);
      if (generation !== this.steeringGeneration) return this.state();
      if (this.s.agent === "codex") this.steered.set(entry.id, entry);
      else this.owner.event(this.s, { type: "message-delivered", messageId: entry.id });
      this.items = this.items.filter((m) => m !== entry);
      this.owner.event(this.s, { type: "user-message", messageId: entry.id, text: entry.text, attachments: entry.attachments, delivery: "steer", deliveryState: this.s.agent === "codex" ? "sending" : undefined });
    } catch (error) {
      if (generation !== this.steeringGeneration) return this.state();
      entry.state = "queued";
      entry.deliveryUncertain = error.deliveryUncertain === true;
      if (entry.deliveryUncertain) this.paused = true;
      if (entry.deliveryUncertain) throw new Error("Steering was not confirmed; inspect history before resending this queued message. " + error.message);
      // A native turn-boundary rejection is not a delivery failure. Keep the
      // message in the normal queue so it sends as soon as this turn finishes.
      this.owner.event(this.s, { type: "diagnostic", text: "The active turn did not accept steering; the message stays queued for the next turn. " + error.message });
      return { ...this.state(), steered: false, reason: error.message };
    }
    finally {
      if (generation === this.steeringGeneration) { this.pending = false; this.emit(); if (!this.closed) void this.drain(); }
    }
    return { ...this.state(), steered: true };
  }
  confirmSteering(id, turnId) {
    const matches = (entry) => !turnId || !entry.steerTurnId || entry.steerTurnId === turnId;
    const attempted = this.items.find((entry) => entry.id === id && (entry.state === "steering" || entry.steerTurnId) && matches(entry));
    if (attempted) {
      // Consumption is the strongest acknowledgement, even when its replay
      // arrives after an RPC failure, recovery, or turn cleanup restored it.
      if (attempted.state === "steering") { this.steeringGeneration++; this.pending = false; }
      this.steered.delete(id);
      this.items = this.items.filter((entry) => entry !== attempted);
      this.emit();
      this.owner.event(this.s, { type: "message-delivered", messageId: id });
      return;
    }
    const accepted = this.steered.get(id);
    if (accepted && matches(accepted) && this.steered.delete(id)) this.owner.event(this.s, { type: "message-delivered", messageId: id });
  }
  finish(code) {
    const unconsumed = [...this.steered.values()];
    this.steered.clear();
    for (const entry of unconsumed) {
      // turn/steer acceptance is not consumption. If the turn ends before its
      // native userMessage arrives, hand the correction back like the TUI does.
      entry.state = "queued"; entry.deliveryUncertain = true;
      this.owner.event(this.s, { type: "user-message-retracted", messageId: entry.id });
    }
    if (unconsumed.length) {
      this.items = [...unconsumed, ...this.items];
      this.paused = true;
    }
    const steering = this.items.find((entry) => entry.state === "steering");
    if (steering) {
      // Every terminal outcome settles an outstanding steer RPC, not just an
      // interruption. Its late response must not strand an unconsumed entry.
      this.steeringGeneration++;
      steering.state = "queued"; steering.deliveryUncertain = true;
      this.pending = false; this.paused = true;
    }
    if (code !== 0 || unconsumed.length || steering) this.pause();
    else void this.drain();
  }
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
