import { useEffect, useRef } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { SlashCommand } from "./types";

export default function CommandMenu({ commands, selected, loading, error, warning, origin, agent, onSelect, onHover, onRefresh, onNative }: {
  commands: SlashCommand[]; selected: number; loading: boolean; error: string;
  warning?: string; origin: string; agent: string;
  onSelect: (command: SlashCommand) => void; onHover: (index: number) => void;
  onRefresh: () => void; onNative: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, commands.length]);
  return (
    <div className="command-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="command-menu-heading">
        <span className="slash-glyph">/</span>
        <strong>Commands</strong><span>· {agent}</span>
        <span className="command-count">{loading ? "Discovering…" : `${commands.length} available`}</span>
        <button aria-label="Refresh slash commands" title="Discover commands again" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={13} className={loading ? "command-refreshing" : ""} />
        </button>
      </div>
      <div ref={list} className="command-list" id="slash-commands" role="listbox" aria-label="Slash commands" aria-busy={loading}>
        {loading && !commands.length ? <div className="command-empty" role="status">Reading commands from your installed CLI…</div> : error ? <div className="command-empty" role="status">{error}</div> : !commands.length ? <div className="command-empty" role="status">No matching commands. Refresh after adding a skill, or explore native commands below.</div> : commands.map((command, index) => (
          <button key={command.insertText} id={`slash-command-${index}`} role="option" aria-selected={index === selected} tabIndex={-1}
            className={`command-option ${index === selected ? "selected" : ""}`} onMouseEnter={() => onHover(index)} onClick={() => onSelect(command)}>
            <span className="command-option-copy">
              <span className="command-name">{command.insertText}<span className="command-arguments">{command.argumentHint}</span></span>
              <span className="command-description" title={command.description}>{command.description}</span>
            </span>
            <span className="command-source">{command.native ? "Native view ↗" : command.source}{command.scope && <small>{command.scope}</small>}</span>
          </button>
        ))}
      </div>
      {warning && <div className="command-warning">{warning}</div>}
      <div className="command-menu-footer">
        <span title={origin}>↑↓ navigate · Tab / ↵ insert · Esc close</span>
        <button onClick={onNative}>Native commands <ArrowUpRight size={12} /></button>
      </div>
    </div>
  );
}
