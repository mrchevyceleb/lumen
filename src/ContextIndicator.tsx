import type { Tab } from "./types";
const format = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export default function ContextIndicator({ tab }: { tab: Tab }) {
  const used = typeof tab.contextTokens === "number" && Number.isFinite(tab.contextTokens) && tab.contextTokens >= 0 ? tab.contextTokens : null;
  const limit = typeof tab.contextWindow === "number" && Number.isFinite(tab.contextWindow) && tab.contextWindow > 0 ? tab.contextWindow : null;
  const percent = used !== null && limit !== null ? Math.round(used / limit * 100) : null;
  const native = tab.mode === "native";
  const stale = native || tab.contextStale;
  const detail = used === null ? native ? "Lumen cannot read context usage from this native terminal. The CLI has its own context display." : "Waiting for this CLI to report its context usage. No token count is estimated by Lumen." :
    `${used.toLocaleString()} tokens${limit !== null ? ` of ${limit.toLocaleString()} (${percent}%)` : "; this CLI has not reported its context limit"}. ${stale ? "Last reported in readable view; waiting for a fresh CLI report after restart or native terminal activity." : "Latest context usage reported by the CLI; updates at its message and turn boundaries."}`;
  return <div className={`context-indicator ${percent !== null && percent >= 95 ? "context-full" : percent !== null && percent >= 80 ? "context-high" : ""}`} title={detail} aria-label={detail}>
    <span className="context-label">{stale && used !== null ? "Last context" : "Context"}</span>
    <strong>{used === null ? "—" : `${format(used)}${limit !== null ? ` / ${format(limit)}` : " tokens"}`}</strong>
    {percent !== null && <><span className="context-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, percent)}%` }} /></span><span>{percent}%</span></>}
  </div>;
}
