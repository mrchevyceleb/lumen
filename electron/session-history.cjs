const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
  const raw = await fs.readFile(file, "utf8"), rows = [];
  for (const line of raw.split("\n")) { try { if (line) rows.push(JSON.parse(line)); } catch { /* The native CLI may still be appending its last line. */ } }
  const messages = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], value = ["claude", "pi"].includes(session.agent) ? row.message : row;
    const role = value?.role || value?.type;
    if (!["user", "assistant", "tool_result"].includes(role)) continue;
    const content = value.content;
    const toolResultOnly = role === "user" && Array.isArray(content) && content.some((block) => block.type === "tool_result") && content.every((block) => block.type === "tool_result");
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block.type === "text" ? block.text : block.type === "tool_result" ? typeof block.content === "string" ? block.content : JSON.stringify(block.content) : "").filter(Boolean).join("\n") : "";
    if (!text && !content?.some?.((block) => block.type === "image")) continue;
    const identity = row.uuid || row.id || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${text}`).digest("hex");
    messages.push({ id: row.uuid || `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp: Date.parse(row.timestamp || row.created_at || "") || 0, role: role === "tool_result" || toolResultOnly ? "tool" : role, text, state: "done" });
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
