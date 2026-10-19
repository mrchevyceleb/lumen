import type { Tab } from "./types";
const format = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export default function ContextIndicator({
  tab,
  variant = "default",
  onClick,
  disabled,
}: {
  tab: Tab;
  variant?: "default" | "composer" | "statusbar";
  onClick?: () => void;
  disabled?: boolean;
}) {
  const used = typeof tab.contextTokens === "number" && Number.isFinite(tab.contextTokens) && tab.contextTokens >= 0 ? tab.contextTokens : null;
  const limit = typeof tab.contextWindow === "number" && Number.isFinite(tab.contextWindow) && tab.contextWindow > 0 ? tab.contextWindow : null;
  const percent = used !== null && limit !== null ? Math.round((used / limit) * 100) : null;
  const native = tab.mode === "native";
  const stale = !!tab.contextStale || (native && ["codex", "grok"].includes(tab.agent));
  const detail = used === null
    ? limit !== null
      ? `Context window: ${limit.toLocaleString()} tokens. Waiting for this CLI to report active token usage.`
      : native
        ? "Lumen cannot read context usage from this native terminal. The CLI has its own context display."
        : "Waiting for this CLI to report its context usage. No token count is estimated by Lumen."
    : `${used.toLocaleString()} tokens${limit !== null ? ` of ${limit.toLocaleString()} (${percent}%)` : "; this CLI has not reported its context limit"}. ${stale ? "Last reported context usage; waiting for a fresh CLI report." : "Latest context usage reported by the CLI; updates at its message and turn boundaries."}`;
  const value = used === null ? (limit !== null ? `— / ${format(limit)}` : "—") : `${format(used)}${limit !== null ? ` / ${format(limit)}` : " tokens"}`;
  const className = `context-indicator context-indicator-${variant} ${percent !== null && percent >= 95 ? "context-full" : percent !== null && percent >= 80 ? "context-high" : ""}`;
  const content = (
    <>
      <span className="context-label">{stale && used !== null ? "Last context" : "Context"}</span>
      <strong>{value}</strong>
      {percent !== null && (
        <>
          <span className="context-meter" aria-hidden="true">
            <i style={{ width: `${Math.min(100, percent)}%` }} />
          </span>
          <span>{percent}%</span>
        </>
      )}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        title={detail}
        aria-label={`${detail} Open context and auto-compact settings.`}
        disabled={disabled}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <div role="status" className={className} title={detail} aria-label={detail}>
      {content}
    </div>
  );
}
