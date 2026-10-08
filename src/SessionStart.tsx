import { ArrowRight, FolderOpen, Settings2 } from "lucide-react";
import { AgentMark } from "./Conversation";
import { agentNames, defaults } from "./settings";
import type { Agent, Settings, Workspace } from "./types";
import "./SessionStart.css";

const choices: Agent[] = ["pi", "codex", "claude", "grok", "shell"];

export default function SessionStart({ workspace, settings, available, starting, onStart, onSettings }: {
  workspace?: Workspace;
  settings: Settings;
  available: Record<string, { available: boolean }>;
  starting?: Agent;
  onStart: (agent: Agent) => Promise<unknown>;
  onSettings: () => void;
}) {
  return <section className="session-start" aria-label="Start a session" aria-busy={!!starting}>
    <div className="session-start-content">
      <div className="session-start-project"><FolderOpen size={18} /><span>{workspace?.name || "No workspace"}</span></div>
      {workspace && <p className="session-start-path">{workspace.root}</p>}
      <h1>How would you like to start?</h1>
      <p>Choose an agent for a new chat, or open a terminal.</p>
      <div className="session-start-options">
        {choices.map((agent) => {
          const command = settings.agents[agent].command.trim();
          const ready = agent === "shell" || available[agent]?.available || (command && command !== defaults.agents[agent].command);
          return <button key={agent} disabled={!!starting}
          aria-label={!ready ? `Configure ${agentNames[agent]}` : agent === "shell" ? "Start Terminal" : `Start ${agentNames[agent]} chat`}
          onClick={() => ready ? void onStart(agent) : onSettings()}>
          <AgentMark agent={agent} color={settings.coloredAgents ? settings.agents[agent].color : settings.muted} size={25} />
          <span><strong>{agentNames[agent]}</strong><small>{starting === agent ? "Starting…" : agent === "shell" ? "Command line" : ready ? "Start a chat" : "Set up in Settings"}</small></span>
          <ArrowRight size={16} />
        </button>; })}
      </div>
      <button className="secondary" disabled={!!starting} onClick={onSettings}><Settings2 size={15} />Agent settings</button>
    </div>
  </section>;
}
