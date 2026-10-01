// Loaded by Lumen's Pi sessions. No settings or provider files are written.
import fs from "node:fs";
export default function lumenControls(pi) {
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
  pi.registerCommand("__lumen_controls", {
    description: "Lumen session controls",
    handler: async (args, ctx) => {
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
    },
  });
}
