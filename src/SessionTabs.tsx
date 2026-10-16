import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MoreHorizontal, Sparkles, X } from "lucide-react";
import { IconButton } from "./Components";
import { AgentMark } from "./Conversation";
import type { Settings, Tab } from "./types";

export interface SessionTabActions {
  onSelect: (tab: Tab) => void;
  onCustomize: (tab: Tab) => void;
  onRename: (tab: Tab, name: string) => void;
  onClose: (tab: Tab) => void;
}
export default function SessionTabs({ tabs, activeId, settings, vertical = false, label, onSelect, onCustomize, onRename, onClose }: SessionTabActions & {
  tabs: Tab[]; activeId: string; settings: Settings; vertical?: boolean; label: string;
}) {
  const nav = useRef<HTMLElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const cancelRename = useRef(false);
  const focusAfter = useRef("");
  const [menu, setMenu] = useState("");
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) setMenu(""); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => { if (menu) menuItem.current?.focus(); }, [menu]);
  useEffect(() => {
    if (renaming || !focusAfter.current) return;
    const id = focusAfter.current;
    focusAfter.current = "";
    nav.current?.querySelector<HTMLButtonElement>(`[data-chat-id="${CSS.escape(id)}"]`)?.focus();
  }, [renaming]);
  const beginRename = (tab: Tab) => {
    cancelRename.current = false;
    setName(tab.name);
    setRenaming(tab.id);
    setMenu("");
    onSelect(tab);
  };
  const finishRename = (tab: Tab) => {
    focusAfter.current = tab.id;
    if (cancelRename.current) { cancelRename.current = false; setRenaming(""); return; }
    const next = name.trim().slice(0, 100);
    if (next && next !== tab.name) onRename(tab, next);
    setRenaming("");
  };
  return <nav className={vertical ? "vertical-chats" : "session-tabs"} aria-label={label} ref={nav}>
    {tabs.map((tab) => <div className={`session-tab ${activeId === tab.id ? "selected" : ""}`} key={tab.id}
      style={{ "--tab-color": settings.coloredTabs ? tab.color || settings.agents[tab.agent].color : settings.border } as CSSProperties}
      onContextMenu={vertical && renaming !== tab.id ? (event) => { event.preventDefault(); setMenu(tab.id); } : undefined}>
      {renaming === tab.id ? <input className="chat-rename" aria-label={`Rename ${tab.name}`} maxLength={100} value={name} autoFocus onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)} onBlur={() => finishRename(tab)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; event.currentTarget.blur(); }
        }} /> : <button className="tab-select" data-chat-id={tab.id} aria-label={`${tab.name}${tab.accountId ? ` · ${tab.accountName}` : ""}`} aria-describedby={`chat-status-${tab.id}`} aria-current={activeId === tab.id ? "page" : undefined} onClick={() => onSelect(tab)} onDoubleClick={() => onCustomize(tab)}
        onKeyDown={vertical ? (event) => { if (event.key === "F2") { event.preventDefault(); beginRename(tab); } } : undefined}
        title={`${tab.projectless ? `No workspace · ${tab.cwd || "Scratch folder"}` : tab.cwd || tab.root}\n${tab.mode === "native" ? "Native CLI" : "Readable session"}${vertical ? " · Right-click or F2 to rename" : ""} · Double-click to customize`}>
        <AgentMark agent={tab.agent} color={settings.coloredAgents ? settings.agents[tab.agent].color : settings.muted} size={vertical ? 14 : 16} />
        <span>{tab.name}{tab.accountId ? ` · ${tab.accountName}` : ""}</span>
        {tab.managedBy && <Sparkles size={11} aria-label="Agent controlled task" />}
        {tab.busy ? tab.phase ? <span className="chat-phase" title={tab.phase}>…</span> : <span className="tiny-pulse" /> : tab.mode === "native" ? <span className="native-tag">CLI</span> : null}
      </button>}
      <span className="screen-reader-only" id={`chat-status-${tab.id}`}>{tab.busy ? tab.phase || "Working" : tab.mode === "native" ? "Native CLI" : "Readable session"}</span>
      {vertical && renaming !== tab.id && <button type="button" className="chat-options" aria-label={`Options for ${tab.name}`} aria-haspopup="menu" aria-expanded={menu === tab.id} aria-controls={menu === tab.id ? `chat-menu-${tab.id}` : undefined} onClick={() => setMenu(menu === tab.id ? "" : tab.id)}><MoreHorizontal size={12} /></button>}
      {renaming !== tab.id && <IconButton label={`Close ${tab.name} tab`} onClick={() => onClose(tab)}><X size={12} /></IconButton>}
      {menu === tab.id && <div className="chat-menu" id={`chat-menu-${tab.id}`} role="menu" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(""); nav.current?.querySelector<HTMLButtonElement>(`[aria-controls="chat-menu-${CSS.escape(tab.id)}"]`)?.focus(); } }}>
        <button ref={menuItem} role="menuitem" onClick={() => beginRename(tab)}>Rename chat</button>
      </div>}
    </div>)}
  </nav>;
}
