import { useEffect, useState } from "react";
import {
  Palette,
  Waves,
  Type,
  Bot,
  SlidersHorizontal,
  Check,
  ImagePlus,
  RotateCcw,
  Download,
  Users,
  ListTree,
  PanelTop,
  Plug,
} from "lucide-react";
import { Modal } from "./Components";
import { agentNames, defaults, themes } from "./settings";
import type { Settings, Agent, AgentConfig } from "./types";
import { api } from "./types";
import GoogleSetup from "./GoogleSetup";
import UpdatesPanel from "./UpdatesPanel";
import AccountsPanel from "./AccountsPanel";
import DefaultModelPicker from "./DefaultModelPicker";
import AgentControlPanel from "./AgentControlPanel";
import AdministratorPanel from "./AdministratorPanel";
import type { AdministratorStatus } from "./types";
import type { AccountProfile } from "./types";
const backgrounds = [
  ["none", "Solid", "Still & focused"],
  ["aurora", "Aurora", "A slow wash of light"],
  ["orbits", "Orbital", "Drifting luminous circles"],
  ["rain", "Rain", "Gentle falling light"],
  ["stars", "Star field", "A slow drift through deep space"],
  ["nebula", "Nebula", "Violet clouds and distant stars"],
  ["fireflies", "Fireflies", "Warm drifting bioluminescence"],
  ["synthwave", "Synthwave", "Neon sunset & horizon grid"],
  ["matrix", "Digital rain", "Cascading phosphor code streams"],
  ["lava", "Lava lamp", "Morphing blobs of warm plasma"],
  ["prism", "Prism rays", "Rotating spectral light beams"],
  ["ripples", "Ripples", "Expanding concentric water rings"],
  ["galaxy", "Spiral galaxy", "Swirling cosmic dust & core"],
  ["meteors", "Meteor shower", "Streaking shooting stars"],
  ["waves", "Ocean waves", "Flowing bioluminescent tides"],
  ["cyberpulse", "Circuit pulse", "Grid nodes & radar sweeps"],
  ["grid", "Blueprint", "A fine architectural grid"],
  ["contour", "Contour", "Quiet topographic lines"],
  ["grain", "Grain", "A little analog texture"],
  ["image", "Your image", "Make it your space"],
];
const animatedBackgrounds = new Set([
  "aurora",
  "orbits",
  "rain",
  "stars",
  "nebula",
  "fireflies",
  "synthwave",
  "matrix",
  "lava",
  "prism",
  "ripples",
  "galaxy",
  "meteors",
  "waves",
  "cyberpulse",
]);
const speedPresets: [number, string][] = [
  [0.5, "0.5× Chill"],
  [1, "1× Normal"],
  [1.5, "1.5× Lively"],
  [2, "2× Fast"],
  [3, "3× Hyper"],
];
export default function SettingsPanel({
  settings: s,
  update,
  onClose,
  available,
  onError,
  initialSection = "appearance",
  onAccountChat,
  administrator,
  onAdministratorStatus,
  onAgentsRefresh,
}: {
  onAgentsRefresh: () => Promise<void>;
  settings: Settings;
  update: (next: Settings) => void;
  onClose: () => void;
  available: Record<string, { available: boolean; file?: string }>;
  onError: (text: string) => void;
  initialSection?: string;
  onAccountChat: (profile: AccountProfile) => void;
  administrator: AdministratorStatus;
  onAdministratorStatus: (status: AdministratorStatus) => void;
}) {
  const [section, setSection] = useState(initialSection);
  const set = (key: keyof Settings, value: any) =>
    update({ ...s, [key]: value });
  const agentSet = (agent: Agent, key: keyof AgentConfig, value: any) =>
    update({
      ...s,
      agents: { ...s.agents, [agent]: { ...s.agents[agent], [key]: value } },
    });
  return (
    <Modal
      title="Make yourself at home"
      subtitle="Your workspace. Your atmosphere. Every change is saved."
      onClose={onClose}
      wide
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            ["appearance", Palette, "Appearance"],
            ["backgrounds", Waves, "Backgrounds"],
            ["type", Type, "Typography"],
            ["agents", Bot, "Agents"],
            ["accounts", Users, "Accounts"],
            ["control", Plug, "Agent control"],
            ["behavior", SlidersHorizontal, "Workspace"],
            ["updates", Download, "Updates"],
          ].map(([key, Icon, label]: any) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={section === key ? "selected" : ""}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "updates" && <UpdatesPanel />}
          {section === "control" && <AgentControlPanel />}
          {section === "accounts" && <AccountsPanel settings={s} onStart={onAccountChat} onAgentsRefresh={onAgentsRefresh} />}
          {section === "appearance" && (
            <>
              <h3>A fresh coat of color</h3>
              <p className="muted">Start with a palette, then make it yours.</p>
              <div className="theme-grid">
                {themes.map((theme) => (
                  <button
                    key={theme.name}
                    className={`theme-card ${s.theme === theme.name ? "selected" : ""}`}
                    onClick={() => {
                      const { name, ...palette } = theme;
                      update({ ...s, ...palette, theme: name });
                    }}
                  >
                    <div
                      className="theme-preview"
                      style={{
                        background: theme.bg,
                        borderColor: theme.border,
                      }}
                    >
                      <i style={{ background: theme.surface }} />
                      <div>
                        <b style={{ background: theme.accent }} />
                        <b style={{ background: theme.text }} />
                        <b style={{ background: theme.muted }} />
                      </div>
                      <span style={{ background: theme.userBubble }} />
                    </div>
                    <span>
                      {theme.name}
                      {s.theme === theme.name && <Check size={13} />}
                    </span>
                  </button>
                ))}
              </div>
              <div className="color-grid">
                {[
                  ["bg", "Canvas"],
                  ["surface", "Panels"],
                  ["text", "Main text"],
                  ["muted", "Secondary text"],
                  ["accent", "Accent"],
                  ["border", "Borders"],
                  ["userBubble", "Your messages"],
                  ["code", "Code blocks"],
                ].map(([key, label]) => (
                  <label className="color-control" key={key}>
                    <span>{label}</span>
                    <input
                      aria-label={`${label} color`}
                      type="color"
                      value={s[key as keyof Settings] as string}
                      onChange={(e) =>
                        update({ ...s, [key]: e.target.value, theme: "Custom" })
                      }
                    />
                    <code>{String(s[key as keyof Settings])}</code>
                  </label>
                ))}
              </div>
              <Toggle
                title="Color-coded tabs"
                detail="Give each session a recognizable edge."
                value={s.coloredTabs}
                onChange={(v) => set("coloredTabs", v)}
              />
              <Toggle
                title="Agent identity colors"
                detail="Use a different color for each kind of agent."
                value={s.coloredAgents}
                onChange={(v) => set("coloredAgents", v)}
              />
            </>
          )}
          {section === "backgrounds" && (
            <>
              <h3>Set the atmosphere</h3>
              <p className="muted">
                A little movement, a little texture, or a clean canvas.
              </p>
              <div className="background-grid">
                {backgrounds.map(([key, name, detail]) => (
                  <button
                    className={`background-card ${s.background === key ? "selected" : ""}`}
                    key={key}
                    aria-pressed={s.background === key}
                    onClick={() => set("background", key)}
                  >
                    <div className="background-swatch" aria-hidden="true">
                      <div className={`background-preview swatch-${key} atmosphere-${key}`}>
                        <i /><i /><i /><i /><i /><i />
                      </div>
                      {s.background === key && <Check size={17} />}
                    </div>
                    <strong>{name}</strong>
                    <span className={`background-kind ${animatedBackgrounds.has(key) ? "animated" : ""}`}>{animatedBackgrounds.has(key) ? "Animated" : "Static"}</span>
                    <small>{detail}</small>
                  </button>
                ))}
              </div>
              <label className="upload-button">
                <ImagePlus size={17} />
                Choose a background image
                <input
                  aria-label="Upload background image"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 5 * 1024 * 1024) {
                      onError("Choose an image smaller than 5 MB.");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () =>
                      update({
                        ...s,
                        image: String(reader.result),
                        background: "image",
                      });
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
              <Range
                title="Background intensity"
                value={s.backgroundOpacity}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => set("backgroundOpacity", v)}
              />
              <Range
                title="Background blur"
                value={s.backgroundBlur}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => set("backgroundBlur", v)}
              />
              <Range
                title="Animation speed"
                value={s.animationSpeed}
                min={0.2}
                max={3}
                step={0.1}
                suffix="×"
                onChange={(v) => set("animationSpeed", Math.round(v * 10) / 10)}
              />
              <div className="speed-presets" role="group" aria-label="Animation speed presets">
                {speedPresets.map(([preset, label]) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={s.animationSpeed === preset}
                    onClick={() => set("animationSpeed", preset)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Toggle
                title="Animate backgrounds"
                detail="All 15 animated atmospheres respond to your speed setting and respect system reduced-motion preferences."
                value={s.motion}
                onChange={(v) => set("motion", v)}
              />
            </>
          )}
          {section === "type" && (
            <>
              <h3>Room for your thoughts</h3>
              <p className="muted">
                Readable text, exactly the way you like it.
              </p>
              <div
                className="typography-preview"
                style={{
                  fontSize: s.fontSize,
                  lineHeight: s.lineHeight,
                  fontFamily: "var(--font)",
                }}
              >
                <p>Good tools get out of your way.</p>
                <p>
                  Use <strong>clear ideas</strong>, a little breathing room, and{" "}
                  <code>code when you need it.</code>
                </p>
                <ul>
                  <li>Your terminal, with room to think.</li>
                  <li>Your agents, all in one place.</li>
                </ul>
              </div>
              <label className="field">
                <span>Conversation font</span>
                <select
                  value={s.font}
                  onChange={(e) => set("font", e.target.value)}
                >
                  <option value="system">System sans — like Codex</option>
                  <option value="serif">Editorial serif</option>
                  <option value="mono">Monospace</option>
                </select>
              </label>
              <Range
                title="Conversation text size"
                value={s.fontSize}
                min={13}
                max={26}
                suffix="px"
                onChange={(v) => set("fontSize", v)}
              />
              <Range
                title="Line spacing"
                value={s.lineHeight}
                min={1.3}
                max={2.2}
                step={0.1}
                suffix="×"
                onChange={(v) => set("lineHeight", v)}
              />
              <Range
                title="Native terminal text size"
                value={s.terminalFontSize}
                min={11}
                max={24}
                suffix="px"
                onChange={(v) => set("terminalFontSize", v)}
              />
            </>
          )}
          {section === "agents" && (
            <>
              <h3>Everyone has a seat</h3>
              <p className="muted">
                Uses your installed CLIs and their existing sign-ins.
              </p>
              {(["pi", "codex", "claude", "grok", "google"] as Agent[]).map((agent) => (
                <div className="agent-config" key={agent}>
                  <div className="agent-config-heading">
                    <span
                      className="agent-orb"
                      style={{ background: s.agents[agent].color }}
                    />
                    <strong>{agentNames[agent]}</strong>
                    <span
                      className={`detection ${available[agent]?.available ? "ready" : ""}`}
                    >
                      {available[agent]?.available
                        ? "Detected"
                        : "Set executable"}
                    </span>
                    <input
                      type="color"
                      aria-label={`${agentNames[agent]} color`}
                      value={s.agents[agent].color}
                      onChange={(e) => agentSet(agent, "color", e.target.value)}
                    />
                  </div>
                  {agent === "google" && <GoogleSetup available={!!available.google?.available} onInstalled={onAgentsRefresh} onError={onError} />}
                  <label className="field">
                    <span>Executable or command</span>
                    <input
                      value={s.agents[agent].command}
                      onChange={(e) =>
                        agentSet(agent, "command", e.target.value)
                      }
                      placeholder={agent}
                    />
                  </label>
                  <DefaultModelPicker agent={agent} config={s.agents[agent]} loadShellProfile={s.loadShellProfile}
                    onChange={(model) => update({ ...s, agents: { ...s.agents, [agent]: { ...s.agents[agent],
                      model: model?.id || "", modelName: model?.name || "", effort: model?.defaultEffort || "" } } })} />
                  <ArgsField
                    value={s.agents[agent].extraArgs}
                    onChange={(value) => agentSet(agent, "extraArgs", value)}
                  />
                </div>
              ))}
              <p className="settings-note">
                New settings apply to new tabs. Rich mode uses CLI event
                streams; native mode opens the full CLI. Agents launch with full
                local tool access. Plan mode is an explicit choice; agent questions
                appear here. Use native mode for login and terminal interfaces.
              </p>
            </>
          )}
          {section === "behavior" && (
            <>
              <h3>A workspace that fits</h3>
              <GroqDictationKey />
              <AdministratorPanel status={administrator} onStatus={onAdministratorStatus} />
              <Toggle title="Restore sessions on launch" detail="Reconnect saved conversations after restarts. Interrupted work waits for Continue; queued messages stay paused." value={s.restoreSessions} onChange={(value) => set("restoreSessions", value)} />
              <Toggle title="Load PowerShell profiles" detail="Use your normal environment, aliases, and functions in new sessions. Disable while troubleshooting profile startup." value={s.loadShellProfile} onChange={(value) => set("loadShellProfile", value)} />
              <div className="chat-layout-setting">
                <strong>Chat layout</strong>
                <p className="muted">Nest chats beneath each project, or keep tabs across the top.</p>
                <div className="chat-layout-picker">
                  <button aria-pressed={s.chatLayout === "vertical"} onClick={() => set("chatLayout", "vertical")}><ListTree size={17} />Vertical chats</button>
                  <button aria-pressed={s.chatLayout === "horizontal"} onClick={() => set("chatLayout", "horizontal")}><PanelTop size={17} />Horizontal tabs</button>
                </div>
              </div>
              <Toggle
                title="Enter to send"
                detail="Shift + Enter always adds a new line."
                value={s.enterSend}
                onChange={(v) => set("enterSend", v)}
              />
              <Toggle
                title="Compact message spacing"
                detail="Fit more of a conversation on screen."
                value={s.compact}
                onChange={(v) => set("compact", v)}
              />
              <Toggle
                title="Playful details"
                detail="Small click sparks and a drifting status ticker."
                value={s.playful}
                onChange={(v) => set("playful", v)}
              />
              <div className="shortcut-list">
                <h4>Keep your hands on the keyboard</h4>
                {[
                  ["Command palette", "Ctrl K"],
                  ["Open workspace", "Ctrl O"],
                  ["Find a file", "Ctrl P"],
                  ["Save file", "Ctrl S"],
                  ["New terminal", "Ctrl Shift T"],
                  ["Worktrees", "Ctrl Shift N"],
                  ["Settings", "Ctrl ,"],
                ].map(([label, key]) => (
                  <div key={key}>
                    <span>{label}</span>
                    <kbd>{key}</kbd>
                  </div>
                ))}
              </div>
              <button
                className="secondary"
                onClick={() => update(structuredClone(defaults))}
              >
                <RotateCcw size={14} />
                Reset customization
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
function GroqDictationKey() {
  const [status, setStatus] = useState<{ configured: boolean; masked: string }>({ configured: false, masked: "" });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const refresh = () => { void api<{ configured: boolean; masked: string }>("dictation:status").then(setStatus).catch(() => setStatus({ configured: false, masked: "" })); };
  useEffect(() => { refresh(); }, []);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true); setNote("");
    try { setStatus(await api<{ configured: boolean; masked: string }>("dictation:set-key", key)); setKey(""); setNote("Saved. Dictation is ready."); refresh(); }
    catch (e: any) { setNote(e?.message || "Could not save that key."); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setNote("");
    try { setStatus(await api<{ configured: boolean; masked: string }>("dictation:set-key", "")); setNote("Removed."); }
    catch (e: any) { setNote(e?.message || "Could not remove the key."); }
    finally { setBusy(false); }
  };
  return (
    <div className="chat-layout-setting">
      <strong>Dictation (Groq)</strong>
      <p className="muted">Same Groq API key and Whisper cleanup you use in TARDIS. Paste it once here; it stays on this computer and never leaves except to Groq.</p>
      <p className="muted">{status.configured ? <>Key saved {status.masked}. Mic shows in every chat composer.</> : "No key saved yet. The mic will ask you to add one."}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <input type="password" value={key} placeholder="gsk_…" aria-label="Groq API key" style={{ flex: "1 1 200px", minHeight: 32 }} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
        <button className="secondary" disabled={!key.trim() || busy} onClick={() => void save()}>Save key</button>
        {status.configured && <button className="secondary" disabled={busy} onClick={() => void remove()}>Remove</button>}
      </div>
      {note && <p role="status" style={{ marginTop: 6, fontSize: 12 }}>{note}</p>}
    </div>
  );
}
function Toggle({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i />
    </label>
  );
}
function Range({
  title,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span>
        {title}
        <code>
          {value}
          {suffix}
        </code>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function ArgsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value));
  const [error, setError] = useState("");
  return (
    <label className="field">
      <span>
        Extra CLI arguments <small>JSON array</small>
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text);
            if (
              !Array.isArray(parsed) ||
              parsed.some((x) => typeof x !== "string")
            )
              throw new Error();
            onChange(parsed);
            setError("");
          } catch {
            setError('Use an array of strings, for example ["--verbose"].');
          }
        }}
      />
      {error && <small className="inline-error">{error}</small>}
    </label>
  );
}
