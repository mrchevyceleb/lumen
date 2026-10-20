export type Agent = "shell" | "pi" | "codex" | "claude" | "grok" | "google";
export type Mode = "rich" | "native";
export interface ImageAttachment { id: string; name: string; mimeType: string; bytes: number; preview: string }
export type BrowserViewMode = { mode: "desktop" } | { mode: "mobile"; device: string; orientation: "portrait" | "landscape" };
export interface BrowserTab { id: string; title: string; url: string; error: string; loading: boolean; unloaded?: boolean; canGoBack: boolean; canGoForward: boolean; view?: BrowserViewMode }
export interface BrowserState { scope: string; activeId: string; tabs: BrowserTab[]; error?: string }
export interface BrowserSnapshot { active: BrowserState; states: BrowserState[] }
export interface BrowserPage { url: string; title: string; text: string; console: { level: string; message: string }[] }
export interface BrowserMark { label: string; x: number; y: number; color: string }
export interface AdministratorStatus { supported: boolean; elevated: boolean | null; error: string }
export interface AccountProfile { id: string; agent: "claude" | "codex"; name: string; signedIn: boolean; email: string; signingIn: boolean; inUse: boolean }
export interface SignInProfile { id: string; agent: Exclude<Agent, "shell">; name: string }
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
  sourceKey?: string;
  models: ModelOption[]; currentModel: string; currentEffort: string; currentMode?: string;
  currentEfforts?: EffortOption[]; favorites?: string[];
  shortcuts?: Record<string, string[]>;
  warning?: string;
}
export interface GitFile {
  path: string;
  code: string;
  staged: boolean;
  unstaged: boolean;
  conflict?: boolean;
  untracked?: boolean;
  original?: string;
}
export interface GitWorktree {
  path: string;
  branch: string;
  detached?: boolean;
  primary?: boolean;
  current?: boolean;
}
export interface GitState {
  available: boolean;
  error?: string;
  root?: string;
  branch: string;
  detached?: boolean;
  files: GitFile[];
  truncated?: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
  remote?: string;
  worktrees: GitWorktree[];
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
export interface AttachmentImport { images: ImageAttachment[]; references: string[] }
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "error" | "notice";
  text: string;
  title?: string;
  state?: string;
  turn?: string;
  time?: number;
  delivery?: "steer" | "send";
  deliveryState?: "sending" | "confirmed" | "uncertain";
  attachments?: ImageAttachment[];
}
export interface QueuedMessage { id: string; text: string; attachments?: ImageAttachment[]; deliveryUncertain?: boolean; dispatchReady?: boolean; state: "queued" | "sending" | "steering" }
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
  nameCustom?: boolean;
  archived?: boolean;
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
  managedBy?: string;
  draftAttachments?: ImageAttachment[];
  browserOpen?: boolean;
  terminalReady?: boolean;
  terminalOpen?: boolean;
  terminalId?: string;
  toolTerminals?: { id: string; title: string }[];
  nativeOwned?: boolean;
  stopping?: boolean;
  forceStopAvailable?: boolean;
  interrupted?: boolean;
  recoveryError?: string;
  command?: string;
}
export interface AgentControlRequest { requestId: string; action: string; id: string; body: Record<string, any> }
export interface AgentControlStatus { enabled: boolean; running: boolean; ready: boolean; url: string; connectionFile: string; guideFile: string; command: string; error: string }
export interface McpConnection {
  name: string; source: string; status: string; enabled: boolean; tools: number | null; canToggle: boolean;
  canReconnect?: boolean; error?: string; authUrl?: string;
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
  modelName?: string;
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
  animationSpeed: number;
  motion: boolean;
  playful: boolean;
  coloredTabs: boolean;
  coloredAgents: boolean;
  compact: boolean;
  chatLayout: "vertical" | "horizontal";
  enterSend: boolean;
  restoreSessions: boolean;
  loadShellProfile: boolean;
  agents: Record<Agent, AgentConfig>;
}
export interface SessionEvent {
  catalog?: ModelCatalog;
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
  deliveryState?: "sending" | "confirmed" | "uncertain";
  delivery?: "steer" | "send";
  attachments?: ImageAttachment[];
  terminalId?: string;
  offset?: number;
  nativeDraft?: string;
  mode?: Mode;
  nativeOwned?: boolean;
  stopping?: boolean;
  forceStopAvailable?: boolean;
  messages?: Message[];
}
export interface PiRequest {
  id: string;
  method: string;
  lines?: string[];
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  text?: string;
  timeout?: number;
  questions?: { id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; options?: { label: string; description?: string }[] }[];
  schema?: { properties?: Record<string, any>; required?: string[] };
  url?: string;
  widgetKey?: string;
  widgetLines?: string[];
  statusKey?: string;
  statusText?: string;
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
      filePath: (file: File) => string;
      invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>;
      onSession: (callback: (event: SessionEvent) => void) => () => void;
      hideBrowserNow: () => boolean;
      switchBrowserNow: (chatId: string, workspace: string, box: { x: number; y: number; width: number; height: number } | null, paint: boolean) => boolean;
      onBrowser: (callback: (state: BrowserState) => void) => () => void;
      onBrowserCommand: (callback: (command: string) => void) => () => void;
      onAgentControl: (callback: (event: AgentControlRequest) => void) => () => void;
      onAgentControlStatus: (callback: (status: AgentControlStatus) => void) => () => void;
      onUpdate: (callback: (status: UpdateStatus) => void) => () => void;
      onAccounts: (callback: (event: { type: string; id?: string; data?: string; text?: string; code?: number; offset?: number }) => void) => () => void;
      onOpenPaths: (callback: () => void) => () => void;
      onClosing: (callback: () => Promise<void>) => () => void;
    };
  }
}
export const api = <T = any>(channel: string, ...args: any[]) =>
  window.lumen.invoke<T>(channel, ...args);
