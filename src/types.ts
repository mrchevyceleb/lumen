export type Agent = "shell" | "pi" | "codex" | "claude" | "grok";
export type Mode = "rich" | "native";
export interface AccountProfile { id: string; agent: "claude" | "codex"; name: string; signedIn: boolean; email: string; signingIn: boolean; inUse: boolean }
export interface AccountInventory { profiles: AccountProfile[]; defaults: { claude: string; codex: string } }
export interface SlashCommand {
  name: string;
  insertText: string;
  description: string;
  argumentHint: string;
  source: string;
  scope: string;
  native: boolean;
}
export interface CommandInventory {
  commands: SlashCommand[];
  origin: string;
  warning?: string;
}
export interface EffortOption { id: string; name: string; description: string }
export interface ModelOption {
  id: string; name: string; description: string; provider?: string;
  efforts: EffortOption[]; defaultEffort?: string;
}
export interface ModelCatalog {
  models: ModelOption[]; currentModel: string; currentEffort: string; currentMode?: string;
  currentEfforts?: EffortOption[]; favorites?: string[];
  shortcuts?: Record<string, string[]>;
}
export interface GitFile {
  path: string;
  code: string;
  staged: boolean;
  unstaged: boolean;
  original?: string;
}
export interface GitState {
  available: boolean;
  error?: string;
  branch: string;
  files: GitFile[];
  ahead: number;
  behind: number;
  upstream?: string;
  remote?: string;
  worktrees: { path: string; branch: string }[];
  log: { hash: string; subject: string; author: string; when: string }[];
}
export interface Workspace {
  root: string;
  name: string;
  git: GitState;
}
export interface Entry {
  name: string;
  path: string;
  directory: boolean;
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "error" | "notice";
  text: string;
  title?: string;
  state?: string;
  turn?: string;
  time?: number;
  delivery?: "steer" | "send";
}
export interface QueuedMessage { id: string; text: string; state: "queued" | "sending" | "steering" }
export interface Tab {
  id: string;
  root: string;
  projectless?: boolean;
  scratchId?: string;
  agent: Agent;
  mode: Mode;
  accountId?: string;
  accountName?: string;
  name: string;
  color?: string;
  messages: Message[];
  busy: boolean;
  phase?: "waiting" | "finishing" | "compacting";
  sessionRef?: string;
  turn?: string;
  started?: number;
  duration?: number;
  cwd?: string;
  cwdVersion?: number;
  exited?: boolean;
  exitCode?: number;
  nativeDraft?: string;
  draft?: string;
  model?: string;
  effort?: string;
  workMode?: string;
  controlId?: string;
  autoCompactTokens?: number | null;
  mcpOverrides?: Record<string, boolean>;
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextStale?: boolean;
  queuedMessages?: QueuedMessage[];
  queuePaused?: boolean;
}
export interface McpConnection {
  name: string; source: string; status: string; enabled: boolean; tools: number | null; canToggle: boolean;
}
export interface SessionControlsState {
  servers: McpConnection[]; contextTokens: number | null; contextWindow?: number | null; autoCompactTokens: number | null;
  mcpOverrides: Record<string, boolean>; warning: string; minimumTokens: number; maximumTokens: number;
}
export interface Doc {
  root: string;
  path: string;
  content: string;
  saved: string;
  version: string;
}
export interface AgentConfig {
  command: string;
  model: string;
  effort?: string;
  extraArgs: string[];
  color: string;
}
export interface Settings {
  theme: string;
  background: string;
  image: string;
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  userBubble: string;
  code: string;
  fontSize: number;
  lineHeight: number;
  font: string;
  terminalFontSize: number;
  backgroundOpacity: number;
  backgroundBlur: number;
  motion: boolean;
  playful: boolean;
  coloredTabs: boolean;
  coloredAgents: boolean;
  compact: boolean;
  enterSend: boolean;
  agents: Record<Agent, AgentConfig>;
}
export interface SessionEvent {
  id: string;
  type: string;
  phase?: "waiting" | "finishing" | "compacting";
  text?: string;
  key?: string;
  replace?: boolean;
  turn?: string;
  title?: string;
  detail?: string;
  state?: string;
  message?: string;
  code?: number;
  sessionRef?: string;
  cwd?: string;
  request?: PiRequest;
  data?: string;
  model?: string;
  effort?: string;
  workMode?: string;
  autoCompactTokens?: number | null;
  mcpOverrides?: Record<string, boolean>;
  contextTokens?: number | null;
  contextWindow?: number | null;
  queuedMessages?: QueuedMessage[];
  queuePaused?: boolean;
  messageId?: string;
  delivery?: "steer" | "send";
}
export interface PiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  text?: string;
  timeout?: number;
  questions?: { id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; options?: { label: string; description?: string }[] }[];
}
export interface UpdateStatus {
  phase: "idle" | "portable" | "checking" | "current" | "downloading" | "downloaded" | "error";
  version: string;
  latest: string;
  percent: number;
  checkedAt: number;
  message: string;
}
declare global {
  interface Window {
    lumen: {
      invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>;
      onSession: (callback: (event: SessionEvent) => void) => () => void;
      onUpdate: (callback: (status: UpdateStatus) => void) => () => void;
      onAccounts: (callback: (event: { type: string; id?: string; data?: string; code?: number; offset?: number }) => void) => () => void;
      onOpenPaths: (callback: () => void) => () => void;
      onClosing: (callback: () => Promise<void>) => () => void;
    };
  }
}
export const api = <T = any>(channel: string, ...args: any[]) =>
  window.lumen.invoke<T>(channel, ...args);
