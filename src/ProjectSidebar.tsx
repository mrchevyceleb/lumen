import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Archive, FolderOpen, Plus, Pin, MoreHorizontal, GripVertical, ChevronRight, ChevronDown, ListTree, PanelTop, PanelLeftClose, TerminalSquare, Sparkles } from "lucide-react";
import SessionTabs, { type SessionTabActions } from "./SessionTabs";
import type { Settings, Tab } from "./types";

export interface Project { root: string; name: string; pinned?: boolean; hidden?: boolean; collapsed?: boolean; color?: string }
export const sameProject = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
const projectColors = [["Red", "#f87171"], ["Amber", "#fbbf24"], ["Green", "#4ade80"], ["Cyan", "#22d3ee"], ["Blue", "#60a5fa"], ["Violet", "#c084fc"]];

export function restoreProjects(): Project[] {
  try { return normalizeProjects(JSON.parse(localStorage.getItem("lumen.projects") || "[]")); } catch { return []; }
}

export function normalizeProjects(values: unknown): Project[] {
  if (!Array.isArray(values)) return [];
  return values.filter((p, i) => p && typeof p.root === "string" && typeof p.name === "string" && !values.slice(0, i).some((q) => q && typeof q.root === "string" && sameProject(p.root, q.root))).map((p) => ({ root: p.root, name: p.name, pinned: p.pinned === true, hidden: p.hidden === true, collapsed: p.collapsed === true, color: typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : undefined }));
}

