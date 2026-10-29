import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, FolderOpen, Plus, Pin, MoreHorizontal, GripVertical, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, ListTree, PanelTop, PanelLeftClose, TerminalSquare, Sparkles } from "lucide-react";
import SessionTabs, { type SessionTabActions } from "./SessionTabs";
import type { Settings, Tab } from "./types";

export interface Project { root: string; name: string; pinned?: boolean; hidden?: boolean; collapsed?: boolean; color?: string }
export const sameProject = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
const archiveGroupKey = (root: string) => root ? `project:${root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()}` : "scratch:";
export const projectRootOf = (tab: { root?: string; projectRoot?: string }) => tab.projectRoot || tab.root || "";
export const inProject = (tab: { root?: string; projectRoot?: string; projectless?: boolean }, root: string) => !tab.projectless && sameProject(projectRootOf(tab), root);
const projectColors = [["Red", "#f87171"], ["Amber", "#fbbf24"], ["Green", "#4ade80"], ["Cyan", "#22d3ee"], ["Blue", "#60a5fa"], ["Violet", "#c084fc"]];

export function restoreProjects(): Project[] {
  try { return normalizeProjects(JSON.parse(localStorage.getItem("lumen.projects") || "[]")); } catch { return []; }
}

export function normalizeProjects(values: unknown): Project[] {
  if (!Array.isArray(values)) return [];
  return values.filter((p, i) => p && typeof p.root === "string" && typeof p.name === "string" && !values.slice(0, i).some((q) => q && typeof q.root === "string" && sameProject(p.root, q.root))).map((p) => ({ root: p.root, name: p.name, pinned: p.pinned === true, hidden: p.hidden === true, collapsed: p.collapsed === true, color: typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : undefined }));
}

