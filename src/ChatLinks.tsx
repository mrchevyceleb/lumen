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

// mailto: and tel: belong to the system, not to a file path. They are the only
// external schemes a chat link may hand off, so a vscode: or ssh: link stays
// inert instead of launching an app nobody asked for.
export function externalLink(href?: string) {
  const match = href?.trim().match(/^(mailto|tel):(\S.*)$/i);
  return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
}

// Turn a Markdown href into a path the app can open on disk. Handles the shapes
// agents actually emit: C:/Users/..., C:\Users\..., \\server\share, /home/me,
// ~/Desktop/file, file:///C:/..., and plain relative paths. Anything that is a
// real web link, or a scheme we do not handle, comes back null. The path stays
// percent-encoded here: the main process decodes it exactly once.
export function filePathFromHref(href?: string) {
  if (!href) return null;
  let value = href.trim();
  if (!value) return null;
  if (/^(?:mailto|tel|data|javascript):/i.test(value)) return null;
  if (webLink(value)) return null;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host.toLowerCase() !== "localhost") {
        // file://server/share/x is a UNC path, not a workspace-relative one.
        value = `\\\\${url.host}${url.pathname.replace(/\//g, "\\")}`;
      } else {
        // file:///C:/x and file://C:/x both mean C:/x on Windows.
        value = url.pathname.replace(/^\/([a-zA-Z]:[\\/])/, "$1");
      }
    } catch {
      value = value.replace(/^file:\/\/(?:localhost)?/i, "");
    }
  } else {
    // A scheme we do not handle (ftp:, vscode:, ssh:, about:) is not a file; a
    // drive letter is the one colon form that is. README.md#section and
    // image.png?raw=1 keep only the path part.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return null;
    value = value.replace(/[?#].*$/, "");
  }
  if (!value || value.startsWith("#")) return null;
  return value;
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

export function ChatLink({ href, children, onWeb, onError, onFile, onFileMenu }: { href?: string; children: ReactNode; onWeb: (url: string) => void; onError: (message: string) => void; onFile?: (path: string) => void; onFileMenu?: (path: string) => void }) {
  const url = href ? webLink(href) : null;
  const external = url ? null : externalLink(href);
  const file = url || external ? null : filePathFromHref(href);
  const title = url
    ? "Open in Lumen · Ctrl-click to open in main browser"
    : external
      ? "Open this link in its app"
      : file
        ? "Open this file · Right-click for more"
        : undefined;
  return <a className={url || external ? "chat-web-link" : file ? "chat-file-link" : undefined} href={url || href}
    title={title}
    onClick={(event) => {
      if (url) activateWebLink(event, url, onWeb, onError);
      else if (external) { event.preventDefault(); void api("external:open", external).catch((error) => onError(error.message)); }
      else { event.preventDefault(); if (file) onFile?.(file); }
    }}
    onAuxClick={(event) => {
      if (event.button !== 1) return;
      if (url) activateWebLink(event, url, onWeb, onError);
      else if (external) { event.preventDefault(); void api("external:open", external).catch((error) => onError(error.message)); }
      else if (file) { event.preventDefault(); onFile?.(file); }
    }}
    onContextMenu={url
      ? (event) => { event.preventDefault(); void webLinkMenu(url, onWeb, onError); }
      : file && onFileMenu
        ? (event) => { event.preventDefault(); onFileMenu(file); }
        : undefined}>{children}</a>;
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
