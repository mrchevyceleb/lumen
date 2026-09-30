const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const label = (id) => ({ xhigh: "Extra high", off: "Off" }[id] || id.charAt(0).toUpperCase() + id.slice(1));
const efforts = (values) => (values || []).map((v) => typeof v === "string" ? { id: v, name: label(v), description: "" } :
  { id: v.reasoningEffort || v.id || v.value, name: v.label || label(v.reasoningEffort || v.id || v.value), description: v.description || "" });
function catalog(agent, values, current = {}) {
  if (!Array.isArray(values)) throw new Error("This CLI did not return its available models. Try native view.");
  const models = values.slice(0, 5000).map((m) => {
    if (agent === "pi") return { id: `${m.provider}/${m.id}`, modelId: m.id, provider: m.provider, name: m.name || m.id,
      description: m.reasoning ? "Supports thinking" : "", efforts: [], reasoning: !!m.reasoning };
    if (agent === "claude") return { id: m.value, name: m.displayName, description: m.description || "",
      efforts: efforts(m.supportedEffortLevels), defaultEffort: "" };
    if (agent === "codex") return { id: m.model, name: m.displayName, description: m.description || "",
      efforts: efforts(m.supportedReasoningEfforts), defaultEffort: m.defaultReasoningEffort };
    return { id: m.modelId, name: m.name, description: m.description || "",
      efforts: efforts(m._meta?.reasoningEfforts), defaultEffort: m._meta?.reasoningEfforts?.find((e) => e.default)?.id || "" };
  }).filter((m) => typeof m.id === "string" && !!m.id && typeof m.name === "string");
  return { models, ...current };
}
function piShortcuts() {
  const defaults = { model: ["ctrl+l"], forward: ["ctrl+p"], backward: [process.platform === "win32" ? "alt+p" : "ctrl+shift+p"], effort: ["shift+tab"] };
  const keys = { model: "app.model.select", forward: "app.model.cycleForward", backward: "app.model.cycleBackward", effort: "app.thinking.cycle" };
  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "keybindings.json"), "utf8"));
    for (const [key, action] of Object.entries(keys)) {
      const value = config[action];
      if (typeof value === "string") defaults[key] = [value];
      else if (Array.isArray(value) && value.every((v) => typeof v === "string")) defaults[key] = value;
    }
  } catch {}
  return defaults;
}
function cliOptions(s) {
  const args = s.model ? ["--model", s.model] : [];
  if (s.effort) args.push(...(s.agent === "codex" ? ["-c", `model_reasoning_effort=${JSON.stringify(s.effort)}`] :
    [s.agent === "pi" ? "--thinking" : s.agent === "claude" ? "--effort" : "--reasoning-effort", s.effort]));
  if (["claude", "grok"].includes(s.agent) && s.workMode) args.push("--permission-mode", s.agent === "claude" && s.workMode === "default" ? "manual" : s.workMode);
  return args;
}
// Explicit picker choices take precedence over the same options in advanced args.
function extraOptions(s) {
  const flags = new Set([...(s.model ? ["--model", "-m", ...(s.agent === "pi" ? ["--provider"] : [])] : []),
    ...(s.effort ? ["--thinking", "--effort", "--reasoning-effort"] : []), ...(s.workMode ? ["--permission-mode"] : [])]);
  const result = [];
  for (let i = 0; i < s.extraArgs.length; i++) {
    const arg = s.extraArgs[i];
    if (flags.has(arg.split("=")[0])) { if (!arg.includes("=")) i++; continue; }
    const ownedConfig = (value) => (s.model && /^model\s*=/.test(value)) || (s.effort && /^model_reasoning_effort\s*=/.test(value));
    if (s.agent === "codex" && ["-c", "--config"].includes(arg) && ownedConfig(s.extraArgs[i + 1] || "")) { i++; continue; }
    if (s.agent === "codex" && arg.startsWith("--config=") && ownedConfig(arg.slice(9))) continue;
    if (s.workMode && s.agent === "grok" && arg === "--no-plan") continue;
    result.push(arg);
  }
  return result;
}
module.exports = { catalog, efforts, piShortcuts, cliOptions, extraOptions };
