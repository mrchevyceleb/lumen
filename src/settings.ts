import type { Settings, Agent } from "./types";
export const agentNames: Record<Agent, string> = {
  shell: "Terminal",
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok",
};
export const themes = [
  {
    name: "Graphite",
    bg: "#191a1e",
    surface: "#202126",
    text: "#e9e9ec",
    muted: "#9b9ca6",
    accent: "#b8ebd6",
    border: "#33343b",
    userBubble: "#2d2e35",
    code: "#16171b",
  },
  {
    name: "Midnight",
    bg: "#111820",
    surface: "#19222d",
    text: "#e1eaf5",
    muted: "#92a3b7",
    accent: "#96c6f0",
    border: "#2d3b4c",
    userBubble: "#233246",
    code: "#0d141d",
  },
  {
    name: "Evergreen",
    bg: "#171e1b",
    surface: "#202a24",
    text: "#e4ede5",
    muted: "#a0b0a3",
    accent: "#bbd7a1",
    border: "#344038",
    userBubble: "#2e3a31",
    code: "#141a16",
  },
  {
    name: "Ember",
    bg: "#211c1a",
    surface: "#2b2521",
    text: "#f2e9de",
    muted: "#b5a59b",
    accent: "#efba91",
    border: "#43362f",
    userBubble: "#3b302a",
    code: "#1b1714",
  },
  {
    name: "Lilac",
    bg: "#1d1b24",
    surface: "#27232f",
    text: "#eeebf5",
    muted: "#b0a6c0",
    accent: "#c7b9ee",
    border: "#3d354b",
    userBubble: "#35303f",
    code: "#18151f",
  },
  {
    name: "Paper",
    bg: "#f6f4ee",
    surface: "#eeece5",
    text: "#292e2b",
    muted: "#646c66",
    accent: "#22694f",
    border: "#d6d7ce",
    userBubble: "#e4e7de",
    code: "#eaece4",
  },
];
export const defaults: Settings = {
  ...themes[0],
  theme: "Graphite",
  background: "aurora",
  image: "",
  fontSize: 17,
  lineHeight: 1.8,
  font: "system",
  terminalFontSize: 15,
  backgroundOpacity: 12,
  motion: true,
  playful: false,
  coloredTabs: true,
  coloredAgents: true,
  compact: false,
  enterSend: true,
  agents: {
    shell: { command: "", model: "", extraArgs: [], color: "#a4b0bd" },
    pi: { command: "pi", model: "", extraArgs: [], color: "#e8bf80" },
    codex: { command: "codex", model: "", extraArgs: [], color: "#b8ebd6" },
    claude: { command: "claude", model: "", extraArgs: [], color: "#e4a48b" },
    grok: { command: "grok", model: "", extraArgs: [], color: "#94bbf1" },
  },
};
export function loadSettings(value: Partial<Settings> | null): Settings {
  return {
    ...defaults,
    ...value,
    agents: { ...defaults.agents, ...value?.agents },
  };
}
export function styleVars(s: Settings): Record<string, string | number> {
  return {
    "--bg": s.bg,
    "--surface": s.surface,
    "--text": s.text,
    "--muted": s.muted,
    "--accent": s.accent,
    "--border": s.border,
    "--bubble": s.userBubble,
    "--code": s.code,
    "--font-size": `${s.fontSize}px`,
    "--line-height": s.lineHeight,
    "--bg-opacity": s.backgroundOpacity / 100,
    "--font":
      s.font === "system"
        ? '"Segoe UI", system-ui, sans-serif'
        : s.font === "serif"
          ? "Georgia, serif"
          : '"Cascadia Code", Consolas, monospace',
  };
}
