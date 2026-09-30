// Loaded only by Lumen's Pi RPC sessions. No settings or provider files are written.
export default function lumenControls(pi) {
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
