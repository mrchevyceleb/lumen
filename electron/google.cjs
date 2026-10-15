// Google Antigravity's documented NDJSON interface, not the retired Gemini OAuth client.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const validId = (id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "");
const effortOrder = ["low", "medium", "high", "xhigh", "max"];
const variant = (id) => {
  const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(id || "");
  return { base: match ? match[1] : id, effort: match ? match[2] : "" };
};
const modelOptions = (s) => s.model ? ["--model", s.model] : [];

async function modelCatalog(s, launch, kill = async (child) => { child.kill(); }) {
  let stdout, timer;
  const pending = execute(launch.file, launch.args, { cwd: s.cwd, env: s.profileEnvironment, windowsHide: true, maxBuffer: 1024 * 1024 });
  s.discoveryChild = pending.child;
  pending.finally(() => { if (s.discoveryChild === pending.child) s.discoveryChild = null; }).catch(() => {});
  const timedOut = () => new Error("Google's model list timed out. You can still send messages with your selected model or CLI default. Retry the model list when Google responds.");
  try {
    ({ stdout } = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { void kill(pending.child).catch(() => {}); reject(timedOut()); }, 15000);
    })]));
  } catch (error) {
    if (error.killed || error.code === "ETIMEDOUT") throw timedOut();
    const detail = (error.stderr || error.stdout || "").replace(/^Fetching available models\.\.\.\s*/gim, "").trim();
    throw new Error(detail || error.message);
  } finally {
    clearTimeout(timer);
  }
  const models = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([a-z0-9][a-z0-9_.:/-]+)(?:\t+| {2,})(.+)$/);
    return match ? [{ id: match[1], name: match[2].trim(), description: "Google Antigravity", efforts: [], defaultEffort: variant(match[1]).effort }] : [];
  });
  if (!models.length) throw new Error("Google's CLI returned no readable models. Refresh the model list or update the Google CLI in Settings → Agents.");
  for (const model of models) {
    const selected = variant(model.id);
    if (selected.effort) model.efforts = models.filter((m) => variant(m.id).base === selected.base && m.defaultEffort)
      .sort((a, b) => effortOrder.indexOf(a.defaultEffort) - effortOrder.indexOf(b.defaultEffort))
      .map((m) => ({ id: m.defaultEffort, name: m.defaultEffort === "xhigh" ? "Extra high" : m.defaultEffort[0].toUpperCase() + m.defaultEffort.slice(1), description: m.name, modelId: m.id }));
  }
  const selected = models.find((m) => m.id === s.model);
  return { models, currentModel: s.model, currentEffort: selected?.defaultEffort || "", currentEfforts: selected?.efforts || [], currentMode: s.workMode };
}

function turn(owner, s, prompt, message = {}) {
  // Send text on stdin: long prompts never cross Windows' command-line limit.
  const args = ["--input-format", "stream-json", "--output-format", "stream-json",
    ...(s.sessionRef ? ["--conversation", s.sessionRef] : []),
    ...modelOptions(s),
    ...(s.workMode === "plan" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"])];
  const child = owner.child(s, args);
  return new Promise((resolve, reject) => {
    let buffer = "", result, accepted = false, stderr = "", protocolError = "";
    const texts = new Map();
    const accept = () => { if (!accepted) { accepted = true; resolve(); } };
    const receive = (event) => {
      const data = event.step_update || event.result || event.init || {};
      const id = event.conversation_id || data.conversation_id;
      if (id && validId(id)) {
        if (s.sessionRef && id !== s.sessionRef) { protocolError = "Google returned a different conversation. The saved chat has been retained."; child.kill(); return; }
        s.sessionRef = id; s.sessionStarted = true;
        owner.event(s, { type: "session", sessionRef: id });
      }
      if (event.event === "step_update") {
        if (data.step_type === "user_input" && data.state === "DONE") accept();
        const key = `google-step-${data.step_index}`;
        if (data.step_type === "agent_response" && data.text_delta) {
          texts.set(key, (texts.get(key) || "") + data.text_delta);
          owner.text(s, texts.get(key), key, true);
        } else if (data.step_type === "tool") {
          const tool = data.tool_info || {};
          owner.tool(s, key, tool.parameters?.CommandLine || data.tool_name || tool.name || "Google tool",
            [tool.parameters ? JSON.stringify(tool.parameters, null, 2) : "", typeof tool.output === "string" ? tool.output : tool.output ? JSON.stringify(tool.output) : "", tool.error?.message || ""].filter(Boolean).join("\n"),
            tool.error || ["ERROR", "FAILED", "CANCELED", "CANCELLED", "INTERRUPTED"].includes(data.state) ? "error" : data.state === "DONE" ? "done" : "running");
        }
      } else if (event.event === "result") {
        result = data;
        if (data.status === "SUCCESS") accept();
        if (!texts.size && data.response) owner.text(s, data.response, "google-answer", true);
        if (data.error) owner.event(s, { type: "error", message: data.error });
        // Per-run totals are cumulative usage, not current context occupancy.
      }
    };
    const parse = (line) => { if (!line.trim()) return; try { receive(JSON.parse(line)); } catch { owner.event(s, { type: "diagnostic", text: line.slice(-2000) }); } };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-5000); });
    child.stdout.on("data", (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) { parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (buffer.length > 8 * 1024 * 1024) { protocolError = "Google produced an oversized event."; child.kill(); }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (s.process !== child) { if (!accepted) reject(new Error("Google stopped before accepting this message.")); return; }
      parse(buffer); s.process = null;
      const success = code === 0 && result?.status === "SUCCESS" && !protocolError;
      const error = protocolError || result?.error || stderr.trim() || "Google closed before completing its reply. Sign in to Antigravity and retry.";
      if (!accepted) reject(new Error(error));
      else {
        if (!success && !result?.error && !s.stopping) owner.event(s, { type: "error", message: error });
        owner.finish(s, success ? 0 : ["CANCELED", "INTERRUPTED"].includes(result?.status) || s.stopping ? 130 : code || 1);
      }
    });
    child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
  });
}

module.exports = { turn, modelCatalog, variant, modelOptions };
module.exports.install = async (dataDir, resolveLauncher) => {
  if (process.platform !== "win32") throw new Error("Use Google's installation guide for this operating system.");
  const fs = require("node:fs/promises"), path = require("node:path");
  const response = await fetch("https://antigravity.google/cli/install.ps1", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Google's CLI installer could not be downloaded. Try again.");
  const script = await response.text();
  if (Buffer.byteLength(script) > 1024 * 1024) throw new Error("Google's installer exceeded the download limit.");
  const folder = path.join(dataDir, "runtime"); await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "install-antigravity.ps1"); await fs.writeFile(file, script);
  const shell = resolveLauncher("powershell");
  await execute(shell.file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "--skip-aliases"], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const cli = resolveLauncher("agy");
  const { stdout } = await execute(cli.file, [...cli.args, "--version"], { windowsHide: true, timeout: 10000 });
  return { version: stdout.trim() };
};
