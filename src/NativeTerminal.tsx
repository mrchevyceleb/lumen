import { useEffect, useRef, useState } from "react";
import { X, ArrowDown } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { api, type Settings } from "./types";
import { CopyButton } from "./Components";
export default function NativeTerminal({
  id,
  active,
  settings,
  onError,
  draft,
  onDismissDraft,
  terminalId,
}: {
  id: string;
  active: boolean;
  settings: Settings;
  onError: (text: string, recoveryFailure?: boolean) => void;
  draft?: string;
  onDismissDraft: () => void;
  terminalId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: settings.terminalFontSize,
      lineHeight: 1.35,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 10000,
      theme: {
        background: "#00000000",
        foreground: settings.text,
        cursor: settings.accent,
        selectionBackground: `${settings.accent}44`,
      },
    });
    const fitter = new FitAddon();
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fitter);
    term.loadAddon(search);
    term.open(host.current!);
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        if (event.type === "keydown") setFinding(true);
        return false;
      }
      return true;
    });
    terminal.current = term;
    fit.current = fitter;
    let disposed = false;
    let ready = false;
    let queued: { data: string; offset: number }[] = [];
    let offset = 0;
    const unsub = window.lumen.onSession((event) => {
      if (event.id !== id) return;
      if (event.type === "terminal" && event.terminalId === terminalId) {
        if (ready && (event.offset || 0) > offset) { term.write(event.data || ""); offset = event.offset || offset; }
        else if (!ready) queued.push({ data: event.data || "", offset: event.offset || 0 });
      }
      if (event.type === "exit")
        term.write(
          `\r\n\x1b[90mSession exited (${event.code}). Open a new terminal to continue.\x1b[0m\r\n`,
        );
    });
    // Snapshot first, then start; remounting never drops existing native scrollback.
    api<{ data: string; offset: number }>("session:buffer", id, terminalId)
      .then((buffer) => {
        if (disposed) return;
        term.write(buffer.data);
        offset = buffer.offset;
        ready = true;
        queued.forEach((chunk) => { if (chunk.offset > offset) { term.write(chunk.data); offset = chunk.offset; } });
        queued = [];
        return (terminalId ? Promise.resolve() : api("session:start", id)).then(() =>
          api("session:resize", id, term.cols, term.rows, terminalId).catch((error) => { if (!disposed) onError(error.message); }),
        );
      })
      .catch((e) => {
        if (!disposed) onError(e.message, true);
      });
    const input = term.onData((data) => {
      // The main-process emulator answers terminal queries even when hidden.
      if (/^\x1b\[(?:\??\d+(?:;\d+)*[Rcn])$/.test(data)) return;
      api("session:write", id, data, terminalId).catch((e) => onError(e.message));
    });
    const resize = term.onResize(({ cols, rows }) => {
      api("session:resize", id, cols, rows, terminalId).catch(() => {});
    });
    const observer = new ResizeObserver(() => {
      if (host.current?.clientWidth) fitter.fit();
    });
    observer.observe(host.current!);
    const find = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFinding(true);
      }
    };
    host.current!.addEventListener("keydown", find);
    return () => {
      disposed = true;
      unsub();
      input.dispose();
      resize.dispose();
      observer.disconnect();
      host.current?.removeEventListener("keydown", find);
      term.dispose();
      terminal.current = null;
    };
  }, [id, terminalId]);
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.fontSize = settings.terminalFontSize;
      terminal.current.options.theme = {
        background: "#00000000",
        foreground: settings.text,
        cursor: settings.accent,
        selectionBackground: `${settings.accent}44`,
      };
      fit.current?.fit();
    }
  }, [settings]);
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        terminal.current?.focus();
      });
    }
  }, [active]);
  return (
    <div
      className={`native-terminal ${draft ? "has-command-draft" : ""}`}
      style={{ display: active ? "block" : "none" }}
    >
      {draft && <div className="native-command-draft"><span>Paste into the CLI when it is ready:</span><code>{draft}</code><CopyButton text={draft} /><button aria-label="Dismiss command draft" onClick={onDismissDraft}><X size={13} /></button></div>}
      {finding && (
        <div className="terminal-find">
          <input
            autoFocus
            aria-label="Find in terminal"
            placeholder="Find in terminal…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              searchRef.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchRef.current?.findNext(query);
              if (e.key === "Escape") {
                setFinding(false);
                terminal.current?.focus();
              }
            }}
          />
          <button
            aria-label="Find next"
            onClick={() => searchRef.current?.findNext(query)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            aria-label="Close terminal search"
            onClick={() => {
              setFinding(false);
              terminal.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
