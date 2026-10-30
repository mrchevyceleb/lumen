import { useRef, useState, type CSSProperties } from "react";
import { Bot, Check, GitBranch, Layers, Sparkles } from "lucide-react";
import { AgentMark } from "./Conversation";
import { Modal } from "./Components";
import DefaultModelPicker from "./DefaultModelPicker";
import { agentNames, defaults } from "./settings";
import type { Agent, AgentConfig, Settings, Workspace } from "./types";
import { api } from "./types";

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
  const [branch, setBranch] = useState(() => `lumen-chat-${id.slice(0, 8)}`), [base, setBase] = useState("HEAD");
  const [name, setName] = useState(""), [text, setText] = useState("");
  const [overrides, setOverrides] = useState<Partial<Record<Agent, Pick<AgentConfig, "model" | "modelName" | "effort">>>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [bound, setBound] = useState(false);
  const busyRef = useRef(false);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const config = { ...settings.agents[agent], ...overrides[agent] };
  const close = () => { if (!busyRef.current) onClose(); };
  const chooseModel = (model: import("./types").ModelOption | null) => setOverrides((old) => ({ ...old,
    [agent]: { model: model?.id || "", modelName: model?.name || "", effort: model?.defaultEffort || "" },
  }));
  return <Modal title="New chat in a worktree" subtitle="Give this chat its own branch and workspace." onClose={close} initialFocus="textarea" wide>
    {!workspace?.git.available ? <p className="dialog-copy">Open a Git repository with at least one commit to start a chat in a worktree.</p> : <form className="dialog-form worktree-job-form" onSubmit={async (event) => {
      event.preventDefault();
      if (busyRef.current) return;
      busyRef.current = true; setBusy(true); setError("");
      try { await onCreate({ id, branch: branch.trim(), base: base.trim() || "HEAD", agent, name: name.trim(), model: config.model, effort: config.effort || "", text: text.trim() }); }
      catch (e: any) {
        const message = String(e.message || e);
        const reserved = await api<unknown>("git:worktree-job:binding", id).then(Boolean, () => true);
        setBound(reserved);
        setError(/needed a single revision|unknown revision|bad revision/i.test(message) ? "Couldn't find that starting point. Check Start from and try again." : /not a valid branch name/i.test(message) ? "That branch name isn't valid. Try another name." : message);
        if (optionsRef.current) optionsRef.current.open = true;
      }
      finally { busyRef.current = false; setBusy(false); }
    }}>
      <div className="worktree-job-source"><span><GitBranch size={19} /></span><div><strong>{workspace.name}</strong><small>{workspace.git.root || workspace.root}</small></div><em>{workspace.git.branch || "Git repository"}</em></div>
      <p className="settings-note">Lumen creates a separate worktree and branch automatically. Your current files stay where they are.</p>
      <div className="section-divider"><span>CHOOSE AN AGENT</span></div>
      <div className="agent-job-grid" role="group" aria-label="Agent for this worktree chat">
        {jobAgents.map((choice) => <button key={choice} type="button" disabled={!ready(choice)} aria-pressed={agent === choice} className={agent === choice ? "selected" : ""}
          style={{ "--agent-color": settings.coloredAgents ? settings.agents[choice].color : settings.accent } as CSSProperties}
          title={ready(choice) ? `Use ${agentNames[choice]}` : `${agentNames[choice]} is not configured`}
          onClick={() => setAgent(choice)}>
          <AgentMark agent={choice} color={settings.coloredAgents ? settings.agents[choice].color : settings.accent} size={20} />
          <span>{agentNames[choice]}</span>{agent === choice && <Check size={13} />}
        </button>)}
      </div>
      <details className="worktree-job-options" ref={optionsRef} onToggle={(event) => { if (!branch.trim()) event.currentTarget.open = true; }}><summary>Branch and model options</summary>
      <div className="worktree-job-fields">
        <label className="field"><span>New branch</span><input value={branch} disabled={bound} onChange={(event) => { setBranch(event.target.value); setError(""); }} placeholder="chat/my-next-idea" maxLength={300} />{!branch.trim() && <small>Enter a branch name to create the chat.</small>}</label>
        <label className="field"><span>Start from</span><input value={base} disabled={bound} onChange={(event) => { setBase(event.target.value); setError(""); }} placeholder="HEAD, main, or a commit" maxLength={300} /></label>
      </div>
      {bound && <p className="settings-note">This worktree is already reserved. Retry with these settings, or close this dialog to start a different chat.</p>}
      <label className="field"><span>Chat name <small>optional</small></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={`Worktree ${id.slice(0, 8)} · ${agentNames[agent]}`} maxLength={100} /></label>
      <div className="job-model-defaults"><DefaultModelPicker agent={agent} config={config} loadShellProfile={settings.loadShellProfile}
        label="Model" labelHint="for this chat" effortLabel="Effort" note="Starts from your Settings defaults. Change either one for this chat only."
        onChange={chooseModel} onEffortChange={(effort) => setOverrides((old) => ({ ...old, [agent]: { ...config, effort } }))} /></div>
      </details>
      <div className="section-divider"><span>WHAT'S ON YOUR MIND?</span></div>
      <label className="field"><span>First instruction <small>optional</small></span><textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={200000}
        placeholder="Fix the login bug, run the relevant checks, and summarize what changed." /></label>
      <p className="settings-note"><Sparkles size={12} /> Leave this blank to start with an empty chat.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !branch.trim() || !ready(agent)}><Bot size={16} />{busy ? "Creating your chat…" : text.trim() ? "Create chat & send" : "Create chat"}<Layers size={15} /></button>
      </div>
    </form>}
  </Modal>;
}
