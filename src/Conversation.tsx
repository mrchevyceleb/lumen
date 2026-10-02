import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
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
  Command,
  Paperclip,
  ExternalLink,
  Cable,
  LogIn,
} from "lucide-react";
import { Busy, CopyButton, IconButton } from "./Components";
import { api, type Settings, type Tab, type Message, type CommandInventory, type SlashCommand } from "./types";
import CommandMenu from "./CommandMenu";
import ModelControls, { type ControlPanel } from "./ModelControls";
import SessionControls, { lumenCommands, parseThreshold } from "./SessionControls";
import type { SessionControlsState } from "./types";
import QueuedMessages from "./QueuedMessages";
import { agentNames } from "./settings";
const authError = (text: string) => /failed to authenticate|authentication[_ ](?:failed|required)|not[_ ]authenticated|OAuth.*(?:expired|revoked|refresh|invalid)|(?:access|refresh)[_ ]token.*(?:expired|revoked|invalid|reused)|invalid[_ ](?:api[_ ]key|authentication credentials)|incorrect API key|API key.*(?:missing|invalid|not (?:found|set|configured))|no (?:API key|credentials)|not (?:logged|signed) in|please (?:log|sign) in/i.test(text);
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
      ) : (
        <span className="grok-mark">/</span>
      )}
    </span>
  );
}
export default function Conversation({
  tab,
  settings,
  onSend,
  onStop,
  onFile,
  onNative,
  onFollowFolder,
  attachment,
  onAttach,
  onDetach,
  onConfig,
  onSignIn,
}: {
  tab: Tab;
  settings: Settings;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onFile: (path: string) => void;
  onNative: (draft?: string) => void;
  onFollowFolder: (folder: string) => void;
  attachment?: string;
  onAttach: () => void;
  onDetach: () => void;
  onConfig: (change: Partial<Tab>) => void;
  onSignIn: () => void;
}) {
  const input = tab.draft || "";
  const setInput = (value: string) => onConfig({ draft: value });
  const [controlPanel, setControlPanel] = useState<ControlPanel>(null);
  const [controlPending, setControlPending] = useState(false);
  const [sessionPanel, setSessionPanel] = useState<"mcp" | "context" | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inventory, setInventory] = useState<CommandInventory>({ commands: [], origin: "" });
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedCommands, setDismissedCommands] = useState(false);
  const [focused, setFocused] = useState(true);
  const [caret, setCaret] = useState(0);
  const request = useRef(0);
  const loadedCommands = useRef(false);
  const loadingCommands = useRef(false);
  const commandToken = input.match(/^([/$])([^\s]*)([\s\S]*)$/);
  const menuOpen = tab.agent !== "shell" && !tab.busy && !controlPanel && !sessionPanel && focused && !dismissedCommands && !!commandToken &&
    (commandToken[1] === "/" || tab.agent === "codex") && caret > 0 && caret <= commandToken[2].length + 1;
  const query = commandToken?.[2].toLowerCase() || "";
  const commands = [...lumenCommands, ...inventory.commands.filter((c) => !lumenCommands.some((local) => local.name === c.name))].filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(query)).sort((a, b) =>
    Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
  const selection = Math.min(selectedCommand, Math.max(0, commands.length - 1));
  const loadCommands = async (refresh = false) => {
    if (loadingCommands.current) return;
    loadingCommands.current = true;
    const current = ++request.current;
    setCommandLoading(true);
    setCommandError("");
    try {
      const result = await api<CommandInventory>("session:commands", tab.id, refresh);
      if (request.current !== current) return;
      setInventory(result);
      loadedCommands.current = true;
      return result;
    } catch (e: any) {
      if (request.current === current) setCommandError(e.message);
    } finally {
      if (request.current === current) { setCommandLoading(false); loadingCommands.current = false; }
    }
  };
  useEffect(() => {
    if (menuOpen && !loadedCommands.current && !commandError) void loadCommands();
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
  useEffect(() => {
    if (stick.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [tab.messages, tab.busy]);
  useEffect(() => {
    stick.current = true;
    setAway(false);
    inputRef.current?.focus();
  }, [tab.id]);
  const isCommandInput = tab.agent !== "shell" && (input.trimStart().startsWith("/") || (tab.agent === "codex" && input.trimStart().startsWith("$")));
  const isLocalCommand = tab.agent !== "shell" && /^\/(mcp|autocompact)(?:\s|$)/.test(input.trim());
  const submit = async () => {
    if (!input.trim() || (tab.busy && tab.agent === "shell") || controlPending || submitting || submitLock.current || (isCommandInput && !isLocalCommand && commandLoading)) return;
    submitLock.current = true;
    try {
    const hostCommand = input.trim();
    setSessionError("");
    if (tab.busy) {
      if (isCommandInput) { setSessionError("Queue a normal message while the agent works. Run CLI commands after this turn finishes."); return; }
      setSubmitting(true);
      if (await onSend(input)) { setInput(""); setCaret(0); stick.current = true; }
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
      if (!discovered) return;
      available = discovered;
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
  return (
    <div className={`conversation ${settings.compact ? "compact" : ""}`}>
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          stick.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          setAway(!stick.current);
        }}
      >
        {tab.messages.length === 0 ? (
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
            {tab.messages.map((message, index) => tab.agent !== "shell" && message.role === "assistant" && authError(message.text) && tab.messages[index + 1]?.role === "error" && authError(tab.messages[index + 1].text) ? null : (
              <MessageView
                key={message.id}
                message={message}
                tab={tab}
                color={color}
                onFile={onFile}
                onSignIn={onSignIn}
              />
            ))}
            {tab.busy && (
              <div className="working-indicator">
                {tab.phase ? <TerminalSquare size={13} /> : <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>}{" "}
                {tab.phase === "compacting" ? "Compacting context…" : tab.phase === "finishing" ? "Finishing Grok CLI…" : tab.phase === "waiting" ? "Waiting for Grok to finish…" : tab.agent === "shell"
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
      <div className="composer-wrap">
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
        <div className="composer-anchor">
        {menuOpen && <CommandMenu commands={commands} selected={selection} loading={commandLoading} error={commandError}
          warning={inventory.warning} origin={inventory.origin} agent={agentNames[tab.agent]}
          onSelect={selectCommand} onHover={setSelectedCommand} onRefresh={() => void loadCommands(true)} onNative={() => onNative()} />}
        <div className="composer">
          {attachment && (
            <div className="attachment">
              <Paperclip size={12} />
              {attachment}
              <button aria-label="Remove file reference" onClick={onDetach}>
                ×
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={2}
            role={tab.agent === "shell" ? undefined : "combobox"}
            aria-autocomplete={tab.agent === "shell" ? undefined : "list"}
            aria-expanded={tab.agent === "shell" ? undefined : menuOpen}
            aria-controls={menuOpen ? "slash-commands" : undefined}
            aria-activedescendant={menuOpen && commands.length > 0 ? `slash-command-${selection}` : undefined}
            aria-label={
              tab.agent === "shell" ? "Shell command" : "Message agent"
            }
            placeholder={
              tab.agent === "shell"
                ? "Run a command…"
                : "Ask, build, or explore… / for commands"
            }
            value={input}
            disabled={(tab.busy && tab.agent === "shell") || submitting}
            onChange={(e) => { setInput(e.target.value); setCaret(e.target.selectionStart); setDismissedCommands(false); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
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
                submit();
              }
            }}
          />
          <div className="composer-footer">
            <div>
              {!tab.projectless && <IconButton
                label="Attach active file reference"
                onClick={onAttach}
              >
                <Paperclip size={16} />
              </IconButton>}
              {tab.agent !== "shell" && <IconButton label="Discover slash commands" disabled={tab.busy} onClick={() => {
                if (!input.startsWith("/") && !(tab.agent === "codex" && input.startsWith("$"))) setInput(input ? `/ ${input}` : "/");
                setCaret(1); setDismissedCommands(false); setFocused(true);
                requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(1, 1); });
              }}><span className="composer-slash">/</span></IconButton>}
              <AgentMark agent={tab.agent} color={color} size={16} />
              <span>{agentNames[tab.agent]}</span>
              <span className="composer-divider" />
              <span className="local-tag">
                {tab.mode === "rich" ? "Readable" : "Native"} view
              </span>
            </div>
            <div>
              <span className="input-hint">
                {settings.enterSend ? "↵ send · ⇧↵ new line" : "Ctrl ↵ send"}
              </span>
              {tab.busy && (
                <button
                  className="send-button stop-button"
                  aria-label="Stop running turn"
                  onClick={onStop}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              )}
              {(!tab.busy || tab.agent !== "shell") && (
                <button
                  className="send-button"
                  aria-label={tab.busy ? "Queue message" : "Send message"}
                  disabled={!input.trim() || controlPending || submitting || (isCommandInput && !isLocalCommand && commandLoading)}
                  onClick={submit}
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
          {tab.agent !== "shell" && <ModelControls tab={tab} panel={controlPanel} setPanel={setControlPanel}
            onConfig={onConfig} onPending={setControlPending} onNative={(draft) => onNative(draft ? `${draft}${input.trim() ? `\n\n${input}` : ""}` : input.trim() || undefined)}
            onPlanDraft={() => { setInput(input.startsWith("/plan") ? input : `/plan${input.trim() ? ` ${input}` : " "}`); setDismissedCommands(true);
              requestAnimationFrame(() => inputRef.current?.focus()); }} />}
          {tab.agent !== "shell" && <div className="session-access-bar"><button disabled={tab.busy || submitting || controlPending} onClick={() => setSessionPanel("mcp")}><Cable size={13} /> MCPs & context</button>
            <button disabled={tab.busy || submitting || controlPending} onClick={() => setSessionPanel("context")}>{tab.autoCompactTokens ? `Auto-compact · ${tab.autoCompactTokens.toLocaleString()}` : "Auto-compact · CLI default"}</button></div>}
          {sessionError && <div className="session-control-error" role="alert"><AlertCircle size={14} />{sessionError}</div>}
        </div>
        </div>
        <div className="composer-caption">
          <span>
            <Command size={11} />K to go anywhere
          </span>
          <span>
            {controlPending ? "Reading or applying CLI controls…" : isCommandInput && commandLoading ? "Discovering commands…" : isCommandInput && commandError ? commandError : tab.phase === "finishing" ? "Grok has finished its response; the CLI is closing." : tab.phase === "waiting" ? "Grok's output has paused. Its CLI may still be running hooks or continuing the turn." : tab.agent === "shell"
              ? "For interactive programs, open a native terminal."
              : "Uses your CLI settings and existing account."}
          </span>
        </div>
      </div>
      {sessionPanel && <SessionControls tab={tab} onConfig={onConfig} focusContext={sessionPanel === "context"} onClose={() => { setSessionPanel(null); requestAnimationFrame(() => inputRef.current?.focus()); }} />}
    </div>
  );
}
function MessageView({
  message: m,
  tab,
  color,
  onFile,
  onSignIn,
}: {
  message: Message;
  tab: Tab;
  color: string;
  onFile: (path: string) => void;
  onSignIn: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (m.role === "user")
    return (
      <div className="user-message">
        <div>{m.delivery === "steer" && <span className="steered-label">Steered into active run</span>}{m.text}</div>
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
          <pre className="tool-detail">{m.text || "No output."}</pre>
        )}
      </div>
    );
  if (m.role === "error")
    return (
      <div className="error-message">
        <AlertCircle size={16} />
        <div>
          {tab.agent !== "shell" && authError(m.text) ? <>
            <strong>{agentNames[tab.agent]} needs you to sign in again</strong>
            <p>Your chat is saved. Sign in here, then retry your message.</p>
            <button className="primary" disabled={tab.busy} onClick={onSignIn}><LogIn size={14} />Sign in to {agentNames[tab.agent]}</button>
            <details className="auth-error-details"><summary>Error details</summary><p>{m.text}</p></details>
          </> : <><strong>Something needs attention</strong><p>{m.text}</p></>}
        </div>
        <CopyButton text={m.text} />
      </div>
    );
  if (m.role === "notice")
    return (
      <details className="notice-message">
        <summary>CLI details</summary>
        <pre>{m.text}</pre>
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
          {m.text || "Command completed without output."}
        </pre>
      ) : (
        <div className="prose">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!href) return;
                    if (/^https?:/.test(href))
                      api("external:open", href).catch(() => {});
                    else onFile(href.replace(/^\.\//, ""));
                  }}
                >
                  {children}
                </a>
              ),
              pre: ({ children }) => (
                <div className="code-block">
                  <pre>{children}</pre>
                </div>
              ),
            }}
          >
            {m.text}
          </Markdown>
        </div>
      )}
    </div>
  );
}