export default function ProjectSidebar({ projects, activeRoot, counts, ready, onOpen, onAdd, onTerminal, onScratch, onChange, onArchive, tabs, activeId, settings, onSelect, onCustomize, onRename, onClose, onArchiveChat, onClearChat, onExportChat, onLayout, onNewChat, newChatRoot, onCollapse, showArchived, onToggleArchived, onLeaveHidden }: SessionTabActions & {
  projects: Project[]; activeRoot: string; counts: Record<string, number>; ready: boolean;
  tabs: Tab[]; activeId: string; settings: Settings; onLayout: () => void; onNewChat: (root: string) => void; newChatRoot?: string;
  onOpen: (project: Project, reveal?: boolean) => void; onAdd: () => void; onTerminal: () => void; onScratch: () => void; onChange: (projects: Project[]) => void; onArchive: (project: Project) => void; onCollapse: () => void;
  showArchived: boolean; onToggleArchived: () => void; onLeaveHidden: () => void;
}) {
  const vertical = settings.chatLayout === "vertical";
  const [scratchCollapsed, setScratchCollapsed] = useState(false);
  const scratch = tabs.filter((tab) => tab.projectless && !tab.archived);
  const [openArchiveGroups, setOpenArchiveGroups] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem("lumen.openArchiveGroups") || "[]"); return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string").map((key) => key === "scratch:" || key.startsWith("project:") ? key : archiveGroupKey(key)) : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("lumen.openArchiveGroups", JSON.stringify(openArchiveGroups)); } catch { /* Storage can be unavailable. */ } }, [openArchiveGroups]);
  const [closedSearchGroups, setClosedSearchGroups] = useState<string[]>([]);
  const [openArchivedProjects, setOpenArchivedProjects] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem("lumen.openArchivedProjects") || "[]"); return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("lumen.openArchivedProjects", JSON.stringify(openArchivedProjects)); } catch { /* Storage can be unavailable. */ } }, [openArchivedProjects]);
  const archiveSection = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState("");
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; flipX?: number; flipY?: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpener = useRef<HTMLElement | null>(null);
  // One placement path for the right-click and … openers: put the menu by the pointer or the
  // button, then measure it after mount and clamp it into the viewport (flipping above the
  // anchor when it would spill off the bottom). The menu is portaled to the app root because
  // the sidebar's backdrop-filter and overflow would otherwise shift and clip a fixed menu.
  const openMenu = (root: string, point: { x: number; y: number }, fallback?: { right: number; top: number }) => {
    menuOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuBox({ top: point.y, left: point.x, flipX: fallback?.right, flipY: fallback ? fallback.top - 4 : undefined });
    setMenu(root);
  };
  const openContextMenu = (event: React.MouseEvent, project: Project) => {
    event.preventDefault();
    // Only the row's own controls are off limits: renaming must keep the native text menu,
    // and the … button keeps its own toggle. Right-clicking the row or its open button opens.
    if (renaming === project.root || (event.target as HTMLElement).closest("input, .project-options, .project-menu")) return;
    if (project.hidden && !showArchived) onToggleArchived();
    onOpen(project, false);
    openMenu(project.root, { x: event.clientX, y: event.clientY });
  };
  const closeMenu = (restoreFocus = false) => {
    setMenu("");
    if (restoreFocus) {
      const opener = menuOpener.current;
      menuOpener.current = null;
      if (opener?.isConnected) opener.focus();
      else {
        const project = projects.find((item) => item.root === menu);
        if (project) container.current?.querySelector<HTMLButtonElement>(`[title="${CSS.escape(project.root)}"]`)?.focus();
      }
    }
  };
  const focusMenuItem = (index: number) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || [])];
    items[(index + items.length) % items.length]?.focus();
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
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const [over, setOver] = useState("");
  const [dragging, setDragging] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const dragProject = useRef("");
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) { closeMenu(true); setAdding(false); } };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    if (!menu) return;
    // Same rule as the chat menus: a pointer down on a different row, or any scroll or
    // resize, closes the project menu instead of leaving it aimed at the wrong project.
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.(".project-row")?.querySelector(".project-open")?.getAttribute("title") === menu) return;
      closeMenu(true);
    };
    const dismiss = () => closeMenu(true);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", dismiss);
    const scroller = container.current?.querySelector(".project-scroll");
    scroller?.addEventListener("scroll", dismiss, { passive: true });
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("resize", dismiss); scroller?.removeEventListener("scroll", dismiss); };
  }, [menu]);
  useEffect(() => {
    if (showArchived) return;
    const active = tabs.find((tab) => tab.id === activeId);
    const folder = active && !active.projectless ? projectRootOf(active) : activeRoot;
    const project = folder ? projects.find((item) => sameProject(item.root, folder)) : undefined;
    const revealed = !!project && !!query.trim() && `${project.name} ${project.root}`.toLowerCase().includes(query.toLowerCase());
    const projectVisible = !project?.hidden || revealed;
    const chatVisible = !active?.archived || (!!project?.hidden && revealed);
    if (!projectVisible || (active && !chatVisible)) onLeaveHidden();
  }, [query, showArchived, activeId, activeRoot, projects, tabs]);
  const rename = (project: Project) => {
    const next = name.trim().slice(0, 100);
    if (next) onChange(projects.map((p) => p.root === project.root ? { ...p, name: next } : p));
    setRenaming("");
  };
  const archive = (project: Project) => {
    onArchive(project);
    setMenu("");
    requestAnimationFrame(() => {
      const next = container.current?.querySelector<HTMLButtonElement>('.project-open[aria-current="true"]')
        || container.current?.querySelector<HTMLButtonElement>(".project-entry .project-open")
        || container.current?.querySelector<HTMLButtonElement>('[aria-label="Add project or session"]');
      next?.focus();
    });
  };
  const visible = projects.filter((p) => !p.hidden);
  const archived = projects.filter((p) => p.hidden);
  const matchText = query.trim().toLowerCase();
  const matchesQuery = (p: Project) => `${p.name} ${p.root}`.toLowerCase().includes(matchText);
  const matchesChat = (name: string, root: string, tab: Tab) => !matchText || [name, tab.name].filter(Boolean).join(" ").toLowerCase().includes(matchText) || [root, tab.name].filter(Boolean).join(" ").toLowerCase().includes(matchText);
  const matches = visible.filter((project) => matchesQuery(project) || tabs.some((tab) => !tab.archived && inProject(tab, project.root) && matchesChat(project.name, project.root, tab)));
  const archivedMatches = archived.filter((project) => matchesQuery(project) || tabs.some((tab) => inProject(tab, project.root) && matchesChat(project.name, project.root, tab)));
  const scratchMatches = scratch.filter((tab) => matchesChat("No workspace", "", tab));
  const scratchOpen = matchText ? !closedSearchGroups.includes("active:scratch") : !scratchCollapsed;
  const archiveGroups = [
    ...visible.map((project) => ({ key: archiveGroupKey(project.root), root: project.root, name: project.name, chats: tabs.filter((tab) => tab.archived && inProject(tab, project.root)) })),
    ...tabs.filter((tab) => tab.archived && !tab.projectless && projectRootOf(tab) && !projects.some((project) => inProject(tab, project.root)))
      .reduce<{ key: string; root: string; name: string; chats: Tab[] }[]>((groups, tab) => {
        const root = projectRootOf(tab), key = archiveGroupKey(root), group = groups.find((item) => item.key === key);
        if (group) group.chats.push(tab);
        else groups.push({ key, root, name: root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || root, chats: [tab] });
        return groups;
      }, []),
    { key: "scratch:", root: "", name: "No workspace", chats: tabs.filter((tab) => tab.archived && (tab.projectless || !projectRootOf(tab))) },
  ].map((group) => ({ ...group, chats: group.chats.filter((tab) => matchesChat(group.name, group.root, tab)) })).filter((group) => group.chats.length);
  const revealArchived = showArchived || !!matchText;
  const archiveCount = archived.length + tabs.filter((tab) => tab.archived && (tab.projectless || !archived.some((project) => sameProject(project.root, projectRootOf(tab))))).length;
  const projectChats = (project: Project) => tabs.filter((tab) => inProject(tab, project.root) && (project.hidden || !tab.archived) && (!matchText || matchesQuery(project) || matchesChat(project.name, project.root, tab)));
  const allCollapsed = visible.length > 0 && visible.every((project) => project.collapsed);
  const toggleAllProjects = () => onChange(projects.map((project) => project.hidden ? project : { ...project, collapsed: !allCollapsed }));
  const selectArchived = (tab: Tab) => {
    if (!showArchived) onToggleArchived();
    const root = projectRootOf(tab), key = archiveGroupKey(tab.projectless ? "" : root);
    setOpenArchiveGroups((old) => old.includes(key) ? old : [...old, key]);
    const project = archived.find((item) => sameProject(item.root, root));
    if (project) setOpenArchivedProjects((old) => old.includes(project.root) ? old : [...old, project.root]);
    onSelect(tab);
  };
  const customizeArchived = (tab: Tab) => { selectArchived(tab); onCustomize(tab); };
  const archiveChatFromGroup = (tab: Tab) => {
    if (tab.archived && tab.projectless) setScratchCollapsed(false);
    onArchiveChat(tab);
    requestAnimationFrame(() => {
      const target = !tab.archived ? container.current?.querySelector<HTMLButtonElement>('.session-tab:not(.archived) .tab-select[aria-current="page"]') : container.current?.querySelector<HTMLButtonElement>(`[data-chat-id="${CSS.escape(tab.id)}"]`);
      if (target?.getClientRects().length) target.focus();
      else (container.current?.querySelector<HTMLButtonElement>(".archive-filter") || container.current?.querySelector<HTMLInputElement>('input[aria-label="Search projects and archives"]') || container.current?.querySelector<HTMLButtonElement>('[aria-label="Add project or session"]'))?.focus();
    });
  };
  useEffect(() => {
    if (!showArchived) return;
    const active = tabs.find((tab) => tab.id === activeId);
    if (!active) return;
    const root = projectRootOf(active), project = projects.find((item) => item.hidden && sameProject(item.root, root));
    if (project) setOpenArchivedProjects((old) => old.includes(project.root) ? old : [...old, project.root]);
    else if (active.archived) {
      const key = archiveGroupKey(active.projectless ? "" : root);
      setOpenArchiveGroups((old) => old.includes(key) ? old : [...old, key]);
    }
  }, [activeId, showArchived, tabs.find((tab) => tab.id === activeId)?.archived, projects.find((item) => item.hidden && sameProject(item.root, projectRootOf(tabs.find((tab) => tab.id === activeId) || {})))?.root]);
  const colorProject = (project: Project, color?: string) => onChange(projects.map((p) => p.root === project.root ? { ...p, color } : p));
  const move = (source: string, target: Project, after = false) => {
    const project = projects.find((p) => p.root === source);
    if (!project || project.hidden || target.hidden || source === target.root) return;
    const next = projects.filter((p) => p.root !== source);
    next.splice(next.findIndex((p) => p.root === target.root) + (after ? 1 : 0), 0, { ...project, pinned: target.pinned });
    onChange(next);
  };
  const moveWithin = (project: Project, direction: number) => {
    const peers = visible.filter((p) => !!p.pinned === !!project.pinned);
    const target = peers[peers.indexOf(project) + direction];
    if (target) move(project.root, target, direction > 0);
    setMenu("");
  };
  const startProjectDrag = (event: React.DragEvent<HTMLElement>, project: Project) => {
    dragProject.current = project.root;
    setDragging(project.root);
    event.dataTransfer.setData("application/x-lumen-project", project.root);
    event.dataTransfer.setData("text/plain", project.root);
    event.dataTransfer.effectAllowed = "move";
  };
  const finishProjectDrag = () => {
    dragProject.current = "";
    setDragging("");
    setOver("");
  };
  const isProjectDrag = (event: React.DragEvent<HTMLElement>) => !!dragProject.current || Array.from(event.dataTransfer.types).some((type) => type.toLowerCase() === "application/x-lumen-project");
  const dropProject = (event: React.DragEvent<HTMLElement>, project: Project) => {
    if (!isProjectDrag(event)) return;
    const source = dragProject.current || event.dataTransfer.getData("application/x-lumen-project");
    const rect = event.currentTarget.getBoundingClientRect();
    move(source, project, event.clientY > rect.top + rect.height / 2);
    finishProjectDrag();
  };
  return <div className={`project-sidebar ${vertical ? "with-chats" : ""} ${matchText ? "searching" : ""}`} ref={container}>
    <div className="project-heading"><span>PROJECTS <small>{visible.length}</small></span><div>{vertical && visible.length > 0 && <button aria-label={allCollapsed ? "Expand all projects" : "Collapse all projects"} title={matchText ? "Clear search to change all projects" : allCollapsed ? "Expand all projects" : "Collapse all projects"} disabled={!!matchText} onClick={toggleAllProjects}>{allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}</button>}<button aria-label={vertical ? "Use horizontal tabs" : "Use vertical chats"} title={vertical ? "Use horizontal tabs" : "Use vertical chats"} onClick={onLayout}>{vertical ? <PanelTop size={14} /> : <ListTree size={14} />}</button><div className="project-add-anchor" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAdding(false); event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus(); } }}><button aria-label="Add project or session" title="Open a folder, terminal, or chat" aria-expanded={adding} onClick={() => setAdding(!adding)} disabled={!ready}><Plus size={15} /></button>{adding && <div className="project-menu project-add-menu"><button autoFocus onClick={() => { setAdding(false); onTerminal(); }}><TerminalSquare size={15} /><span>New terminal<small>No workspace · Ctrl Alt T</small></span></button><button onClick={() => { setAdding(false); onScratch(); }}><Sparkles size={15} /><span>New agent chat<small>No workspace</small></span></button><button onClick={() => { setAdding(false); onAdd(); }}><FolderOpen size={15} /><span>Open project folder<small>Ctrl O</small></span></button></div>}</div><button aria-label="Collapse projects sidebar" title="Collapse projects sidebar" onClick={onCollapse}><PanelLeftClose size={14} /></button></div></div>
    <input aria-label="Search projects and archives" placeholder="Find a project or chat…" value={query} onChange={(e) => { setQuery(e.target.value); setClosedSearchGroups([]); }} onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); setClosedSearchGroups([]); } }} />
    {!!archiveCount && <button type="button" className="archive-filter" aria-pressed={showArchived} title={showArchived ? "Hide archived projects and chats" : "Show archived projects and chats"} onClick={() => { onToggleArchived(); if (!showArchived) requestAnimationFrame(() => archiveSection.current?.scrollIntoView({ block: "nearest" })); }}><span>{showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Archive size={14} />{showArchived ? "Hide archive" : "Archive"}</span><small>{archiveCount}</small></button>}
    <div className="project-scroll">
      {[true, false].map((pinned) => matches.some((p) => !!p.pinned === pinned) && <section key={String(pinned)} className={`project-section ${pinned ? "pinned" : "unpinned"}`} aria-label={pinned ? "Pinned projects" : "Projects"}>
        <div className="project-group">{pinned ? <><Pin size={10} /> Pinned</> : <><FolderOpen size={10} /> Projects</>}</div>
        {matches.filter((p) => !!p.pinned === pinned).map((project) => <div key={project.root} className="project-entry"><div className={`project-row ${pinned ? "is-pinned" : "is-unpinned"} ${project.color ? "has-color" : ""} ${sameProject(activeRoot, project.root) ? "selected" : ""} ${over === project.root ? "drop-target" : ""} ${dragging === project.root ? "dragging" : ""}`} style={{ "--project-color": project.color } as CSSProperties}
          onDragOver={(e) => { if (isProjectDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(project.root); } }}
          onDragEnter={(e) => { if (isProjectDrag(e)) { e.preventDefault(); setOver(project.root); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(""); }}
          onDrop={(e) => { e.preventDefault(); dropProject(e, project); }}
          onContextMenu={(e) => openContextMenu(e, project)}>
          <span className="project-grip" role="button" tabIndex={0} aria-label={`Drag to reorder ${project.name}`} draggable onDragStart={(e) => startProjectDrag(e, project)} onDragEnd={finishProjectDrag} onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); moveWithin(project, -1); } if (e.key === "ArrowDown") { e.preventDefault(); moveWithin(project, 1); } }} title="Drag to reorder, or use arrow keys"><GripVertical size={12} /></span>
          {(vertical || !!matchText) && <button className="project-collapse" title={`${(matchText ? closedSearchGroups.includes(`active:${archiveGroupKey(project.root)}`) : project.collapsed) ? "Expand" : "Collapse"} chats for ${project.name}`} aria-label={`${(matchText ? closedSearchGroups.includes(`active:${archiveGroupKey(project.root)}`) : project.collapsed) ? "Expand" : "Collapse"} chats for ${project.name}`} aria-expanded={matchText ? !closedSearchGroups.includes(`active:${archiveGroupKey(project.root)}`) : !project.collapsed} aria-controls={`chats-${encodeURIComponent(project.root)}`} onClick={() => {
            const key = `active:${archiveGroupKey(project.root)}`;
            if (matchText) setClosedSearchGroups((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
            else onChange(projects.map((p) => p.root === project.root ? { ...p, collapsed: !p.collapsed } : p));
          }}>{(matchText ? closedSearchGroups.includes(`active:${archiveGroupKey(project.root)}`) : project.collapsed) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>}
          {renaming === project.root ? <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => rename(project)} onKeyDown={(e) => { if (e.key === "Enter") rename(project); if (e.key === "Escape") setRenaming(""); }} /> : <button className="project-open" title={project.root} aria-current={sameProject(activeRoot, project.root) ? "true" : undefined} disabled={!ready} onClick={() => onOpen(project)}><FolderOpen size={16} /><span>{project.name}</span>{pinned && <Pin className="project-pin-mark" size={10} aria-label="Pinned" />}{!!(matchText ? projectChats(project).length : counts[project.root]) && <small>{matchText ? projectChats(project).length : counts[project.root]}</small>}</button>}
          {vertical && <button className="project-options" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} aria-expanded={newChatRoot !== undefined && sameProject(newChatRoot, project.root)} aria-controls={newChatRoot !== undefined && sameProject(newChatRoot, project.root) ? "new-chat-menu" : undefined} disabled={!ready} onClick={() => onNewChat(project.root)}><Plus size={13} /></button>}
          <button className="project-options" aria-label={`Options for ${project.name}`} aria-haspopup="menu" aria-expanded={menu === project.root} onClick={(e) => { if (menu === project.root) { closeMenu(true); return; } const r = e.currentTarget.getBoundingClientRect(); menuOpener.current = e.currentTarget; openMenu(project.root, { x: r.left, y: r.bottom + 4 }, { right: r.right, top: r.top }); }}><MoreHorizontal size={13} /></button>
          {menu === project.root && createPortal(<div className="project-menu" ref={menuRef} role="menu" aria-label={`Options for ${project.name}`} style={menuBox ? { top: menuBox.top, left: menuBox.left } : { visibility: "hidden" }} onKeyDown={(e) => { const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); } else if (e.key === "ArrowDown") { e.preventDefault(); focusMenuItem(index + 1); } else if (e.key === "ArrowUp") { e.preventDefault(); focusMenuItem(index - 1); } else if (e.key === "Home") { e.preventDefault(); focusMenuItem(0); } else if (e.key === "End") { e.preventDefault(); focusMenuItem(items.length - 1); } }}><button autoFocus role="menuitem" onClick={() => { onChange(projects.map((p) => p.root === project.root ? { ...p, pinned: !p.pinned } : p)); setMenu(""); }}>{project.pinned ? "Unpin project" : "Pin project"}</button><button role="menuitem" onClick={() => { setName(project.name); setRenaming(project.root); setMenu(""); }}>Rename project</button><button role="menuitem" onClick={() => moveWithin(project, -1)}>Move up</button><button role="menuitem" onClick={() => moveWithin(project, 1)}>Move down</button>
            <span className="project-color-label">Project color</span><div className="project-colors" role="group" aria-label={`Color for ${project.name}`}>
              {projectColors.map(([label, color]) => <button key={color} aria-label={`${label} project color`} title={label} aria-pressed={project.color === color} style={{ background: color }} onClick={() => colorProject(project, color)} />)}
              <input type="color" aria-label={`Custom project color for ${project.name}`} title="Custom color" value={project.color || "#60a5fa"} onChange={(e) => colorProject(project, e.target.value)} />
            </div><button role="menuitem" onClick={() => colorProject(project)}>Reset color</button>
            <button role="menuitem" className="remove-project" disabled={!ready} onClick={() => archive(project)}>Archive project<small>Keep files and chats · restore anytime</small></button></div>, container.current?.closest(".app") || document.body)}
        </div>{(vertical || !!matchText) && <div id={`chats-${encodeURIComponent(project.root)}`} hidden={matchText ? closedSearchGroups.includes(`active:${archiveGroupKey(project.root)}`) : project.collapsed}>
          <SessionTabs tabs={projectChats(project)} activeId={activeId} settings={settings} vertical label={`Chats in ${project.name}`} onSelect={onSelect} onCustomize={onCustomize} onRename={onRename} onClose={onClose} onArchiveChat={archiveChatFromGroup} onClearChat={onClearChat} onExportChat={onExportChat} />
        </div>}</div>)}
      </section>)}
      {(vertical || !!matchText) && (!matchText || scratchMatches.length > 0) && <div className="scratch-chats"><div className="scratch-heading"><button aria-label={!scratch.length && !matchText ? "New chat without workspace" : `${scratchOpen ? "Collapse" : "Expand"} chats without a workspace`} aria-expanded={!scratch.length && !matchText ? undefined : scratchOpen} onClick={() => matchText ? setClosedSearchGroups((old) => old.includes("active:scratch") ? old.filter((key) => key !== "active:scratch") : [...old, "active:scratch"]) : scratch.length ? setScratchCollapsed(!scratchCollapsed) : onScratch()}>{(matchText ? closedSearchGroups.includes("active:scratch") : scratchCollapsed) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<FolderOpen size={15} /><span>No workspace</span><small>{matchText ? scratchMatches.length : scratch.length}</small></button><button aria-label="New chat without workspace" disabled={!ready} aria-expanded={newChatRoot === ""} aria-controls={newChatRoot === "" ? "new-chat-menu" : undefined} onClick={() => onNewChat("")}><Plus size={13} /></button></div>
        <div hidden={!scratchOpen}><SessionTabs tabs={scratchMatches} activeId={activeId} settings={settings} vertical label="Chats without a workspace" onSelect={onSelect} onCustomize={onCustomize} onRename={onRename} onClose={onClose} onArchiveChat={archiveChatFromGroup} onClearChat={onClearChat} onExportChat={onExportChat} /></div>
      </div>}
      {revealArchived && archiveGroups.length > 0 && <section className="archive-chats" aria-label="Archived chats" ref={archiveSection}>
        <div className="project-group"><Archive size={10} /> Archived chats</div>
        {archiveGroups.map((group) => {
          const open = matchText ? !closedSearchGroups.includes(group.key) : openArchiveGroups.includes(group.key);
          const groupId = `archive-chats-${encodeURIComponent(group.key || "scratch")}`;
          return <div className="archive-chat-group" key={group.key}>
            <button className="archive-chat-heading" aria-expanded={open} aria-controls={groupId} onClick={() => matchText ? setClosedSearchGroups((old) => old.includes(group.key) ? old.filter((key) => key !== group.key) : [...old, group.key]) : setOpenArchiveGroups((old) => old.includes(group.key) ? old.filter((key) => key !== group.key) : [...old, group.key])}>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderOpen size={14} /><span>{group.name}</span><small>{group.chats.length}</small>
            </button>
            <div id={groupId} hidden={!open}><SessionTabs tabs={group.chats} activeId={activeId} settings={settings} vertical label={`Archived chats in ${group.name}`} hideArchivedBadge onSelect={selectArchived} onCustomize={customizeArchived} onRename={onRename} onClose={onClose} onArchiveChat={archiveChatFromGroup} onClearChat={onClearChat} onExportChat={onExportChat} /></div>
          </div>;
        })}
      </section>}
      {revealArchived && archivedMatches.length > 0 && <section className="archived-projects" aria-label="Archived projects" ref={archiveGroups.length ? undefined : archiveSection}>
        {!!archivedMatches.length && <div className="project-group"><Archive size={10} /> Archived projects</div>}
        {archivedMatches.map((project) => {
          const searchKey = `project:${project.root}`;
          const open = matchText ? !closedSearchGroups.includes(searchKey) : openArchivedProjects.includes(project.root);
          return <div key={project.root} className="project-entry"><div className={`project-row archived ${project.color ? "has-color" : ""} ${sameProject(activeRoot, project.root) ? "selected" : ""}`} style={{ "--project-color": project.color } as CSSProperties} onContextMenu={(e) => openContextMenu(e, project)}>
          <span className="project-grip" />
          <button className="project-collapse" title={`${open ? "Collapse" : "Expand"} chats for ${project.name}`} aria-label={`${open ? "Collapse" : "Expand"} chats for ${project.name}`} aria-expanded={open} aria-controls={`chats-${encodeURIComponent(project.root)}`} onClick={() => matchText ? setClosedSearchGroups((old) => old.includes(searchKey) ? old.filter((key) => key !== searchKey) : [...old, searchKey]) : setOpenArchivedProjects((old) => old.includes(project.root) ? old.filter((key) => key !== project.root) : [...old, project.root])}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
          {renaming === project.root ? <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => rename(project)} onKeyDown={(e) => { if (e.key === "Enter") rename(project); if (e.key === "Escape") setRenaming(""); }} /> : <button className="project-open" title={project.root} aria-current={sameProject(activeRoot, project.root) ? "true" : undefined} disabled={!ready} onClick={() => { if (!showArchived) onToggleArchived(); setQuery(""); setOpenArchivedProjects((old) => old.includes(project.root) ? old : [...old, project.root]); onOpen(project, false); }}><FolderOpen size={16} /><span>{project.name}</span>{!!(matchText ? projectChats(project).length : counts[project.root]) && <small>{matchText ? projectChats(project).length : counts[project.root]}</small>}</button>}
          {vertical && <button className="project-options" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} aria-expanded={newChatRoot !== undefined && sameProject(newChatRoot, project.root)} aria-controls={newChatRoot !== undefined && sameProject(newChatRoot, project.root) ? "new-chat-menu" : undefined} disabled={!ready} onClick={() => onNewChat(project.root)}><Plus size={13} /></button>}
          <button className="project-options" aria-label={`Options for ${project.name}`} aria-haspopup="menu" aria-expanded={menu === project.root} onClick={(e) => { if (menu === project.root) { closeMenu(true); return; } const r = e.currentTarget.getBoundingClientRect(); menuOpener.current = e.currentTarget; openMenu(project.root, { x: r.left, y: r.bottom + 4 }, { right: r.right, top: r.top }); }}><MoreHorizontal size={13} /></button>
          {menu === project.root && createPortal(<div className="project-menu" ref={menuRef} role="menu" aria-label={`Options for ${project.name}`} style={menuBox ? { top: menuBox.top, left: menuBox.left } : { visibility: "hidden" }} onKeyDown={(e) => { const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") || [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); } else if (e.key === "ArrowDown") { e.preventDefault(); focusMenuItem(index + 1); } else if (e.key === "ArrowUp") { e.preventDefault(); focusMenuItem(index - 1); } else if (e.key === "Home") { e.preventDefault(); focusMenuItem(0); } else if (e.key === "End") { e.preventDefault(); focusMenuItem(items.length - 1); } }}><button autoFocus role="menuitem" onClick={() => { onChange(projects.map((p) => p.root === project.root ? { ...p, hidden: false, collapsed: false } : p)); setQuery(""); setMenu(""); requestAnimationFrame(() => (container.current?.querySelector<HTMLButtonElement>(`[title="${CSS.escape(project.root)}"]`) || container.current?.querySelector<HTMLInputElement>('input[aria-label="Search projects and archives"]'))?.focus()); }}>Restore project</button><button role="menuitem" onClick={() => { setName(project.name); setRenaming(project.root); setMenu(""); }}>Rename project</button></div>, container.current?.closest(".app") || document.body)}
        </div><div id={`chats-${encodeURIComponent(project.root)}`} hidden={!open}>
          <SessionTabs tabs={projectChats(project)} activeId={activeId} settings={settings} vertical label={`Archived chats in ${project.name}`} onSelect={selectArchived} onCustomize={customizeArchived} onRename={onRename} onClose={onClose} onArchiveChat={archiveChatFromGroup} onClearChat={onClearChat} onExportChat={onExportChat} />
        </div></div>})}
      </section>}
      {!visible.length && (!vertical || !scratch.length) && !revealArchived && <p className="project-empty">{archived.length ? "All projects are archived. Open Archive to see them, or open a folder." : "Add repositories here. Your chats stay open as you switch."}</p>}
      {!!matchText && !matches.length && !scratchMatches.length && !archiveGroups.length && !archivedMatches.length && <p className="project-empty">No matching projects or chats.</p>}
    </div>
  </div>;
}
