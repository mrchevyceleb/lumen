import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Pin, MoreHorizontal, GripVertical } from "lucide-react";

export interface Project { root: string; name: string; pinned?: boolean }
export const sameProject = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

export function restoreProjects(): Project[] {
  try {
    const values = JSON.parse(localStorage.getItem("lumen.projects") || "[]");
    return Array.isArray(values) ? values.filter((p, i) => p && typeof p.root === "string" && typeof p.name === "string" && !values.slice(0, i).some((q) => q && typeof q.root === "string" && sameProject(p.root, q.root))) : [];
  } catch { return []; }
}

export default function ProjectSidebar({ projects, activeRoot, counts, ready, onOpen, onAdd, onChange }: {
  projects: Project[]; activeRoot: string; counts: Record<string, number>; ready: boolean;
  onOpen: (project: Project) => void; onAdd: () => void; onChange: (projects: Project[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState("");
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const [over, setOver] = useState("");
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setMenu(""); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  const rename = (project: Project) => {
    const next = name.trim().slice(0, 100);
    if (next) onChange(projects.map((p) => p.root === project.root ? { ...p, name: next } : p));
    setRenaming("");
  };
  const matches = projects.filter((p) => `${p.name} ${p.root}`.toLowerCase().includes(query.toLowerCase()));
  const move = (source: string, target: Project, after = false) => {
    const project = projects.find((p) => p.root === source);
    if (!project || source === target.root) return;
    const next = projects.filter((p) => p.root !== source);
    next.splice(next.findIndex((p) => p.root === target.root) + (after ? 1 : 0), 0, { ...project, pinned: target.pinned });
    onChange(next);
  };
  const moveWithin = (project: Project, direction: number) => {
    const peers = projects.filter((p) => !!p.pinned === !!project.pinned);
    const target = peers[peers.indexOf(project) + direction];
    if (target) move(project.root, target, direction > 0);
    setMenu("");
  };
  return <div className="project-sidebar" ref={container}>
    <div className="project-heading"><span>PROJECTS <small>{projects.length}</small></span><button aria-label="Add project" onClick={onAdd} disabled={!ready}><Plus size={15} /></button></div>
    {projects.length > 4 && <input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={(e) => setQuery(e.target.value)} />}
    <div className="project-scroll">
      {[true, false].map((pinned) => <div key={String(pinned)}>
        {matches.some((p) => !!p.pinned === pinned) && pinned && <div className="project-group"><Pin size={10} /> Pinned</div>}
        {matches.filter((p) => !!p.pinned === pinned).map((project) => <div key={project.root} className={`project-row ${sameProject(activeRoot, project.root) ? "selected" : ""} ${over === project.root ? "drop-target" : ""}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-lumen-project")) { e.preventDefault(); setOver(project.root); } }}
          onDragLeave={() => setOver("")} onDrop={(e) => { e.preventDefault(); move(e.dataTransfer.getData("application/x-lumen-project"), project, e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2); setOver(""); }}>
          <span className="project-grip" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-lumen-project", project.root); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setOver("")} title="Drag to reorder"><GripVertical size={12} /></span>
          {renaming === project.root ? <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => rename(project)} onKeyDown={(e) => { if (e.key === "Enter") rename(project); if (e.key === "Escape") setRenaming(""); }} /> : <button className="project-open" title={project.root} aria-current={sameProject(activeRoot, project.root) ? "true" : undefined} disabled={!ready} onClick={() => onOpen(project)}><FolderOpen size={16} /><span>{project.name}</span>{!!counts[project.root] && <small>{counts[project.root]}</small>}</button>}
          <button className="project-options" aria-label={`Options for ${project.name}`} aria-expanded={menu === project.root} onClick={() => setMenu(menu === project.root ? "" : project.root)}><MoreHorizontal size={13} /></button>
          {menu === project.root && <div className="project-menu"><button onClick={() => { onChange(projects.map((p) => p.root === project.root ? { ...p, pinned: !p.pinned } : p)); setMenu(""); }}>{project.pinned ? "Unpin project" : "Pin project"}</button><button onClick={() => { setName(project.name); setRenaming(project.root); setMenu(""); }}>Rename project</button><button onClick={() => moveWithin(project, -1)}>Move up</button><button onClick={() => moveWithin(project, 1)}>Move down</button></div>}
        </div>)}
      </div>)}
      {!projects.length && <p className="project-empty">Add repositories here. Your chats stay open as you switch.</p>}
      {!!projects.length && !matches.length && <p className="project-empty">No matching projects.</p>}
    </div>
  </div>;
}
