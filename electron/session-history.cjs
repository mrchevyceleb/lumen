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
function isNarrationThinking(block, narrationIndexes, blockIndex) {
  if (block?.type !== "thinking" || typeof block.thinking !== "string" || !block.thinking.trim()) return false;
  if (Array.isArray(narrationIndexes) && Number.isInteger(blockIndex) && narrationIndexes.includes(blockIndex)) return true;
  if (typeof block.signature !== "string" || !block.signature) return false;
  try {
    return Buffer.from(block.signature, "base64").includes(Buffer.from("\x42\x09narration"));
  } catch {
    return false;
  }
}
function formatToolDetail(rawContent) {
  if (typeof rawContent === "string") return rawContent;
  if (Array.isArray(rawContent))
    return rawContent.map((part) => (typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part))).filter(Boolean).join("\n");
  return rawContent != null ? JSON.stringify(rawContent) : "";
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
  const messages = [], toolsByCallId = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (session.agent === "claude" && (row.type !== "user" && row.type !== "assistant" || row.isMeta || row.isVisibleInTranscriptOnly || row.isCompactSummary || row.origin?.kind === "task-notification")) continue;
    if (session.agent === "pi" && row.type && row.type !== "message") continue;
    const value = ["claude", "pi"].includes(session.agent) ? row.message : row;
    const role = value?.role || value?.type;
    if (!["user", "assistant", "tool", "tool_result", "toolResult"].includes(role)) continue;
    const content = value.content;
    const timestamp = Date.parse(row.timestamp || row.created_at || "") || (session.agent === "grok" && Number.isInteger(value?.prompt_index) ? grokTimestamps.get(value.prompt_index) || 0 : 0);
    let hasImages = !!content?.some?.((block) => block.type === "image");
    const toolResultOnly = role === "user" && Array.isArray(content) && content.some((block) => block.type === "tool_result") && content.every((block) => block.type === "tool_result");
    if (role === "assistant") {
      const textParts = [];
      let textPartIndex = 0;
      const flushAssistantText = () => {
        const text = textParts.join("\n").trim();
        textParts.length = 0;
        if (!text && !hasImages) return;
        const suffix = textPartIndex++ > 0 ? `-${textPartIndex}` : "";
        const identity = (row.uuid || row.id ? `${row.uuid || row.id}${suffix}` : null) || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${textPartIndex}:${text}`).digest("hex");
        messages.push({ id: row.uuid ? `${row.uuid}${suffix}` : `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp, role: "assistant", text, state: "done" });
        hasImages = false;
      };
      if (typeof content === "string") {
        if (content.trim()) textParts.push(content);
      } else if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (block.type === "text" && block.text) textParts.push(block.text);
          else if (isNarrationThinking(block, row.narration_block_indexes, i)) textParts.push(block.thinking);
          else if (block.type === "tool_use" || block.type === "toolCall") {
            flushAssistantText();
            const callId = block.id, inputObj = block.input ?? block.arguments ?? {};
            const inputText = typeof inputObj === "string" ? inputObj : JSON.stringify(inputObj, null, 2);
            const toolMsg = { id: callId ? `native-tool-${callId}` : `native-tool-${index}-${i}`, providerMessageId: row.uuid || row.id, timestamp, role: "tool", title: block.name || "Tool", text: inputText, state: "done" };
            messages.push(toolMsg);
            if (callId) toolsByCallId.set(callId, toolMsg);
          }
        }
      }
      flushAssistantText();
      if (Array.isArray(value.tool_calls)) {
        for (let i = 0; i < value.tool_calls.length; i++) {
          const tc = value.tool_calls[i], callId = tc.id, name = tc.name || tc.function?.name || "Tool", inputObj = tc.arguments ?? tc.function?.arguments ?? {};
          const inputText = typeof inputObj === "string" ? inputObj : JSON.stringify(inputObj, null, 2);
          const toolMsg = { id: callId ? `native-tool-${callId}` : `native-tool-${index}-${i}`, providerMessageId: row.uuid || row.id, timestamp, role: "tool", title: name, text: inputText, state: "done" };
          messages.push(toolMsg);
          if (callId) toolsByCallId.set(callId, toolMsg);
        }
      }
      continue;
    }
    if (toolResultOnly) {
      for (const block of content) {
        const detail = formatToolDetail(block.content);
        const existing = block.tool_use_id ? toolsByCallId.get(block.tool_use_id) : null;
        if (existing) {
          if (detail) existing.text = detail;
          existing.state = block.is_error ? "error" : "done";
        } else if (detail) {
          const identity = row.uuid || row.id || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${detail}`).digest("hex");
          messages.push({ id: block.tool_use_id ? `native-tool-${block.tool_use_id}` : row.uuid || `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp, role: "tool", title: "Tool result", text: detail, state: block.is_error ? "error" : "done" });
        }
      }
      continue;
    }
    if (role === "toolResult" || role === "tool_result" || role === "tool") {
      const detail = formatToolDetail(content);
      const callId = value.toolCallId || value.tool_call_id;
      const isError = !!(value.isError ?? value.is_error);
      const toolTitle = value.toolName || value.tool_name || value.name;
      const existing = callId ? toolsByCallId.get(callId) : null;
      if (existing) {
        if (detail) existing.text = detail;
        if (toolTitle && (!existing.title || existing.title === "Tool")) existing.title = toolTitle;
        existing.state = isError ? "error" : "done";
      } else if (detail) {
        const identity = row.uuid || row.id || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${detail}`).digest("hex");
        messages.push({ id: callId ? `native-tool-${callId}` : row.uuid || `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp, role: "tool", title: toolTitle || "Tool result", text: detail, state: isError ? "error" : "done" });
      }
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const detail = formatToolDetail(block.content);
          const existing = block.tool_use_id ? toolsByCallId.get(block.tool_use_id) : null;
          if (existing) {
            if (detail) existing.text = detail;
            existing.state = block.is_error ? "error" : "done";
          }
        }
      }
    }
    let text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n") : "";
    if (session.agent === "claude" && /^\[Request interrupted by user\b/.test(text.trim())) continue;
    if (session.agent === "grok" && role === "user") {
      hasImages = hasImages || /^<image_files>[\s\S]*?<\/image_files>/.test(text);
      text = grokUserText(value, text, hasImages);
      if (text === null) continue;
    }
    if (!text && !hasImages) continue;
    const identity = row.uuid || row.id || crypto.createHash("sha256").update(`${session.sessionRef}:${index}:${text}`).digest("hex");
    messages.push({ id: row.uuid || `native-${identity}`, providerMessageId: row.uuid || row.id, timestamp, role, text, state: "done" });
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
module.exports = { sessionFile, readHistory, preserveAttachments, isNarrationThinking, formatToolDetail };
