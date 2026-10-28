import { useEffect, useState } from "react";
import { Activity, ArrowRight, Bot, CheckCircle2, CircleAlert, Clock3, MessageSquareMore } from "lucide-react";
import { Modal } from "./Components";
import { AgentMark } from "./Conversation";
import { agentNames } from "./settings";
import type { PiRequest, Settings, Tab } from "./types";

interface AgentRequest {
  session: string;
  request: PiRequest;
}

const oneLine = (text = "") => text.replace(/\s+/g, " ").trim();
const folderName = (tab: Tab) => tab.projectless ? "No workspace" : (tab.cwd || tab.root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "No workspace";
const formatTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

const formatSilence = (ms: number) => {
  const minutes = Math.max(2, Math.floor(ms / 60000));
  if (minutes < 60) return `No updates for ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `No updates for ${hours}h` : `No updates for ${Math.floor(hours / 24)}d`;
};

function taskText(tab: Tab) {
  const task = tab.messages.find((message) => message.role === "user" && oneLine(message.text));
  return oneLine(task?.text) || "Waiting for its first instruction.";
}

function toolDetail(text: string) {
  const value = oneLine(text);
  if (!value || value === "(no output)") return "";
  try {
    const args = JSON.parse(text);
    const detail = args.command || args.path || args.file_path || args.url || args.query || args.pattern;
    return typeof detail === "string" ? oneLine(detail) : "";
  } catch {
    return value;
  }
}

function latestActivity(tab: Tab, request?: PiRequest) {
  if (request) return oneLine(request.questions?.map((question) => question.question).filter(Boolean).join(" · ") || request.message || request.text || request.title || "This agent is waiting for your answer.");
  const message = [...tab.messages].reverse().find((item) => item.role !== "notice" && item.role !== "user" && oneLine(item.text || item.title));
  if (!message) return tab.busy ? "Starting the run…" : "No activity yet.";
  if (message.role === "tool") {
    const name = message.title || "Tool";
    const detail = toolDetail(message.text);
    return `${message.state === "running" ? `Using ${name}` : name}${detail ? ` · ${detail}` : ""}`;
  }
  return oneLine(message.text || message.title);
}

function statusFor(tab: Tab, needsInput: boolean) {
  if (needsInput) return { label: "Needs input", tone: "attention" };
  if (tab.recoveryError) return { label: "Needs attention", tone: "attention" };
  if (tab.busy && tab.stalled) return { label: "Stalled", tone: "stalled" };
  if (tab.stopping) return { label: "Stopping", tone: "working" };
  if (tab.busy) {
    const phase = tab.phase === "compacting" ? "Compacting" : tab.phase === "retrying" ? "Reconnecting" : tab.phase === "waiting" ? "Waiting" : tab.phase === "finishing" ? "Finishing" : "Working";
    return { label: phase, tone: "working" };
  }
  if (tab.queuePaused && !!tab.queuedMessages?.length) return { label: "Queue paused", tone: "attention" };
  if (tab.interrupted) return { label: "Stopped", tone: "idle" };
  return { label: "Idle", tone: "idle" };
}

export default function AgentsPanel({ tabs, settings, activeId, requests, onOpen, onClose }: {
  tabs: Tab[];
  settings: Settings;
  activeId: string;
  requests: AgentRequest[];
  onOpen: (tab: Tab) => void;
  onClose: () => void;
}) {
  const [, setClock] = useState(0);
  const hasWorking = tabs.some((tab) => tab.busy);
  useEffect(() => {
    if (!hasWorking) return;
    const timer = setInterval(() => setClock((value) => value + 1), 10000);
    return () => clearInterval(timer);
  }, [hasWorking]);
  const requestFor = (tab: Tab) => requests.find((item) => item.session === tab.id)?.request;
  const isActive = (tab: Tab) => tab.busy || !!requestFor(tab) || !!tab.stopping || !!tab.queuedMessages?.length;
  const agents = tabs.filter((tab) => tab.agent !== "shell");
  const active = agents.filter(isActive).sort((a, b) => {
    const attention = Number(!!requestFor(b) || !!b.stalled) - Number(!!requestFor(a) || !!a.stalled);
    return attention || (a.started || a.lastActivityAt || 0) - (b.started || b.lastActivityAt || 0);
  });
  const recent = agents.filter((tab) => !isActive(tab)).sort((a, b) => (b.lastActivityAt || b.started || 0) - (a.lastActivityAt || a.started || 0));
  const working = agents.filter((tab) => tab.busy && !tab.stalled && !requestFor(tab)).length;
  const stalled = agents.filter((tab) => tab.busy && tab.stalled && !requestFor(tab)).length;
  const input = new Set(requests.map((item) => item.session)).size;
  const paused = agents.filter((tab) => !tab.busy && !requestFor(tab) && tab.queuePaused && !!tab.queuedMessages?.length).length;

  const card = (tab: Tab) => {
    const request = requestFor(tab);
    const status = statusFor(tab, !!request);
    const activity = latestActivity(tab, request);
    const queue = tab.queuedMessages?.length || 0;
    const activityAt = tab.lastActivityAt || tab.started;
    return <button type="button" key={tab.id} className={`agent-overview-card ${status.tone} ${activeId === tab.id ? "current" : ""}`}
      aria-label={`Open ${tab.name}. ${status.label}. ${activity}`} onClick={() => onOpen(tab)}>
      <span className="agent-overview-heading">
        <AgentMark agent={tab.agent} color={settings.coloredAgents ? settings.agents[tab.agent].color : settings.muted} size={22} />
        <span className="agent-overview-name"><strong>{tab.name}</strong><small>{tab.managedBy ? `${tab.managedBy} · background task` : agentNames[tab.agent]}</small></span>
        <span className={`agent-status ${status.tone}`}><i />{status.label}</span>
      </span>
      <span className="agent-overview-task">{taskText(tab)}</span>
      <span className="agent-overview-activity"><Activity size={13} /><span>{activity}</span></span>
      <span className="agent-overview-footer">
        <span title={tab.cwd || tab.root || "No workspace"}>{folderName(tab)}</span>
        {!!queue && <span className="agent-queue"><MessageSquareMore size={12} />{queue} queued</span>}
        {request ? <span className="agent-input-wait"><CircleAlert size={12} />Waiting for you</span> : tab.busy && activityAt && <span className={tab.stalled ? "agent-silence stalled" : "agent-silence"}><Clock3 size={12} />{tab.stalled ? formatSilence(Date.now() - activityAt) : formatTime(Date.now() - activityAt)}</span>}
        <span className="agent-open">Open chat <ArrowRight size={13} /></span>
      </span>
    </button>;
  };

  return <Modal title="Agents" subtitle="Live work across every chat." wide onClose={onClose}>
    <div className="agents-summary" aria-label="Agent activity summary">
      <span className={working ? "working" : ""}><Activity size={14} />{working || stalled || input || paused ? `${working} working` : "All quiet"}</span>
      {!!stalled && <span className="stalled"><Clock3 size={14} />{stalled} stalled</span>}
      {!!input && <span className="attention"><CircleAlert size={14} />{input} needs input</span>}
      {!!paused && <span className="attention"><MessageSquareMore size={14} />{paused} {paused === 1 ? "queue" : "queues"} paused</span>}
      <span className="agents-summary-total">{recent.length + active.length} {recent.length + active.length === 1 ? "agent" : "agents"}</span>
    </div>
    <div className="agents-overview-scroll">
      {!active.length && !!recent.length && <div className="agents-all-clear"><CheckCircle2 size={17} /><span>Nothing running right now.</span></div>}
      {!!active.length && <section className="agents-section"><h3>Active now <span>{active.length}</span></h3><div className="agents-list">{active.map(card)}</div></section>}
      {!!recent.length && <section className="agents-section"><h3>Idle & recent <span>{recent.length}</span></h3><div className="agents-list">{recent.map(card)}</div></section>}
      {!active.length && !recent.length && <div className="agents-empty"><span className="agents-empty-icon"><Bot size={28} /></span><h3>Your agents will gather here</h3><p>Start a chat or a worktree agent job. Its task, progress and status will show up here live.</p></div>}
    </div>
  </Modal>;
}
