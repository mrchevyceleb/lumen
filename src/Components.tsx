import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  X,
  Check,
  ChevronRight,
  ChevronDown,
  Folder,
  FileCode2,
  FileText,
  FileJson,
  Loader2,
  Copy,
} from "lucide-react";
import { api, type Entry } from "./types";
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = root.current!;
    (el.querySelector("input,textarea,button,select") as HTMLElement)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const items = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,[tabindex="0"]',
          ),
        ).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1)!.focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="modal-heading">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
export function FileIcon({ name }: { name: string }) {
  return /\.(json|jsonc)$/.test(name) ? (
    <FileJson size={15} className="file-json" />
  ) : /\.(tsx?|jsx?|py|rs|go|css|html)$/.test(name) ? (
    <FileCode2 size={15} className="file-code" />
  ) : (
    <FileText size={15} />
  );
}
export function FileTree({
  root,
  refresh,
  onOpen,
  changes,
}: {
  root: string;
  refresh: number;
  onOpen: (path: string) => void;
  changes: Record<string, string>;
}) {
  return (
    <TreeLevel
      root={root}
      relative=""
      depth={0}
      refresh={refresh}
      onOpen={onOpen}
      changes={changes}
    />
  );
}
function TreeLevel({
  root,
  relative,
  depth,
  refresh,
  onOpen,
  changes,
}: {
  root: string;
  relative: string;
  depth: number;
  refresh: number;
  onOpen: (path: string) => void;
  changes: Record<string, string>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api<Entry[]>("files:tree", root, relative)
      .then((data) => {
        if (alive) {
          setEntries(data);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [root, relative, refresh]);
  return (
    <div className="tree-level">
      {error && <p className="inline-error">{error}</p>}
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 12 + depth * 15 }}
            onClick={() =>
              entry.directory
                ? setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  })
                : onOpen(entry.path)
            }
            title={entry.path}
            aria-expanded={
              entry.directory ? expanded.has(entry.path) : undefined
            }
          >
            {entry.directory ? (
              <>
                {expanded.has(entry.path) ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
                <Folder size={15} />
              </>
            ) : (
              <>
                <span className="tree-indent" />
                <FileIcon name={entry.name} />
              </>
            )}
            <span>{entry.name}</span>
            {changes[entry.path] && (
              <em className="file-status">{changes[entry.path].trim()}</em>
            )}
          </button>
          {entry.directory && expanded.has(entry.path) && (
            <TreeLevel
              root={root}
              relative={entry.path}
              depth={depth + 1}
              refresh={refresh}
              onOpen={onOpen}
              changes={changes}
            />
          )}
        </div>
      ))}
    </div>
  );
}
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : "Copy text"}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}
export function Busy({ text = "Working" }: { text?: string }) {
  return (
    <span className="busy">
      <Loader2 size={14} className="spin" />
      {text}
    </span>
  );
}
