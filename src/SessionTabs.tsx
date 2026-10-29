import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, MoreHorizontal, Sparkles, X } from "lucide-react";
import { IconButton } from "./Components";
import { AgentMark } from "./Conversation";
import type { Settings, Tab } from "./types";

export interface SessionTabActions {
  onSelect: (tab: Tab) => void;
  onCustomize: (tab: Tab) => void;
  onRename: (tab: Tab, name: string) => void;
  onClose: (tab: Tab) => void;
  onArchiveChat: (tab: Tab) => void;
  onClearChat: (tab: Tab) => void;
  onExportChat: (tab: Tab) => void;
}
export default function SessionTabs({ tabs, activeId, settings, vertical = false, hideArchivedBadge = false, label, onSelect, onCustomize, onRename, onClose, onArchiveChat, onClearChat, onExportChat }: SessionTabActions & {
  tabs: Tab[]; activeId: string; settings: Settings; vertical?: boolean; hideArchivedBadge?: boolean; label: string;
}) {
  const nav = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const menuOpener = useRef<HTMLElement | null>(null);
  const cancelRename = useRef(false);
  const focusAfter = useRef("");
  const [menu, setMenu] = useState("");
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; flipX?: number; flipY?: number } | null>(null);
  // One placement path for the right-click and … openers; the menu is portaled to the app root
  // because the sidebar clips and filters fixed descendants, then measured and clamped.
  const openMenu = (tab: Tab, point: { x: number; y: number }, fallback?: { right: number; top: number }) => {
    menuOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuBox({ top: point.y, left: point.x, flipX: fallback?.right, flipY: fallback ? fallback.top - 4 : undefined });
    setMenu(tab.id);
  };
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el || !menuBox) return;
    const rect = el.getBoundingClientRect();
    let top = menuBox.top, left = menuBox.left;
    if (menuBox.flipY !== undefined && top + rect.height > window.innerHeight - 8) top = menuBox.flipY - rect.height;
    if (menuBox.flipX !== undefined && left + rect.width > window.innerWidth - 8) left = Math.max(8, menuBox.flipX - rect.width);
    top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - rect.height - 8)));
    left = Math.max(8, Math.min(left, Math.max(8, window.innerWidth - rect.width - 8)));
    if (top !== menuBox.top || left !== menuBox.left) setMenuBox({ top, left });
  });
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const closeMenu = (restoreFocus = false) => {
    setMenu("");
    if (restoreFocus) {
      const opener = menuOpener.current;
      menuOpener.current = null;
      if (opener?.isConnected) opener.focus();
      else {
        const tab = tabs.find((item) => item.id === menu);
        if (tab) nav.current?.querySelector<HTMLButtonElement>(`[data-chat-id="${CSS.escape(tab.id)}"]`)?.focus();
      }
    }
  };
  const focusMenuItem = (index: number) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || [])];
    items[(index + items.length) % items.length]?.focus();
  };
  useEffect(() => {
    if (!menu) return;
    // The menu belongs to one row: any pointer down outside the menu and that row (including
    // on a sibling row) closes it, and scrolling or resizing closes it too so it never hangs
    // in space pointing at a row that moved.
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.(".session-tab")?.querySelector(`[data-chat-id="${CSS.escape(menu)}"]`)) return;
      closeMenu(true);
    };
    const dismiss = () => closeMenu(true);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", dismiss);
    nav.current?.closest(".project-scroll, .session-tabs")?.addEventListener("scroll", dismiss, { passive: true });
    const scroller = nav.current?.closest(".project-scroll, .session-tabs");
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("resize", dismiss); scroller?.removeEventListener("scroll", dismiss); };
  }, [menu]);
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
    {tabs.map((tab) => <div className={`session-tab ${activeId === tab.id ? "selected" : ""} ${tab.archived ? "archived" : ""}`} key={tab.id}
      style={{ "--tab-color": settings.coloredTabs ? tab.color || settings.agents[tab.agent].color : settings.border } as CSSProperties}
      onContextMenu={renaming !== tab.id ? (event) => { event.preventDefault(); onSelect(tab); openMenu(tab, { x: event.clientX, y: event.clientY }); } : undefined}>
      {renaming === tab.id ? <input className="chat-rename" aria-label={`Rename ${tab.name}`} maxLength={100} value={name} autoFocus onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)} onBlur={() => finishRename(tab)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; event.currentTarget.blur(); }
        }} /> : <button className="tab-select" data-chat-id={tab.id} aria-label={`${tab.name}${tab.archived ? " · Archived" : ""}${tab.accountId ? ` · ${tab.accountName}` : ""}`} aria-describedby={`chat-status-${tab.id}`} aria-current={activeId === tab.id ? "page" : undefined} onClick={() => onSelect(tab)} onDoubleClick={() => onCustomize(tab)}
        onKeyDown={vertical ? (event) => { if (event.key === "F2") { event.preventDefault(); beginRename(tab); } } : undefined}
        title={`${tab.projectless ? `No workspace · ${tab.cwd || "Scratch folder"}` : tab.cwd || tab.root}\n${tab.mode === "native" ? "Native CLI" : "Readable session"}${tab.archived ? " · Archived" : ""}${vertical ? " · Right-click or F2 to rename" : ""} · Double-click to customize`}>
        <AgentMark agent={tab.agent} color={settings.coloredAgents ? settings.agents[tab.agent].color : settings.muted} size={vertical ? 14 : 16} />
        <span>{tab.name}{tab.accountId ? ` · ${tab.accountName}` : ""}</span>
        {tab.archived && !hideArchivedBadge && <span className="archived-tag" title="Archived"><Archive size={12} aria-hidden="true" /></span>}
        {tab.managedBy && <Sparkles size={11} aria-label="Agent controlled task" />}
        {tab.busy ? tab.phase ? <span className="chat-phase" title={tab.phaseText || tab.phase}>…</span> : <span className="tiny-pulse" /> : tab.mode === "native" ? <span className="native-tag">CLI</span> : null}
      </button>}
      <span className="screen-reader-only" id={`chat-status-${tab.id}`}>{`${tab.archived ? "Archived. " : ""}${tab.busy ? tab.phaseText || tab.phase || "Working" : tab.mode === "native" ? "Native CLI" : "Readable session"}`}</span>
      {renaming !== tab.id && <button type="button" className="chat-options" aria-label={`Options for ${tab.name}`} aria-haspopup="menu" aria-expanded={menu === tab.id} aria-controls={menu === tab.id ? `chat-menu-${tab.id}` : undefined} onClick={(event) => { if (menu === tab.id) { setMenu(""); return; } menuOpener.current = event.currentTarget; const r = event.currentTarget.getBoundingClientRect(); openMenu(tab, { x: r.left, y: r.bottom + 4 }, { right: r.right, top: r.top }); }}><MoreHorizontal size={12} /></button>}
      {renaming !== tab.id && <IconButton label={`Close ${tab.name} tab`} onClick={() => onClose(tab)}><X size={12} /></IconButton>}
      {menu === tab.id && createPortal(<div className="chat-menu" id={`chat-menu-${tab.id}`} ref={menuRef} role="menu" style={menuBox ? { top: menuBox.top, left: menuBox.left } : { visibility: "hidden" }} onKeyDown={(event) => { const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); } else if (event.key === "ArrowDown") { event.preventDefault(); focusMenuItem(index + 1); } else if (event.key === "ArrowUp") { event.preventDefault(); focusMenuItem(index - 1); } else if (event.key === "Home") { event.preventDefault(); focusMenuItem(0); } else if (event.key === "End") { event.preventDefault(); focusMenuItem(items.length - 1); } }}>
        <button ref={menuItem} role="menuitem" onClick={() => beginRename(tab)}>Rename chat</button>
        <button role="menuitem" onClick={() => { onCustomize(tab); setMenu(""); }}>Customize chat…</button>
        <button role="menuitem" onClick={() => { onExportChat(tab); setMenu(""); }}>Export chat…</button>
        <button role="menuitem" onClick={() => { onArchiveChat(tab); setMenu(""); }}>{tab.archived ? "Restore chat" : "Archive chat"}</button>
        <button role="menuitem" onClick={() => { onClearChat(tab); setMenu(""); }}>Clear chat…</button>
        <button role="menuitem" onClick={() => { onClose(tab); setMenu(""); }}>Close chat</button>
      </div>, nav.current?.closest(".app") || document.body)}
    </div>)}
  </nav>;
}
