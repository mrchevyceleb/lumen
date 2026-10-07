// Loaded by Lumen's Pi sessions. No settings or provider files are written.
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
export default function lumenControls(pi) {
  let context, socket, view = process.env.LUMEN_PI_VIEW === "native" ? "native" : "rich";
  const dialogs = new Map();
  const deliveries = new Map();
  const saveEmptySession = (ctx) => {
    const file = ctx.sessionManager.getSessionFile(), header = ctx.sessionManager.getHeader();
    if (!file || !header) throw new Error("Pi has not allocated a resumable session.");
    // Lumen supplies an empty --session file before launch, allowing Pi itself
    // to initialize its header and mark it writable. A native /new may reserve
    // a missing file: retain its header separately until Pi materializes it.
    if (fs.existsSync(file)) { const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  };
  const output = (message) => { if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
  const state = () => ({ sessionFile: context?.sessionManager.getSessionFile(), sessionHeader: context?.sessionManager.getHeader(), model: context?.model,
    thinkingLevel: pi.getThinkingLevel(), isStreaming: context ? !context.isIdle() : false, isCompacting: compacting, pendingMessageCount: context?.hasPendingMessages() ? 1 : 0 });
  const installUI = (ctx) => {
    const ui = ctx.ui;
    if (ui.__lumenBridge) return;
    ui.__lumenBridge = true;
    for (const method of ["select", "confirm", "input", "editor"]) {
      const original = ui[method].bind(ui);
      ui[method] = (...args) => {
        if (view === "native" || !socket || socket.destroyed) return original(...args);
        const id = crypto.randomUUID(), [title, value, options] = args;
        return new Promise((resolve) => {
          let timer;
          const finish = (answer) => { clearTimeout(timer); dialogs.delete(id); options?.signal?.removeEventListener("abort", abort); output({ type: "agent_ui_cancel", id });
            resolve(method === "confirm" ? !!answer.confirmed : answer.cancelled ? undefined : answer.value); };
          const abort = () => finish({ cancelled: true });
          dialogs.set(id, { finish, native: () => { clearTimeout(timer); dialogs.delete(id); options?.signal?.removeEventListener("abort", abort); output({ type: "agent_ui_cancel", id }); original(...args).then(resolve); } });
          output({ type: "extension_ui_request", id, method, title, ...(method === "select" ? { options: value } : method === "confirm" ? { message: value } : method === "input" ? { placeholder: value } : { prefill: value }) });
          if (options?.timeout) timer = setTimeout(abort, options.timeout);
          options?.signal?.addEventListener("abort", abort, { once: true });
        });
      };
    }
    const notify = ui.notify.bind(ui);
    ui.notify = (message, type) => { output({ type: "extension_ui_request", method: "notify", message, notificationType: type }); if (!message.startsWith("LUMEN_")) notify(message, type); };
    for (const method of ["setStatus", "setTitle", "setWidget", "setEditorText"]) {
      const original = ui[method].bind(ui);
      ui[method] = (...args) => { original(...args); output({ type: "extension_ui_request", method: method === "setEditorText" ? "set_editor_text" : method,
        ...(method === "setStatus" ? { statusKey: args[0], statusText: args[1] } : method === "setTitle" ? { title: args[0] } : method === "setWidget" ? { widgetKey: args[0], widgetLines: Array.isArray(args[1]) ? args[1] : undefined, native: !!args[1] && !Array.isArray(args[1]) } : { text: args[0] }) }); };
    }
  };
  const respond = (request, data = {}) => output({ type: "response", id: request.id, command: request.type, success: true, data });
  const dispatch = async (request) => {
    try {
      if (!context) throw new Error("Pi is still initializing.");
      if (request.type === "extension_ui_response") { dialogs.get(request.id)?.finish(request); return; }
      if (request.type === "view") { view = request.mode; if (view === "native") for (const dialog of [...dialogs.values()]) dialog.native(); respond(request); return; }
      if (request.type === "get_state") { respond(request, state()); return; }
      if (request.type === "get_session_stats") { respond(request, { contextUsage: context.getContextUsage() }); return; }
      if (request.type === "get_commands") { respond(request, { commands: pi.getCommands().map((command) => ({ ...command, native: true })) }); return; }
      if (request.type === "get_available_models") { respond(request, { models: context.modelRegistry.getAvailable() }); return; }
      if (request.type === "get_available_thinking_levels") { respond(request, { levels: context.model?.reasoning ? ["off", "minimal", "low", "medium", "high", ...(context.model?.id?.includes("opus") || context.model?.id?.includes("gpt-") ? ["xhigh"] : [])] : ["off"] }); return; }
      if (request.type === "set_thinking_level") { pi.setThinkingLevel(request.level); respond(request, state()); return; }
      if (request.type === "cycle_model" || request.type === "cycle_thinking_level") {
        if (request.type === "cycle_thinking_level") { const levels = context.model?.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"]; pi.setThinkingLevel(levels[(levels.indexOf(pi.getThinkingLevel()) + 1) % levels.length]); }
        else { const models = context.modelRegistry.getAvailable(); const index = models.findIndex((model) => model.provider === context.model?.provider && model.id === context.model?.id); if (models.length && !await pi.setModel(models[(index + 1) % models.length])) throw new Error("The next model needs authentication."); }
        respond(request, state()); return;
      }
      if (request.type === "abort") { for (const dialog of [...dialogs.values()]) dialog.finish({ cancelled: true }); context.abort(); respond(request); return; }
      if (request.type === "controls") { await controlsHandler(JSON.stringify({ ...request, ...request.data }), context); respond(request); return; }
      if (request.type === "validate_images") { if (!context.model?.input?.includes("image")) throw new Error("The selected Pi model does not accept images."); respond(request); return; }
      if (["prompt", "steer"].includes(request.type)) {
        const content = [{ type: "text", text: request.message || "" }, ...(request.images || [])];
        if (request.type === "prompt" && request.message?.startsWith("/")) {
          throw new Error("This command needs Native CLI. The message was not submitted.");
        }
        if (request.type === "prompt" && !context.isIdle()) throw new Error("Pi is already running a turn.");
        deliveries.set(request.clientId || request.id, request);
        try { pi.sendUserMessage(content, { ...(request.type === "steer" ? { deliverAs: "steer" } : {}), expandPromptTemplates: true }); }
        catch (error) { deliveries.delete(request.clientId || request.id); throw error; }
        return;
      }
      throw new Error("This Pi control needs its native terminal.");
    } catch (error) { output({ type: "response", id: request.id, command: request.type, success: false, error: error.message }); }
  };
  if (process.env.LUMEN_PI_BRIDGE) {
    socket = net.createConnection(process.env.LUMEN_PI_BRIDGE);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => { output({ token: process.env.LUMEN_PI_BRIDGE_TOKEN }); if (context) output({ type: "bridge_ready", ...state() }); });
    socket.on("error", () => {});
    socket.on("close", () => { for (const dialog of [...dialogs.values()]) dialog.native(); });
    socket.on("data", (chunk) => { buffer += chunk; let index; while ((index = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { void dispatch(JSON.parse(line)); } catch {} } });
    pi.on("session_start", (_event, ctx) => { context = ctx; saveEmptySession(ctx); installUI(ctx); output({ type: "bridge_ready", ...state() }); });
    for (const event of ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "session_compact", "model_select", "ui_prompt_start", "ui_prompt_end"])
      pi.on(event, (message, ctx) => { context = ctx;
        const delivery = message.message?.role === "user" && [...deliveries.values()].find((request) => message.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") === request.message);
        if (delivery) {
          output({ ...message, clientId: delivery.clientId });
          if (event === "message_end") {
            delivery.confirming = true;
            // Extension message_end runs BEFORE SessionManager.appendMessage.
            // Yield the hook, then verify that this exact entry reached disk.
            void (async () => {
              try {
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                  const entry = ctx.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message === message.message);
                  const file = ctx.sessionManager.getSessionFile();
                  if (entry && fs.existsSync(file) && fs.readFileSync(file, "utf8").split("\n").some((line) => { try { return JSON.parse(line).id === entry.id; } catch { return false; } })) {
                    const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } respond(delivery, state()); return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error("The CLI has not persisted the matching user entry.");
              } catch (error) { output({ type: "response", id: delivery.id, command: delivery.type, success: false, error: "Pi did not confirm saved delivery: " + error.message }); }
              finally { deliveries.delete(delivery.clientId || delivery.id); }
            })();
          }
        } else output(message);
        if (event === "agent_settled") {
          for (const [id, request] of deliveries) if (!request.confirming) { output({ type: "response", id: request.id, command: request.type, success: false, error: "Pi ended before confirming this message. Inspect its history before resending." }); deliveries.delete(id); }
        }
        if (["agent_settled", "model_select", "session_compact"].includes(event)) output({ type: "response", command: "get_state", success: true, data: state() });
      });
  }
  let threshold = Number(process.env.LUMEN_AUTO_COMPACT_TOKENS) || null;
  let compacting = false;
  let lastCompactedUsage = null;
  try { const stored = JSON.parse(fs.readFileSync(process.env.LUMEN_COMPACT_STATE_FILE, "utf8")); if (Number.isFinite(stored.lastCompactedUsage) && stored.lastCompactedUsage >= 0) lastCompactedUsage = stored.lastCompactedUsage; } catch {}
  const saveWatermark = () => { try { if (process.env.LUMEN_COMPACT_STATE_FILE) fs.writeFileSync(process.env.LUMEN_COMPACT_STATE_FILE, JSON.stringify({ lastCompactedUsage }), { mode: 0o600 }); } catch { /* Context protection continues even if its restart watermark cannot be saved. */ } };
  const contextEvent = (ctx, data) => {
    data = { contextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? null, ...data };
    if (process.env.LUMEN_RPC_CONTROLS === "1") ctx.ui.notify("LUMEN_CONTEXT:" + JSON.stringify(data), "info");
    else if (data.compacting === true) ctx.ui.notify("Compacting context…", "info");
    else if (data.compacting === false) ctx.ui.notify(data.error ? "Auto-compact: " + data.error : "Context compacted", data.error ? "warning" : "info");
  };
  for (const event of ["session_start", "model_select", "message_end", "session_compact"])
    pi.on(event, (_event, ctx) => contextEvent(ctx, { contextTokens: ctx.getContextUsage()?.tokens ?? null }));
  pi.on("agent_settled", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? null;
    contextEvent(ctx, { contextTokens: tokens });
    if (!threshold || tokens === null || compacting) return;
    if (tokens < threshold && lastCompactedUsage !== null) { lastCompactedUsage = null; saveWatermark(); }
    // A summary + retained messages can themselves exceed a small threshold.
    // Require fresh context growth before compacting again; never compact-loop.
    if (tokens < threshold || (lastCompactedUsage !== null && tokens < lastCompactedUsage + Math.max(1000, threshold * 0.1))) return;
    compacting = true;
    lastCompactedUsage = tokens;
    contextEvent(ctx, { contextTokens: tokens, compacting: true });
    ctx.compact({
      onComplete: (result) => { compacting = false; lastCompactedUsage = result?.estimatedTokensAfter ?? ctx.getContextUsage()?.tokens ?? tokens; saveWatermark();
        contextEvent(ctx, { contextTokens: ctx.getContextUsage()?.tokens ?? null, compacting: false }); },
      onError: (error) => { compacting = false;
        saveWatermark();
        contextEvent(ctx, { contextTokens: tokens, compacting: false, error: error.message }); },
    });
  });
  const controlsHandler = async (args, ctx) => {
      const request = JSON.parse(args);
      try {
        const available = ctx.modelRegistry.getAvailable();
        const scoped = ctx.scopedModels.filter((s) => available.some((m) => m.provider === s.model.provider && m.id === s.model.id));
        if (request.action === "select") {
          const model = available.find((m) => `${m.provider}/${m.id}` === request.model);
          if (!model || !await pi.setModel(model)) throw new Error("This model is no longer available.");
          const level = scoped.find((s) => s.model.provider === model.provider && s.model.id === model.id)?.thinkingLevel;
          if (level) pi.setThinkingLevel(level);
        } else if (request.action === "backward") {
          const choices = scoped.length ? scoped : available.map((model) => ({ model }));
          if (choices.length > 1) {
            let index = choices.findIndex((s) => s.model.provider === ctx.model?.provider && s.model.id === ctx.model?.id);
            if (index < 0) index = 0;
            const next = choices[(index + choices.length - 1) % choices.length];
            if (!await pi.setModel(next.model)) throw new Error("No account configured for this model.");
            if (next.thinkingLevel) pi.setThinkingLevel(next.thinkingLevel);
          }
        } else if (request.action === "autocompact") {
          threshold = request.tokens ?? null;
          if (request.reset) { lastCompactedUsage = null; saveWatermark(); }
        } else if (request.action !== "state") throw new Error("Unknown Lumen control.");
        ctx.ui.notify("LUMEN_CONTROLS:" + JSON.stringify({ id: request.id,
          favorites: scoped.map((s) => `${s.model.provider}/${s.model.id}`),
        }), "info");
      } catch (error) {
        ctx.ui.notify("LUMEN_CONTROLS:" + JSON.stringify({ id: request.id, error: error.message }), "error");
      }
    };
  pi.registerCommand("__lumen_controls", { description: "Lumen session controls", handler: controlsHandler });
}
