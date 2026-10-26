import { useRef, useState, type CSSProperties } from "react";
import { Bot, Check, GitBranch, Layers, Sparkles } from "lucide-react";
import { AgentMark } from "./Conversation";
import { Modal } from "./Components";
import DefaultModelPicker from "./DefaultModelPicker";
import { agentNames, defaults } from "./settings";
import type { Agent, AgentConfig, Settings, Workspace } from "./types";

const jobAgents: Agent[] = ["pi", "codex", "claude", "grok", "google"];
export type WorktreeJobInput = {
  id: string;
  branch: string;
  base: string;
  agent: Agent;
  name: string;
  model: string;
  effort: string;
  text: string;
};

export default function WorktreeJobDialog({ workspace, settings, available, onClose, onCreate }: {
  workspace?: Workspace;
  settings: Settings;
  available: Record<string, { available: boolean }>;
  onClose: () => void;
  onCreate: (input: WorktreeJobInput) => Promise<void>;
}) {
  const ready = (agent: Agent) => available[agent]?.available || settings.agents[agent].command.trim() !== defaults.agents[agent].command;
  const [id] = useState(() => crypto.randomUUID());
  const [agent, setAgent] = useState<Agent>(() => ready("codex") ? "codex" : jobAgents.find(ready) || "codex");
  const [branch, setBranch] = useState(""), [base, setBase] = useState("HEAD");
  const [name, setName] = useState(""), [text, setText] = useState("");
  const [overrides, setOverrides] = useState<Partial<Record<Agent, Pick<AgentConfig, "model" | "modelName" | "effort">>>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef(false);
  const config = { ...settings.agents[agent], ...overrides[agent] };
  const close = () => { if (!busyRef.current) onClose(); };
  const chooseModel = (model: import("./types").ModelOption | null) => setOverrides((old) => ({ ...old,
    [agent]: { model: model?.id || "", modelName: model?.name || "", effort: model?.defaultEffort || "" },
  }));
  return <Modal title="Put an agent to work" subtitle="A fresh worktree. The right model. One visible job." onClose={close} wide>
    {!workspace?.git.available ? <p className="dialog-copy">Open a Git repository with at least one commit to start a worktree agent job.</p> : <form className="dialog-form worktree-job-form" onSubmit={async (event) => {
      event.preventDefault();
      if (busyRef.current) return;
      busyRef.current = true; setBusy(true); setError("");
      try { await onCreate({ id, branch: branch.trim(), base: base.trim() || "HEAD", agent, name: name.trim(), model: config.model, effort: config.effort || "", text: text.trim() }); }
      catch (e: any) { setError(e.message); }
      finally { busyRef.current = false; setBusy(false); }
    }}>
      <div className="worktree-job-source"><span><GitBranch size={19} /></span><div><strong>{workspace.name}</strong><small>{workspace.git.root || workspace.root}</small></div><em>{workspace.git.branch || "Git repository"}</em></div>
      <div className="section-divider"><span>THE WORKTREE</span></div>
      <div className="worktree-job-fields">
        <label className="field"><span>New branch</span><input autoFocus value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="agent/login-fix" maxLength={300} /></label>
        <label className="field"><span>Start from</span><input value={base} onChange={(event) => setBase(event.target.value)} placeholder="HEAD, main, or a commit" maxLength={300} /></label>
      </div>
      <p className="settings-note">Created beside your repository in its dedicated worktrees folder. Your current checkout stays exactly where it is.</p>
      <div className="section-divider"><span>THE AGENT</span></div>
      <div className="agent-job-grid" role="group" aria-label="Agent for this worktree job">
        {jobAgents.map((choice) => <button key={choice} type="button" disabled={!ready(choice)} aria-pressed={agent === choice} className={agent === choice ? "selected" : ""}
          style={{ "--agent-color": settings.coloredAgents ? settings.agents[choice].color : settings.accent } as CSSProperties}
          title={ready(choice) ? `Use ${agentNames[choice]}` : `${agentNames[choice]} is not configured`}
          onClick={() => setAgent(choice)}>
          <AgentMark agent={choice} color={settings.coloredAgents ? settings.agents[choice].color : settings.accent} size={20} />
          <span>{agentNames[choice]}</span>{agent === choice && <Check size={13} />}
        </button>)}
      </div>
      <label className="field"><span>Job name <small>optional</small></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={`${agentNames[agent]} worktree job`} maxLength={100} /></label>
      <div className="job-model-defaults"><DefaultModelPicker agent={agent} config={config} loadShellProfile={settings.loadShellProfile}
        label="Model" labelHint="for this job" effortLabel="Effort" note="Starts from your Settings defaults. Change either one for this job only."
        onChange={chooseModel} onEffortChange={(effort) => setOverrides((old) => ({ ...old, [agent]: { ...config, effort } }))} /></div>
      <div className="section-divider"><span>THE WORK</span></div>
      <label className="field"><span>First instruction <small>optional</small></span><textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={200000}
        placeholder="Fix the login bug, run the relevant checks, and summarize what changed." /></label>
      <p className="settings-note"><Sparkles size={12} /> The job opens as a normal Lumen chat. Watch it, send follow-ups, steer queued work, or stop it at any time.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !branch.trim() || !ready(agent)}><Bot size={16} />{busy ? "Creating worktree…" : text.trim() ? "Create worktree & start" : "Create worktree & open chat"}<Layers size={15} /></button>
      </div>
    </form>}
  </Modal>;
}
