import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Brain, Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { api, type Agent, type AgentConfig, type ModelCatalog, type ModelOption } from "./types";
import { agentNames } from "./settings";

type PickerPanel = "model" | "effort" | null;
type PickerChoice = { id: string; name: string; description: string; provider?: string };

export default function DefaultModelPicker({ agent, config, loadShellProfile, onChange, onEffortChange, label = "Default model", labelHint = "for new chats", effortLabel = "Default effort", note = "Uses your default account. Existing chats keep their selected model." }: {
  agent: Agent;
  config: AgentConfig;
  loadShellProfile: boolean;
  onChange: (model: ModelOption | null) => void;
  onEffortChange?: (effort: string) => void;
  label?: string;
  labelHint?: string;
  effortLabel?: string;
  note?: string;
}) {
  const [open, setOpen] = useState<PickerPanel>(null), [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalog>(), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), listbox = useRef<HTMLDivElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null), effortButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0), source = useRef(""), id = useId();
  const signature = JSON.stringify([agent, config.command, config.extraArgs, loadShellProfile]);
  const load = async (refresh = false) => {
    const current = ++request.current; setLoading(true); setError("");
    try {
      const value = await api<ModelCatalog>("agents:models", { agent, command: config.command, extraArgs: config.extraArgs, loadShellProfile }, refresh);
      if (current === request.current) { source.current = value.sourceKey || ""; setCatalog(value); }
    } catch (e: any) { if (current === request.current) setError(e.message); }
    finally { if (current === request.current) setLoading(false); }
  };
  useEffect(() => {
    setCatalog(undefined);
    source.current = "";
    if (open) {
      setQuery(""); setSelected(0); void load();
      if (open === "model") input.current?.focus();
      else listbox.current?.focus();
    }
    return () => { request.current++; };
  }, [open, signature]);
  useEffect(() => window.lumen.onSession((event) => {
    if (event.type === "default-models" && source.current && event.catalog?.sourceKey === source.current) setCatalog(event.catalog);
  }), []);
  useEffect(() => window.lumen.onAccounts((event) => {
    if (["changed", "authenticated"].includes(event.type)) { request.current++; source.current = ""; setCatalog(undefined); setOpen(null); }
  }), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const close = () => {
    const panel = open;
    setOpen(null);
    (panel === "effort" ? effortButton : modelButton).current?.focus();
  };
  const matches = (catalog?.models || []).filter((m) => `${m.name} ${m.id} ${m.provider || ""}`.toLowerCase().includes(query.toLowerCase()));
  const modelChoices: (ModelOption | null)[] = [null, ...matches];
  const selectedModel = catalog?.models.find((m) => m.id === (config.model || catalog.currentModel));
  const levels = selectedModel?.efforts || (agent === "pi" ? catalog?.currentEfforts || [] : []);
  const effortChoices: PickerChoice[] = [
    { id: "", name: "Use model default", description: "Follow the selected model or CLI's own effort setting." },
    ...levels,
  ];
  const choices: PickerChoice[] = open === "effort" ? effortChoices : modelChoices.map((model) => model || { id: "", name: "Use CLI default", description: "Follow this CLI's own default model." });
  const selection = Math.min(selected, Math.max(0, choices.length - 1));
  useEffect(() => { root.current?.querySelectorAll<HTMLElement>('[role="option"]')[selection]?.scrollIntoView({ block: "nearest" }); }, [selection]);
  const choose = (choice: PickerChoice) => {
    if (open === "effort") onEffortChange?.(choice.id);
    else onChange(modelChoices[choices.indexOf(choice)] || null);
    close();
  };
  const navigate = (event: ReactKeyboardEvent) => {
    if (!open || event.nativeEvent.isComposing) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && choices.length) {
      event.preventDefault();
      setSelected(event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 :
        (selection + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    }
    if ((event.key === "Enter" || (open === "effort" && event.key === " ")) && choices.length &&
      (open === "effort" || !query.trim() || matches.length) && (!loading || selection === 0)) {
      event.preventDefault(); choose(choices[selection]);
    }
  };
  const name = config.model ? config.modelName || catalog?.models.find((m) => m.id === config.model)?.name || "Saved model" : "Use CLI default";
  const effortName = config.effort ? levels.find((level) => level.id === config.effort)?.name || config.effort : "Use model default";
  const currentId = open === "effort" ? config.effort || "" : config.model || "";
  const optionsId = `${id}-${open || "closed"}`;
  const picker = (panel: Exclude<PickerPanel, null>) => open === panel && <div className="default-model-options">
    <div className="model-search-row">
      {panel === "model" ? <label className="model-search"><Search size={15} /><input ref={input} value={query} placeholder="Search models…"
        aria-label={`Search ${agentNames[agent]} models`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={optionsId}
        aria-activedescendant={`${optionsId}-${selection}`} onChange={(e) => { setQuery(e.target.value); setSelected(e.target.value.trim() ? 1 : 0); }} onKeyDownCapture={navigate} /></label> : <span className="effort-picker-label"><Brain size={15} />Thinking level</span>}
      <button type="button" className="picker-refresh" aria-label={`Refresh ${agentNames[agent]} models`} disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} /></button>
    </div>
    <div ref={listbox} className="model-options" id={optionsId} role="listbox" tabIndex={panel === "effort" ? 0 : -1}
      aria-activedescendant={panel === "effort" ? `${optionsId}-${selection}` : undefined} onKeyDown={navigate}
      aria-label={panel === "model" ? `${agentNames[agent]} default models` : `${agentNames[agent]} effort levels`} aria-busy={loading}>
      {choices.map((choice, index) => <button type="button" key={choice.id || "cli-default"} id={`${optionsId}-${index}`} role="option" tabIndex={-1}
        disabled={loading && !!choice.id} aria-selected={choice.id === currentId} className={`model-option ${selection === index ? "highlighted" : ""}`}
        onMouseEnter={() => setSelected(index)} onClick={() => choose(choice)}><div><strong>{choice.name}</strong>
          {choice.id === currentId && <Check size={14} className="current-check" />}</div>
        <p>{panel === "model" ? choice.provider || choice.description : choice.description}</p>
        {panel === "model" && choice.id && <small>{choice.id}</small>}
      </button>)}
    </div>
    {loading && <p className="picker-note" role="status">Loading available models…</p>}
    {!loading && !error && panel === "model" && !matches.length && <p className="picker-note">No matching models.</p>}
    {!loading && !error && panel === "effort" && !levels.length && <p className="picker-note">This model does not expose adjustable effort. The model default still applies.</p>}
    {error && <p className="inline-error" role="alert">{error} You can keep your saved settings or use the CLI default.</p>}
    {catalog?.warning && <p className="picker-note" role="status">{catalog.warning}</p>}
    <p className="picker-note">{note}</p>
  </div>;
  return <div className="default-model-group" ref={root} onKeyDownCapture={(e) => {
    if (open && e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); close(); }
  }}>
    <div className="field default-model-picker">
      <span>{label} <small>{labelHint}</small></span>
      <button ref={modelButton} type="button" className="default-model-trigger" aria-label={`${label} for ${agentNames[agent]}`} aria-haspopup="listbox" aria-expanded={open === "model"}
        title={config.model || "Follow the CLI's own default"} onClick={() => setOpen(open === "model" ? null : "model")}><span>{name}</span><ChevronDown size={15} /></button>
      {picker("model")}
    </div>
    {onEffortChange && <div className="field default-model-picker">
      <span>{effortLabel} <small>for this model</small></span>
      <button ref={effortButton} type="button" className="default-model-trigger" aria-label={`${effortLabel} for ${agentNames[agent]}`} aria-haspopup="listbox" aria-expanded={open === "effort"}
        title={config.effort || "Follow the model's default effort"} onClick={() => setOpen(open === "effort" ? null : "effort")}><span>{effortName}</span><Brain size={14} /><ChevronDown size={15} /></button>
      {picker("effort")}
    </div>}
  </div>;
}