export default function ProjectSidebar({ projects, activeRoot, counts, ready, onOpen, onAdd, onTerminal, onScratch, onChange, onArchive, tabs, activeId, settings, onSelect, onCustomize, onRename, onClose, onArchiveChat, onLayout, onNewChat, newChatRoot, onCollapse, showArchived, onToggleArchived, onLeaveHidden }: SessionTabActions & {
  projects: Project[]; activeRoot: string; counts: Record<string, number>; ready: boolean;
  tabs: Tab[]; activeId: string; settings: Settings; onLayout: () => void; onNewChat: (root: string) => void; newChatRoot?: string;
  onOpen: (project: Project, reveal?: boolean) => void; onAdd: () => void; onTerminal: () => void; onScratch: () => void; onChange: (projects: Project[]) => void; onArchive: (project: Project) => void; onCollapse: () => void;
  showArchived: boolean; onToggleArchived: () => void; onLeaveHidden: () => void;
}) {
  const vertical = settings.chatLayout === "vertical";
  const [scratchCollapsed, setScratchCollapsed] = useState(false);
  const scratch = tabs.filter((tab) => tab.projectless && (showArchived || !tab.archived));
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState("");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const [over, setOver] = useState("");
  const [dragging, setDragging] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const dragProject = useRef("");
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) { setMenu(""); setAdding(false); } };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => { if (projects.length <= 4) setQuery(""); }, [projects.length]);
  useEffect(() => {
    if (showArchived) return;
    const active = tabs.find((tab) => tab.id === activeId);
    const folder = active && !active.projectless ? active.root : activeRoot;
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
  const matchesQuery = (p: Project) => `${p.name} ${p.root}`.toLowerCase().includes(query.toLowerCase());
  const matches = visible.filter(matchesQuery);
  const archivedMatches = archived.filter(matchesQuery);
  const revealArchived = showArchived || !!query.trim();
  const archiveCount = archived.length + tabs.filter((tab) => tab.archived && (tab.projectless || !archived.some((project) => sameProject(project.root, tab.root)))).length;
  const projectChats = (project: Project) => tabs.filter((tab) => !tab.projectless && sameProject(tab.root, project.root) && (project.hidden || showArchived || !tab.archived));
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
  return <div className={`project-sidebar ${vertical ? "with-chats" : ""}`} ref={container}>
    <div className="project-heading"><span>PROJECTS <small>{visible.length}</small></span><div><button aria-label={vertical ? "Use horizontal tabs" : "Use vertical chats"} title={vertical ? "Use horizontal tabs" : "Use vertical chats"} onClick={onLayout}>{vertical ? <PanelTop size={14} /> : <ListTree size={14} />}</button><div className="project-add-anchor" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAdding(false); event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus(); } }}><button aria-label="Add project or session" title="Open a folder, terminal, or chat" aria-expanded={adding} onClick={() => setAdding(!adding)} disabled={!ready}><Plus size={15} /></button>{adding && <div className="project-menu project-add-menu"><button autoFocus onClick={() => { setAdding(false); onTerminal(); }}><TerminalSquare size={15} /><span>New terminal<small>No workspace · Ctrl Alt T</small></span></button><button onClick={() => { setAdding(false); onScratch(); }}><Sparkles size={15} /><span>New agent chat<small>No workspace</small></span></button><button onClick={() => { setAdding(false); onAdd(); }}><FolderOpen size={15} /><span>Open project folder<small>Ctrl O</small></span></button></div>}</div><button aria-label="Collapse projects sidebar" title="Collapse projects sidebar" onClick={onCollapse}><PanelLeftClose size={14} /></button></div></div>
    {projects.length > 4 && <input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={(e) => setQuery(e.target.value)} />}
    {!!archiveCount && <button type="button" className="archive-filter" aria-pressed={showArchived} title={showArchived ? "Hide archived projects and chats" : "Show archived projects and chats"} onClick={onToggleArchived}><span>{showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Archive size={14} />{showArchived ? "Hide archived" : "Show archived"}</span><small>{archiveCount}</small></button>}
    <div className="project-scroll">
      {[true, false].map((pinned) => matches.some((p) => !!p.pinned === pinned) && <section key={String(pinned)} className={`project-section ${pinned ? "pinned" : "unpinned"}`} aria-label={pinned ? "Pinned projects" : "Projects"}>
        <div className="project-group">{pinned ? <><Pin size={10} /> Pinned</> : <><FolderOpen size={10} /> Projects</>}</div>
        {matches.filter((p) => !!p.pinned === pinned).map((project) => <div key={project.root} className="project-entry"><div className={`project-row ${pinned ? "is-pinned" : "is-unpinned"} ${project.color ? "has-color" : ""} ${sameProject(activeRoot, project.root) ? "selected" : ""} ${over === project.root ? "drop-target" : ""} ${dragging === project.root ? "dragging" : ""}`} style={{ "--project-color": project.color } as CSSProperties}
          onDragOver={(e) => { if (isProjectDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(project.root); } }}
          onDragEnter={(e) => { if (isProjectDrag(e)) { e.preventDefault(); setOver(project.root); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(""); }}
          onDrop={(e) => { e.preventDefault(); dropProject(e, project); }}>
          <span className="project-grip" role="button" tabIndex={0} aria-label={`Drag to reorder ${project.name}`} draggable onDragStart={(e) => startProjectDrag(e, project)} onDragEnd={finishProjectDrag} onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); moveWithin(project, -1); } if (e.key === "ArrowDown") { e.preventDefault(); moveWithin(project, 1); } }} title="Drag to reorder, or use arrow keys"><GripVertical size={12} /></span>
          {vertical && <button className="project-collapse" aria-label={`${project.collapsed ? "Expand" : "Collapse"} chats for ${project.name}`} aria-expanded={!project.collapsed} aria-controls={`chats-${encodeURIComponent(project.root)}`} onClick={() => onChange(projects.map((p) => p.root === project.root ? { ...p, collapsed: !p.collapsed } : p))}>{project.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>}
          {renaming === project.root ? <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => rename(project)} onKeyDown={(e) => { if (e.key === "Enter") rename(project); if (e.key === "Escape") setRenaming(""); }} /> : <button className="project-open" title={project.root} aria-current={sameProject(activeRoot, project.root) ? "true" : undefined} disabled={!ready} onClick={() => onOpen(project)}><FolderOpen size={16} /><span>{project.name}</span>{pinned && <Pin className="project-pin-mark" size={10} aria-label="Pinned" />}{!!counts[project.root] && <small>{counts[project.root]}</small>}</button>}
          {vertical && <button className="project-options" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} aria-expanded={newChatRoot !== undefined && sameProject(newChatRoot, project.root)} aria-controls={newChatRoot !== undefined && sameProject(newChatRoot, project.root) ? "new-chat-menu" : undefined} disabled={!ready} onClick={() => onNewChat(project.root)}><Plus size={13} /></button>}
          <button className="project-options" aria-label={`Options for ${project.name}`} aria-expanded={menu === project.root} onClick={() => setMenu(menu === project.root ? "" : project.root)}><MoreHorizontal size={13} /></button>
          {menu === project.root && <div className="project-menu"><button onClick={() => { onChange(projects.map((p) => p.root === project.root ? { ...p, pinned: !p.pinned } : p)); setMenu(""); }}>{project.pinned ? "Unpin project" : "Pin project"}</button><button onClick={() => { setName(project.name); setRenaming(project.root); setMenu(""); }}>Rename project</button><button onClick={() => moveWithin(project, -1)}>Move up</button><button onClick={() => moveWithin(project, 1)}>Move down</button>
            <span className="project-color-label">Project color</span><div className="project-colors" role="group" aria-label={`Color for ${project.name}`}>
              {projectColors.map(([label, color]) => <button key={color} aria-label={`${label} project color`} title={label} aria-pressed={project.color === color} style={{ background: color }} onClick={() => colorProject(project, color)} />)}
              <input type="color" aria-label={`Custom project color for ${project.name}`} title="Custom color" value={project.color || "#60a5fa"} onChange={(e) => colorProject(project, e.target.value)} />
            </div><button onClick={() => colorProject(project)}>Reset color</button>
            <button className="remove-project" disabled={!ready} onClick={() => archive(project)}>Archive project<small>Keep files and chats · restore anytime</small></button></div>}
        </div>{vertical && <div id={`chats-${encodeURIComponent(project.root)}`} hidden={project.collapsed}>
          <SessionTabs tabs={projectChats(project)} activeId={activeId} settings={settings} vertical label={`Chats in ${project.name}`} onSelect={onSelect} onCustomize={onCustomize} onRename={onRename} onClose={onClose} onArchiveChat={onArchiveChat} />
        </div>}</div>)}
      </section>)}
      {vertical && <div className="scratch-chats"><div className="scratch-heading"><button aria-label={`${scratchCollapsed ? "Expand" : "Collapse"} chats without a workspace`} aria-expanded={!scratchCollapsed} onClick={() => scratch.length ? setScratchCollapsed(!scratchCollapsed) : onScratch()}>{scratchCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<FolderOpen size={15} /><span>No workspace</span><small>{scratch.length}</small></button><button aria-label="New chat without workspace" disabled={!ready} aria-expanded={newChatRoot === ""} aria-controls={newChatRoot === "" ? "new-chat-menu" : undefined} onClick={() => onNewChat("")}><Plus size={13} /></button></div>
        <div hidden={scratchCollapsed}><SessionTabs tabs={scratch} activeId={activeId} settings={settings} vertical label="Chats without a workspace" onSelect={onSelect} onCustomize={onCustomize} onRename={onRename} onClose={onClose} onArchiveChat={onArchiveChat} /></div>
      </div>}
      {revealArchived && !!archived.length && <section className="archived-projects" aria-label="Archived projects">
        {!!archivedMatches.length && <div className="project-group"><Archive size={10} /> Archived</div>}
        {archivedMatches.map((project) => <div key={project.root} className="project-entry"><div className={`project-row archived ${project.color ? "has-color" : ""} ${sameProject(activeRoot, project.root) ? "selected" : ""}`} style={{ "--project-color": project.color } as CSSProperties}>
          <span className="project-grip" />
          {vertical && <button className="project-collapse" aria-label={`${project.collapsed ? "Expand" : "Collapse"} chats for ${project.name}`} aria-expanded={!project.collapsed} aria-controls={`chats-${encodeURIComponent(project.root)}`} onClick={() => onChange(projects.map((p) => p.root === project.root ? { ...p, collapsed: !p.collapsed } : p))}>{project.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>}
          {renaming === project.root ? <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => rename(project)} onKeyDown={(e) => { if (e.key === "Enter") rename(project); if (e.key === "Escape") setRenaming(""); }} /> : <button className="project-open" title={project.root} aria-current={sameProject(activeRoot, project.root) ? "true" : undefined} disabled={!ready} onClick={() => onOpen(project, false)}><FolderOpen size={16} /><span>{project.name}</span>{!!counts[project.root] && <small>{counts[project.root]}</small>}</button>}
          {vertical && <button className="project-options" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} aria-expanded={newChatRoot !== undefined && sameProject(newChatRoot, project.root)} aria-controls={newChatRoot !== undefined && sameProject(newChatRoot, project.root) ? "new-chat-menu" : undefined} disabled={!ready} onClick={() => onNewChat(project.root)}><Plus size={13} /></button>}
          <button className="project-options" aria-label={`Options for ${project.name}`} aria-expanded={menu === project.root} onClick={() => setMenu(menu === project.root ? "" : project.root)}><MoreHorizontal size={13} /></button>
          {menu === project.root && <div className="project-menu"><button onClick={() => { onChange(projects.map((p) => p.root === project.root ? { ...p, hidden: false, collapsed: false } : p)); setMenu(""); }}>Restore project</button><button onClick={() => { setName(project.name); setRenaming(project.root); setMenu(""); }}>Rename project</button></div>}
        </div>{vertical && <div id={`chats-${encodeURIComponent(project.root)}`} hidden={project.collapsed}>
          <SessionTabs tabs={projectChats(project)} activeId={activeId} settings={settings} vertical label={`Archived chats in ${project.name}`} onSelect={onSelect} onCustomize={onCustomize} onRename={onRename} onClose={onClose} onArchiveChat={onArchiveChat} />
        </div>}</div>)}
        {!archivedMatches.length && <p className="project-empty">No matching archived projects.</p>}
      </section>}
      {!visible.length && (!vertical || !scratch.length) && !revealArchived && <p className="project-empty">{archived.length ? "All projects are archived. Show archived to open one, or open a folder." : "Add repositories here. Your chats stay open as you switch."}</p>}
      {!!visible.length && !matches.length && <p className="project-empty">No matching projects.</p>}
    </div>
  </div>;
}
