import { useEffect, useRef } from "react";
import { File, Folder } from "lucide-react";
import type { Entry } from "./types";

export default function FileMentionMenu({ entries, selected, loading, error, truncated, ghost, query = "", onSelect, onHover }: {
  entries: Entry[]; selected: number; loading: boolean; error: string; truncated: boolean;
  ghost: { before: string; rest: string } | null; query?: string; onSelect: (entry: Entry) => void; onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, entries.length]);
  return (
    <div className="command-menu file-mention-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="command-menu-heading">
        <span className="slash-glyph">@</span>
        <strong>Files & folders</strong>
        <span className="command-count">{loading && !entries.length ? "Searching…" : `${entries.length} found`}</span>
      </div>
      <div ref={list} className="command-list" id="file-mentions" role="listbox" aria-label="Files and folders" aria-busy={loading}>
        {loading && !entries.length ? <div className="command-empty" role="status">Searching this workspace…</div>
          : error ? <div className="command-empty" role="status">{error}</div>
          : !entries.length ? <div className="command-empty" role="status">No files or folders match. Keep typing to narrow it down.</div>
          : entries.map((entry, index) => (
            <button key={entry.path} id={`file-mention-${index}`} role="option" aria-selected={index === selected} tabIndex={-1}
              className={`command-option ${index === selected ? "selected" : ""}`} onMouseEnter={() => onHover(index)} onClick={() => onSelect(entry)}>
              <span className="command-option-copy">
                <span className="command-name">{entry.directory ? <Folder size={13} /> : <File size={13} />}{entry.name}{entry.directory ? "/" : ""}</span>
                <span className="command-description" title={entry.path}>{entry.path}</span>
              </span>
              <span className="command-source">{entry.directory ? "Folder" : "File"}</span>
            </button>
          ))}
      </div>
      <div className="mention-ghost" aria-hidden="true">{ghost
        ? <><span>@{ghost.before}</span><span className="mention-ghost-rest">{ghost.rest}</span></>
        : query ? <><span>@{query}</span><span className="mention-ghost-rest">{entries[selected] ? ` → ${entries[selected].path}${entries[selected].directory ? "/" : ""}` : ""}</span></>
        : <span className="mention-ghost-rest">Type to search this workspace</span>}</div>
      <div className="command-menu-footer">
        <span>↑↓ navigate · Tab / ↵ tag · Esc close</span>
        {truncated && <span>Large repo, showing best matches</span>}
      </div>
    </div>
  );
}
