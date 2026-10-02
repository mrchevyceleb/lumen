import type { CSSProperties } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Components";
import { AgentMark } from "./Conversation";
import type { Settings, Tab } from "./types";

export interface SessionTabActions {
  onSelect: (tab: Tab) => void;
  onCustomize: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
}
export default function SessionTabs({ tabs, activeId, settings, vertical = false, label, onSelect, onCustomize, onClose }: SessionTabActions & {
  tabs: Tab[]; activeId: string; settings: Settings; vertical?: boolean; label: string;
}) {
  return <nav className={vertical ? "vertical-chats" : "session-tabs"} aria-label={label}>
    {tabs.map((tab) => <div className={`session-tab ${activeId === tab.id ? "selected" : ""}`} key={tab.id}
      style={{ "--tab-color": settings.coloredTabs ? tab.color || settings.agents[tab.agent].color : settings.border } as CSSProperties}>
      <button className="tab-select" aria-label={`${tab.name}${tab.accountId ? ` · ${tab.accountName}` : ""}`} aria-describedby={`chat-status-${tab.id}`} aria-current={activeId === tab.id ? "page" : undefined} onClick={() => onSelect(tab)} onDoubleClick={() => onCustomize(tab)}
        title={`${tab.projectless ? "No workspace · Scratch folder" : tab.cwd || tab.root}\n${tab.mode === "native" ? "Native CLI" : "Readable session"} · Double-click to customize`}>
        <AgentMark agent={tab.agent} color={settings.coloredAgents ? settings.agents[tab.agent].color : settings.muted} size={vertical ? 14 : 16} />
        <span>{tab.name}{tab.accountId ? ` · ${tab.accountName}` : ""}</span>
        {tab.busy ? tab.phase ? <span className="chat-phase" title={tab.phase}>…</span> : <span className="tiny-pulse" /> : tab.mode === "native" ? <span className="native-tag">CLI</span> : null}
      </button>
      <span className="screen-reader-only" id={`chat-status-${tab.id}`}>{tab.busy ? tab.phase || "Working" : tab.mode === "native" ? "Native CLI" : "Readable session"}</span>
      <IconButton label={`Close ${tab.name} tab`} onClick={() => onClose(tab)}><X size={12} /></IconButton>
    </div>)}
  </nav>;
}
