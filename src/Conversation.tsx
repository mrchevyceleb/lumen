import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Check,
  AlertCircle,
  TerminalSquare,
  Sparkles,
  FolderOpen,
  ArrowUp,
  Square,
  Paperclip,
  ExternalLink,
  Cable,
  Shrink,
  LogIn,
  GitBranch,
} from "lucide-react";
import { Busy, CopyButton, IconButton } from "./Components";
import ContextIndicator from "./ContextIndicator";
import { api, type Settings, type Tab, type Message, type CommandInventory, type SlashCommand, type Entry, type MentionResults, type CheckoutInfo } from "./types";
import CommandMenu from "./CommandMenu";
import FileMentionMenu from "./FileMentionMenu";
import ModelControls, { type ControlPanel } from "./ModelControls";
import SessionControls, { lumenCommands, parseThreshold } from "./SessionControls";
import type { SessionControlsState } from "./types";
import QueuedMessages, { sendingMessage } from "./QueuedMessages";
import { agentNames, foregroundFor } from "./settings";
import { ChatLink, LinkText, externalLink, filePathFromHref, rehypeWebLinks, webLink } from "./ChatLinks";
import { StreamingMarkdown } from "./stream-fade";
import { Dictation } from "./dictation/Dictation";
const authError = (text: string) => /failed to authenticate|authentication[_ ](?:failed|required)|not[_ ]authenticated|OAuth.*(?:expired|revoked|refresh|invalid)|(?:access|refresh)[_ ]token.*(?:expired|revoked|invalid|reused)|invalid[_ ](?:api[_ ]key|authentication credentials)|incorrect API key|API key.*(?:missing|invalid|not (?:found|set|configured))|no (?:API key|credentials)|not (?:logged|signed) in|please (?:log|sign) in/i.test(text);
// react-markdown renders a fenced block as <pre><code class="language-x">…</code></pre>. Pull the
// raw text and language out of that tree so the copy button copies the code itself, never the
// react-markdown element tree.
const codeOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeOf).join("");
  if (node && typeof node === "object" && "props" in node) return codeOf((node as { props?: { children?: unknown } }).props?.children);
  return "";
};
const languageOf = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(languageOf).find(Boolean) || "";
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { className?: string; children?: unknown } }).props;
    const match = /language-([\w-]+)/.exec(props?.className || "");
    return match ? match[1] : languageOf(props?.children);
  }
  return "";
};
export function AgentMark({
  agent,
  color,
  size = 20,
}: {
  agent: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      className={`agent-mark mark-${agent}`}
      style={{ color, width: size, height: size, fontSize: size * 0.72 }}
    >
      {agent === "shell" ? (
        <TerminalSquare size={size * 0.8} />
      ) : agent === "pi" ? (
        "π"
      ) : agent === "codex" ? (
        <span className="codex-mark">✳</span>
      ) : agent === "claude" ? (
        <span className="claude-mark">✺</span>
      ) : agent === "google" ? (
        <Sparkles size={size * 0.8} />
      ) : (
        <span className="grok-mark">/</span>
      )}
    </span>
  );
}
// A long chat holds thousands of messages. Drawing all of them makes every frame
// walk tens of thousands of elements, so a spinner or a streamed word pegs a CPU
// core and typing lags. Show the newest ones and let the reader page back.
const RECENT_MESSAGES = 200;
export default function Conversation({
  tab,
  settings,
  onSend,
  onStop,
  onFile,
  onFileMenu,
  onWeb,
  onError,
  onNotice,
  onNative,
  onFollowFolder,
  attachment,
  onAttach,
  onDetach,
  onConfig,
  onSignIn,
  onPasteAttachments,
  onDropAttachments,
  onClearChat,
  onTerminal,
  onForceStop,
  onContinue,
  onReconnect,
  checkout,
  onCheckout,
}: {
  tab: Tab;
  settings: Settings;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onFile: (path: string) => void;
  onFileMenu: (path: string) => void;
  onWeb: (url: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onNative: (draft?: string) => void;
  onFollowFolder: (folder: string) => void;
  attachment?: string;
  onAttach: () => void;
  onDetach: () => void;
  onConfig: (change: Partial<Tab>) => void;
  onSignIn: () => void;
  onPasteAttachments: () => void;
  onDropAttachments: (files: string[]) => void;
  onClearChat: () => void;
  onTerminal: () => void;
  onForceStop: () => void;
  onContinue: () => void;
  onReconnect: () => void;
  checkout?: CheckoutInfo;
  onCheckout?: () => void;
}) {
  const input = tab.draft || "";
  const setInput = (value: string) => onConfig({ draft: value });
  const [controlPanel, setControlPanel] = useState<ControlPanel>(null);
  const [controlPending, setControlPending] = useState(false);
  const [sessionPanel, setSessionPanel] = useState<"mcp" | "context" | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const compactLock = useRef(false);
  const [compactPending, setCompactPending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyPosition = useRef(-1), historyDraft = useRef("");
  const [inventory, setInventory] = useState<CommandInventory>({ commands: [], origin: "" });
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedCommands, setDismissedCommands] = useState(false);
  const [focused, setFocused] = useState(true);
  const [caret, setCaret] = useState(0);
  const request = useRef(0);
  const busyRef = useRef(tab.busy);
  busyRef.current = tab.busy;
  const loadedCommands = useRef(false);
  const loadingCommands = useRef<Promise<{ inventory?: CommandInventory; error?: string }> | null>(null);
  const commandToken = input.match(/^([/$])([^\s]*)([\s\S]*)$/);
  const menuOpen = tab.agent !== "shell" && !tab.busy && !controlPanel && !sessionPanel && focused && !dismissedCommands && !!commandToken &&
    (commandToken[1] === "/" || tab.agent === "codex") && caret > 0 && caret <= commandToken[2].length + 1;
  const query = commandToken?.[2].toLowerCase() || "";
  const localCommands = tab.agent === "google" ? lumenCommands.filter((command) => command.name === "clear") : lumenCommands;
  const commands = [...localCommands, ...inventory.commands.filter((c) => !localCommands.some((local) => local.name === c.name))].filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(query)).sort((a, b) =>
    Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
  const selection = Math.min(selectedCommand, Math.max(0, commands.length - 1));
  // @ mentions: an @ at the start of the draft or after whitespace opens the file picker for
  // the workspace the chat lives in. The menu lists repo files and folders; picking one (or
  // pressing Tab on the ghost completion) tags it as @path in the draft.
  const mentionRoot = tab.cwd || tab.root;
  const mentionToken = (() => {
    if (tab.agent === "shell" || tab.busy || tab.nativeOwned || !mentionRoot) return null;
    const before = input.slice(0, caret);
    const match = before.match(/(^|\s)@([^@\s"'`{}\[\]()<>]+)$/);
    if (!match) return null;
    return { start: caret - match[2].length - 1, query: match[2] };
  })();
  const [mentionEntries, setMentionEntries] = useState<Entry[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState("");
  const [mentionTruncated, setMentionTruncated] = useState(false);
  const [dismissedMentions, setDismissedMentions] = useState(false);
  const mentionRequest = useRef(0);
  // A Tab/Enter pressed while the current results are still loading is an explicit
  // completion intent, not a key to throw away. Keep it with the exact draft/caret it was
  // made against; when current results land, complete once. Any later edit supersedes it.
  const queuedMentionAccept = useRef<{ input: string; caret: number } | null>(null);
  const mentionOpen = !!mentionToken && !menuOpen && focused && !dismissedMentions && !controlPanel && !sessionPanel;
  const mentionQuery = mentionToken?.query || "";
  const [mentionResultQuery, setMentionResultQuery] = useState("");
  // Results only count for the query they were fetched with; a stale list must never be
  // accepted with Tab, or fast typing tags whatever the previous search found.
  const mentionFresh = mentionResultQuery === mentionQuery;
  const shownMentionEntries = mentionFresh ? mentionEntries : [];
  const mentionSelection = Math.min(mentionSelected, Math.max(0, shownMentionEntries.length - 1));
  // Ghost completion: the top match shown faded after what was typed (full path for fuzzy hits).
  const ghostEntry = mentionOpen ? shownMentionEntries[mentionSelection] : undefined;
  const ghost = ghostEntry && mentionQuery && ghostEntry.path.toLowerCase().startsWith(mentionQuery.toLowerCase()) && ghostEntry.path.length > mentionQuery.length
    ? { before: mentionQuery, rest: ghostEntry.path.slice(mentionQuery.length) + (ghostEntry.directory ? "/" : "") }
    : null;
  useEffect(() => { setMentionSelected(0); }, [mentionQuery, tab.id]);
  useEffect(() => {
    if (!mentionOpen) return;
    const current = ++mentionRequest.current;
    setMentionLoading(true);
    const timer = setTimeout(() => {
      api<MentionResults>("files:mentions", mentionRoot, mentionQuery)
        .then((result) => { if (mentionRequest.current !== current) return; setMentionEntries(result.entries); setMentionResultQuery(mentionQuery); setMentionTruncated(result.truncated); setMentionError(""); })
        .catch((e: any) => { if (mentionRequest.current === current) { setMentionEntries([]); setMentionResultQuery(mentionQuery); setMentionError(e.message || "Could not search this workspace."); } })
        .finally(() => { if (mentionRequest.current === current) setMentionLoading(false); });
    }, 60);
    return () => { clearTimeout(timer); if (mentionRequest.current === current) mentionRequest.current++; };
  }, [mentionOpen, mentionQuery, mentionRoot]);
  const selectMention = (entry: Entry) => {
    if (!mentionToken) return;
    queuedMentionAccept.current = null;
    const tagged = `${entry.path}${entry.directory ? "/" : ""}`;
    const mention = /\s/.test(tagged) ? `@"${tagged.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"` : `@${tagged}`;
    const next = input.slice(0, mentionToken.start) + mention + " " + input.slice(caret);
    setInput(next);
    setDismissedMentions(true);
    const nextCaret = mentionToken.start + mention.length + 1;
    setCaret(nextCaret);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(nextCaret, nextCaret); });
  };
  const queuedMentionSettled = !mentionLoading && mentionFresh;
  useEffect(() => {
    const queued = queuedMentionAccept.current;
    if (!queued || !queuedMentionSettled) return;
    // The key was queued against one exact draft and caret. A later edit is a newer intent.
    if (queued.input !== input || queued.caret !== caret || !mentionOpen) { queuedMentionAccept.current = null; return; }
    queuedMentionAccept.current = null;
    if (shownMentionEntries.length) selectMention(shownMentionEntries[mentionSelection]);
  }, [caret, input, mentionOpen, mentionSelection, queuedMentionSettled, shownMentionEntries]);
  const loadCommands = (refresh = false): Promise<{ inventory?: CommandInventory; error?: string }> => {
    if (loadingCommands.current) return loadingCommands.current;
    const current = ++request.current;
    setCommandLoading(true);
    setCommandError("");
    const pending = (async () => {
      try {
        const result = await api<CommandInventory>("session:commands", tab.id, refresh);
        if (request.current !== current) return { error: "Commands changed while loading." };
        setInventory(result);
        loadedCommands.current = true;
        return { inventory: result };
      } catch (e: any) {
        if (request.current === current) setCommandError(e.message);
        return { error: e.message || "Could not load this agent's commands." };
      }
    })().finally(() => {
      if (request.current === current) setCommandLoading(false);
      if (loadingCommands.current === pending) loadingCommands.current = null;
    });
    loadingCommands.current = pending;
    return pending;
  };
  useEffect(() => {
    if (menuOpen && !loadedCommands.current && !commandError) { void loadCommands(); }
  }, [menuOpen, commandError]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { setSelectedCommand(0); }, [query]);
  const selectCommand = (command: SlashCommand) => {
    const suffix = commandToken?.[3] || " ";
    setInput(command.insertText + suffix);
    setDismissedCommands(true);
    const nextCaret = command.insertText.length + (suffix.startsWith(" ") ? 1 : 0);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const sending = sendingMessage(tab);
  const messages = useMemo<Message[]>(() => sending && !tab.messages.some((message) => message.id === sending.id)
    ? [...tab.messages, { id: sending.id, role: "user", text: sending.text, attachments: sending.attachments, delivery: "send", deliveryState: "sending" }]
    : tab.messages, [tab.messages, sending]);
  // The first message on screen once the reader scrolls up or pages back, so
  // new messages do not push the top away; null follows the newest ones.
  const [firstShown, setFirstShown] = useState<string | null>(null);
  const pagedBack = useRef<{ height: number; top: number } | null>(null);
  const pinned = firstShown ? messages.findIndex((message) => message.id === firstShown) : -1;
  const start = pinned >= 0 ? pinned : Math.max(0, messages.length - RECENT_MESSAGES);
  useLayoutEffect(() => {
    const el = scroll.current, saved = pagedBack.current;
    pagedBack.current = null;
    if (!el || !saved) return;
    // Keep the message the reader was looking at in place above what was added.
    el.scrollTop = saved.top + el.scrollHeight - saved.height;
    // The button goes away with the last page; hand its focus to the composer.
    if (document.activeElement === document.body) inputRef.current?.focus({ preventScroll: true });
  }, [firstShown]);
  // Only the reply being written right now fades word by word; everything
  // already on screen stays still. The reply must sit after the newest user
  // turn, or a send in flight would replay the previous answer's fade before
  // the new one exists.
  const streamingId = useMemo(() => {
    if (!tab.busy) return undefined;
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === "user") { lastUser = index; break; }
    for (let index = messages.length - 1; index > lastUser; index--) if (messages[index].role === "assistant") return messages[index].id;
    return undefined;
  }, [tab.busy, messages]);
  useEffect(() => {
    if (stick.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [messages, tab.busy]);
  useEffect(() => {
    stick.current = true;
    setAway(false);
    setFirstShown(null);
    inputRef.current?.focus();
  }, [tab.id]);
  const isCommandInput = tab.agent !== "shell" && (input.trimStart().startsWith("/") || (tab.agent === "codex" && input.trimStart().startsWith("$")));
  const hostCommandName = input.trim().split(/\s+/, 1)[0];
  const isHostCommand = tab.agent !== "shell" && (hostCommandName === "/clear" || hostCommandName === "/compact");
  const isLocalCommand = tab.agent === "google"
    ? hostCommandName === "/clear" || hostCommandName === "/compact"
    : !["shell", "google"].includes(tab.agent) && /^\/(mcp|autocompact|compact|clear)(?:\s|$)/.test(input.trim());
  // Manual compact: one code path for the /compact command, the Compact button and the
  // context panel. Claude has a real /compact and runs it as its own turn; the rest go
  // through the session-controls RPC. Google only compacts inside its own CLI.
  const compactNow = async () => {
    if (compactLock.current) throw new Error("Compaction is already running for this chat.");
    compactLock.current = true;
    setCompactPending(true);
    try {
      if (tab.busy || tab.agent === "shell" || tab.nativeOwned || tab.recoveryError || controlPending) throw new Error("Finish this turn before compacting.");
      if (tab.agent === "google") throw new Error("Antigravity compacts inside its own CLI. Open native view and run /compact there.");
      if (tab.agent === "claude") {
        if (!await onSend("/compact")) throw new Error("Claude did not accept /compact. Try again.");
        return;
      }
      const next = await api<SessionControlsState>("session:controls-change", tab.id, { compact: true });
      onConfig({ autoCompactTokens: next.autoCompactTokens, mcpOverrides: next.mcpOverrides, contextTokens: next.contextTokens, contextWindow: next.contextWindow });
      // `notice` is the compact outcome itself (for example "nothing to compact yet").
      // The generic control warning belongs in SessionControls and must not be toasted
      // as though this tap produced it.
      if (next.notice) onNotice(next.notice);
    } finally {
      compactLock.current = false;
      setCompactPending(false);
    }
  };
  const submit = async () => {
    if ((!input.trim() && !tab.draftAttachments?.length) || tab.nativeOwned || tab.recoveryError || tab.phase === "compacting" || (tab.busy && tab.agent === "shell") || controlPending || submitting || submitLock.current || (isCommandInput && !isLocalCommand && !isHostCommand && commandLoading)) return;
    submitLock.current = true;
    try {
    const hostCommand = input.trim();
    setSessionError("");
    if (tab.busy) {
      // Queue by default: everything typed while the agent works waits above
      // the composer and sends as the next turn. Only the explicit Steer
      // correction button injects into the running turn.
      // Lumen's own commands run against the idle chat. Host commands with
      // arguments are rejected exactly as the idle path rejects them, instead
      // of being queued and then diverging from Lumen's transcript.
      const bareHostCommand = hostCommand.trim() === hostCommandName && (isHostCommand || ["/model", "/effort", "/thinking"].includes(hostCommandName));
      if (isHostCommand && !bareHostCommand) {
        setSessionError(hostCommandName === "/clear" ? "Use /clear without extra text." : "Use /compact without extra text.");
        return;
      }
      if (bareHostCommand || isLocalCommand) {
        setSessionError("This Lumen command runs when the chat is idle. Queue a message or a CLI command for the next turn.");
        return;
      }
      if (isCommandInput) {
        // Resolve the command now, exactly as the idle path would, so the queued
        // text is what the next turn should actually run. Native-view commands
        // cannot ride the queue; say so instead of queueing text that would
        // misfire later. Pi extension commands queue natively.
        setSubmitting(true);
        try {
          let available = inventory;
          if (!loadedCommands.current) {
            const discovered = await loadCommands();
            if (!discovered.inventory) { setSessionError(discovered.error || "Could not load this agent's commands. The message was not queued."); return; }
            if (!busyRef.current) { setSessionError("The turn finished before this command could queue. Review it and send again."); return; }
            available = discovered.inventory;
          }
          const token = input.trim().split(/\s+/)[0];
          const command = available.commands.find((c) => c.insertText === token || (tab.agent === "codex" && `/${c.name}` === token));
          if (command?.native) { setSessionError("This command needs Native CLI. Run it after this turn finishes."); return; }
          const resolved = command && tab.agent === "codex" && token.startsWith("/") ? input.replace(token, command.insertText) : input;
          if (await onSend(resolved)) { setInput(""); setCaret(0); stick.current = true; }
          return;
        } finally { setSubmitting(false); }
      }
      setSubmitting(true);
      if (await onSend(input)) { setInput(""); setCaret(0); stick.current = true; }
      return;
    }
    if (hostCommandName === "/clear") {
      if (hostCommand !== "/clear") { setSessionError("Use /clear without extra text."); return; }
      setSessionPanel(null);
      onClearChat();
      return;
    }
    if (hostCommandName === "/compact") {
      if (hostCommand !== "/compact") { setSessionError("Use /compact without extra text."); return; }
      setSubmitting(true);
      try { await compactNow(); setInput(""); setCaret(0); setDismissedCommands(true); }
      catch (e: any) { setSessionError(e.message); }
      finally { setSubmitting(false); }
      return;
    }
    if (isLocalCommand) {
      const [name, ...args] = hostCommand.split(/\s+/);
      if (!args.length) {
        setSessionPanel(name === "/mcp" ? "mcp" : "context"); setInput(""); setDismissedCommands(true); return;
      }
      setSubmitting(true);
      try {
        if (args.length !== 1 || (name === "/mcp" && args[0] !== "reset")) throw new Error(name === "/mcp" ? "Use /mcp or /mcp reset." : "Use /autocompact 160k or /autocompact auto.");
        const next = await api<SessionControlsState>("session:controls-change", tab.id, name === "/mcp" ? { resetMcps: true } : { autoCompactTokens: parseThreshold(args[0]) });
        onConfig({ autoCompactTokens: next.autoCompactTokens, mcpOverrides: next.mcpOverrides, contextTokens: next.contextTokens, contextWindow: next.contextWindow, draft: "" });
        setDismissedCommands(true); setSessionPanel(name === "/mcp" ? "mcp" : "context");
      } catch (e: any) { setSessionError(e.message); }
      finally { setSubmitting(false); }
      return;
    }
    if (tab.agent !== "shell" && ["/model", "/effort", "/thinking"].includes(hostCommand)) {
      setControlPanel(hostCommand === "/model" ? "model" : "effort");
      setInput(""); setDismissedCommands(true); return;
    }
    setSubmitting(true);
    try {
    let available = inventory;
    if (isCommandInput && !loadedCommands.current) {
      const discovered = await loadCommands();
      if (!discovered.inventory) return;
      available = discovered.inventory;
    }
    const token = input.trim().split(/\s+/)[0];
    const command = available.commands.find((c) => c.insertText === token || (tab.agent === "codex" && `/${c.name}` === token));
    if (command?.native) onNative(input.trim());
    else if (!await onSend(command && tab.agent === "codex" && token.startsWith("/") ? input.replace(token, command.insertText) : input)) return;
    setInput("");
    setCaret(0);
    setDismissedCommands(false);
    stick.current = true;
    } finally { setSubmitting(false); }
    } finally { submitLock.current = false; setSubmitting(false); }
  };
  const color = settings.coloredAgents
    ? settings.agents[tab.agent].color
    : settings.accent;
  const statusCaption = controlPending ? "Reading or applying CLI controls…" : isCommandInput && commandLoading ? "Discovering commands…" : isCommandInput && commandError ? commandError : tab.phase === "finishing" ? "Grok has finished its response; the CLI is closing." : tab.phase === "waiting" ? "Grok's output has paused. Its CLI may still be running hooks or continuing the turn." : "";
  const compactLabel = tab.autoCompactTokens ? `Auto-compact · ${tab.autoCompactTokens.toLocaleString()} tokens` : "Auto-compact · CLI default";
  return (
    <div
      className={`conversation ${settings.compact ? "compact" : ""}`}
      style={{ "--agent-color": color, "--agent-foreground": foregroundFor(color) } as CSSProperties}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { dragDepth.current++; setDraggingFiles(true); } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDraggingFiles(false); }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); const files = Array.from(event.dataTransfer.files).map((file) => window.lumen.filePath(file)).filter(Boolean); if (files.length) onDropAttachments(files); }}>
      {draggingFiles && <div className="drop-overlay" aria-hidden="true"><Paperclip size={22} /><span>Drop to add the path</span></div>}
      {tab.recoveryError && <div className="recovery-banner" role="alert"><span>{tab.recoveryError}</span><button onClick={onReconnect}>Retry connection</button></div>}
      {tab.nativeOwned && <div className="recovery-banner"><span>Native CLI is still open. Exit it when ready; Readable will reconnect to this conversation.</span><button onClick={onTerminal}>Show terminal</button></div>}
      {tab.interrupted && !tab.busy && !tab.recoveryError && <div className="recovery-banner"><span>{tab.agent === "shell" ? "This shell was interrupted. Open its terminal or enter a new command." : "This turn was interrupted. Your conversation is restored."}</span><button onClick={tab.agent === "shell" ? onTerminal : onContinue}>{tab.agent === "shell" ? "Open terminal" : "Continue"}</button></div>}
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          stick.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          setAway(!stick.current);
          if (!stick.current && !firstShown && messages[start]) setFirstShown(messages[start].id);
          else if (stick.current && firstShown) setFirstShown(null);
        }}
      >
        {messages.length === 0 ? (
          <div className="session-empty">
            <div className="session-emblem" style={{ color }}>
              <AgentMark agent={tab.agent} color={color} size={44} />
            </div>
            <span className="eyebrow">
              {tab.agent === "shell"
                ? "A TERMINAL WITH ROOM TO THINK"
                : `${agentNames[tab.agent].toUpperCase()} · YOUR NEXT GOOD IDEA`}
            </span>
            <h1>
              {tab.agent === "shell"
                ? "Less noise. More flow."
                : "What are we working on?"}
            </h1>
            <p>
              {tab.agent === "shell"
                ? tab.projectless ? "Real shell commands. Clear, readable output. Open a workspace whenever you need one." : "Real shell commands. Clear, readable output. Your files and Git, a glance away."
                : "Your familiar CLI, in a calmer space. Messages read like a conversation; tools stay within reach."}
            </p>
            <div className="prompt-suggestions">
              {(tab.agent === "shell"
                ? tab.projectless ? ["Get-Location", "Get-ChildItem", 'Write-Output "Hello, Lumen"'] : ["Get-Location", "git status", "git log --oneline -5"]
                : tab.projectless ? ["Help me brainstorm an idea", "Explain a coding concept", "Help me plan a project"]
                : [
                    "Give me a quick tour of this repository",
                    "Help me plan my next change",
                    "Review the current Git diff",
                  ]
              ).map((text) => (
                <button
                  key={text}
                  onClick={() => {
                    setInput(text);
                    inputRef.current?.focus();
                  }}
                >
                  {text}
                  <ArrowUp size={14} />
                </button>
              ))}
            </div>
            <div className="session-empty-note">
              <span className="live-dot" />
              Connected to your local{" "}
              {tab.agent === "shell" ? "shell" : agentNames[tab.agent] + " CLI"}
              <button onClick={() => onNative()}>
                Open native view
                <ExternalLink size={11} />
              </button>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {start > 0 && (
              <button
                className="earlier-messages"
                onClick={() => {
                  const el = scroll.current;
                  if (el) pagedBack.current = { height: el.scrollHeight, top: el.scrollTop };
                  setFirstShown(messages[Math.max(0, start - RECENT_MESSAGES)].id);
                }}
              >
                Show {Math.min(start, RECENT_MESSAGES)} earlier messages
                <span>{start.toLocaleString()} above</span>
              </button>
            )}
            {messages.map((message, index) => index < start || tab.agent !== "shell" && message.role === "assistant" && authError(message.text) && messages[index + 1]?.role === "error" && authError(messages[index + 1].text) ? null : (
              <MessageView
                key={message.id}
                message={message}
                tab={tab}
                streaming={message.id === streamingId}
                color={color}
                onFile={onFile}
                onFileMenu={onFileMenu}
                onWeb={onWeb}
                onError={onError}
                onNotice={onNotice}
                onSignIn={onSignIn}
              />
            ))}
            {(tab.busy || tab.phase === "compacting") && (
              <div className="working-indicator" role="status" aria-live="polite">
                {tab.phase ? <TerminalSquare size={13} /> : <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>}{" "}
                {tab.phase === "retrying" ? (tab.phaseText || "Reconnecting…") : tab.phase === "compacting" ? "Compacting context…" : tab.phase === "finishing" ? "Finishing Grok CLI…" : tab.phase === "waiting" ? "Waiting for Grok to finish…" : tab.agent === "shell"
                  ? "Running command"
                  : `${agentNames[tab.agent]} is working`}
              </div>
            )}
            {!tab.busy && tab.duration !== undefined && (
              <div className="turn-footer">
                <Check size={13} />
                {tab.exitCode !== undefined && tab.exitCode !== 0 && (
                  <span>
                    {tab.exitCode === 130
                      ? "Stopped · "
                      : `Exit ${tab.exitCode} · `}
                  </span>
                )}
                Worked for{" "}
                {tab.duration < 1000
                  ? "<1s"
                  : `${Math.round(tab.duration / 1000)}s`}
                <span>·</span>
                {tab.messages.filter((m) => m.role === "tool").length}{" "}
                activities
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {/* Anchored to the composer, not the window: when the toolbar wraps on a
            narrow chat the composer grows, and a fixed offset would land the
            arrow on top of the model picker. */}
        {away && (
          <button
            className="jump-bottom"
            aria-label="Jump to latest message"
            onClick={() => {
              stick.current = true;
              scroll.current?.scrollTo({
                top: scroll.current.scrollHeight,
                behavior: "smooth",
              });
              setAway(false);
            }}
          >
            <ArrowDown size={18} />
          </button>
        )}
        {tab.agent !== "shell" && <QueuedMessages tab={tab} onConfig={onConfig} />}
        {tab.agent === "shell" && tab.cwd && tab.cwd !== tab.root && (
          <button
            className="cwd-banner"
            onClick={() => onFollowFolder(tab.cwd!)}
          >
            <FolderOpen size={13} />
            {tab.cwd}
            <span>Open this workspace ↗</span>
          </button>
        )}
        {tab.agent !== "shell" && checkout?.linked && (
          <button
            className="cwd-banner worktree-banner"
            onClick={() => onCheckout?.()}
            title={checkout.path}
          >
            <GitBranch size={13} />
            Worktree: {checkout.name}{checkout.branch ? ` · ${checkout.branch}` : ""}
            <span>Manage worktrees ↗</span>
          </button>
        )}
        <div className="composer-anchor">
        {menuOpen && <CommandMenu commands={commands} selected={selection} loading={commandLoading} error={commandError}
          warning={inventory.warning} origin={inventory.origin} agent={agentNames[tab.agent]}
          onSelect={selectCommand} onHover={setSelectedCommand} onRefresh={() => { void loadCommands(true); }} onNative={() => onNative()} />}
        {mentionOpen && <FileMentionMenu entries={shownMentionEntries} selected={mentionSelection} loading={mentionLoading || !mentionFresh} error={mentionError} query={mentionQuery}
          truncated={mentionTruncated} ghost={ghost} onSelect={selectMention} onHover={setMentionSelected} />}
        <div className="composer">
          {!!tab.draftAttachments?.length && <div className="image-attachments">{tab.draftAttachments.map((image) => <div key={image.id}><img src={image.preview} alt={image.name} /><span>{image.name}</span><button aria-label={`Remove ${image.name}`} onClick={() => onConfig({ draftAttachments: tab.draftAttachments?.filter((value) => value.id !== image.id) })}>×</button></div>)}</div>}
          {attachment && (
            <div className="attachment">
              <Paperclip size={12} />
              {attachment}
              <button aria-label="Remove file reference" onClick={onDetach}>
                ×
              </button>
            </div>
          )}
          <div className="composer-input-row">
          <textarea
            ref={inputRef}
            rows={1}
            role={tab.agent === "shell" ? undefined : "combobox"}
            aria-autocomplete={tab.agent === "shell" ? undefined : "list"}
            aria-expanded={tab.agent === "shell" ? undefined : menuOpen || mentionOpen}
            aria-controls={menuOpen ? "slash-commands" : mentionOpen ? "file-mentions" : undefined}
            aria-activedescendant={menuOpen && commands.length > 0 ? `slash-command-${selection}` : mentionOpen && shownMentionEntries.length > 0 ? `file-mention-${mentionSelection}` : undefined}
            aria-label={
              tab.agent === "shell" ? "Shell command" : "Message agent"
            }
            placeholder={
              tab.agent === "shell"
                ? "Run a command…"
                : "Ask, build, or explore… / commands · @ files"
            }
            value={input}
            disabled={(tab.busy && tab.agent === "shell") || submitting || tab.nativeOwned || !!tab.recoveryError}
            onPaste={(event) => {
              if (tab.agent === "shell") return;
              if (event.clipboardData.files.length || Array.from(event.clipboardData.items).some((item) => item.kind === "file") || !event.clipboardData.getData("text/plain")) {
                event.preventDefault(); onPasteAttachments();
              }
            }}
            onChange={(e) => { queuedMentionAccept.current = null; historyPosition.current = -1; setInput(e.target.value); setCaret(e.target.selectionStart); setDismissedCommands(false); setDismissedMentions(false); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (tab.agent === "shell" && !e.ctrlKey && !e.metaKey && !e.altKey && (!input.includes("\n") || historyPosition.current >= 0) && ["ArrowUp", "ArrowDown"].includes(e.key)) {
                const history = tab.messages.filter((message) => message.role === "user").map((message) => message.text).reverse();
                if (e.key === "ArrowUp" && history.length) {
                  e.preventDefault(); if (historyPosition.current < 0) historyDraft.current = input;
                  historyPosition.current = Math.min(historyPosition.current + 1, history.length - 1); setInput(history[historyPosition.current]);
                } else if (e.key === "ArrowDown" && historyPosition.current >= 0) { e.preventDefault(); historyPosition.current--; setInput(historyPosition.current < 0 ? historyDraft.current : history[historyPosition.current]); }
                return;
              }
              if (mentionOpen && e.key === "Escape") { queuedMentionAccept.current = null; e.preventDefault(); e.stopPropagation(); setDismissedMentions(true); return; }
              if (mentionOpen && ["ArrowDown", "ArrowUp"].includes(e.key)) {
                queuedMentionAccept.current = null;
                e.preventDefault();
                if (shownMentionEntries.length) setMentionSelected((mentionSelection + (e.key === "ArrowDown" ? 1 : shownMentionEntries.length - 1)) % shownMentionEntries.length);
                return;
              }
              if (mentionOpen && !e.shiftKey && !e.ctrlKey && !e.metaKey && ["Enter", "Tab"].includes(e.key)) {
                // While results are still loading there is nothing safe to accept yet, but
                // the key must not fall through to the browser: Tab would jump focus to the
                // Send button and Enter would send a half-typed mention. Queue that intent
                // for the current draft instead of discarding it; only current-query
                // results may satisfy it.
                if (mentionLoading || !mentionFresh) { e.preventDefault(); queuedMentionAccept.current = { input, caret }; return; }
                if (shownMentionEntries.length) { e.preventDefault(); selectMention(shownMentionEntries[mentionSelection]); return; }
              }
              if (mentionOpen && e.key === "ArrowRight" && ghost && caret === input.length) {
                e.preventDefault(); selectMention(shownMentionEntries[mentionSelection]); return;
              }
              if (menuOpen && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissedCommands(true); return; }
              if (menuOpen && ["ArrowDown", "ArrowUp"].includes(e.key)) {
                e.preventDefault();
                if (commands.length) setSelectedCommand((selection + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
                return;
              }
              if (menuOpen && !e.shiftKey && !e.ctrlKey && !e.metaKey && ["Enter", "Tab"].includes(e.key) && commands.length) {
                e.preventDefault(); selectCommand(commands[selection]); return;
              }
              if (menuOpen && commandLoading && !isLocalCommand && e.key === "Enter") { e.preventDefault(); return; }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                (settings.enterSend || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault();
                historyPosition.current = -1; submit();
              }
            }}
          />
          <div className="composer-send-actions">
              {tab.agent !== "shell" && <Dictation chatId={tab.id} onText={(text) => {
                const before = input.slice(0, caret), after = input.slice(caret);
                const textBefore = before && !/\s$/.test(before) ? " " : "";
                const textAfter = after && !/^\s/.test(after) && !/^[.,!?;:]/.test(after) ? " " : "";
                const next = `${before}${textBefore}${text}${textAfter}${after}`;
                setInput(next);
                const nextCaret = before.length + textBefore.length + text.length;
                setCaret(nextCaret);
                requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(nextCaret, nextCaret); });
              }} onActive={() => {}} />}
              {tab.busy && (
                <button className="send-button stop-button" disabled={tab.stopping} aria-label="Stop running turn" title={tab.stopping ? "Cancellation requested" : "Stop running turn"} onClick={onStop}>
                  <Square size={13} fill="currentColor" />
                </button>
              )}
              {(!tab.busy || tab.agent !== "shell") && (
                <button className="send-button" aria-label={tab.busy ? "Queue message" : "Send message"}
                  title={`${tab.busy ? "Queue message" : "Send message"} · ${settings.enterSend ? "Enter · Shift+Enter for a new line" : "Ctrl+Enter"}`}
                  disabled={(!input.trim() && !tab.draftAttachments?.length) || tab.nativeOwned || !!tab.recoveryError || tab.phase === "compacting" || controlPending || submitting || (isCommandInput && !isLocalCommand && commandLoading)} onClick={submit}>
                  <ArrowUp size={18} />
                </button>
              )}
          </div>
          </div>
          <div className="composer-toolbar">
              {checkout && <button className={`model-control checkout-chip${checkout.linked ? " worktree-chip" : ""}`} aria-label={`Current ${checkout.linked ? "worktree" : "folder"}: ${checkout.path}`} title={`${checkout.linked ? "Worktree" : "Folder"}: ${checkout.path}${checkout.branch ? `\nBranch: ${checkout.branch}` : ""}`} onClick={() => onCheckout?.()}>
                <GitBranch size={13} /><span>{checkout.linked ? `Worktree: ${checkout.name}` : checkout.name}{checkout.branch ? ` · ${checkout.branch}` : ""}</span>
              </button>}
              {tab.agent !== "shell" && <IconButton
                label="Attach images or videos"
                onClick={onAttach}
              >
                <Paperclip size={16} />
              </IconButton>}
              <IconButton label="Show interactive terminal" onClick={onTerminal}><TerminalSquare size={16} /></IconButton>
              {tab.forceStopAvailable && <button className="force-stop" onClick={onForceStop}>Force stop</button>}
              {tab.agent !== "shell" && <IconButton label="Discover slash commands" disabled={tab.busy} onClick={() => {
                if (!input.startsWith("/") && !(tab.agent === "codex" && input.startsWith("$"))) setInput(input ? `/ ${input}` : "/");
                setCaret(1); setDismissedCommands(false); setFocused(true);
                requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(1, 1); });
              }}><span className="composer-slash">/</span></IconButton>}
          {tab.agent !== "shell" && tab.agent !== "google" && <button className="model-control compact-control" aria-label="Compact this chat now" title="Compact this chat now · /compact" disabled={tab.busy || tab.phase === "compacting" || compactPending || submitting || controlPending || tab.nativeOwned || !!tab.recoveryError} onClick={() => { void compactNow().catch((e: any) => setSessionError(e.message)); }}>
            <Shrink size={13} /><span>Compact</span>
          </button>}
          {tab.agent !== "shell" && <ModelControls tab={tab} panel={controlPanel} setPanel={setControlPanel}
            onConfig={onConfig} onPending={setControlPending} onNative={(draft) => onNative(draft ? `${draft}${input.trim() ? `\n\n${input}` : ""}` : input.trim() || undefined)}
            onPlanDraft={() => { setInput(input.startsWith("/plan") ? input : `/plan${input.trim() ? ` ${input}` : " "}`); setDismissedCommands(true);
              requestAnimationFrame(() => inputRef.current?.focus()); }} />}
          {!["shell", "google"].includes(tab.agent) && <>
            <IconButton label="MCPs & context" disabled={tab.busy || submitting || controlPending} onClick={() => setSessionPanel("mcp")}><Cable size={14} /></IconButton>
            <button className="model-control auto-compact-control" aria-label={compactLabel} title={compactLabel}
              disabled={tab.busy || submitting || controlPending} onClick={() => setSessionPanel("context")}>
              <Shrink size={13} /><span>{tab.autoCompactTokens ? `${(tab.autoCompactTokens / 1000).toLocaleString()}k` : "Auto-compact"}</span>
            </button>
            <ContextIndicator
              tab={tab}
              variant="composer"
              disabled={tab.busy || submitting || controlPending}
              onClick={() => setSessionPanel("context")}
            />
          </>}
          </div>
          {sessionError && <div className="session-control-error" role="alert"><AlertCircle size={14} /><span>{sessionError}</span>{authError(sessionError) && <button className="secondary" disabled={tab.busy} onClick={onSignIn}>Sign in</button>}</div>}
        </div>
        </div>
        {statusCaption && <div className="composer-caption" role="status">{statusCaption}</div>}
      </div>
      {sessionPanel && <SessionControls tab={tab} onConfig={onConfig} focusContext={sessionPanel === "context"} onSignIn={onSignIn} onCompact={compactNow}
        onNative={() => { setSessionPanel(null); if (tab.agent === "pi") void onSend("/mcp"); else onNative("/mcp"); }}
        onClose={() => { setSessionPanel(null); requestAnimationFrame(() => inputRef.current?.focus()); }} />}
    </div>
  );
}
function MessageView({
  message: m,
  tab,
  color,
  streaming,
  onFile,
  onFileMenu,
  onWeb,
  onError,
  onNotice,
  onSignIn,
}: {
  message: Message;
  tab: Tab;
  color: string;
  streaming: boolean;
  onFile: (path: string) => void;
  onFileMenu: (path: string) => void;
  onWeb: (url: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onSignIn: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (m.role === "user")
    return (
      <div className="user-message">
        {!!m.attachments?.length && <div className="message-images">{m.attachments.map((image) => <img key={image.id} src={image.preview} alt={image.name} />)}</div>}
        <div>{m.deliveryState === "sending" && <span className="steered-label">Sending…</span>}{m.deliveryState === "uncertain" && <span className="steered-label">Delivery uncertain · inspect history before resending</span>}{m.delivery === "steer" && <span className="steered-label">Added during run · separate answer not guaranteed</span>}<LinkText text={m.text} onWeb={onWeb} onError={onError} /></div>
        <CopyButton text={m.text} />
      </div>
    );
  if (m.role === "tool")
    return (
      <div className={`tool-message tool-${m.state}`}>
        <button
          className="tool-summary"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="tool-state">
            {m.state === "running" ? (
              <span className="tiny-pulse" />
            ) : m.state === "error" || m.state === "failed" ? (
              <AlertCircle size={13} />
            ) : (
              <Check size={13} />
            )}
          </span>
          <span>{m.title}</span>
        </button>
        {expanded && (
          <pre className="tool-detail"><LinkText text={m.text || "No output."} onWeb={onWeb} onError={onError} /></pre>
        )}
      </div>
    );
  if (m.role === "error")
    return (
      <div className="error-message">
        <AlertCircle size={16} />
        <div>
          {tab.agent !== "shell" && authError(m.text) ? tab.agent === "pi" && (m.provider || m.model) ? <>
            {/* Pi names the provider on its errors, so point at that provider's saved credential,
                never at a generic Pi sign-in: re-running the wrong login was the sign-in loop. */}
            <strong>{m.provider ? `${m.provider} ` : ""}rejected its saved sign-in{m.model ? ` for ${m.model}` : ""}</strong>
            <p>Pi is still signed in. Update the {m.provider || "provider"} credential or saved sign-in under Settings → Accounts → Pi, or pick a different model, then retry your message.</p>
            <button className="primary" disabled={tab.busy} onClick={onSignIn}><LogIn size={14} />Update {m.provider || "provider"} sign-in</button>
            <details className="auth-error-details"><summary>Error details</summary><p><LinkText text={m.text} onWeb={onWeb} onError={onError} /></p></details>
          </> : <>
            <strong>{agentNames[tab.agent]} needs you to sign in again</strong>
            <p>Your chat is saved. Sign in here, then retry your message.</p>
            <button className="primary" disabled={tab.busy} onClick={onSignIn}><LogIn size={14} />Sign in to {agentNames[tab.agent]}</button>
            <details className="auth-error-details"><summary>Error details</summary><p><LinkText text={m.text} onWeb={onWeb} onError={onError} /></p></details>
          </> : <><strong>Something needs attention</strong><p><LinkText text={m.text} onWeb={onWeb} onError={onError} /></p></>}
        </div>
        <CopyButton text={m.text} />
      </div>
    );
  if (m.role === "notice")
    return (
      <details className="notice-message">
        <summary>CLI details</summary>
        <pre><LinkText text={m.text} onWeb={onWeb} onError={onError} /></pre>
      </details>
    );
  return (
    <div className="assistant-message">
      <div className="message-author">
        <AgentMark agent={tab.agent} color={color} size={16} />
        <span>{agentNames[tab.agent]}</span>
        <CopyButton text={m.text} />
      </div>
      {tab.agent === "shell" ? (
        <pre className="shell-output">
          <LinkText text={m.text || "Command completed without output."} onWeb={onWeb} onError={onError} />
        </pre>
      ) : (
        <div className="prose">
          <StreamingMarkdown
            text={m.text}
            animate={streaming}
            animationKey={m.id}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeWebLinks]}
            // defaultUrlTransform drops things like C:/Users/... because it reads
            // "C:" as an unknown protocol, and it drops tel: outright. A file path
            // and a phone number are what ChatLink knows how to open, so keep both
            // intact and let it decide.
            urlTransform={(url) => webLink(url) || externalLink(url) || filePathFromHref(url) || defaultUrlTransform(url)}
            components={{
              a: ({ href, children }) => (
                <ChatLink href={href} onWeb={onWeb} onError={onError} onNotice={onNotice} onFile={onFile} onFileMenu={onFileMenu}>{children}</ChatLink>
              ),
              pre: ({ children }) => {
                const language = languageOf(children);
                return (
                  <div className="code-block">
                    <div className="code-block-bar">
                      <span className="code-block-lang">{language}</span>
                      <CopyButton text={codeOf(children)} />
                    </div>
                    <pre>{children}</pre>
                  </div>
                );
              },
            }}
          />
        </div>
      )}
    </div>
  );
}
