import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { api, type Agent, type AgentConfig, type ModelCatalog, type ModelOption } from "./types";
import { agentNames } from "./settings";

export default function DefaultModelPicker({ agent, config, loadShellProfile, onChange }: {
  agent: Agent; config: AgentConfig; loadShellProfile: boolean; onChange: (model: ModelOption | null) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalog>(), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), button = useRef<HTMLButtonElement>(null);
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
    if (open) { setQuery(""); setSelected(0); void load(); input.current?.focus(); }
    return () => { request.current++; };
  }, [open, signature]);
  useEffect(() => window.lumen.onSession((event) => {
    if (event.type === "default-models" && source.current && event.catalog?.sourceKey === source.current) setCatalog(event.catalog);
  }), []);
  useEffect(() => window.lumen.onAccounts((event) => {
    if (["changed", "authenticated"].includes(event.type)) { request.current++; source.current = ""; setCatalog(undefined); setOpen(false); }
  }), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const matches = (catalog?.models || []).filter((m) => `${m.name} ${m.id} ${m.provider || ""}`.toLowerCase().includes(query.toLowerCase()));
  const choices = [null, ...matches];
  const selection = Math.min(selected, choices.length - 1);
  useEffect(() => { root.current?.querySelectorAll<HTMLElement>('[role="option"]')[selection]?.scrollIntoView({ block: "nearest" }); }, [selection]);
  const choose = (model: ModelOption | null) => { onChange(model); setOpen(false); button.current?.focus(); };
  const name = config.model ? config.modelName || catalog?.models.find((m) => m.id === config.model)?.name || "Saved model" : "Use CLI default";
  return <div className="field default-model-picker" ref={root} onKeyDownCapture={(e) => {
    if (open && e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
  }}>
    <span>Default model <small>for new chats</small></span>
    <button ref={button} type="button" className="default-model-trigger" aria-label={`Default model for ${agentNames[agent]}`} aria-haspopup="listbox" aria-expanded={open}
      title={config.model || "Follow the CLI's own default"} onClick={() => setOpen(!open)}><span>{name}</span><ChevronDown size={15} /></button>
    {open && <div className="default-model-options">
      <div className="model-search-row"><label className="model-search"><Search size={15} /><input ref={input} value={query} placeholder="Search models…"
        aria-label={`Search ${agentNames[agent]} models`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={id}
        aria-activedescendant={`${id}-${selection}`} onChange={(e) => { setQuery(e.target.value); setSelected(e.target.value.trim() ? 1 : 0); }} onKeyDownCapture={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); setSelected((selection + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length); }
          if (e.key === "Enter") {
            e.preventDefault();
            if ((!query.trim() || matches.length) && (!loading || selection === 0)) choose(choices[selection]);
          }
        }} /></label><button type="button" className="picker-refresh" aria-label={`Refresh ${agentNames[agent]} models`} disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} /></button></div>
      <div className="model-options" id={id} role="listbox" aria-label={`${agentNames[agent]} default models`} aria-busy={loading}>
        {choices.map((model, index) => <button type="button" key={model?.id || "cli-default"} id={`${id}-${index}`} role="option"
          disabled={loading && !!model} aria-selected={(model?.id || "") === config.model} className={`model-option ${selection === index ? "highlighted" : ""}`}
          onClick={() => choose(model)}><div><strong>{model?.name || "Use CLI default"}</strong>
            {(model?.id || "") === config.model && <Check size={14} className="current-check" />}</div>
          <p>{model ? model.provider || model.description : "Follow this CLI's own default model."}</p>
        </button>)}
      </div>
      {loading && <p className="picker-note" role="status">Loading available models…</p>}
      {!loading && !error && !matches.length && <p className="picker-note">No matching models.</p>}
      {error && <p className="inline-error" role="alert">{error} You can keep your saved model or use the CLI default.</p>}
      {catalog?.warning && <p className="picker-note" role="status">{catalog.warning}</p>}
      <p className="picker-note">Uses your default account. Existing chats keep their selected model.</p>
    </div>}
  </div>;
}
