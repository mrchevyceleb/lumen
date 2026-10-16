import type { Settings, Agent } from "./types";
export const agentNames: Record<Agent, string> = {
  shell: "Terminal",
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok",
  google: "Google Antigravity",
};
export const themes = [
  {
    name: "Graphite",
    bg: "#13151a",
    surface: "#1b1e26",
    text: "#eef0f6",
    muted: "#98a0b3",
    accent: "#5eead4",
    border: "#2b303c",
    userBubble: "#232834",
    code: "#0f1116",
  },
  {
    name: "Midnight",
    bg: "#0d131c",
    surface: "#151f2e",
    text: "#e6f0fc",
    muted: "#8ea4be",
    accent: "#38bdf8",
    border: "#24344d",
    userBubble: "#1c2b42",
    code: "#090e15",
  },
  {
    name: "Synthwave",
    bg: "#120d24",
    surface: "#1c1436",
    text: "#f5ecff",
    muted: "#a896cc",
    accent: "#f472b6",
    border: "#352561",
    userBubble: "#2a1c4f",
    code: "#0c081a",
  },
  {
    name: "Cyber",
    bg: "#091318",
    surface: "#102029",
    text: "#e4f9ff",
    muted: "#80acb8",
    accent: "#22d3ee",
    border: "#1d3b4a",
    userBubble: "#15303d",
    code: "#060d11",
  },
  {
    name: "Evergreen",
    bg: "#111915",
    surface: "#19251f",
    text: "#e6f4ea",
    muted: "#95b09d",
    accent: "#4ade80",
    border: "#293d32",
    userBubble: "#213329",
    code: "#0d1310",
  },
  {
    name: "Ember",
    bg: "#1b1311",
    surface: "#261b18",
    text: "#f9ece4",
    muted: "#b89f93",
    accent: "#fb923c",
    border: "#402d27",
    userBubble: "#35241f",
    code: "#140e0c",
  },
  {
    name: "Solar",
    bg: "#191118",
    surface: "#261924",
    text: "#fceef5",
    muted: "#b898aa",
    accent: "#fb7185",
    border: "#422a3d",
    userBubble: "#362132",
    code: "#120c11",
  },
  {
    name: "Lilac",
    bg: "#151221",
    surface: "#201b30",
    text: "#f0ebfa",
    muted: "#a99ec2",
    accent: "#c084fc",
    border: "#362d50",
    userBubble: "#2c2442",
    code: "#100d1a",
  },
  {
    name: "Paper",
    bg: "#f6f4ee",
    surface: "#eeece5",
    text: "#222725",
    muted: "#5f6862",
    accent: "#0d9488",
    border: "#d5d7ce",
    userBubble: "#e2e6dc",
    code: "#eaece4",
  },
];
const legacyThemes: Record<string, Record<string, string>> = {
  Graphite: { bg: "#131518", surface: "#181b1f", text: "#ece9e2", muted: "#9297a0", accent: "#d6b88c", border: "#232830", userBubble: "#22262c", code: "#0f1114" },
  Midnight: { bg: "#0e131a", surface: "#131a24", text: "#e6edf6", muted: "#8a99ad", accent: "#8fb7e8", border: "#1f2a38", userBubble: "#1a2432", code: "#0a0e14" },
  Evergreen: { bg: "#101614", surface: "#151d1a", text: "#e7ece9", muted: "#8fa199", accent: "#94c9a9", border: "#22302b", userBubble: "#1c2823", code: "#0c110f" },
  Ember: { bg: "#161210", surface: "#1e1816", text: "#f0e7e2", muted: "#a69288", accent: "#e0a080", border: "#2f2420", userBubble: "#29201c", code: "#110d0c" },
  Lilac: { bg: "#141218", surface: "#1b1821", text: "#ede9f3", muted: "#9c93ab", accent: "#c3a6e8", border: "#2a2533", userBubble: "#241f2c", code: "#0f0d13" },
  Paper: { bg: "#f4f1ea", surface: "#ebe7de", text: "#262522", muted: "#6c6860", accent: "#3f6e68", border: "#dcd6c9", userBubble: "#e3ddd1", code: "#e8e3d8" },
};
const paletteKeys = ["bg", "surface", "text", "muted", "accent", "border", "userBubble", "code"] as const;
const { name: _defaultThemeName, ...defaultPalette } = themes[0];
export const defaults: Settings = {
  ...defaultPalette,
  theme: "Graphite",
  background: "aurora",
  image: "",
  fontSize: 17,
  lineHeight: 1.8,
  font: "system",
  terminalFontSize: 15,
  backgroundOpacity: 28,
  backgroundBlur: 0,
  animationSpeed: 1,
  motion: true,
  playful: true,
  coloredTabs: true,
  coloredAgents: true,
  compact: false,
  chatLayout: "vertical",
  enterSend: true,
  restoreSessions: true,
  loadShellProfile: true,
  agents: {
    shell: { command: "", model: "", extraArgs: [], color: "#38bdf8" },
    pi: { command: "pi", model: "", extraArgs: [], color: "#fbbf24" },
    codex: { command: "codex", model: "", extraArgs: [], color: "#34d399" },
    claude: { command: "claude", model: "", extraArgs: [], color: "#fb923c" },
    grok: { command: "grok", model: "", extraArgs: [], color: "#818cf8" },
    google: { command: "agy", model: "", extraArgs: [], color: "#c084fc" },
  },
};
function normalizeAnimationSpeed(value: unknown): number {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0
    ? Math.min(3, Math.max(0.2, Math.round(speed * 10) / 10))
    : defaults.animationSpeed;
}
export function foregroundFor(color: string): string {
  const hex = /^#([\da-f]{6})$/i.exec(color)?.[1];
  if (!hex) return "#13151a";
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.0575 >= 1.05 / (luminance + 0.05) ? "#13151a" : "#ffffff";
}
export function loadSettings(value: Partial<Settings> | null): Settings {
  const matchedTheme = value?.theme && value.theme !== "Custom" ? themes.find((t) => t.name === value.theme) : undefined;
  const legacyTheme = value?.theme ? legacyThemes[value.theme] : undefined;
  const { name: _ignoredName, ...persisted } = (value ?? {}) as Partial<Settings> & { name?: unknown };
  const resolvedPalette: Partial<Record<(typeof paletteKeys)[number], string>> = {};
  if (matchedTheme) {
    for (const key of paletteKeys) {
      const saved = persisted[key];
      resolvedPalette[key] = !saved || saved === legacyTheme?.[key] ? matchedTheme[key] : saved;
    }
  }
  const animationSpeed = normalizeAnimationSpeed(value?.animationSpeed);
  const rawOpacity = value?.backgroundOpacity;
  const backgroundOpacity = typeof rawOpacity === "number" && Number.isFinite(rawOpacity)
    ? Math.min(100, Math.max(0, rawOpacity)) : defaults.backgroundOpacity;
  const agents = { ...defaults.agents };
  if (value?.agents) {
    for (const key of Object.keys(defaults.agents) as Agent[]) {
      const incoming = value.agents[key];
      if (!incoming) continue;
      const color = incoming.color || defaults.agents[key].color;
      agents[key] = { ...defaults.agents[key], ...incoming, color };
    }
  }
  return {
    ...defaults,
    ...persisted,
    ...resolvedPalette,
    backgroundOpacity,
    animationSpeed,
    chatLayout: value?.chatLayout === "horizontal" ? "horizontal" : "vertical",
    agents,
  };
}
export function styleVars(s: Settings): Record<string, string | number> {
  const speed = normalizeAnimationSpeed(s.animationSpeed);
  return {
    "--bg": s.bg,
    "--surface": s.surface,
    "--text": s.text,
    "--muted": s.muted,
    "--accent": s.accent,
    "--accent-foreground": foregroundFor(s.accent),
    "--border": s.border,
    "--bubble": s.userBubble,
    "--code": s.code,
    "--font-size": `${s.fontSize}px`,
    "--line-height": s.lineHeight,
    "--bg-opacity": s.backgroundOpacity / 100,
    "--bg-blur": `${(Number.isFinite(s.backgroundBlur) ? Math.min(100, Math.max(0, s.backgroundBlur)) : 0) * 0.4}px`,
    "--anim-speed": speed,
    "--anim-scale": +(1 / speed).toFixed(4),
    "--font":
      s.font === "system"
        ? '"Segoe UI", system-ui, sans-serif'
        : s.font === "serif"
          ? "Georgia, serif"
          : '"Cascadia Code", Consolas, monospace',
  };
}
