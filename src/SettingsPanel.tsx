import { useState } from "react";
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
import UpdatesPanel from "./UpdatesPanel";
import AccountsPanel from "./AccountsPanel";
import AgentControlPanel from "./AgentControlPanel";
import type { AccountProfile } from "./types";
const backgrounds = [
  ["none", "Solid", "Still & focused"],
  ["aurora", "Aurora", "A slow wash of light"],
  ["orbits", "Orbital", "Drifting luminous circles"],
  ["rain", "Rain", "Gentle falling light"],
  ["stars", "Star field", "A slow drift through deep space"],
  ["nebula", "Nebula", "Violet clouds and distant stars"],
  ["grid", "Blueprint", "A fine architectural grid"],
  ["contour", "Contour", "Quiet topographic lines"],
  ["grain", "Grain", "A little analog texture"],
  ["image", "Your image", "Make it your space"],
];
const animatedBackgrounds = new Set(["aurora", "orbits", "rain", "stars", "nebula"]);
export default function SettingsPanel({
  settings: s,
  update,
  onClose,
  available,
  onError,
  initialSection = "appearance",
  onAccountChat,
}: {
  settings: Settings;
  update: (next: Settings) => void;
  onClose: () => void;
  available: Record<string, { available: boolean; file?: string }>;
  onError: (text: string) => void;
  initialSection?: string;
  onAccountChat: (profile: AccountProfile) => void;
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
          {section === "accounts" && <AccountsPanel settings={s} onStart={onAccountChat} />}
          {section === "appearance" && (
            <>
              <h3>A fresh coat of color</h3>
              <p className="muted">Start with a palette, then make it yours.</p>
              <div className="theme-grid">
                {themes.map((theme) => (
                  <button
                    key={theme.name}
                    className={`theme-card ${s.theme === theme.name ? "selected" : ""}`}
                    onClick={() =>
                      update({ ...s, ...theme, theme: theme.name })
                    }
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
                max={50}
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
              <Toggle
                title="Animate backgrounds"
                detail="Aurora, Orbital, Rain, Star field, and Nebula animate. Motion also follows your system’s reduced-motion setting."
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
              {(["pi", "codex", "claude", "grok"] as Agent[]).map((agent) => (
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
                  <label className="field">
                    <span>
                      Model <small>optional · CLI default when blank</small>
                    </span>
                    <input
                      value={s.agents[agent].model}
                      onChange={(e) => agentSet(agent, "model", e.target.value)}
                      placeholder="Use my CLI default"
                    />
                  </label>
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
