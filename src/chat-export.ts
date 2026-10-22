import { agentNames } from "./settings";
import type { Tab } from "./types";

// The words of a chat, ready to save as Markdown. Tool rows and CLI details are
// left out on purpose: they are machine output, not the conversation the person
// is exporting. Errors stay because they explain why an answer never came.
export function chatText(tab: Tab) {
  const agent = agentNames[tab.agent];
  const blocks: string[] = [];
  let last = "";
  const add = (role: "user" | "assistant", body: string) => {
    if (!body) return;
    if (last === role) blocks[blocks.length - 1] += `\n\n${body}`;
    else blocks.push(`## ${role === "user" ? "You" : agent}\n\n${body}`);
    last = role;
  };
  for (const message of tab.messages) {
    const text = (message.text || "").trim();
    if (message.role === "user") {
      const images = message.attachments?.length
        ? `[${message.attachments.length === 1 ? "An image was" : `${message.attachments.length} images were`} attached]`
        : "";
      add("user", [text, images].filter(Boolean).join("\n\n"));
    } else if (message.role === "assistant") add("assistant", text);
    else if (message.role === "error" && text) {
      blocks.push(`> **Error:** ${text.replace(/\n+/g, " ")}`);
      last = "error";
    }
  }
  if (!blocks.length) return "";
  const workspace = tab.projectless ? tab.cwd || "Scratch folder" : tab.cwd || tab.root;
  const exported = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return [`# ${tab.name}`, "", `- Agent: ${agent}`, `- Workspace: ${workspace}`, `- Exported: ${exported}`, "", blocks.join("\n\n"), ""].join("\n");
}
