import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, ListChecks, RefreshCw, Search, Star } from "lucide-react";
import { Modal } from "./Components";
import { api, type ModelCatalog, type Tab } from "./types";
import { agentNames } from "./settings";
export type ControlPanel = "model" | "effort" | "plan" | null;
function matches(e: KeyboardEvent, binding: string) {
  const parts = binding.toLowerCase().split("+");
  return e.key.toLowerCase() === parts.at(-1) && e.ctrlKey === parts.includes("ctrl") &&
    e.altKey === parts.includes("alt") && e.shiftKey === parts.includes("shift") && e.metaKey === parts.includes("meta");
}
export default function ModelControls({ tab, panel, setPanel, onConfig, onPending, onPlanDraft, onNative }: {
  tab: Tab; panel: ControlPanel; setPanel: (panel: ControlPanel) => void;
  onConfig: (change: Partial<Tab>) => void; onPending: (pending: boolean) => void;
  onPlanDraft: () => void; onNative: (draft?: string) => void;
}) {
  const [info, setInfo] = useState<ModelCatalog>();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [selected, setSelected] = useState(0);
  const [shortcuts, setShortcuts] = useState<Record<string, string[]>>({});
  const alive = useRef(true);
  const inFlight = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    api<Record<string, string[]>>("session:shortcuts", tab.id).then((value) => { if (alive.current) setShortcuts(value); }).catch(() => {});
    return () => { alive.current = false; };
  }, [tab.id]);
  useEffect(() => { onPending(loading || applying); }, [loading, applying]);
  const load = async (refresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError("");
    try {
      const value = await api<ModelCatalog>("session:models", tab.id, refresh);
      if (alive.current) { setInfo(value); if (value.shortcuts) setShortcuts(value.shortcuts); }
    } catch (e: any) { if (alive.current) setError(e.message); }
    finally { inFlight.current = false; if (alive.current) setLoading(false); }
  };
  const apply = async (change: { model?: string; effort?: string; workMode?: string; cycle?: string }) => {
    if (inFlight.current || tab.busy) return;
    inFlight.current = true; setApplying(true); setError("");
    try {
      const value = await api<{ model: string; effort: string; workMode: string; catalog: ModelCatalog }>("session:configure", tab.id, change);
      onConfig({ model: value.model, effort: value.effort, workMode: value.workMode });
      if (alive.current) { setInfo(value.catalog); setPanel(null); }
    } catch (e: any) { if (alive.current) setError(e.message); }
    finally { inFlight.current = false; if (alive.current) setApplying(false); }
  };
  useEffect(() => { void load(); }, [tab.id]);
  useEffect(() => {
    if (panel) {
      setQuery(""); setSelected(0); setError(""); if (panel !== "plan") void load();
      if (panel === "model") requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('[aria-label="Search models"]')?.focus());
    }
  }, [panel]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || panel || e.repeat || !(e.target instanceof HTMLElement) ||
          !root.current?.closest(".conversation")?.contains(e.target) || e.target.closest(".modal")) return;
      let action: string | undefined;
      if (tab.agent === "pi") for (const name of ["backward", "forward", "effort", "model"]) {
        if (shortcuts[name]?.some((binding) => matches(e, binding))) { action = name; break; }
      }
      if (!action && matches(e, "ctrl+alt+m")) action = "model";
      if (!action && matches(e, "ctrl+alt+r")) action = "effort-picker";
      if (!action && matches(e, "ctrl+shift+p")) action = "plan";
      if (tab.agent === "claude") {
        if (matches(e, "alt+p")) action = "model";
        if (matches(e, "alt+t")) action = "effort-picker";
        if (matches(e, "shift+tab")) action = "plan";
      }
      if (!action) return;
      e.preventDefault(); e.stopPropagation();
      if (tab.busy || inFlight.current) return;
      if (["forward", "backward"].includes(action) || (action === "effort" && tab.agent === "pi")) void apply({ cycle: action });
      else setPanel(action === "effort-picker" ? "effort" : action as ControlPanel);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [tab.busy, tab.agent, panel, shortcuts]);
  const modelId = tab.model || info?.currentModel;
  const model = info?.models.find((m) => m.id === modelId);
  const levels = tab.agent === "pi" ? info?.currentEfforts || [] : model?.efforts || [];
  const effort = tab.effort || info?.currentEffort;
  const workMode = tab.workMode || info?.currentMode;
  const modelChoices = favorites ? (info?.favorites || []).flatMap((id) => info?.models.filter((m) => m.id === id) || []) : info?.models || [];
  const choices = panel === "model" ? modelChoices.filter((m) =>
    `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(query.toLowerCase())) :
    [...(tab.agent === "pi" || !levels.length ? [] : [{ id: "", name: "CLI default", description: "Use the CLI's effort setting for this model." }]), ...levels];
  const selection = Math.min(selected, Math.max(0, choices.length - 1));
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>(".model-option")[selection]?.scrollIntoView({ block: "nearest" });
  }, [selection, query]);
  const choose = (id: string) => void apply(panel === "model" ? { model: id } : { effort: id });
  const locked = tab.busy || loading || applying;
  return <div className="model-controls" ref={root}>
    <button disabled={locked} className="model-control" aria-label="Choose model" title="Choose model · Ctrl+Alt+M" onClick={() => setPanel("model")}>
      <span>{model?.name || modelId || "CLI model"}</span><ChevronDown size={12} />
    </button>
    <button disabled={locked} className="model-control effort-control" aria-label="Choose effort level" title="Effort · Ctrl+Alt+R" onClick={() => setPanel("effort")}>
      <Brain size={13} /><span>{effort || "Effort"}</span><ChevronDown size={12} />
    </button>
    <button disabled={locked} className={`model-control ${workMode === "plan" ? "plan-active" : ""}`} aria-label="Choose planning mode" title="Planning · Ctrl+Shift+P" onClick={() => setPanel("plan")}>
      <ListChecks size={13} /><span>{workMode === "plan" ? "Plan" : "Mode"}</span><ChevronDown size={12} />
    </button>
    {!panel && (loading || applying || error) && <span className={error ? "control-error" : "control-status"} role="status">{error || "Updating controls…"}</span>}
    {panel && <Modal title={panel === "model" ? "Choose a model" : panel === "effort" ? "Thinking & effort" : "Plan before building"}
      subtitle={`${agentNames[tab.agent]} · ${panel === "plan" ? "Choose the CLI's planning workflow." : "Apply to this conversation. Your draft and history stay here."}`}
      onClose={() => { if (!applying) setPanel(null); }}>
      {panel !== "plan" ? <>
        <div className="model-search-row">
          {panel === "model" && <label className="model-search"><Search size={16} /><input autoFocus placeholder="Search models or providers…" aria-label="Search models" value={query}
            role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="model-picker-options" aria-activedescendant={!loading && choices.length ? `model-picker-option-${selection}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (["ArrowDown", "ArrowUp"].includes(e.key) && choices.length) { e.preventDefault(); setSelected((selection + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length); }
              if (e.key === "Enter" && choices.length && !locked) { e.preventDefault(); choose(choices[selection].id); }
            }} /></label>}
          {!!info?.favorites?.length && panel === "model" && <button className={`favorite-filter ${favorites ? "active" : ""}`} aria-pressed={favorites} onClick={() => { setFavorites(!favorites); setSelected(0); }}><Star size={14} />Favorites</button>}
          <button className="picker-refresh" aria-label="Refresh available models" disabled={locked} onClick={() => void load(true)}><RefreshCw size={16} /></button>
        </div>
        <div id="model-picker-options" className="model-options" role="listbox" aria-label={panel === "model" ? "Available models" : "Available effort levels"} aria-busy={locked}>
          {loading ? <p className="picker-empty">Reading your installed CLI…</p> : choices.length === 0 ?
            <p className="picker-empty">{panel === "effort" ? "This model does not expose adjustable thinking. Choose another model or open native view." : "No matching models. Refresh or check your CLI account in native view."}</p> :
            choices.map((choice, index) => <button key={choice.id} id={`model-picker-option-${index}`} role="option" disabled={locked} aria-selected={choice.id === (panel === "model" ? modelId : effort)}
              className={`model-option ${selection === index ? "highlighted" : ""}`} onMouseEnter={() => setSelected(index)} onClick={() => choose(choice.id)}>
              <div><strong>{choice.name}</strong>{panel === "model" && info?.favorites?.includes(choice.id) && <Star size={12} className="favorite-star" />}
                {choice.id === (panel === "model" ? modelId : effort) && <Check size={15} className="current-check" />}</div>
              {choice.description && <p>{choice.description}</p>}{panel === "model" && <small>{choice.id}</small>}
            </button>)}
        </div>
        {tab.agent === "pi" && <p className="picker-note">Favorites come from Pi's scoped model list. Your model and thinking shortcuts work in readable view.</p>}
        <p className="picker-note">{applying ? "Applying to your chat…" : "Native CLI options · changes apply to the next turn"}</p>
      </> : <div className="plan-choices">
        {["claude", "grok"].includes(tab.agent) ? <>
          <button disabled={locked} onClick={() => void apply({ workMode: "plan" })}><ListChecks size={20} /><div><strong>Plan mode</strong><p>Use {agentNames[tab.agent]}'s native plan permission mode for your next turns.</p></div>{workMode === "plan" && <Check size={16} />}</button>
          <button disabled={locked} onClick={() => void apply({ workMode: "default" })}><Check size={20} /><div><strong>Full access</strong><p>Run tools and commands with your normal local account access.</p></div>{workMode !== "plan" && <Check size={16} />}</button>
        </> : tab.agent === "pi" ?
          <button disabled={locked} onClick={() => { setPanel(null); onPlanDraft(); }}><ListChecks size={20} /><div><strong>Plan with Pi</strong><p>Put /plan in your draft. Uses your installed planning command when you send it.</p></div></button> :
          <button disabled={locked} onClick={() => { setPanel(null); onNative("/plan"); }}><ListChecks size={20} /><div><strong>Plan in native Codex</strong><p>Open the same conversation in native view with /plan ready to copy.</p></div></button>}
        <p className="picker-note">Switching controls never sends a message automatically.</p>
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="model-picker-footer"><span>{panel === "model" ? "↑↓ navigate · Enter select" : "Tab navigate · Enter select"}</span><button disabled={applying} onClick={() => { setPanel(null); onNative(); }}>Open native view ↗</button></div>
    </Modal>}
  </div>;
}
