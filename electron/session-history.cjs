const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const grokSyntheticPrefix = /^<(?:user_info|project_layout|git_status|fork-context|system-reminder|agent-memory|system_reminder|background_context|rules)\b/;
function grokUserText(value, text, hasImages) {
  if (value?.synthetic_reason) return null;
  const cleaned = text.replace(/^<image_files>[\s\S]*?<\/image_files>\s*/, "");
  if (grokSyntheticPrefix.test(cleaned.trimStart())) return null;
  const query = cleaned.match(/^(?:The user sent a message while you were working:\r?\n)?<user_query>\r?\n?([\s\S]*)\r?\n?<\/user_query>(?:\r?\n<skill_information\b[\s\S]*?<\/skill_information>|\r?\nPlease address this message[\s\S]*)?\s*$/);
  if (query) return query[1].replace(/\r?\n$/, "");
  if (!cleaned && (hasImages || cleaned !== text)) return "";
  return cleaned || null;
}
async function sessionFile(session) {
  if (!session.sessionRef) return null;
  if (session.agent === "pi") return session.sessionRef;
  const root = session.agent === "claude" ? path.join(session.claudeHome, "projects") : path.join(session.grokHome, "sessions");
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = session.agent === "claude" ? path.join(root, entry.name, session.sessionRef + ".jsonl") : path.join(root, entry.name, session.sessionRef, "chat_history.jsonl");
    if (await fs.stat(file).then((stat) => stat.isFile(), () => false)) return file;
  }
  return null;
}
async function readHistory(session) {
  const file = await sessionFile(session);
  if (!file) return null;
  const raw = await fs.readFile(file, "utf8"), rows = [], grokTimestamps = new Map();
  for (const line of raw.split("\n")) { try { if (line) rows.push(JSON.parse(line)); } catch { /* The native CLI may still be appending its last line. */ } }
  if (session.agent === "grok") {
    const updates = await fs.readFile(path.join(path.dirname(file), "updates.jsonl"), "utf8").catch(() => "");
    for (const line of updates.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line), update = entry.params?.update;
        const promptIndex = update?._meta?.promptIndex, agentMs = entry.params?._meta?.agentTimestampMs;
        const timestamp = Number.isFinite(agentMs) && agentMs > 0 ? agentMs : Number.isFinite(entry.timestamp) && entry.timestamp > 0 ? Math.round(entry.timestamp * 1000) : 0;
        if (update?.sessionUpdate === "user_message_chunk" && Number.isInteger(promptIndex) && timestamp && !grokTimestamps.has(promptIndex))
          grokTimestamps.set(promptIndex, timestamp);
      } catch { /* The native CLI may still be appending its last line. */ }
    }
  }
  const messages = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], value = ["claude", "pi"].includes(session.agent) ? row.message : row;
    const role = value?.role || value?.type;
    if (!["user", "assistant", "tool_result"].includes(role)) continue;
    const content = value.content;
    let hasImages = !!content?.some?.((block) => block.type === "image");
    const toolResultOnly = role === "user" && Array.isArray(content) && content.some((block) => block.type === "tool_result") && content.every((block) => block.type === "tool_result");
    let text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block.type === "text" ? block.text : block.type === "tool_result" ? typeof block.content === "string" ? block.content : JSON.stringify(block.content) : "").filter(Boolean).join("\n") : "";
    if (session.agent === "grok" && role === "user" && !toolResultOnly) {
      hasImages = hasImages || /^<image_files>[\s\S]*?<\/image_files>/.test(text);
      text = grokUserText(value, text, hasImages);
      if (text === null) continue;
    }
    if (!text && !hasImages) continue;
    const timestamp = Date.parse(row.timestamp || row.created_at || "") || (session.agent === "grok" && Number.isInteger(value?.prompt_index) ? grokTimestamps.get(value.prompt_index) || 0 : 0);
    const identity = row.uuid || row.id || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${text}`).digest("hex");
    messages.push({ id: row.uuid || `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp, role: role === "tool_result" || toolResultOnly ? "tool" : role, text, state: "done" });
  }
  return { messages, file };
}
function preserveAttachments(messages, saved = []) {
  const previous = saved.filter((message) => message.role === "user");
  const used = new Set();
  return messages.map((message) => {
    if (message.role !== "user") return message;
    let index = previous.findIndex((item, i) => !used.has(i) && (item.id === message.id || item.id === message.providerMessageId));
    if (index < 0) index = previous.findIndex((item, i) => !used.has(i) && item.text === message.text);
    if (index < 0) return { ...message, deliveryState: "confirmed" };
    used.add(index);
    return { ...message, attachments: previous[index].attachments || message.attachments, delivery: previous[index].delivery, deliveryState: "confirmed" };
  });
}
module.exports = { sessionFile, readHistory, preserveAttachments };
