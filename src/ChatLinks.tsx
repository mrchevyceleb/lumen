import type { ReactNode } from "react";
import { api } from "./types";

export function webLink(value: string) {
  const input = value.trim();
  const local = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (!/^https?:\/\//i.test(input) && !input.startsWith("//") && !local && !/^www\./i.test(input) && !/^[\w.-]+\.\w+:\d+(?:[/?#]|$)/.test(input)) return null;
  try {
    const url = new URL(input.startsWith("//") ? `https:${input}` : /^https?:/i.test(input) ? input : `${local ? "http" : "https"}://${input}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function findWebLinks(text: string) {
  const pattern = /(?:https?:\/\/|www\.|localhost(?=[:/?#\s]|$)|(?:\d{1,3}\.){3}\d{1,3}(?=:\d+)|\[::1\](?=[:/?#\s]|$)|[\w.-]+\.\w+:\d+)[^\s<>"'`\\]*/gi;
  const links: { start: number; end: number; text: string; url: string }[] = [];
  for (const match of text.matchAll(pattern)) {
    // Punctuation around a prose URL is not part of its address; balanced path parentheses are.
    let label = match[0].replace(/[.,;:!?]+$/, "");
    while (/[)\]}]$/.test(label)) {
      const close = label.at(-1)!, open = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[close];
      if (label.split(close).length <= label.split(open).length) break;
      label = label.slice(0, -1);
    }
    const url = webLink(label);
    if (url && (match.index === 0 || !/[\w@/]/.test(text[match.index! - 1])))
      links.push({ start: match.index!, end: match.index! + label.length, text: label, url });
  }
  return links;
}

export function activateWebLink(event: { preventDefault: () => void; ctrlKey: boolean; metaKey: boolean }, url: string, onWeb: (url: string) => void, onError: (message: string) => void) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) void api("external:open", url).catch((error) => onError(error.message));
  else onWeb(url);
}

export async function webLinkMenu(url: string, onWeb: (url: string) => void, onError: (message: string) => void) {
  try {
    const choice = await api<string | null>("browser:link-menu", url);
    if (choice === "embedded") onWeb(url);
    else if (choice === "external") await api("external:open", url);
  } catch (error: any) { onError(error.message); }
}

export function ChatLink({ href, children, onWeb, onError, onFile }: { href?: string; children: ReactNode; onWeb: (url: string) => void; onError: (message: string) => void; onFile?: (path: string) => void }) {
  const url = href ? webLink(href) : null;
  return <a className={url ? "chat-web-link" : undefined} href={url || href}
    title={url ? "Open in Lumen · Ctrl-click to open in main browser" : undefined}
    onClick={(event) => {
      if (url) activateWebLink(event, url, onWeb, onError);
      else { event.preventDefault(); if (href) onFile?.(href.replace(/^\.\//, "")); }
    }}
    onAuxClick={(event) => { if (event.button === 1 && url) activateWebLink(event, url, onWeb, onError); }}
    onContextMenu={url ? (event) => { event.preventDefault(); void webLinkMenu(url, onWeb, onError); } : undefined}>{children}</a>;
}

export function LinkText({ text, onWeb, onError }: { text: string; onWeb: (url: string) => void; onError: (message: string) => void }) {
  const children: ReactNode[] = [];
  let offset = 0;
  for (const link of findWebLinks(text)) {
    children.push(text.slice(offset, link.start), <ChatLink key={link.start} href={link.url} onWeb={onWeb} onError={onError}>{link.text}</ChatLink>);
    offset = link.end;
  }
  children.push(text.slice(offset));
  return <>{children}</>;
}

// Link bare server addresses and code output after Markdown has parsed its explicit links.
export function rehypeWebLinks() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node.children || ["a", "script", "style"].includes(node.tagName)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== "text") { walk(child); return [child]; }
        const parts: any[] = []; let offset = 0;
        for (const link of findWebLinks(child.value)) {
          parts.push({ type: "text", value: child.value.slice(offset, link.start) },
            { type: "element", tagName: "a", properties: { href: link.url }, children: [{ type: "text", value: link.text }] });
          offset = link.end;
        }
        return parts.length ? [...parts, { type: "text", value: child.value.slice(offset) }] : [child];
      });
    };
    walk(tree);
  };
}
