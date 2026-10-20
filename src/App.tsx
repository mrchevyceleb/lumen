import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  FolderOpen,
  Files,
  GitBranch,
  Settings2,
  Plus,
  ChevronDown,
  X,
  Minus,
  Square,
  Search,
  PanelRightClose,
  PanelRightOpen,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  GitCommitHorizontal,
  GitPullRequest,
  ExternalLink,
  FilePlus2,
  Command,
  ArrowRight,
  Check,
  Layers,
  TerminalSquare,
  MoreHorizontal,
  Sparkles,
  Circle,
  Download,
  ListTree,
  PanelTop,
  ShieldCheck,
  Globe,
} from "lucide-react";
import {
  api,
  type Agent,
  type Workspace,
  type Tab,
  type Settings,
  type Doc,
  type GitFile,
  type PiRequest,
  type SessionEvent,
  type Entry,
  type AccountProfile,
  type SignInProfile,
  type AdministratorStatus,
  type ImageAttachment,
  type AttachmentImport,
  type BrowserMark,
  type BrowserPage,
} from "./types";
import { defaults, loadSettings, styleVars, agentNames } from "./settings";
import { Modal, IconButton, FileTree, FileIcon, Busy } from "./Components";
import SettingsPanel from "./SettingsPanel";
import Conversation, { AgentMark } from "./Conversation";
import NativeTerminal from "./NativeTerminal";
import AgentForm from "./AgentForm";
import ProjectSidebar, { normalizeProjects, restoreProjects, sameProject, type Project } from "./ProjectSidebar";
import { useUpdates } from "./UpdatesPanel";
import { AccountLogin, AccountPicker, useAccounts } from "./AccountsPanel";
import ContextIndicator from "./ContextIndicator";
import SessionTabs from "./SessionTabs";
import BrowserPane from "./BrowserPane";
import PiCustomControl from "./PiCustomControl";
import SessionStart from "./SessionStart";
import { useAgentControl, taskView, settleControl } from "./useAgentControl";
const EditorPane = lazy(() => import("./EditorPane"));
const agents: Agent[] = ["shell", "pi", "codex", "claude", "grok", "google"];
const docKey = (doc: { root: string; path: string }) =>
  `${doc.root}|${doc.path}`;
const foldPathCase = typeof process !== "undefined" && process.platform
  ? process.platform === "win32"
  : typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
const normalizePath = (value: string) => {
  let key = value.replace(/[\\/]+/g, "/");
  const root = key === "/" || /^[a-zA-Z]:\/$/.test(key);
  if (!root) key = key.replace(/\/+$/, "");
  return foldPathCase ? key.toLowerCase() : key;
};
const samePath = (a?: string, b?: string) => !!a && !!b && normalizePath(a) === normalizePath(b);
const insideFolder = (folder: string, parent: string) => {
  const target = normalizePath(folder);
  const base = normalizePath(parent);
  if (!target || !base) return false;
  if (target === base) return true;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix);
};
const gitRootOf = (item?: Workspace) => item?.git.root || item?.root || "";
function matchingWorktree(trees: Workspace["git"]["worktrees"], folder: string) {
  const target = normalizePath(folder);
  return trees.reduce<Workspace["git"]["worktrees"][number] | undefined>((best, tree) => {
    const candidate = normalizePath(tree.path);
    const prefix = candidate.endsWith("/") ? candidate : `${candidate}/`;
    const hit = !!candidate && (target === candidate || target.startsWith(prefix));
    if (!hit) return best;
    if (!best || candidate.length > normalizePath(best.path).length) return tree;
    return best;
  }, undefined);
}
type Bootstrap = {
  recent: string[];
  platform: string;
  agents: Record<string, { available: boolean; file?: string }>;
  administrator: AdministratorStatus;
};
type Dialog =
  "settings" | "worktrees" | "palette" | "open" | "newfile" | "tab" | null;
export default function App() {
  const updateStatus = useUpdates();
  const { accounts } = useAccounts();
  const [settings, setSettings] = useState<Settings>(structuredClone(defaults));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [boot, setBoot] = useState<Bootstrap>({
    recent: [],
    platform: "win32",
    agents: {},
    administrator: { supported: false, elevated: null, error: "" },
  });
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>(restoreProjects);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [showArchived, setShowArchived] = useState(() => { try { return localStorage.getItem("lumen.showArchived") === "1"; } catch { return false; } });
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  useEffect(() => { try { localStorage.setItem("lumen.showArchived", showArchived ? "1" : "0"); } catch { /* Storage can be unavailable in private contexts. */ } }, [showArchived]);
  const isHiddenProject = (folder: string) => projectsRef.current.some((p) => p.hidden && sameProject(p.root, folder));
  const rememberProject = (folder: string, name?: string, show = false) => {
    if (!folder) return;
    setProjects((old) => old.some((p) => sameProject(p.root, folder)) ? show ? old.map((p) => sameProject(p.root, folder) ? { ...p, hidden: false, collapsed: false } : p) : old : [...old, { root: folder, name: name || folder.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || folder }]);
  };
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [selectedRoot, setSelectedRoot] = useState("");
  const [startingProjectless, setStartingProjectless] = useState(false);
  const pendingCwds = useRef<Record<string, string>>({});
  const pendingStarts = useRef(new Set<string>());
  const [startingAgents, setStartingAgents] = useState<Record<string, Agent | undefined>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const contextBar = useRef<HTMLDivElement>(null);
  const [nativeTop, setNativeTop] = useState(76);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    setTabs((old) => {
      let changed = false;
      const next = old.map((tab) => {
        const profile = accounts.profiles.find((p) => p.id === tab.accountId);
        if (!profile || profile.name === tab.accountName) return tab;
        changed = true; return { ...tab, accountName: profile.name };
      });
      return changed ? next : old;
    });
  }, [accounts]);
  const projectTabsRef = useRef<Record<string, string>>({});
  const MIN_PANEL = 48;
  // A conversation needs real room to be readable; panels wrap and shrink instead of eating it.
  const MIN_MAIN = 340;
  const RAIL_WIDTH = 44;
  const [panelPreferences] = useState(() => { try { return JSON.parse(localStorage.getItem("lumen.panels") || "{}") || {}; } catch { return {}; } });
  const [panel, setPanel] = useState<"files" | "git">(panelPreferences.panel === "git" ? "git" : "files");
  const [sidebar, setSidebar] = useState(panelPreferences.projects !== false);
  const [explorer, setExplorer] = useState(panelPreferences.workspace === true);
  const [browserWidth, setBrowserWidth] = useState(Number.isFinite(panelPreferences.browserWidth) ? Math.max(MIN_PANEL, panelPreferences.browserWidth) : 500);
  const browserOpen = !!tabs.find((tab) => tab.id === activeId)?.browserOpen;
  const projectsToggle = useRef<HTMLButtonElement>(null);
  const explorerToggle = useRef<HTMLButtonElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(Number.isFinite(panelPreferences.projectsWidth) ? Math.max(MIN_PANEL, panelPreferences.projectsWidth) : 250);
  const [explorerWidth, setExplorerWidth] = useState(Number.isFinite(panelPreferences.workspaceWidth) ? Math.max(MIN_PANEL, panelPreferences.workspaceWidth) : 270);
  const [split, setSplit] = useState(Number.isFinite(panelPreferences.split) ? Math.min(98, Math.max(2, panelPreferences.split)) : 50);
  const [terminalHeight, setTerminalHeight] = useState(Number.isFinite(panelPreferences.terminalHeight) ? Math.max(60, panelPreferences.terminalHeight) : 280);
  const [resizing, setResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeTargetRef = useRef<HTMLElement | null>(null);
  const explorerPinned = useRef(false);
  // Responsive hiding is a view concern, not a preference: it must never be written to disk or it
  // comes back after a restart with the user's explorer silently turned off.
  const [explorerHidden, setExplorerHidden] = useState(false);
  const [mainElement, setMainElement] = useState<HTMLElement | null>(null);
  const [mainHeight, setMainHeight] = useState(() => Math.max(120, window.innerHeight - 52));
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const measure = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      resizeCleanupRef.current?.();
    };
  }, []);
  useEffect(() => {
    if (resizing && !resizeTargetRef.current?.isConnected) {
      resizeCleanupRef.current?.();
    }
  });
  useLayoutEffect(() => {
    if (!mainElement) return;
    const measure = () => setMainHeight(mainElement.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(mainElement);
    measure();
    return () => observer.disconnect();
  }, [mainElement]);
  const maxTerminalHeight = Math.max(60, mainHeight - nativeTop - 60);
  useEffect(() => {
    if (terminalHeight > maxTerminalHeight) setTerminalHeight(maxTerminalHeight);
  }, [maxTerminalHeight, terminalHeight]);
  const visibleExplorer = explorer && !explorerHidden;
  const visibleSidebar = sidebar;
  const panelWidthsRef = useRef({ sidebar: sidebarWidth, explorer: explorerWidth, browser: browserWidth, sidebarOpen: visibleSidebar, explorerOpen: visibleExplorer, browserOpen });
  panelWidthsRef.current = { sidebar: sidebarWidth, explorer: explorerWidth, browser: browserWidth, sidebarOpen: visibleSidebar, explorerOpen: visibleExplorer, browserOpen };
  useEffect(() => {
    const openKeys: Array<"sidebar" | "browser" | "explorer"> = [];
    if (visibleSidebar) openKeys.push("sidebar");
    if (browserOpen) openKeys.push("browser");
    if (visibleExplorer) openKeys.push("explorer");
    if (!openKeys.length) return;
    const maxTotal = Math.max(MIN_PANEL, viewportWidth - RAIL_WIDTH - MIN_MAIN);
    const current = panelWidthsRef.current;
    const activeTotal = openKeys.reduce((sum, key) => sum + current[key], 0);
    if (activeTotal <= maxTotal) return;
    const minEach = Math.min(MIN_PANEL, Math.floor(maxTotal / openKeys.length));
    const distributable = Math.max(0, maxTotal - openKeys.length * minEach);
    const currentExtra = openKeys.reduce((sum, key) => sum + Math.max(0, current[key] - minEach), 0);
    let allocated = 0;
    const nextWidths: Partial<Record<"sidebar" | "browser" | "explorer", number>> = {};
    openKeys.forEach((key, index) => {
      if (index === openKeys.length - 1) {
        nextWidths[key] = Math.max(minEach, maxTotal - allocated);
      } else {
        const extra = currentExtra > 0 ? Math.floor((Math.max(0, current[key] - minEach) / currentExtra) * distributable) : 0;
        const w = minEach + extra;
        nextWidths[key] = w;
        allocated += w;
      }
    });
    if (nextWidths.sidebar !== undefined && nextWidths.sidebar !== current.sidebar) {
      panelWidthsRef.current.sidebar = nextWidths.sidebar;
      setSidebarWidth(nextWidths.sidebar);
    }
    if (nextWidths.browser !== undefined && nextWidths.browser !== current.browser) {
      panelWidthsRef.current.browser = nextWidths.browser;
      setBrowserWidth(nextWidths.browser);
    }
    if (nextWidths.explorer !== undefined && nextWidths.explorer !== current.explorer) {
      panelWidthsRef.current.explorer = nextWidths.explorer;
      setExplorerWidth(nextWidths.explorer);
    }
  }, [viewportWidth, visibleSidebar, browserOpen, visibleExplorer]);
  // Three panes beside a usable conversation do not fit on a small window, and squeezing all of
  // them to slivers is what made a 900px window feel broken. The file explorer is the least
  // essential of the three: hide it (only when we are the ones hiding it) and bring it back when
  // the browser closes or the window has room again.
  useEffect(() => {
    if (!visibleExplorer || explorerPinned.current) return;
    const room = viewportWidth - RAIL_WIDTH - MIN_MAIN - (visibleSidebar ? sidebarWidth : 0) - (browserOpen ? browserWidth : 0);
    if (room < 0) setExplorerHidden(true);
  }, [browserOpen, viewportWidth, visibleExplorer, visibleSidebar, sidebarWidth, browserWidth]);
  useEffect(() => {
    if (!explorerHidden) return;
    if (browserOpen && viewportWidth < 1180) return;
    setExplorerHidden(false); explorerPinned.current = false;
  }, [browserOpen, viewportWidth, explorerHidden]);
  const verticalChats = settings.chatLayout === "vertical" && visibleSidebar;
  useLayoutEffect(() => {
    const element = contextBar.current;
    if (!element) return;
    const measure = () => setNativeTop(element.offsetTop + element.offsetHeight);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [activeId, verticalChats]);
  useEffect(() => {
    try { localStorage.setItem("lumen.panels", JSON.stringify({ projects: sidebar, workspace: explorer, panel, projectsWidth: sidebarWidth, workspaceWidth: explorerWidth, browserWidth, split, terminalHeight })); } catch {}
  }, [sidebar, explorer, panel, sidebarWidth, explorerWidth, browserWidth, split, terminalHeight]);
  const hideProjects = () => { setSidebar(false); projectsToggle.current?.focus(); };
  const hideExplorer = () => { explorerPinned.current = false; setExplorer(false); explorerToggle.current?.focus(); };
  // Every manual open goes through here so the responsive auto-hide can never swallow it.
  const showExplorer = () => { explorerPinned.current = true; setExplorer(true); setExplorerHidden(false); };
  const toggleExplorer = (next: boolean) => { if (next) showExplorer(); else hideExplorer(); };
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeDocKey, setActiveDocKey] = useState("");
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [worktreeFocus, setWorktreeFocus] = useState("");
  const [signIn, setSignIn] = useState<SignInProfile | null>(null);
  const signInLock = useRef(false);
  const [settingsSection, setSettingsSection] = useState("appearance");
  const [agentMenu, setAgentMenu] = useState(false);
  const [agentMenuRoot, setAgentMenuRoot] = useState<string | undefined>();
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const agentMenuAnchorRef = useRef<HTMLDivElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const agentMenuTrigger = useRef<HTMLElement | null>(null);
  const [agentMenuPos, setAgentMenuPos] = useState<{ top: number; right: number } | null>(null);
  // Position from the anchor's real rect AFTER mount (a render-time read is stale by a layout pass),
  // and keep it correct on resize. The menu itself is portaled to <body> so no ancestor stacking
  // context can trap it under the chat column.
  useLayoutEffect(() => {
    if (!agentMenu) { setAgentMenuPos(null); return; }
    const place = () => {
      const r = agentMenuAnchorRef.current?.getBoundingClientRect();
      if (r) setAgentMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [agentMenu, agentMenuRoot, verticalChats]);
  useEffect(() => {
    if (!agentMenu) return;
    if (!agentMenuRef.current?.contains(document.activeElement)) agentMenuTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    agentMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [agentMenu, agentMenuRoot, verticalChats]);
  useEffect(() => {
    if (!agentMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!agentMenuRef.current?.contains(target) && !(target instanceof Element && target.closest(".agent-menu-anchor"))) {
        setAgentMenu(false);
        setAgentMenuRoot(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAgentMenu(false);
      setAgentMenuRoot(undefined);
      if (agentMenuTrigger.current?.isConnected) agentMenuTrigger.current.focus();
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [agentMenu]);
  const [notice, setNotice] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [attachment, setAttachment] = useState("");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    action: () => void;
  } | null>(null);
  const [uiRequests, setUiRequests] = useState<{
    session: string;
    request: PiRequest;
  }[]>([]);
  const uiRequestsRef = useRef(uiRequests);
  uiRequestsRef.current = uiRequests;
  const piRequest = uiRequests[0];
  const [diff, setDiff] = useState<{
    path: string;
    text: string;
    staged: boolean;
  } | null>(null);
  const [spark, setSpark] = useState<{ x: number; y: number; dx: number; dy: number; glyph: string; color: string; id: string }[]>(
    [],
  );
  const active = tabs.find((t) => t.id === activeId);
  const browserOpenRef = useRef<Record<string, boolean>>({});
  const setBrowserOpen = (open: boolean | ((value: boolean) => boolean)) => {
    const chat = tabsRef.current.find((tab) => tab.id === activeIdRef.current);
    if (!chat) { notify("Open a chat first, then its browser stays with that chat."); return; }
    const key = chat.controlId || chat.id;
    const current = browserOpenRef.current[key] ?? chat.browserOpen === true;
    const next = typeof open === "function" ? open(current) : open;
    if (next === current) return;
    browserOpenRef.current[key] = next;
    setTabs((old) => old.map((tab) => tab.id === chat.id ? { ...tab, browserOpen: next } : tab));
    void updateTab(chat.id, { browserOpen: next });
  };
  if (active && !active.projectless) projectTabsRef.current[active.root] = active.id;
  const root = active?.projectless ? "" : active?.root || selectedRoot;
  const rootRef = useRef(root);
  rootRef.current = root;
  const workspace = workspaces[root];
  const checkoutPath = active?.cwd && active.cwd !== active.root ? active.cwd : active?.projectless ? "" : root;
  const statusWorkspace = (() => {
    if (!checkoutPath) return undefined;
    if (workspaces[checkoutPath]) return workspaces[checkoutPath];
    let best: Workspace | undefined;
    let bestLength = -1;
    for (const item of Object.values(workspaces)) {
      const candidate = gitRootOf(item) || item.root;
      if (!insideFolder(checkoutPath, candidate)) continue;
      const length = normalizePath(candidate).length;
      if (length > bestLength) { best = item; bestLength = length; }
    }
    return best;
  })();
  const checkout = statusWorkspace?.git.worktrees.find((tree) => tree.current) || matchingWorktree(statusWorkspace?.git.worktrees || [], statusWorkspace?.git.root || checkoutPath);
  const linkedCheckout = checkout?.primary === false;
  const checkoutName = (checkout?.path || checkoutPath).replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  const checkoutInsideProject = !!(workspace && checkoutPath && insideFolder(checkoutPath, gitRootOf(workspace) || workspace.root));
  const scmRepos = (() => {
    const entries: { workspace: Workspace; current: boolean }[] = [];
    const seen = new Set<string>();
    const add = (item: Workspace | undefined, current: boolean) => {
      if (!item?.git.available) return;
      const key = normalizePath(gitRootOf(item));
      if (!key || seen.has(key)) return;
      seen.add(key);
      entries.push({ workspace: item, current });
    };
    add(statusWorkspace, true);
    if (!statusWorkspace?.git.available && (checkoutInsideProject || !checkoutPath || samePath(checkoutPath, workspace?.root))) add(workspace, true);
    add(workspace, false);
    return entries;
  })();
  const currentRepo = scmRepos.find((entry) => entry.current)?.workspace || workspace;
  const worktreeTarget = useRef("");
  worktreeTarget.current = currentRepo?.root || root;
  const editorRoots = [root, ...scmRepos.flatMap((entry) => [entry.workspace.root, entry.workspace.git.root || ""])].filter(Boolean);
  const editorDocs = docs.filter((doc) => editorRoots.some((folder) => samePath(folder, doc.root)));
  useEffect(() => {
    if (!active?.cwd || active.cwd === active.root) return;
    let alive = true;
    api<Workspace>("workspace:inspect", active.cwd).then((value) => {
      if (alive) setWorkspaces((old) => ({ ...old, [value.root]: value, [active.cwd!]: value }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [active?.id, active?.cwd]);
  const projectDocsRef = useRef<Record<string, string>>({});
  const activeDoc = editorDocs.find((doc) => docKey(doc) === activeDocKey) || (root ? editorDocs.find((doc) => samePath(doc.root, root) && docKey(doc) === projectDocsRef.current[root]) : undefined);
  if (activeDoc && root && samePath(activeDoc.root, root)) projectDocsRef.current[root] = docKey(activeDoc);
  useEffect(() => setAttachment(""), [activeId]);
  useEffect(() => {
    api("editor:dirty", docs.filter((d) => d.content !== d.saved).length).catch(
      () => {},
    );
  }, [docs]);
  const notify = useCallback((text: string) => {
    setNotice(text);
  }, []);
  const openWeb = (url: string) => {
    const chat = tabsRef.current.find((tab) => tab.id === activeIdRef.current);
    if (!chat) { notify("Open a chat before opening its browser."); return; }
    const chatId = chat.controlId || chat.id;
    const workspace = chat.cwd && chat.cwd !== chat.root ? chat.cwd : chat.projectless ? "" : chat.root;
    setBrowserOpen(true);
    void api("browser:action", { action: "open", url, chatId, workspace }).catch((error) => notify(error.message));
  };
  const updateTab = (id: string, change: Partial<Tab>) => {
    const tab = tabsRef.current.find((value) => value.id === id);
    setTabs((old) => old.map((value) => value.id === id ? { ...value, ...change } : value));
    return tab?.controlId ? api("recovery:update", tab.controlId, change).catch((error) => notify("Draft recovery could not be saved: " + error.message)) : Promise.resolve();
  };
  const attachBrowser = async (id: string, marks?: BrowserMark[], captureToken?: string) => {
    const chatId = activeIdRef.current;
    const chat = tabsRef.current.find((tab) => tab.id === chatId);
    if (!chat || chat.agent === "shell" || chat.mode !== "rich") throw new Error("Select a readable agent chat to attach this page.");
    if ((chat.draftAttachments?.length || 0) >= 8) throw new Error("Attach up to eight images.");
    if (marks && ((marks.length < 1) || (marks.length > 10))) throw new Error("Mark up to ten things on the screenshot, or skip markup.");
    const result = await api<{ attachment: ImageAttachment; page: BrowserPage }>("browser:attach", id, chatId, marks, captureToken);
    const latest = tabsRef.current.find((tab) => tab.id === chatId);
    if (!latest) throw new Error("The chat was closed while capturing the page.");
    if ((latest.draftAttachments?.length || 0) >= 8) throw new Error("Attach up to eight images.");
    const context = `Browser page: ${result.page.title}\nURL: ${result.page.url}\n\n${result.page.text.slice(0, 4000)}`;
    setTabs((old) => old.map((tab) => tab.id === chatId && (tab.draftAttachments?.length || 0) < 8
      ? { ...tab, draftAttachments: [...(tab.draftAttachments || []), result.attachment], draft: [tab.draft, context].filter(Boolean).join("\n\n") } : tab));
    await settleControl();
    if (!tabsRef.current.find((tab) => tab.id === chatId)?.draftAttachments?.some((image) => image.id === result.attachment.id))
      throw new Error("The chat changed or reached its eight-image limit while capturing.");
    await persist();
    notify("Page screenshot and context added to your chat draft");
  };
  const signInChat = async (id: string) => {
    if (signInLock.current || signIn) return;
    signInLock.current = true;
    try { setSignIn(await api<SignInProfile>("accounts:login-session", id)); }
    catch (e: any) { notify(e.message); }
    finally { signInLock.current = false; }
  };
  const persist = async () => {
    await api("recovery:save", { tabs: tabsRef.current, root: rootRef.current, active: activeIdRef.current, projects: projectsRef.current });
  };
  useEffect(
    () =>
      window.lumen.onClosing(async () => {
        await Promise.race([
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
        await persist();
        await api("settings:save", settingsRef.current);
      }),
    [],
  );
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 7000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const addTab = async (
    agent: Agent,
    mode: "rich" | "native" = "rich",
    folder = root,
    resume?: Partial<Tab>,
    startCwd?: string,
    accountId?: string,
    scratchId?: string,
    control?: Partial<Tab>,
  ) => {
    const config = settingsRef.current.agents[agent];
    const selection = { root: rootRef.current, id: activeIdRef.current };
    try {
      const request = {
        root: folder,
        cwd: startCwd ?? (resume ? undefined : pendingCwds.current[folder]),
        agent,
        mode,
        ...config,
        command: resume?.command || config.command,
        model: resume?.model ?? control?.model ?? config.model,
        effort: resume?.effort ?? control?.effort ?? config.effort ?? "",
        workMode: resume?.workMode || control?.workMode || "",
        sessionRef: resume?.sessionRef || "",
        scratchId: resume?.scratchId || scratchId || "",
        controlId: resume?.controlId || control?.controlId || "",
        autoCompactTokens: resume?.autoCompactTokens ?? null,
        mcpOverrides: resume?.mcpOverrides || {},
        accountId: resume ? resume.accountId || "" : accountId,
        queuedMessages: resume?.queuedMessages || [],
        loadShellProfile: settingsRef.current.loadShellProfile,
        shellCommand: settingsRef.current.agents.shell.command,
        savedTab: resume || {},
      };
      let created: { id: string; root: string; cwd: string; projectless: boolean; scratchId: string; controlId: string; accountId: string; accountName: string; contextTokens?: number | null; contextWindow?: number | null };
      created = await api("session:create", request);
      delete pendingCwds.current[folder];
      const tab: Tab = {
        id: created.id,
        root: created.root,
        cwd: created.cwd,
        projectless: created.projectless,
        scratchId: created.scratchId,
        agent,
        mode,
        name: resume?.name || control?.name || agentNames[agent],
        nameCustom: resume?.nameCustom === true,
        managedBy: resume?.managedBy || control?.managedBy,
        accountId: created.accountId,
        accountName: created.accountName,
        color: resume?.color,
        messages: resume?.messages || [],
        draft: resume?.draft || "",
        draftAttachments: resume?.draftAttachments || [],
        nativeDraft: resume?.nativeDraft,
        interrupted: resume?.interrupted,
        command: request.command,
        busy: false,
        sessionRef: resume?.sessionRef,
        model: request.model,
        effort: request.effort,
        workMode: request.workMode,
        controlId: created.controlId,
        autoCompactTokens: resume?.autoCompactTokens ?? null,
        mcpOverrides: resume?.mcpOverrides || {},
        contextTokens: created.contextTokens ?? resume?.contextTokens ?? null,
        contextWindow: created.contextWindow ?? resume?.contextWindow ?? null,
        contextStale: (created.contextTokens ?? resume?.contextTokens) != null,
        queuedMessages: resume?.queuedMessages?.map((m) => ({ ...m, state: "queued" })) || [],
        queuePaused: !!resume?.queuedMessages?.length,
        archived: resume?.archived === true,
        browserOpen: resume?.browserOpen === true,
      };
      browserOpenRef.current[created.controlId] = tab.browserOpen === true;
      setTabs((old) => [...old.filter((value) => value.controlId !== tab.controlId), tab]);
      const selectionUnchanged = rootRef.current === selection.root && activeIdRef.current === selection.id;
      const canFocusArchived = showArchivedRef.current || resume?.archived !== true;
      const canFocusProject = created.projectless || showArchivedRef.current || !isHiddenProject(created.root);
      if ((resume || control || selectionUnchanged) && (!control || !activeIdRef.current) && (!resume || (canFocusArchived && canFocusProject))) {
        setActiveId(tab.id);
        setSelectedRoot(folder);
        setStartingProjectless(false);
      }
      if (!created.projectless) rememberProject(created.root, undefined, !resume && !isHiddenProject(created.root));
      if (selectionUnchanged) {
        setAgentMenu(false);
        setAgentMenuRoot(undefined);
      }
      if (resume && agent !== "shell" && mode === "rich") void api("session:reconnect", tab.id).catch((error) => {
        setTabs((old) => old.map((value) => value.id === tab.id ? { ...value, recoveryError: error.message } : value));
      });
      return tab;
    } catch (e: any) {
      if (control) throw e;
      if (resume?.controlId && resume.agent) {
        const retained = { ...resume, id: resume.controlId, mode: "rich", busy: false, recoveryError: e.message, messages: resume.messages || [], name: resume.name || agentNames[resume.agent] } as Tab;
        setTabs((old) => [...old.filter((value) => value.controlId !== retained.controlId), retained]);
        setActiveId(retained.id);
        return retained;
      }
      notify(e.message);
    }
  };
  const startSession = async (agent: Agent) => {
    const folder = root;
    if (pendingStarts.current.has(folder)) return;
    pendingStarts.current.add(folder);
    setStartingAgents((old) => ({ ...old, [folder]: agent }));
    try { await addTab(agent, "rich", folder); }
    finally {
      pendingStarts.current.delete(folder);
      setStartingAgents((old) => { const next = { ...old }; delete next[folder]; return next; });
    }
  };
  const activateWorkspace = (next: Workspace, cwd = next.root, reveal = true) => {
    setWorkspaces((old) => ({ ...old, [next.root]: next }));
    setSelectedRoot(next.root);
    setStartingProjectless(false);
    rememberProject(next.root, next.name, reveal);
    setDialog(null);
    setAgentMenu(false);
    setAgentMenuRoot(undefined);
    const existing = tabsRef.current.find((t) => t.id === projectTabsRef.current[next.root]) || tabsRef.current.find((t) => !t.projectless && sameProject(t.root, next.root));
    setActiveId(existing?.id || "");
    if (!existing) pendingCwds.current[next.root] = cwd;
    setBoot((old) => ({ ...old, recent: [next.root, ...old.recent.filter((x) => x !== next.root)] }));
  };
  const startWithoutWorkspace = () => {
    setActiveId("");
    setSelectedRoot("");
    setStartingProjectless(true);
    setAgentMenu(false);
    setAgentMenuRoot(undefined);
  };
  const openWorkspace = async (folder?: string, reveal = true) => {
    try {
      const next = await api<Workspace | null>(
        folder ? "workspace:open" : "workspace:choose",
        ...(folder ? [folder] : []),
      );
      if (!next) return;
      activateWorkspace(next, next.root, reveal);
      return next;
    } catch (e: any) {
      notify(e.message);
    }
  };
  const archiveProject = (project: Project) => {
    const remaining = projectsRef.current.filter((p) => !p.hidden && !sameProject(p.root, project.root));
    setProjects((old) => old.map((p) => sameProject(p.root, project.root) ? { ...p, hidden: true } : p));
    if (sameProject(rootRef.current, project.root)) {
      const next = remaining.find((p) => p.pinned) || remaining[0];
      const existing = next ? tabsRef.current.find((t) => t.id === projectTabsRef.current[next.root]) || tabsRef.current.find((t) => !t.projectless && sameProject(t.root, next.root)) : tabsRef.current.find((t) => t.projectless);
      setActiveId(existing?.id || "");
      setSelectedRoot(existing && !existing.projectless ? existing.root : "");
      if (!existing && next) void openWorkspace(next.root);
    }
    notify(`${project.name} archived. Use Show archived in the sidebar to see it and its chats.`);
  };
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [info, saved] = await Promise.all([
          api<Bootstrap>("bootstrap"),
          api<Settings | null>("settings:load"),
        ]);
        if (!alive) return;
        setBoot(info);
        for (const folder of info.recent) rememberProject(folder);
        const current = loadSettings(saved);
        settingsRef.current = current;
        setSettings(current);
        let recovered = await api<{ tabs: Partial<Tab>[]; root: string; active: string; projects: Project[]; error: string }>("recovery:load");
        if (!recovered.tabs.length) {
          let legacy: Partial<Tab>[] = [];
          try { legacy = JSON.parse(localStorage.getItem("lumen.tabs") || "[]"); } catch {}
          if (legacy.length) {
            await api("recovery:save", { tabs: legacy.map((tab) => ({ ...tab, controlId: tab.controlId || tab.id })), root: localStorage.getItem("lumen.last") || "", active: localStorage.getItem("lumen.active") || "", projects: projectsRef.current });
            recovered = await api("recovery:load");
          }
        }
        if (recovered.error) notify(recovered.error);
        if (recovered.projects?.length) {
          const restoredProjects = normalizeProjects(recovered.projects);
          setProjects(restoredProjects);
          projectsRef.current = restoredProjects;
        }
        const persisted: Partial<Tab>[] = current.restoreSessions ? recovered.tabs : [];
        const last = current.restoreSessions ? recovered.root : "";
        const roots = [
          ...new Set(
            [last, ...persisted.filter((t) => !t.projectless).map((t) => t.root)].filter(Boolean) as string[],
          ),
        ];
        for (const folder of roots) rememberProject(folder);
        const opened: Record<string, Workspace> = {};
        for (const folder of roots) {
          try {
            opened[folder] = await api<Workspace>("workspace:register", folder);
          } catch {}
        }
        if (!alive) return;
        setWorkspaces(opened);
        const savedActive = recovered.active;
        let restoredActive = "";
        const restoring = persisted;
        const savedTab = persisted.find((t) => t.id === savedActive);
        if (savedTab && !restoring.includes(savedTab)) restoring.splice(0, 1, savedTab);
        for (const tab of restoring) {
          if (tab.agent) {
            const restored = await addTab(tab.agent, tab.mode || "rich", tab.projectless ? "" : tab.root, tab, tab.cwd);
            if (tab.id === savedActive && restored && (showArchivedRef.current || !restored.archived) && (tab.projectless || showArchivedRef.current || !isHiddenProject(restored.root))) restoredActive = restored.id;
          }
        }
        if (last && opened[last] && (showArchivedRef.current || !isHiddenProject(last))) {
          setSelectedRoot(last);
          if (!persisted.some((t) => t.root === last))
            setActiveId("");
        }
        if (restoredActive) setActiveId(restoredActive);
      } catch (e: any) {
        notify(e.message);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    let alive = true, draining = false, again = false;
    const drain = async () => {
      again = true;
      if (draining) return;
      draining = true;
      try {
        while (alive && again) {
          again = false;
          const paths = await api<string[]>("launch:take");
          for (const target of paths) {
            if (!alive) break;
            try {
              const opened = await api<{ workspace: Workspace; cwd: string; file: string }>("launch:resolve", target);
              const next = opened.workspace;
              activateWorkspace(next, opened.cwd);
              if (opened.file) {
                try {
                  const result = await api("files:read", next.root, opened.file);
                  const doc: Doc = { root: next.root, ...result, saved: result.content };
                  setDocs((old) => old.some((d) => docKey(d) === docKey(doc)) ? old : [...old, doc]);
                  setActiveDocKey(docKey(doc));
                } catch (error: any) { notify(`Workspace opened. ${error.message}`); }
              }
            } catch (error: any) { notify(error.message); }
          }
        }
      } catch (error: any) { notify(error.message); }
      finally { draining = false; }
    };
    const unsubscribe = window.lumen.onOpenPaths(() => { void drain(); });
    void drain();
    return () => { alive = false; unsubscribe(); };
  }, [loaded]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      api("settings:save", settings).catch((e) => notify(e.message));
    }, 300);
    return () => clearTimeout(timer);
  }, [settings, loaded]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void persist().catch((error) => notify("Session recovery could not be saved: " + error.message));
    }, 300);
    return () => clearTimeout(timer);
  }, [tabs, root, activeId, projects, loaded]);
  useEffect(() => {
    if (loaded) void persist().catch((error) => notify("Session recovery could not be saved: " + error.message));
  }, [root, activeId, projects, loaded]);
  const switchView = async () => {
    if (!active) return;
    try {
      const result = await api(
        "session:mode",
        active.id,
        active.mode === "rich" ? "native" : "rich",
      );
      setTabs((old) =>
        old.map((t) =>
          t.id === active.id
            ? {
                ...t,
                mode: result.mode,
                sessionRef: result.sessionRef,
                nativeOwned: result.nativeOwned,
                exited: false,
                contextStale: true,
              }
            : t,
        ),
      );
      if (result.pending) notify("Native controls will open when the current turn finishes.");
    } catch (e: any) {
      notify(e.message);
    }
  };
  const openNativeCommand = async (draft: string) => {
    if (!active) return;
    try {
      const result = await api("session:mode", active.id, "native");
      await updateTab(active.id, { nativeDraft: draft });
      setTabs((old) => old.map((t) => t.id === active.id ? { ...t, mode: result.mode, sessionRef: result.sessionRef, exited: false, contextStale: true, nativeDraft: draft } : t));
    } catch (e: any) { notify(e.message); }
  };
  const refreshGit = async (folder = root) => {
    if (!folder) return;
    try {
      const git = await api("git:status", folder);
      const key = normalizePath(folder);
      setWorkspaces((old) => Object.fromEntries(Object.entries(old).map(([id, value]) =>
        [id, normalizePath(value.root) === key || normalizePath(value.git?.root || "") === key ? { ...value, git } : value])));
      setRefresh((n) => n + 1);
    } catch (e: any) {
      notify(e.message);
    }
  };
  useEffect(() => {
    const folders = [...new Set([root, statusWorkspace?.root].filter(Boolean) as string[])];
    if (!folders.length) return;
    const focus = () => { for (const folder of folders) void refreshGit(folder); };
    focus();
    const timer = setInterval(focus, 15000);
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [root, statusWorkspace?.root, active?.busy, active?.cwdVersion]);
  useEffect(() => {
    let queue: SessionEvent[] = [];
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
      fallback = undefined;
      frame = 0;
      const events = queue;
      queue = [];
      setTabs((old) =>
        old.map((original) => {
          const changes = events.filter((e) => e.id === original.id);
          if (!changes.length) return original;
          const t = { ...original, messages: [...original.messages] };
          for (const e of changes) {
            if (e.type === "start") {
              t.busy = true;
              t.interrupted = false;
              t.phase = undefined;
              t.turn = e.turn;
              t.started = Date.now();
            } else if (e.type === "done") {
              t.busy = false;
              t.stopping = false;
              t.forceStopAvailable = false;
              t.interrupted = e.code === 130;
              t.phase = undefined;
              t.exitCode = e.code;
              t.duration = Date.now() - (t.started || Date.now());
              if (e.sessionRef) t.sessionRef = e.sessionRef;
            } else if (e.type === "stop-state") { t.stopping = e.stopping; t.forceStopAvailable = e.forceStopAvailable; }
            else if (e.type === "native-owner") t.nativeOwned = e.nativeOwned;
            else if (e.type === "terminal-ready") t.terminalReady = true;
            else if (e.type === "tool-terminal-release") { t.toolTerminals = t.toolTerminals?.filter((terminal) => terminal.id !== e.terminalId); if (t.terminalId === e.terminalId) t.terminalId = t.toolTerminals?.[0]?.id; }
            else if (e.type === "terminal-needed") {
              t.terminalOpen = true; t.terminalId = e.terminalId; t.terminalReady ||= !e.terminalId;
              if (e.nativeDraft) t.nativeDraft = e.nativeDraft;
              if (e.terminalId && !t.toolTerminals?.some((terminal) => terminal.id === e.terminalId)) t.toolTerminals = [...(t.toolTerminals || []), { id: e.terminalId, title: e.title || "Tool terminal" }];
            }
            else if (e.type === "view") { if (e.mode) t.mode = e.mode; if (e.sessionRef) t.sessionRef = e.sessionRef; }
            else if (e.type === "history") t.messages = e.messages || t.messages;
            else if (e.type === "reconnected") { t.recoveryError = undefined; t.exited = false; }
            else if (e.type === "phase") t.phase = e.phase;
            else if (e.type === "session") t.sessionRef = e.sessionRef;
            else if (e.type === "config") { t.model = e.model; t.effort = e.effort; t.workMode = e.workMode; }
            else if (e.type === "session-controls") { t.autoCompactTokens = e.autoCompactTokens; t.mcpOverrides = e.mcpOverrides; }
            else if (e.type === "context") { t.contextTokens = e.contextTokens; t.contextWindow = e.contextWindow; t.contextStale = false; }
            else if (e.type === "queue") { t.queuedMessages = e.queuedMessages; t.queuePaused = e.queuePaused; }
            else if (e.type === "user-message" && e.messageId && !t.messages.some((m) => m.id === e.messageId)) t.messages.push({ id: e.messageId, turn: t.turn, role: "user", text: e.text || "", attachments: e.attachments, delivery: e.delivery, deliveryState: e.deliveryState });
            else if (["message-delivered", "message-delivery-state"].includes(e.type)) t.messages = t.messages.map((message) => message.id === e.messageId ? { ...message, deliveryState: e.type === "message-delivered" ? "confirmed" : e.deliveryState } : message);
            else if (e.type === "user-message-retracted") t.messages = t.messages.filter((m) => m.id !== e.messageId);
            else if (e.type === "cwd") { t.cwd = e.cwd; t.cwdVersion = (t.cwdVersion || 0) + 1; }
            else if (e.type === "exit") t.exited = true;
            else if (["text", "tool", "error", "diagnostic"].includes(e.type)) {
              const id = `${t.turn || "init"}-${e.key || e.type}`;
              const index = t.messages.findIndex((m) => m.id === id);
              const previous = t.messages[index];
              const message = {
                id,
                turn: t.turn,
                role: (e.type === "text"
                  ? "assistant"
                  : e.type === "tool"
                    ? "tool"
                    : e.type === "error"
                      ? "error"
                      : "notice") as any,
                text:
                  e.type === "tool"
                    ? e.detail || previous?.text || ""
                    : e.type === "error"
                      ? e.message || ""
                      : e.replace
                        ? e.text || ""
                        : (previous?.text || "") + (e.text || ""),
                title:
                  e.title === "Tool result" && previous?.title
                    ? previous.title
                    : e.title,
                state: e.state,
              };
              if (index >= 0) t.messages[index] = message;
              else t.messages.push(message);
            }
          }
          return t;
        }),
      );
    };
    const unsub = window.lumen.onSession((e) => {
      if (e.type === "done" || e.type === "exit") setUiRequests((old) => old.filter((value) => value.session !== e.id));
      if (e.type === "agent_ui_cancel" && e.request) {
        setUiRequests((old) => old.filter((value) => value.session !== e.id || value.request.id !== e.request!.id));
        return;
      }
      if (["pi_ui", "agent_ui"].includes(e.type) && e.request) {
        const request = e.request;
        if (["select", "confirm", "input", "editor", "questions", "form", "native", "custom"].includes(request.method))
          setUiRequests((old) => [...old.filter((value) => value.session !== e.id || value.request.id !== request.id), { session: e.id, request }]);
        else if (request.method === "notify") notify(request.message || "Pi notification");
        else if (request.method === "set_editor_text") setTabs((old) => old.map((tab) => tab.id === e.id ? { ...tab, draft: request.text || "" } : tab));
        else if (request.method === "setTitle") setTabs((old) => old.map((tab) => tab.id === e.id && !tab.nameCustom ? { ...tab, name: request.title || tab.name } : tab));
        // Pi's footer status updates are routine, not popup notifications.
        else if (request.method === "setStatus") return;
        else if (request.method === "setWidget") {
          queue.push({ ...e, type: "diagnostic", key: `pi-widget-${request.widgetKey}`, text: request.widgetLines?.join("\n") || "", replace: true });
          if (!frame) { frame = requestAnimationFrame(flush); fallback = setTimeout(flush, 30); }
        }
        return;
      }
      if (e.type === "terminal") return;
      queue.push(e);
      if (!frame) {
        frame = requestAnimationFrame(flush);
        // Minimized/hidden windows may not paint; agent clients still need current state.
        fallback = setTimeout(flush, 30);
      }
    });
    return () => {
      unsub();
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, []);
  const addAttachments = async (source: "clipboard" | "choose" | string[]) => {
    if (!active || active.agent === "shell") return;
    const target = active.id;
    try {
      const imported = source === "clipboard" ? await api<AttachmentImport>("attachments:paste", target) : source === "choose" ? await api<AttachmentImport>("attachments:choose", target) : await api<AttachmentImport>("attachments:import", target, source);
      if (!imported.images.length && !imported.references.length) return;
      setTabs((old) => old.map((tab) => tab.id === target ? { ...tab,
        draftAttachments: [...(tab.draftAttachments || []), ...imported.images].slice(0, 8),
        draft: [tab.draft, ...imported.references.map((file) => `Video file: ${file}`)].filter(Boolean).join("\n\n"),
      } : tab));
      await settleControl();
      await persist();
    } catch (error: any) { notify(error.message); }
  };
  const send = async (text: string) => {
    if (!active) return false;
    const message = attachment ? `${text}\n\nFile reference: ${attachment}` : text;
    const images = active.draftAttachments || [];
    try {
      const entry = { id: crypto.randomUUID(), text: message, attachments: images };
      if (active.agent === "shell") await api("session:send", active.id, message, entry);
      else await api("session:submit", active.id, entry);
      const current = tabsRef.current.find((tab) => tab.id === active.id);
      await updateTab(active.id, { draftAttachments: (current?.draftAttachments || []).filter((image) => !images.some((sent) => sent.id === image.id)), ...(current?.draft === text ? { draft: "" } : {}) });
      if (activeIdRef.current === active.id) setAttachment("");
      return true;
    } catch (error: any) { notify(error.message); return false; }
  };
  const continueSession = async () => {
    if (!active) return;
    const text = "Continue from where you left off. First inspect the current state and completed actions; do not repeat completed work.";
    try { await api("session:send", active.id, text, { id: crypto.randomUUID(), text }); }
    catch (error: any) { notify(error.message); }
  };
  const closeTab = (tab: Tab) => {
    const action = () => {
      void api("session:close", tab.id).then(() => {
        delete browserOpenRef.current[tab.controlId || tab.id];
        setTabs((old) => {
          const next = old.filter((t) => t.id !== tab.id);
          if (activeIdRef.current === tab.id) {
            const sibling = next.filter((t) => tab.projectless ? t.projectless : !t.projectless && sameProject(t.root, tab.root)).at(-1);
            setActiveId(sibling?.id || "");
            setSelectedRoot(tab.projectless ? "" : tab.root);
          }
          return next;
        });
      }).catch((e) => notify(e.message));
    };
    if (tab.busy)
      setConfirmation({
        title: "Stop and close this tab?",
        text: "This stops the current turn. Your saved files and CLI history remain available.",
        action,
      });
    else action();
  };
  useAgentControl(loaded, async ({ action, id, body }) => {
    const find = () => tabsRef.current.find((t) => (t.controlId || t.id) === id);
    const view = (tab: Tab, full = true) => taskView(tab, uiRequestsRef.current, full);
    const audit = (tab: Tab, text: string) => setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, messages: [...t.messages, { id: crypto.randomUUID(), role: "notice", title: "Agent control", text }] } : t));
    const submit = async (tab: Tab, messageId: string, text: string) => {
      if (tab.messages.some((m) => m.id === messageId) || tab.queuedMessages?.some((m) => m.id === messageId)) return true;
      if (tab.mode !== "rich") throw new Error("Return this task to readable view before submitting its prompt.");
      if (tab.agent === "shell") {
        if (tab.busy) throw new Error("Wait for this shell command to finish.");
        setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, messages: [...t.messages, { id: messageId, role: "user", text }] } : t));
        try { await api("session:send", tab.id, text, { id: messageId, text }); }
        catch (e) { setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, messages: t.messages.filter((m) => m.id !== messageId) } : t)); throw e; }
      } else await api("session:submit", tab.id, { id: messageId, text });
      return false;
    };
    if (action === "list") return { tasks: tabsRef.current.map((t) => view(t, false)) };
    if (action === "create") {
      let created = tabsRef.current.find((t) => t.controlId === body.id);
      const reused = !!created;
      if (!created) {
        let folder = "";
        if (body.root) {
          const opened = await api<Workspace>("workspace:register", body.root);
          folder = opened.root; setWorkspaces((old) => ({ ...old, [folder]: opened }));
        }
        created = await addTab(body.agent, "rich", folder, undefined, body.cwd, body.accountId, undefined, {
          controlId: body.id, managedBy: body.owner || "Local agent", name: body.name || `Agent task · ${agentNames[body.agent as Agent]}`,
          model: body.model, effort: body.effort, workMode: body.workMode,
        });
        if (!created) throw new Error("Could not create the chat.");
        audit(created, `${created.managedBy} created this task through Lumen's local interface.`);
        notify(`Agent control started ${created.name}`);
      }
      await settleControl();
      let deliveryError = "";
      if (body.text) {
        try {
          await submit(created, body.id, body.text);
        } catch (e: any) { deliveryError = e.message; audit(created, `Initial prompt was not submitted: ${e.message}. Retry create with task ID ${body.id}.`); }
      }
      await settleControl(); persist();
      return { ...view(tabsRef.current.find((t) => t.id === created!.id) || created), reused, ...(deliveryError ? { deliveryError } : {}) };
    }
    const tab = find();
    if (!tab) throw Object.assign(new Error("This task is no longer open. Use list to find available chats."), { status: 404 });
    if (action === "get") return view(tab);
    if (action === "focus") {
      if (!tab.projectless) rememberProject(tab.root, undefined, true);
      setActiveId(tab.id); setSelectedRoot(tab.projectless ? "" : tab.root);
    } else if (action === "rename") setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, name: body.name, nameCustom: true } : t));
    else if (action === "close") {
      if (tab.busy || tab.queuedMessages?.length || tab.mode === "native") throw new Error("Stop this task and remove queued messages in readable view before closing it.");
      await api("session:close", tab.id);
      delete browserOpenRef.current[tab.controlId || tab.id];
      setTabs((old) => {
        const next = old.filter((t) => t.id !== tab.id);
        if (activeIdRef.current === tab.id) {
          const selected = next.filter((t) => tab.projectless ? t.projectless : !t.projectless && sameProject(t.root, tab.root)).at(-1) || next[Math.min(old.findIndex((t) => t.id === tab.id), next.length - 1)];
          setActiveId(selected?.id || ""); setSelectedRoot(selected && !selected.projectless ? selected.root : "");
        }
        return next;
      });
      notify(`Agent control closed ${tab.name}`);
      await settleControl(); persist(); return { id, closed: true };
    } else {
      if (tab.mode !== "rich") throw new Error("Return this chat to readable view to control it. Native terminal interaction stays in Lumen.");
      if (action === "message") {
        if (await submit(tab, body.id, body.text)) return { ...view(tab), messageId: body.id, reused: true };
      } else if (action === "queue" || action === "resume") await api("session:queue-action", tab.id, body.messageId || "", action === "resume" ? "resume" : body.action);
      else if (action === "stop") await api("session:stop", tab.id);
      else if (action === "models") return api("session:models", tab.id);
      else if (action === "configure") await api("session:configure", tab.id, body);
      else if (action === "answer") {
        const request = uiRequestsRef.current.find((r) => r.session === tab.id && r.request.id === body.requestId)?.request;
        if (!request) throw new Error("This question is no longer pending.");
        if (!body.response.cancelled && (request.method === "confirm" ? typeof body.response.confirmed !== "boolean" : request.method === "questions" ? !body.response.answers : typeof body.response.value !== "string" || request.method === "select" && !request.options?.includes(body.response.value))) throw new Error("Use the response shape for this pending question.");
        if (!body.response.cancelled && request.method === "questions") {
          const questions = request.questions || [], ids = new Set(questions.map((q) => q.id));
          if (!questions.length || [body.response.answers, body.response.answerLists, body.response.notes].some((values) => values && Object.keys(values).some((key) => !ids.has(key))) ||
            questions.some((q) => !body.response.answers[q.id]?.trim() || body.response.answerLists && (!body.response.answerLists[q.id]?.length || body.response.answerLists[q.id].some((value: string) => !value.trim()) || !q.multiSelect && body.response.answerLists[q.id].length > 1)))
            throw new Error("Answer each pending question using its exact ID, or cancel. Custom written answers are allowed.");
        }
        await api("session:pi-response", tab.id, { ...body.response, id: body.requestId });
        setUiRequests((old) => old.filter((r) => r.session !== tab.id || r.request.id !== body.requestId));
      } else throw new Error("Unknown agent-control action.");
    }
    if (action !== "message") audit(tab, `Local agent requested ${action}${action === "queue" ? ` · ${body.action}` : ""}.`);
    await settleControl(); persist();
    return { ...view(find() || tab), ...(action === "message" ? { messageId: body.id } : {}) };
  });
  const openFile = async (file: string, folder = root) => {
    if (!folder) return;
    const normalized = file
      .replace(/^file:\/\//, "")
      .replace(/^\//, "")
      .split("#")[0];
    const existing = docs.find((d) => samePath(d.root, folder) && d.path === normalized);
    if (existing) {
      setActiveDocKey(docKey(existing));
      return;
    }
    try {
      const result = await api("files:read", folder, normalized);
      const doc: Doc = { root: folder, ...result, saved: result.content };
      setDocs((old) => [...old, doc]);
      setActiveDocKey(docKey(doc));
    } catch (e: any) {
      notify(e.message);
    }
  };
  const saveFile = async () => {
    if (!activeDoc) return;
    const doc = activeDoc;
    try {
      const result = await api(
        "files:save",
        doc.root,
        doc.path,
        doc.content,
        doc.version,
      );
      setDocs((old) =>
        old.map((d) =>
          docKey(d) === docKey(doc)
            ? { ...d, saved: doc.content, version: result.version }
            : d,
        ),
      );
      refreshGit(doc.root);
      notify(`${doc.path} saved`);
    } catch (e: any) {
      notify(e.message);
    }
  };
  const closeDoc = (doc: Doc) => {
    const action = () => {
      setDocs((old) => {
        const next = old.filter((d) => docKey(d) !== docKey(doc));
        if (activeDoc && docKey(activeDoc) === docKey(doc)) {
          const sibling = next.filter((d) => d.root === doc.root).at(-1);
          setActiveDocKey(sibling ? docKey(sibling) : "");
          projectDocsRef.current[doc.root] = sibling ? docKey(sibling) : "";
        }
        return next;
      });
    };
    if (doc.content !== doc.saved)
      setConfirmation({
        title: "Discard unsaved edits?",
        text: `${doc.path} has edits that haven't been saved.`,
        action,
      });
    else action();
  };
  const reloadDoc = () => {
    if (!activeDoc) return;
    const doc = activeDoc;
    const action = async () => {
      try {
        const next = await api("files:read", doc.root, doc.path);
        setDocs((old) =>
          old.map((d) =>
            docKey(d) === docKey(doc)
              ? { ...d, ...next, saved: next.content }
              : d,
          ),
        );
      } catch (e: any) {
        notify(e.message);
      }
    };
    if (doc.content !== doc.saved)
      setConfirmation({
        title: "Reload from disk?",
        text: "Unsaved editor changes will be replaced with the file on disk.",
        action,
      });
    else action();
  };
  const gitAction = async (folder: string, action: string, payload?: any) => {
    if (!folder || gitBusy) return false;
    setGitBusy(true);
    try {
      const git = await api("git:action", folder, action, payload);
      const key = normalizePath(git.root || folder);
      setWorkspaces((old) => Object.fromEntries(Object.entries(old).map(([id, value]) =>
        [id, normalizePath(value.root) === key || normalizePath(value.git?.root || "") === key || normalizePath(id) === normalizePath(folder) ? { ...value, git } : value])));
      setRefresh((n) => n + 1);
      notify(
        {
          commit: "Commit created",
          push: "Push complete",
          pull: "Pull complete",
          fetch: "Remotes refreshed",
          stage: "Changes staged",
          unstage: "Changes unstaged",
        }[action] || "Git updated",
      );
      return true;
    } catch (e: any) {
      notify(e.message);
      return false;
    } finally {
      setGitBusy(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.target as HTMLElement)?.closest(".modal")) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault(); setBrowserOpen((value) => !value);
      } else if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault(); void addTab("shell", "rich", "");
      } else if (e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault(); void addTab("shell");
      } else if (e.key === "Tab") {
        const visible = tabsRef.current.filter((tab) => root ? !tab.projectless && sameProject(tab.root, root) : tab.projectless);
        if (visible.length > 1) { e.preventDefault(); const index = visible.findIndex((tab) => tab.id === activeIdRef.current); const next = visible[(index + (e.shiftKey ? -1 : 1) + visible.length) % visible.length]; setActiveId(next.id); }
      } else if ((e.target as HTMLElement)?.closest(".native-terminal")) return;
      else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveFile();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("palette");
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        setDialog("palette");
      } else if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        setDialog("open");
      } else if (e.key === ",") {
        e.preventDefault();
        setDialog("settings");
      } else if (e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setWorktreeFocus(worktreeTarget.current);
        setDialog("worktrees");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const applySidebarWidth = (desired: number, hostWidth = window.innerWidth) => {
    const state = panelWidthsRef.current;
    const maxTotal = Math.max(MIN_PANEL, hostWidth - RAIL_WIDTH - MIN_MAIN);
    const maxSidebar = Math.max(MIN_PANEL, maxTotal - (state.browserOpen ? MIN_PANEL : 0) - (state.explorerOpen ? MIN_PANEL : 0));
    const next = Math.min(maxSidebar, Math.max(MIN_PANEL, Math.round(desired)));
    state.sidebar = next;
    setSidebarWidth(next);
    let remaining = maxTotal - next;
    if (state.explorerOpen) {
      const nextExp = Math.min(state.explorer, Math.max(MIN_PANEL, remaining - (state.browserOpen ? MIN_PANEL : 0)));
      if (nextExp !== state.explorer) { state.explorer = nextExp; setExplorerWidth(nextExp); }
      remaining -= nextExp;
    }
    if (state.browserOpen) {
      const nextBrow = Math.min(state.browser, Math.max(MIN_PANEL, remaining));
      if (nextBrow !== state.browser) { state.browser = nextBrow; setBrowserWidth(nextBrow); }
    }
  };
  const applyExplorerWidth = (desired: number, hostWidth = window.innerWidth) => {
    const state = panelWidthsRef.current;
    const maxTotal = Math.max(MIN_PANEL, hostWidth - RAIL_WIDTH - MIN_MAIN);
    const maxExplorer = Math.max(MIN_PANEL, maxTotal - (state.sidebarOpen ? MIN_PANEL : 0) - (state.browserOpen ? MIN_PANEL : 0));
    const next = Math.min(maxExplorer, Math.max(MIN_PANEL, Math.round(desired)));
    state.explorer = next;
    setExplorerWidth(next);
    let remaining = maxTotal - next;
    if (state.sidebarOpen) {
      const nextSide = Math.min(state.sidebar, Math.max(MIN_PANEL, remaining - (state.browserOpen ? MIN_PANEL : 0)));
      if (nextSide !== state.sidebar) { state.sidebar = nextSide; setSidebarWidth(nextSide); }
      remaining -= nextSide;
    }
    if (state.browserOpen) {
      const nextBrow = Math.min(state.browser, Math.max(MIN_PANEL, remaining));
      if (nextBrow !== state.browser) { state.browser = nextBrow; setBrowserWidth(nextBrow); }
    }
  };
  const applyBrowserWidth = (desired: number, hostWidth = window.innerWidth) => {
    const state = panelWidthsRef.current;
    const maxTotal = Math.max(MIN_PANEL, hostWidth - RAIL_WIDTH - MIN_MAIN);
    const reservedRight = state.explorerOpen ? state.explorer : 0;
    const maxBrowser = Math.max(MIN_PANEL, maxTotal - reservedRight - (state.sidebarOpen ? MIN_PANEL : 0));
    const next = Math.min(maxBrowser, Math.max(MIN_PANEL, Math.round(desired)));
    state.browser = next;
    setBrowserWidth(next);
    const remaining = maxTotal - reservedRight - next;
    if (state.sidebarOpen) {
      const nextSide = Math.min(state.sidebar, Math.max(MIN_PANEL, remaining));
      if (nextSide !== state.sidebar) { state.sidebar = nextSide; setSidebarWidth(nextSide); }
    }
  };
  const resize = (event: React.PointerEvent, kind: "sidebar" | "explorer" | "split" | "terminal") => {
    resizeCleanupRef.current?.();
    const target = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const host = target.parentElement!;
    const width = Math.max(1, host.clientWidth);
    const initial =
      kind === "sidebar"
        ? target.previousElementSibling?.getBoundingClientRect().width ?? sidebarWidth
        : kind === "explorer"
          ? target.nextElementSibling?.getBoundingClientRect().width ?? explorerWidth
          : kind === "terminal"
            ? host.getBoundingClientRect().height
            : split;
    target.setPointerCapture(event.pointerId);
    resizeTargetRef.current = target;
    setResizing(true);
    const move = (e: PointerEvent) => {
      if (kind === "sidebar")
        applySidebarWidth(initial + e.clientX - startX, host.clientWidth || width);
      else if (kind === "explorer")
        applyExplorerWidth(initial + startX - e.clientX, host.clientWidth || width);
      else if (kind === "terminal") {
        const currentMainHeight = (target.closest(".main") as HTMLElement | null)?.clientHeight || mainHeight;
        const maxTerm = Math.max(60, currentMainHeight - nativeTop - 60);
        setTerminalHeight(Math.min(maxTerm, Math.max(60, Math.round(initial + e.clientY - startY))));
      } else {
        const currentWidth = Math.max(1, host.clientWidth || width);
        setSplit(
          Math.min(
            98,
            Math.max(2, initial + ((e.clientX - startX) / currentWidth) * 100),
          ),
        );
      }
    };
    const end = () => {
      if (resizeCleanupRef.current === end) resizeCleanupRef.current = null;
      if (resizeTargetRef.current === target) resizeTargetRef.current = null;
      setResizing(false);
      target.removeEventListener("pointermove", move as any);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      target.removeEventListener("lostpointercapture", end);
    };
    resizeCleanupRef.current = end;
    target.addEventListener("pointermove", move as any);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
    target.addEventListener("lostpointercapture", end);
  };
  const githubURL = (remote?: string) => {
    if (!remote) return "";
    const converted = remote
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "");
    return /^https?:\/\//.test(converted) ? converted : "";
  };
  const activeColor = active
    ? settings.coloredAgents
      ? settings.agents[active.agent].color
      : settings.accent
    : settings.accent;
  const hasNative = tabs.some((t) => t.mode === "native" || t.terminalReady || t.toolTerminals?.length);
  const selectTab = (tab: Tab) => {
    setActiveId(tab.id); setSelectedRoot(tab.projectless ? "" : tab.root);
    if (!tab.projectless) setProjects((old) => old.map((p) => sameProject(p.root, tab.root) && p.collapsed ? { ...p, collapsed: false } : p));
  };
  const listedTab = (tab: Tab) => !tab.archived && (tab.projectless || !isHiddenProject(tab.root));
  const archiveChat = (tab: Tab) => {
    const archived = !tab.archived;
    setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, archived } : t));
    if (archived && !showArchivedRef.current && activeIdRef.current === tab.id) {
      const sibling = tabsRef.current.filter((t) => t.id !== tab.id && listedTab(t) && (tab.projectless ? t.projectless : !t.projectless && sameProject(t.root, tab.root))).at(-1)
        || tabsRef.current.filter((t) => t.id !== tab.id && listedTab(t)).at(-1);
      setActiveId(sibling?.id || "");
      setSelectedRoot(sibling && !sibling.projectless ? sibling.root : "");
    }
  };
  const leaveHiddenView = () => {
    const activeTab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    const shownRoot = activeTab ? (activeTab.projectless ? "" : activeTab.root) : selectedRoot;
    if (!((activeTab?.archived) || (shownRoot && isHiddenProject(shownRoot)))) return;
    const sibling = tabsRef.current.filter((t) => t.id !== activeTab?.id && listedTab(t)).at(-1);
    setActiveId(sibling?.id || "");
    setSelectedRoot(sibling && !sibling.projectless ? sibling.root : "");
  };
  const toggleArchived = () => {
    const next = !showArchived;
    if (next) setProjects((old) => old.map((p) => p.hidden && p.collapsed ? { ...p, collapsed: false } : p));
    if (!next) leaveHiddenView();
    setShowArchived(next);
  };
  const tabActions = { onSelect: selectTab, onCustomize: (tab: Tab) => { selectTab(tab); setDialog("tab"); }, onRename: (tab: Tab, name: string) => setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, name, nameCustom: true } : t)), onClose: closeTab, onArchiveChat: archiveChat };
  const toggleChatLayout = () => { setSettings((s) => ({ ...s, chatLayout: s.chatLayout === "vertical" ? "horizontal" : "vertical" })); setSidebar(true); };
  const sessionActions = <div className="tab-actions">
    <IconButton label={settings.chatLayout === "vertical" ? "Use horizontal tabs" : "Use vertical chats"} onClick={toggleChatLayout}>{settings.chatLayout === "vertical" ? <PanelTop size={16} /> : <ListTree size={16} />}</IconButton>
    <div className="agent-menu-anchor" ref={agentMenuAnchorRef}>
      <IconButton label="New agent session" active={agentMenu} aria-expanded={agentMenu} aria-controls={agentMenu ? "new-chat-menu" : undefined} onClick={() => { setAgentMenuRoot(undefined); setAgentMenu(!agentMenu); }}><Plus size={18} /></IconButton>
      {agentMenu && createPortal(<div className="agent-menu" id="new-chat-menu" ref={agentMenuRef} role="group" aria-label="Choose an agent" style={agentMenuPos ? { top: agentMenuPos.top, right: agentMenuPos.right } : { visibility: "hidden" }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAgentMenu(false); if (agentMenuTrigger.current?.isConnected) agentMenuTrigger.current.focus(); } }}><div className="menu-label">NEW CHAT{agentMenuRoot !== undefined ? ` · ${agentMenuRoot ? projects.find((p) => sameProject(p.root, agentMenuRoot))?.name || "Project" : "No workspace"}` : ""}</div>
        {agents.map((agent) => <button key={agent} onClick={() => { setAgentMenu(false); setAgentMenuRoot(undefined); void addTab(agent, "rich", agentMenuRoot ?? root); }}><AgentMark agent={agent} color={settings.agents[agent].color} size={18} /><span>{agentNames[agent]}</span><small>{agent === "shell" ? "Shell" : boot.agents[agent]?.available ? "Ready" : "Configure"}</small></button>)}
        <div className="menu-divider" /><button onClick={() => { setAgentMenu(false); void addTab("shell", "rich", ""); }}><TerminalSquare size={17} /><span>Terminal without workspace</span><kbd>Ctrl Alt T</kbd></button><button onClick={() => { setAgentMenu(false); startWithoutWorkspace(); }}><Sparkles size={17} /><span>New chat without workspace</span></button>
        <button onClick={() => { setAgentMenu(false); setWorktreeFocus(worktreeTarget.current); setDialog("worktrees"); }}><Layers size={17} /><span>New worktree</span><kbd>Ctrl ⇧ N</kbd></button>
      </div>, appRootRef.current || document.body)}
    </div>
    <IconButton label="Settings" onClick={() => setDialog("settings")}><MoreHorizontal size={18} /></IconButton>
  </div>;
  return (
    <div
      ref={appRootRef}
      className={`app ${verticalChats ? "vertical-layout" : "horizontal-layout"} ${settings.motion ? "" : "motion-off"} ${settings.theme === "Paper" ? "light" : ""} ${resizing ? "resizing" : ""}`}
      style={styleVars(settings) as CSSProperties}
      onClick={(e) => {
        if (!settings.playful || !settings.motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches || e.detail === 0) return;
        const baseId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const glyphs = ["✦", "✧", "⋆", "✺"];
        const palette = [activeColor, settings.accent, "#fbbf24", "#38bdf8", "#f472b6", "#c084fc"];
        const burst = [0, 1, 2].map((i) => {
          const angle = -Math.PI / 2 + (i - 1) * 0.65 + (Math.random() - 0.5) * 0.35;
          const dist = 26 + Math.random() * 22;
          return {
            x: e.clientX,
            y: e.clientY,
            dx: Math.round(Math.cos(angle) * dist),
            dy: Math.round(Math.sin(angle) * dist - 14),
            glyph: glyphs[(i + Math.floor(Math.random() * glyphs.length)) % glyphs.length],
            color: palette[i % palette.length],
            id: `${baseId}-${i}`,
          };
        });
        const ids = new Set(burst.map((b) => b.id));
        setSpark((old) => [...old.slice(-18), ...burst]);
        setTimeout(
          () => setSpark((old) => old.filter((s) => !ids.has(s.id))),
          750,
        );
      }}
    >
      <div
        className={`atmosphere atmosphere-${settings.background}`}
        aria-hidden="true"
        style={
          settings.background === "image" && settings.image
            ? { backgroundImage: `url(${settings.image})` }
            : undefined
        }
      >
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-glyph">
            L<i />
          </span>
          <span>
            lumen<span className="brand-dot">.</span>
          </span>
        </div>
        <span className="titlebar-caption">a little more room to think</span>
        <div className="titlebar-right">
          <button className={`icon-button ${browserOpen ? "active" : ""}`} aria-label={browserOpen ? "Hide browser" : "Show browser"} title="Browser (Ctrl Shift B)" aria-expanded={browserOpen} aria-controls="browser-panel" onClick={() => setBrowserOpen(!browserOpen)}><Globe size={17} /></button>
          <button ref={explorerToggle} className={`icon-button ${visibleExplorer && panel === "files" ? "active" : ""}`} aria-label={visibleExplorer && panel === "files" ? "Hide file explorer" : "Show file explorer"} title={visibleExplorer && panel === "files" ? "Hide file explorer" : "Show file explorer"} aria-expanded={visibleExplorer && panel === "files"} aria-controls="workspace-panel" onClick={() => { setPanel("files"); toggleExplorer(!(visibleExplorer && panel === "files")); }}>
            {visibleExplorer && panel === "files" ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button className="command-hint" onClick={() => setDialog("palette")}>
            <Search size={12} />
            <span>Go anywhere</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="window-controls">
            <button
              aria-label="Minimize"
              onClick={() => api("window:action", "minimize")}
            >
              <Minus size={14} />
            </button>
            <button
              aria-label="Maximize"
              onClick={() => api("window:action", "maximize")}
            >
              <Square size={11} />
            </button>
            <button
              aria-label="Close window"
              onClick={() => api("window:action", "close")}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </header>
      <div className="app-body" style={{ "--projects-panel-width": `${visibleSidebar ? sidebarWidth : 0}px`, "--workspace-panel-width": `${visibleExplorer ? explorerWidth : 0}px` } as CSSProperties}>
        <nav className="rail" aria-label="Workspace panels">
          <div>
            <button ref={projectsToggle} className={`icon-button ${visibleSidebar ? "active" : ""}`} aria-label={visibleSidebar ? "Hide projects sidebar" : "Show projects sidebar"} title={visibleSidebar ? "Hide projects sidebar" : "Show projects sidebar"} aria-expanded={visibleSidebar} aria-controls="projects-sidebar" onClick={() => setSidebar(!visibleSidebar)}><Files size={21} /></button>
            <button
              className={`icon-button ${panel === "git" && visibleExplorer ? "active" : ""}`}
              aria-label="Source control"
              title="Source control"
              aria-expanded={panel === "git" && visibleExplorer}
              aria-controls="workspace-panel"
              onClick={() => {
                setPanel("git");
                toggleExplorer(!(visibleExplorer && panel === "git"));
              }}
            >
              <GitBranch size={21} />
              {scmRepos.reduce((count, entry) => count + entry.workspace.git.files.length, 0) > 0 && (
                <span className="rail-badge">{scmRepos.reduce((count, entry) => count + entry.workspace.git.files.length, 0)}</span>
              )}
            </button>
            <IconButton
              label="Worktrees"
              onClick={() => { setWorktreeFocus(worktreeTarget.current); setDialog("worktrees"); }}
            >
              <Layers size={21} />
            </IconButton>
            <IconButton label="New terminal" onClick={() => addTab("shell")}>
              <TerminalSquare size={21} />
            </IconButton>
            <IconButton label="Browser (Ctrl Shift B)" active={browserOpen} onClick={() => setBrowserOpen(!browserOpen)}><Globe size={21} /></IconButton>
          </div>
          <div>
            <IconButton
              label="Open workspace"
              onClick={() => setDialog("open")}
            >
              <FolderOpen size={21} />
            </IconButton>
            <IconButton
              label="Customize workspace"
              onClick={() => setDialog("settings")}
            >
              <Settings2 size={21} />
            </IconButton>
            <span className="local-avatar" title="Local workspace">
              M
            </span>
          </div>
        </nav>
        {visibleSidebar && (
          <>
            <aside id="projects-sidebar" aria-label="Projects and chats" className="sidebar projects-panel" style={{ width: sidebarWidth }}>
              <ProjectSidebar projects={projects} activeRoot={root} ready={loaded} onCollapse={hideProjects}
                tabs={tabs} activeId={activeId} settings={settings} {...tabActions} onLayout={toggleChatLayout} newChatRoot={agentMenu ? agentMenuRoot : undefined}
                onNewChat={(folder) => {
                  const open = () => { setAgentMenuRoot(folder); setAgentMenu(true); };
                  if (folder) {
                    if (projectsRef.current.some((p) => p.hidden && sameProject(p.root, folder))) setShowArchived(true);
                    void openWorkspace(folder, !projectsRef.current.some((p) => p.hidden && sameProject(p.root, folder))).then((value) => { if (value) { setAgentMenuRoot(value.root); setAgentMenu(true); } });
                  } else open();
                }}
                counts={Object.fromEntries(projects.map((p) => [p.root, tabs.filter((t) => !t.projectless && sameProject(t.root, p.root) && (showArchived || p.hidden || !t.archived)).length]))}
                showArchived={showArchived} onToggleArchived={toggleArchived} onLeaveHidden={leaveHiddenView}
                onOpen={(project, reveal = true) => { void openWorkspace(project.root, reveal); }} onAdd={() => setDialog("open")} onTerminal={() => { void addTab("shell", "rich", ""); }} onScratch={startWithoutWorkspace}
                onChange={setProjects} onArchive={archiveProject} />
            </aside>
            <div
              className="resizer sidebar-resizer"
              role="separator"
              aria-label="Resize projects sidebar"
              aria-orientation="vertical"
              aria-valuemin={MIN_PANEL}
              aria-valuemax={Math.max(MIN_PANEL, viewportWidth - RAIL_WIDTH - MIN_MAIN - (browserOpen ? MIN_PANEL : 0) - (visibleExplorer ? MIN_PANEL : 0))}
              aria-valuenow={Math.round(sidebarWidth)}
              tabIndex={0}
              onPointerDown={(e) => resize(e, "sidebar")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  applySidebarWidth(sidebarWidth + 16);
                }
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  applySidebarWidth(sidebarWidth - 16);
                }
              }}
            />
          </>
        )}
        <main className="main" ref={setMainElement}>
          {(!verticalChats || !active) && <div className="tabbar">
            <SessionTabs tabs={tabs.filter((tab) => (root ? !tab.projectless && sameProject(tab.root, root) : tab.projectless) && (showArchived || !tab.archived))} activeId={activeId} settings={settings} label="Workspace chats" {...tabActions} />
            {sessionActions}
          </div>}
          {active || workspace || startingProjectless ? (
            <>
              {active && <div className="contextbar" ref={contextBar}>
                <div>
                  <span
                    className="live-dot"
                    style={{ background: activeColor }}
                  />
                  <span>{workspace?.name || "No workspace"}</span>
                  {verticalChats && <strong className="active-chat-name" title={active.name}>{active.name}</strong>}
                  <ChevronDown size={11} />
                  {workspace || currentRepo ? <button
                    className="branch-chip"
                    title={currentRepo ? `Branch: ${currentRepo.git.branch || "No Git repository"}\n${gitRootOf(currentRepo)}` : "Worktrees"}
                    onClick={() => { setWorktreeFocus(gitRootOf(currentRepo) || currentRepo?.root || root); setDialog("worktrees"); }}
                  >
                    <GitBranch size={12} />
                    {currentRepo?.git.branch || workspace?.git.branch || "folder"}
                  </button> : <button className="branch-chip" onClick={() => openWorkspace()}>
                    <FolderOpen size={12} />
                    Open workspace
                  </button>}
                </div>
                <div>
                  {active.managedBy && <button className="agent-control-badge" title={`${active.managedBy} · Task ${active.controlId}`} onClick={() => { setSettingsSection("control"); setDialog("settings"); }}><Sparkles size={12} />Agent control</button>}
                  {!["shell", "google"].includes(active.agent) && <ContextIndicator tab={active} />}
                  {active.agent !== "shell" && <AccountPicker key={active.id} tab={active} onSelect={(id) => {
                    if (id !== (active.accountId || "")) void addTab(active.agent, active.mode, active.projectless ? "" : active.root, undefined, active.cwd, id, active.projectless ? active.scratchId : undefined);
                  }} onManage={() => { setSettingsSection("accounts"); setDialog("settings"); }} onSignIn={() => void signInChat(active.id)} />}
                  <button className="view-button" onClick={switchView}>
                    <TerminalSquare size={13} />
                    {active.mode === "rich" ? "Native CLI" : "Readable view"}
                  </button>
                  <button
                    className="switch-agent"
                    onClick={() => { setAgentMenuRoot(undefined); setAgentMenu(!agentMenu); }}
                  >
                    <AgentMark
                      agent={active.agent}
                      color={activeColor}
                      size={14}
                    />
                    {agentNames[active.agent]}
                    <ChevronDown size={12} />
                  </button>
                  {verticalChats && sessionActions}
                </div>
              </div>}
              <div className="workspace-content">
                <div
                  className={`session-pane ${active?.mode === "rich" && active.terminalOpen ? "with-terminal" : ""}`}
                  style={{
                    width: activeDoc && !editorExpanded ? `${split}%` : "100%",
                    display: editorExpanded && activeDoc ? "none" : undefined,
                  }}
                >
                  {active ? <>
                  {active.mode === "rich" && active.terminalOpen && <div className="terminal-reserve" style={{ flexBasis: Math.min(maxTerminalHeight, terminalHeight), maxHeight: "calc(100% - 60px)" }} />}
                  {(active.mode === "rich" || active.recoveryError) && (
                    <Conversation
                      key={active.id}
                      tab={active}
                      settings={settings}
                      onConfig={(change) => updateTab(active.id, change)}
                      onSend={send}
                      onStop={() =>
                        api("session:stop", active.id).catch((e) =>
                          notify(e.message),
                        )
                      }
                      onFile={openFile}
                      onWeb={openWeb}
                      onError={notify}
                      onSignIn={() => void signInChat(active.id)}
                      onFollowFolder={openWorkspace}
                      onNative={(draft) => typeof draft === "string" ? openNativeCommand(draft) : switchView()}
                      attachment={attachment}
                      onAttach={() => void addAttachments("choose")}
                      onPasteAttachments={() => void addAttachments("clipboard")}
                      onDropAttachments={(files) => void addAttachments(files)}
                      onTerminal={() => {
                        if (["claude", "grok"].includes(active.agent) && !active.nativeOwned && !active.terminalId) { void switchView(); return; }
                        setTabs((old) => old.map((tab) => tab.id === active.id ? { ...tab, terminalOpen: true, terminalReady: !tab.terminalId || tab.terminalReady } : tab));
                      }}
                      onForceStop={() => api("session:stop", active.id, true).catch((error) => notify(error.message))}
                      onContinue={() => void continueSession()}
                      onReconnect={() => {
                        if (active.recoveryError) void api("session:reconnect", active.id).then(() => setTabs((old) => old.map((tab) => tab.id === active.id ? { ...tab, recoveryError: undefined } : tab))).catch(async (error) => {
                          if (!error.message.includes("session is no longer available")) { updateTab(active.id, { recoveryError: error.message }); notify(error.message); return; }
                          if (!active.projectless) { try { await api("workspace:register", active.root); } catch (failure: any) { notify(failure.message); return; } }
                          await addTab(active.agent, active.mode, active.projectless ? "" : active.root, active, active.cwd);
                        });
                      }}
                      onDetach={() => setAttachment("")}
                    />
                  )}
                  </> : <SessionStart key={root} workspace={workspace} settings={settings} available={boot.agents}
                    starting={startingAgents[root]} onStart={startSession}
                    onSettings={() => { setSettingsSection("agents"); setDialog("settings"); }} />}
                </div>
                {activeDoc && (
                  <>
                    {!editorExpanded && (
                      <div
                        className="resizer editor-resizer"
                        role="separator"
                        aria-label="Resize editor"
                        aria-orientation="vertical"
                        aria-valuemin={2}
                        aria-valuemax={98}
                        aria-valuenow={Math.round(split)}
                        tabIndex={0}
                        onPointerDown={(e) => resize(e, "split")}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowRight") {
                            e.preventDefault();
                            setSplit((n) => Math.min(98, n + 2));
                          }
                          if (e.key === "ArrowLeft") {
                            e.preventDefault();
                            setSplit((n) => Math.max(2, n - 2));
                          }
                        }}
                      />
                    )}
                    <Suspense
                      fallback={
                        <div className="editor-pane editor-loading">
                          Opening editor…
                        </div>
                      }
                    >
                      <EditorPane
                        docs={editorDocs}
                        active={activeDoc}
                        settings={settings}
                        expanded={editorExpanded}
                        onExpand={() => setEditorExpanded(!editorExpanded)}
                        onActive={(d) => setActiveDocKey(docKey(d))}
                        onChange={(value) =>
                          setDocs((old) =>
                            old.map((d) =>
                              docKey(d) === docKey(activeDoc)
                                ? { ...d, content: value }
                                : d,
                            ),
                          )
                        }
                        onSave={saveFile}
                        onClose={closeDoc}
                        onReload={reloadDoc}
                      />
                    </Suspense>
                  </>
                )}
              </div>
            </>
          ) : (
            <Welcome
              boot={boot}
              settings={settings}
              onOpen={() => openWorkspace()}
              onPath={() => setDialog("open")}
              onStart={startWithoutWorkspace}
              onRecent={openWorkspace}
              onSettings={() => setDialog("settings")}
              loaded={loaded}
            />
          )}
          {hasNative && (
            <div
              className={`native-layers ${active?.mode === "rich" ? "embedded-terminal" : ""}`}
              style={{
                display: (active?.mode === "native" || active?.terminalOpen) && !(editorExpanded && activeDoc) ? "block" : "none",
                top: nativeTop,
                width: activeDoc ? `${split}%` : "100%",
                height: active?.mode === "rich" ? Math.min(maxTerminalHeight, terminalHeight) : undefined,
                maxHeight: active?.mode === "rich" ? `calc(100% - ${nativeTop + 60}px)` : undefined,
              }}
            >
              <div className="terminal-panel-heading"><span>{active?.terminalId ? "Tool terminal" : "Interactive terminal"}</span>
                {active?.mode === "native" && active.interrupted && <span>Interrupted · ready for your next message</span>}
                {active?.busy && <button disabled={active.stopping} onClick={() => api("session:stop", active.id).catch((error) => notify(error.message))}>{active.stopping ? "Cancelling…" : "Stop"}</button>}
                {!!active?.toolTerminals?.length && <select aria-label="Choose tool terminal" value={active.terminalId || ""} onChange={(event) => setTabs((old) => old.map((tab) => tab.id === active.id ? { ...tab, terminalId: event.target.value || undefined } : tab))}><option value="">Session terminal</option>{active.toolTerminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.title}</option>)}</select>}
                {active?.forceStopAvailable && <button className="force-stop" onClick={() => api("session:stop", active.id, true).catch((error) => notify(error.message))}>Force stop</button>}
                <button aria-label="Close terminal panel" onClick={() => { if (active?.mode === "native") void switchView(); else setTabs((old) => old.map((tab) => tab.id === active?.id ? { ...tab, terminalOpen: false } : tab)); }}><X size={15} /></button>
              </div>
              {tabs
                .filter((t) => (t.mode === "native" || t.terminalReady) && !t.recoveryError)
                .map((tab) => (
                  <NativeTerminal
                    draft={tab.nativeDraft}
                    onDismissDraft={() => { void updateTab(tab.id, { nativeDraft: undefined }); }}
                    key={tab.id}
                    id={tab.id}
                    active={activeId === tab.id && (active?.mode === "native" || !!active?.terminalOpen) && !active?.terminalId}
                    settings={settings}
                    onWeb={openWeb}
                    onError={(message, recoveryFailure) => { notify(message); if (recoveryFailure) void updateTab(tab.id, { recoveryError: message }); }}
                  />
                ))}
              {tabs.flatMap((tab) => (tab.toolTerminals || []).map((terminal) => <NativeTerminal key={`${tab.id}:${terminal.id}`} id={tab.id} terminalId={terminal.id}
                active={activeId === tab.id && active?.terminalId === terminal.id && !!active?.terminalOpen} settings={settings} onWeb={openWeb} onError={notify} onDismissDraft={() => {}} />))}
              {active?.mode === "rich" && (
                <div
                  className="resizer terminal-resizer"
                  role="separator"
                  aria-label="Resize terminal panel"
                  aria-orientation="horizontal"
                  aria-valuemin={60}
                  aria-valuemax={maxTerminalHeight}
                  aria-valuenow={Math.min(maxTerminalHeight, Math.round(terminalHeight))}
                  tabIndex={0}
                  onPointerDown={(e) => resize(e, "terminal")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setTerminalHeight((n) => Math.min(maxTerminalHeight, Math.min(maxTerminalHeight, n) + 16));
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setTerminalHeight((n) => Math.max(60, Math.min(maxTerminalHeight, n) - 16));
                    }
                  }}
                />
              )}
            </div>
          )}
        </main>
        <BrowserPane chatId={active?.controlId || activeId} chatName={active?.name || ""} workspace={checkoutPath} open={browserOpen} blocked={resizing || !!(dialog || signIn || confirmation || piRequest || diff || agentMenu)}
          width={browserWidth} maxWidth={Math.max(MIN_PANEL, viewportWidth - RAIL_WIDTH - MIN_MAIN - (visibleExplorer ? explorerWidth : 0) - (visibleSidebar ? MIN_PANEL : 0))}
          onWidth={applyBrowserWidth} onClose={() => setBrowserOpen(false)} onAttach={attachBrowser}
          canAttach={!!active && active.agent !== "shell" && active.mode === "rich" && !active.recoveryError} onError={notify} />
        {visibleExplorer && (
          <>
            <div
              className="resizer sidebar-resizer explorer-resizer"
              role="separator"
              aria-label="Resize workspace panel"
              aria-orientation="vertical"
              aria-valuemin={MIN_PANEL}
              aria-valuemax={Math.max(MIN_PANEL, viewportWidth - RAIL_WIDTH - MIN_MAIN - (visibleSidebar ? MIN_PANEL : 0) - (browserOpen ? MIN_PANEL : 0))}
              aria-valuenow={Math.round(explorerWidth)}
              tabIndex={0}
              onPointerDown={(e) => resize(e, "explorer")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  applyExplorerWidth(explorerWidth - 16);
                }
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  applyExplorerWidth(explorerWidth + 16);
                }
              }}
            />
            <aside id="workspace-panel" aria-label={panel === "files" ? "File explorer" : "Source control"} className="sidebar workspace-panel" style={{ width: explorerWidth }}>
              <div className="sidebar-heading">
                <span>{panel === "files" ? "EXPLORER" : "SOURCE CONTROL"}</span>
                <div>
                  {panel === "files" && (
                    <>
                      <IconButton
                        label="Find a file"
                        onClick={() => setDialog("palette")}
                      >
                        <Search size={14} />
                      </IconButton>
                      <IconButton
                        label="New file"
                        disabled={!workspace}
                        onClick={() => setDialog("newfile")}
                      >
                        <FilePlus2 size={14} />
                      </IconButton>
                    </>
                  )}
                  <IconButton
                    label="Refresh workspace"
                    disabled={!workspace && !scmRepos.length}
                    onClick={() => { const folders = [...new Set([root, ...scmRepos.map((entry) => gitRootOf(entry.workspace))].filter(Boolean))]; for (const folder of folders) void refreshGit(folder); }}
                  >
                    <RefreshCw size={14} />
                  </IconButton>
                  <IconButton
                    label="Hide workspace panel"
                    onClick={hideExplorer}
                  >
                    <PanelRightClose size={14} />
                  </IconButton>
                </div>
              </div>
              {(panel === "files" ? workspace : scmRepos.length || workspace) ? (
                panel === "files" ? (
                  <>
                    <div className="tree-scroll">
                      <div className="repo-label">
                        <ChevronDown size={12} />
                        {workspace.name.toUpperCase()}
                      </div>
                      <FileTree
                        root={root}
                        refresh={refresh}
                        onOpen={openFile}
                        changes={Object.fromEntries(
                          workspace.git.files.map((f) => [f.path, f.code]),
                        )}
                      />
                    </div>
                    <div className="sidebar-bottom">
                      <span className="eyebrow">
                        YOUR WORKSPACE, UNINTERRUPTED
                      </span>
                      <button
                        className="worktree-shortcut"
                        onClick={() => { setWorktreeFocus(root); setDialog("worktrees"); }}
                      >
                        <Layers size={16} />
                        <span>
                          Start in a worktree
                          <small>A fresh branch. A clean space.</small>
                        </span>
                        <ArrowRight size={14} />
                      </button>
                      <div className="sidebar-tips">
                        <kbd>Ctrl P</kbd>
                        <span>Find any file</span>
                      </div>
                    </div>
                  </>
                ) : scmRepos.length ? (
                  <GitPanel
                    repos={scmRepos}
                    busy={gitBusy}
                    action={gitAction}
                    onDiff={async (folder, file, staged) => {
                      try {
                        setDiff({
                          path: file.path,
                          staged,
                          text: await api("git:diff", folder, file.path, staged, file.original),
                        });
                      } catch (e: any) {
                        notify(e.message);
                      }
                    }}
                    onFile={(folder, file) => void openFile(file, folder)}
                    onGitHub={(remote) => {
                      const url = githubURL(remote);
                      if (url)
                        api("external:open", url).catch((e) =>
                          notify(e.message),
                        );
                      else
                        notify(
                          "Add a GitHub origin remote to open this repository.",
                        );
                    }}
                    onWorktree={(folder) => { setWorktreeFocus(folder); setDialog("worktrees"); }}
                    onError={notify}
                  />
                ) : (
                    <div className="sidebar-empty">
                      <GitBranch size={28} />
                      <p>This folder isn't a Git repository.</p>
                      <small>Run git init in a terminal to get started.</small>
                    </div>
                )
              ) : (
                <div className="sidebar-empty">
                  <FolderOpen size={30} />
                  <p>{active ? "This chat has no workspace." : "A home for your code."}</p>
                  <button className="secondary" onClick={() => openWorkspace()}>
                    Open a folder
                  </button>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
      <footer className="statusbar">
        <div className="checkout-status">
          <span className="live-dot" />
          {checkoutPath ? <button className="checkout-location" title={checkout?.path || checkoutPath} aria-label={`Current ${linkedCheckout ? "worktree" : "folder"}: ${checkout?.path || checkoutPath}`}
            onClick={() => linkedCheckout ? (setWorktreeFocus(gitRootOf(statusWorkspace) || checkoutPath), setDialog("worktrees")) : void openWorkspace(checkoutPath, !isHiddenProject(checkoutPath))}>
            <FolderOpen size={12} /><span>{linkedCheckout ? "Worktree" : "Folder"}: {checkoutName}</span>
          </button> : <span>No workspace</span>}
          {statusWorkspace && (
            <>
              <span className="status-divider" />
              <button className="checkout-branch" title={`Branch: ${statusWorkspace.git.branch || "No Git repository"}\n${gitRootOf(statusWorkspace)}`} onClick={async () => { const folder = gitRootOf(statusWorkspace) || checkoutPath; setWorktreeFocus(folder); await openWorkspace(folder, !isHiddenProject(folder)); setDialog("worktrees"); }}>
                <GitBranch size={12} />
                <span>{statusWorkspace.git.branch || "No Git repository"}</span>
              </button>
              <button
                onClick={() => {
                  setPanel("git");
                  showExplorer();
                }}
              >
                {statusWorkspace.git.ahead} ↑ {statusWorkspace.git.behind} ↓
              </button>
            </>
          )}
        </div>
        <div className={`status-ticker ${settings.playful ? "scrolling" : ""}`}>
          <span>One workspace. Every agent. Room to think.</span>
        </div>
        <div>
          {active && !["shell", "google"].includes(active.agent) && <ContextIndicator tab={active} variant="statusbar" />}
          {updateStatus?.phase === "downloaded" && <button className="update-ready" title={`Lumen ${updateStatus.latest} is ready. Close Lumen to install, or restart now.`} onClick={() => api("updates:install").catch((e) => notify(e.message))}><Download size={12} />Update ready</button>}
          {boot.administrator.supported && <button className={boot.administrator.elevated ? "administrator-active" : ""} title={boot.administrator.elevated ? "Agents and terminals have Windows administrator access" : "Restart Lumen with Windows administrator access"}
            onClick={() => { setSettingsSection("behavior"); setDialog("settings"); }}><ShieldCheck size={12} />{boot.administrator.elevated ? "Administrator" : "Run as administrator"}</button>}
          {active?.busy ? (
              active.phase ? <><TerminalSquare size={12} /><span>{active.phase === "compacting" ? "Compacting context…" : active.phase === "finishing" ? "Finishing Grok CLI…" : "Waiting for Grok CLI…"}</span></> : <Busy text="Working" />
          ) : (
            <>
              <Circle size={9} />
              <span>Ready when you are</span>
            </>
          )}
          <button onClick={() => setDialog("settings")}>
            <span className="theme-dot" />
            {settings.theme}
          </button>
        </div>
      </footer>
      {dialog === "settings" && (
        <SettingsPanel
          settings={settings}
          update={setSettings}
          onClose={() => setDialog(null)}
          available={boot.agents}
          onAgentsRefresh={async () => { const value = await api<Bootstrap>("bootstrap"); setBoot((old) => ({ ...old, ...value })); }}
          onError={notify}
          initialSection={settingsSection}
          administrator={boot.administrator}
          onAdministratorStatus={(administrator) => setBoot((old) => ({ ...old, administrator }))}
          onAccountChat={(profile) => { void addTab(profile.agent, "rich", root, undefined, undefined, profile.id); setDialog(null); }}
        />
      )}
      {signIn && <Modal title={`Sign in to ${agentNames[signIn.agent]}`} onClose={() => setSignIn(null)} wide>
        <div className="account-sign-in"><AccountLogin profile={signIn} settings={settings} onDone={(success) => { setSignIn(null); if (success) notify(`Signed in to ${agentNames[signIn.agent]}. Retry your message in the same chat.`); }} /></div>
      </Modal>}
      {dialog === "open" && (
        <OpenDialog
          recent={boot.recent}
          onClose={() => setDialog(null)}
          onOpen={openWorkspace}
        />
      )}
      {dialog === "worktrees" && (
        <WorktreeDialog
          workspace={Object.values(workspaces).find((item) => samePath(item.root, worktreeFocus) || samePath(item.git.root, worktreeFocus)) || currentRepo || workspace}
          onClose={() => { setDialog(null); setWorktreeFocus(""); }}
          onOpen={openWorkspace}
          onCreate={async (branch, base) => {
            const source = gitRootOf(Object.values(workspaces).find((item) => samePath(item.root, worktreeFocus) || samePath(item.git.root, worktreeFocus)) || currentRepo || workspace);
            if (!source) throw new Error("Open a Git repository first.");
            const next = await api<Workspace>("git:worktree", source, branch, base);
            activateWorkspace(next);
            const loaded = Object.values(workspaces);
            const related = [source, ...(next.git.worktrees || []).map((tree) => tree.path)].filter((folder, index, all) =>
              !!folder && all.findIndex((item) => samePath(item, folder)) === index && loaded.some((item) => samePath(item.root, folder) || samePath(item.git.root, folder)));
            await Promise.all(related.map((folder) => refreshGit(folder)));
          }}
        />
      )}
      {dialog === "palette" && (
        <Palette
          root={root}
          onClose={() => setDialog(null)}
          onFile={(path) => {
            openFile(path);
            setDialog(null);
          }}
          onAction={(action) => {
            setDialog(null);
            if (action === "open") setDialog("open");
            else if (action === "projectless") startWithoutWorkspace();
            else if (action === "settings") setDialog("settings");
            else if (action === "worktrees") { setWorktreeFocus(worktreeTarget.current); setDialog("worktrees"); }
            else addTab(action as Agent);
          }}
        />
      )}
      {dialog === "newfile" && (
        <InputDialog
          title="New file"
          subtitle="Enter a path in an existing folder."
          placeholder="src/new-file.ts"
          onClose={() => setDialog(null)}
          onSubmit={async (value) => {
            if (!root) throw new Error("Open a workspace first.");
            await api("files:create", root, value);
            setRefresh((n) => n + 1);
            await openFile(value);
            setDialog(null);
          }}
        />
      )}
      {dialog === "tab" && active && (
        <TabDialog
          tab={active}
          onClose={() => setDialog(null)}
          onUpdate={(changes) =>
            setTabs((old) =>
              old.map((t) => (t.id === active.id ? { ...t, ...changes, ...(Object.hasOwn(changes, "name") ? { nameCustom: true } : {}) } : t)),
            )
          }
          defaultColor={settings.agents[active.agent].color}
        />
      )}
      {confirmation && (
        <Modal title={confirmation.title} onClose={() => setConfirmation(null)}>
          <p className="dialog-copy">{confirmation.text}</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setConfirmation(null)}>
              Keep working
            </button>
            <button
              className="primary"
              onClick={() => {
                confirmation.action();
                setConfirmation(null);
              }}
            >
              Continue
            </button>
          </div>
        </Modal>
      )}
      {piRequest && (
        <PiDialog
          key={`${piRequest.session}:${piRequest.request.id}`}
          value={piRequest.request}
          sessionName={(() => { const tab = tabs.find((value) => value.id === piRequest.session); return tab ? `${tab.name} · ${tab.root || "No workspace"}` : "Agent session"; })()}
          onReply={async (response) => {
            try {
              if (response.native && tabsRef.current.find((tab) => tab.id === piRequest.session)?.agent === "pi") {
                await api("session:mode", piRequest.session, "native");
                setUiRequests((old) => old.filter((value) => value.session !== piRequest.session || value.request.id !== piRequest.request.id));
                return;
              }
              await api("session:pi-response", piRequest.session, {
                id: piRequest.request.id,
                ...response,
              });
              if (response.input !== undefined) return;
              setUiRequests((old) => old.filter((value) => value.session !== piRequest.session || value.request.id !== piRequest.request.id));
              if (response.native) { await api("session:stop", piRequest.session); await api("session:mode", piRequest.session, "native"); }
            } catch (e: any) {
              notify(e.message);
            }
          }}
        />
      )}
      {diff && (
        <Modal
          title={diff.path}
          subtitle={diff.staged ? "Staged changes" : "Working tree changes"}
          onClose={() => setDiff(null)}
          wide
        >
          <pre className="diff-view">
            {diff.text.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith("+")
                    ? "addition"
                    : line.startsWith("-")
                      ? "deletion"
                      : line.startsWith("@@")
                        ? "hunk"
                        : ""
                }
              >
                {line + "\n"}
              </span>
            ))}
          </pre>
          <div className="dialog-actions">
            <button
              className="secondary"
              onClick={() => {
                openFile(diff.path);
                setDiff(null);
              }}
            >
              <FileIcon name={diff.path} />
              Open in editor
            </button>
          </div>
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {spark.map((s) => (
        <span
          className="click-spark"
          aria-hidden="true"
          key={s.id}
          style={{
            left: s.x,
            top: s.y,
            color: s.color,
            "--spark-dx": `${s.dx}px`,
            "--spark-dy": `${s.dy}px`,
          } as CSSProperties}
        >
          {s.glyph}
        </span>
      ))}
    </div>
  );
}
function Welcome({
  boot,
  settings,
  onOpen,
  onPath,
  onStart,
  onRecent,
  onSettings,
  loaded,
}: {
  boot: Bootstrap;
  settings: Settings;
  onOpen: () => void;
  onPath: () => void;
  onStart: () => void;
  onRecent: (folder: string) => void;
  onSettings: () => void;
  loaded: boolean;
}) {
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-orb">
          <span className="brand-glyph">
            L<i />
          </span>
          <span className="orbit-dot" />
        </div>
        <span className="eyebrow">THE TERMINAL, REIMAGINED</span>
        <h1>
          A little more
          <br />
          room to think<span>.</span>
        </h1>
        <p>
          Your terminal. Your code. Your favorite agents.
          <br />
          Finally, in the same quiet space.
        </p>
        <div className="welcome-actions" style={{ flexWrap: "wrap" }}>
          <button className="primary" onClick={onOpen} disabled={!loaded}>
            <FolderOpen size={17} />
            Open a workspace
            <ArrowRight size={15} />
          </button>
          <button className="secondary" onClick={onPath}>
            Open by path
          </button>
          <button className="secondary" onClick={onStart} disabled={!loaded}>
            <TerminalSquare size={17} />
            Start without a workspace
          </button>
        </div>
        <div className="agent-line">
          {(["pi", "codex", "claude", "grok", "google"] as Agent[]).map((agent) => (
            <span
              key={agent}
              style={{ "--agent-color": settings.coloredAgents ? settings.agents[agent].color : settings.accent } as CSSProperties}
              title={
                boot.agents[agent]?.available
                  ? "CLI detected"
                  : "Configure in Settings"
              }
            >
              <AgentMark
                agent={agent}
                color={settings.coloredAgents ? settings.agents[agent].color : settings.accent}
                size={18}
              />
              {agentNames[agent]}
              {boot.agents[agent]?.available && <i />}
            </span>
          ))}
        </div>
        {boot.recent.length > 0 && (
          <div className="recent-workspaces">
            <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
            {boot.recent.slice(0, 3).map((folder) => (
              <button key={folder} onClick={() => onRecent(folder)}>
                <FolderOpen size={15} />
                <span>
                  <strong>{folder.split(/[\\/]/).at(-1)}</strong>
                  <small>{folder}</small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        )}
        <button className="welcome-customize" onClick={onSettings}>
          <Sparkles size={14} />
          Make it feel like you
          <ArrowRight size={12} />
        </button>
      </div>
      <div className="welcome-side-note">
        Built for the way
        <br />
        you actually work.<span>LOCAL FIRST · CLI NATIVE</span>
      </div>
    </div>
  );
}
function OpenDialog({
  recent,
  onClose,
  onOpen,
}: {
  recent: string[];
  onClose: () => void;
  onOpen: (folder?: string) => Promise<any>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Where are we working?"
      subtitle="Open a repository or any folder on your machine."
      onClose={onClose}
    >
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onOpen(value);
          setBusy(false);
        }}
      >
        <label className="field">
          <span>Folder path</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="C:\projects\my-repo"
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => onOpen()}>
            <FolderOpen size={15} />
            Browse folders
          </button>
          <button className="primary" disabled={busy || !value.trim()}>
            {busy ? "Opening…" : "Open workspace"}
          </button>
        </div>
      </form>
      {recent.length > 0 && (
        <div className="recent-workspaces">
          <span className="eyebrow">RECENT WORKSPACES</span>
          {recent.map((folder) => (
            <button key={folder} onClick={() => onOpen(folder)}>
              <FolderOpen size={14} />
              <span>
                <strong>{folder.split(/[\\/]/).at(-1)}</strong>
                <small>{folder}</small>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
function WorktreeDialog({
  workspace,
  onClose,
  onOpen,
  onCreate,
}: {
  workspace?: Workspace;
  onClose: () => void;
  onOpen: (folder: string) => void;
  onCreate: (branch: string, base: string) => Promise<void>;
}) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const here = workspace?.git.worktrees.find((tree) => tree.current) || workspace?.git.worktrees.find((tree) => samePath(tree.path, gitRootOf(workspace)));
  return (
    <Modal
      title="A fresh space for your next idea"
      subtitle="Separate checkouts. Independent sessions. One repository."
      onClose={onClose}
    >
      <div className="worktree-list">
        {workspace?.git.worktrees.map((tree) => (
          <button key={tree.path} onClick={() => onOpen(tree.path)}>
            <span className="worktree-icon">
              <GitBranch size={18} />
            </span>
            <span>
              <strong>{tree.branch}</strong>
              <small>{tree.path}</small>
            </span>
            {here && samePath(here.path, tree.path) ? (
              <span className="current-tag">Current</span>
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        ))}
      </div>
      {workspace?.git.available ? (
        <form
          className="dialog-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onCreate(branch, base);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="section-divider">
            <span>CREATE A WORKTREE</span>
          </div>
          <label className="field">
            <span>New branch name</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/my-next-idea"
            />
          </label>
          <label className="field">
            <span>Start from</span>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="HEAD, main, or a commit"
            />
          </label>
          <p className="settings-note">
            Created beside your repository in a dedicated worktrees folder. Your
            current checkout stays available.
          </p>
          {error && <p className="inline-error">{error}</p>}
          <div className="dialog-actions">
            <button className="primary" disabled={busy || !branch.trim()}>
              <Layers size={15} />
              {busy ? "Creating…" : "Create & switch"}
            </button>
          </div>
        </form>
      ) : (
        <p className="dialog-copy">
          Open a Git repository with at least one commit to create worktrees.
        </p>
      )}
    </Modal>
  );
}
function changeLetter(file: GitFile, kind: "staged" | "unstaged" | "conflict") {
  if (file.untracked) return "U";
  if (kind === "conflict") return file.code.trim() || "U";
  const side = kind === "staged" ? file.code[0] : file.code[1];
  return side && side !== " " && side !== "." ? side : file.code.trim();
}
function repoLabel(repo: Workspace, repos: Workspace[]) {
  const name = repo.name;
  if (repos.filter((item) => item.name === name).length < 2) return name;
  return gitRootOf(repo).replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") || name;
}
function GitPanel({
  repos,
  busy,
  action,
  onDiff,
  onFile,
  onGitHub,
  onWorktree,
  onError,
}: {
  repos: { workspace: Workspace; current: boolean }[];
  busy: boolean;
  action: (root: string, action: string, payload?: any) => Promise<boolean>;
  onDiff: (root: string, file: GitFile, staged: boolean) => void;
  onFile: (root: string, file: string) => void;
  onGitHub: (remote?: string) => void;
  onWorktree: (root: string) => void;
  onError: (text: string) => void;
}) {
  const current = repos.find((entry) => entry.current) || repos[0];
  const folder = gitRootOf(current.workspace);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [view, setView] = useState<"changes" | "history" | "github">("changes");
  const [prs, setPrs] = useState<any[]>([]);
  const [prError, setPrError] = useState("");
  useEffect(() => {
    if (view !== "github") return;
    let alive = true;
    setPrError("");
    setPrs([]);
    api("git:prs", folder)
      .then((result) => { if (alive) setPrs(result); })
      .catch((e) => {
        if (alive) setPrError("Install GitHub CLI (gh) and run gh auth login to list pull requests. " + e.message);
      });
    return () => { alive = false; };
  }, [view, folder]);
  const identity = (repo: { workspace: Workspace; current: boolean }) => {
    const tree = repo.workspace.git.worktrees.find((item) => item.current) || matchingWorktree(repo.workspace.git.worktrees, gitRootOf(repo.workspace));
    return { tree, linked: tree?.primary === false };
  };
  const header = (repo: { workspace: Workspace; current: boolean }) => {
    const { linked } = identity(repo);
    return (
      <div className="git-repo">
        <GitBranch size={14} />
        <strong>{repo.workspace.git.branch || "No branch"}</strong>
        <span title={gitRootOf(repo.workspace)}>{repoLabel(repo.workspace, repos.map((entry) => entry.workspace))}</span>
        {linked && <em className="current-tag">Worktree</em>}
        {repo.current && repos.length > 1 && <em className="current-tag">Current</em>}
      </div>
    );
  };
  const sync = (repo: Workspace) => {
    const root = gitRootOf(repo);
    return (
      <div className="git-sync">
        <button disabled={busy} onClick={() => action(root, "pull")}><ArrowDownToLine size={14} />Pull <small>{repo.git.behind}</small></button>
        <button disabled={busy} onClick={() => action(root, "push")}><ArrowUpFromLine size={14} />Push <small>{repo.git.ahead}</small></button>
        <IconButton label="Fetch remotes" disabled={busy} onClick={() => action(root, "fetch")}><RefreshCw size={14} /></IconButton>
      </div>
    );
  };
  const changes = (repo: { workspace: Workspace; current: boolean }) => {
    const root = gitRootOf(repo.workspace);
    const text = messages[root] || "";
    const groups = [
      { name: "MERGE CHANGES", kind: "conflict" as const, files: repo.workspace.git.files.filter((file) => file.conflict) },
      { name: "STAGED CHANGES", kind: "staged" as const, files: repo.workspace.git.files.filter((file) => file.staged) },
      { name: "CHANGES", kind: "unstaged" as const, files: repo.workspace.git.files.filter((file) => file.unstaged) },
    ].filter((group) => group.files.length);
    return (
      <div className="git-repo-block" key={root}>
        {header(repo)}
        {sync(repo.workspace)}
        <div className="commit-box">
          <textarea aria-label={`Commit message for ${repo.workspace.git.branch || repo.workspace.name}`} placeholder="What's changed?" rows={3} value={text} onChange={(e) => setMessages((old) => ({ ...old, [root]: e.target.value }))} />
          <button className="primary" disabled={busy || !text.trim() || !repo.workspace.git.files.some((file) => file.staged)} onClick={async () => { if (await action(root, "commit", { message: text })) setMessages((old) => ({ ...old, [root]: "" })); }}>
            <GitCommitHorizontal size={15} />Commit staged changes
          </button>
        </div>
        {groups.map((group) => (
          <div className="git-file-group" key={group.name}>
            <div className="git-group-heading">
              <span>{group.name}<i>{group.files.length}</i></span>
              <IconButton label={group.kind === "staged" ? "Unstage all" : group.kind === "conflict" ? "Mark all resolved" : "Stage all"} disabled={busy} onClick={() => action(root, group.kind === "staged" ? "unstage" : "stage", { paths: group.files.map((file) => file.path) })}>
                {group.kind === "staged" ? <Minus size={14} /> : <Plus size={14} />}
              </IconButton>
            </div>
            {group.files.map((file) => {
              const detail = file.original ? `from ${file.original}` : file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
              return (
                <div className="git-file-row" key={`${group.kind}:${file.path}`}>
                  <button className="git-file-name" onClick={() => onDiff(root, file, group.kind === "staged")} title={file.original ? `${file.original} → ${file.path}` : file.path}>
                    <FileIcon name={file.path} />
                    <span>{file.path.split("/").at(-1)}{detail && <small>{detail}</small>}</span>
                    <em>{changeLetter(file, group.kind)}</em>
                  </button>
                  <IconButton label={`Open ${file.path}`} onClick={() => onFile(root, file.path)}><ExternalLink size={12} /></IconButton>
                  <IconButton label={`${group.kind === "staged" ? "Unstage" : group.kind === "conflict" ? "Mark resolved" : "Stage"} ${file.path}`} disabled={busy} onClick={() => action(root, group.kind === "staged" ? "unstage" : "stage", { paths: [file.path] })}>
                    {group.kind === "staged" ? <Minus size={13} /> : <Plus size={13} />}
                  </IconButton>
                </div>
              );
            })}
          </div>
        ))}
        {!repo.workspace.git.files.length && <div className="git-clean"><span><Check size={20} /></span><strong>All clear.</strong><p>This working tree is clean.</p></div>}
        {repo.workspace.git.truncated && <p className="git-truncated">Showing the first 10,000 changes in this worktree.</p>}
      </div>
    );
  };
  const ordered = current.current ? [current, ...repos.filter((entry) => entry !== current)] : repos;
  return (
    <div className="git-panel">
      <div className="git-nav">
        {(["changes", "history", "github"] as const).map((tab) => (
          <button key={tab} className={view === tab ? "selected" : ""} onClick={() => setView(tab)}>
            {tab === "github" ? "GitHub" : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {busy && <div className="git-working"><Busy text="Updating repository" /></div>}
      {view === "changes" ? (
        <div className="git-files-scroll">{ordered.map((repo) => changes(repo))}</div>
      ) : view === "history" ? (
        <>
          {header(current)}
          <div className="git-history">
            {current.workspace.git.log.map((commit) => (
              <div key={commit.hash}>
                <GitCommitHorizontal size={16} />
                <span>
                  <strong>{commit.subject}</strong>
                  <small>{commit.author} · {commit.when}</small>
                  <code>{commit.hash}</code>
                </span>
              </div>
            ))}
            {!current.workspace.git.log.length && <p className="dialog-copy">Your first commit will appear here.</p>}
          </div>
        </>
      ) : (
        <>
          {header(current)}
          <div className="github-panel">
            <button className="secondary" onClick={() => onGitHub(current.workspace.git.remote)}><ExternalLink size={14} />Open on GitHub</button>
            <div className="section-divider"><span>OPEN PULL REQUESTS</span></div>
            {prError ? <p className="inline-error">{prError}</p> : prs.length ? prs.map((pr) => (
              <button className="pr-row" key={pr.number} onClick={() => api("external:open", pr.url).catch((e) => onError(e.message))}>
                <GitPullRequest size={15} />
                <span><strong>{pr.title}</strong><small>#{pr.number} · {pr.isDraft ? "Draft" : pr.headRefName}</small></span>
              </button>
            )) : <p className="dialog-copy">No open pull requests.</p>}
          </div>
        </>
      )}
      <div className="git-bottom">
        <button onClick={() => onWorktree(folder)}>
          <Layers size={15} />
          Manage worktrees
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}
function Palette({
  root,
  onClose,
  onFile,
  onAction,
}: {
  root: string;
  onClose: () => void;
  onFile: (path: string) => void;
  onAction: (action: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!root || !query || query.startsWith(">")) {
      setFiles([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        api<Entry[]>("files:search", root, query)
          .then((data) => {
            if (alive) setFiles(data);
          })
          .catch((e) => {
            if (alive) setError(e.message);
          })
          .finally(() => {
            if (alive) setLoading(false);
          }),
      180,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, root]);
  const commands = [
    ...agents.map((agent) => ({
      label: `New ${agentNames[agent]} session`,
      key: agent,
    })),
    { label: "Open workspace", key: "open" },
    { label: "New chat without workspace", key: "projectless" },
    { label: "Create or switch worktree", key: "worktrees" },
    { label: "Customize workspace", key: "settings" },
  ].filter((c) =>
    c.label
      .toLowerCase()
      .includes(query.replace(/^>/, "").trim().toLowerCase()),
  );
  return (
    <Modal
      title="Go anywhere"
      subtitle="Find files, switch agents, or type > for commands."
      onClose={onClose}
    >
      <div className="palette-input">
        <Search size={17} />
        <input
          aria-label="Search files and commands"
          placeholder="Search your workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-results">
        {loading && <Busy text="Finding files" />}
        {error && <p className="inline-error">{error}</p>}
        {files.map((file) => (
          <button key={file.path} onClick={() => onFile(file.path)}>
            <FileIcon name={file.path} />
            <span>{file.path}</span>
            <ArrowRight size={13} />
          </button>
        ))}
        {commands.map((command) => (
          <button key={command.key} onClick={() => onAction(command.key)}>
            <Command size={14} />
            <span>{command.label}</span>
            <ArrowRight size={13} />
          </button>
        ))}
        {query && !loading && !files.length && !commands.length && (
          <p className="dialog-copy">No matches. Try part of a file name.</p>
        )}
      </div>
    </Modal>
  );
}
function InputDialog({
  title,
  subtitle,
  placeholder,
  onClose,
  onSubmit,
}: {
  title: string;
  subtitle: string;
  placeholder: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSubmit(value);
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        <input
          aria-label={title}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
        />
        {error && <p className="inline-error">{error}</p>}
        <div className="dialog-actions">
          <button className="primary" disabled={!value.trim()}>
            Create file
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TabDialog({
  tab,
  onClose,
  onUpdate,
  defaultColor,
}: {
  tab: Tab;
  onClose: () => void;
  onUpdate: (changes: Partial<Tab>) => void;
  defaultColor: string;
}) {
  return (
    <Modal title="Make this tab yours" onClose={onClose}>
      <div className="dialog-form">
        <label className="field">
          <span>Tab name</span>
          <input
            value={tab.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
          />
        </label>
        <label className="color-control">
          <span>Tab color</span>
          <input
            aria-label="Tab color"
            type="color"
            value={tab.color || defaultColor}
            onChange={(e) => onUpdate({ color: e.target.value })}
          />
        </label>
        <div className="dialog-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
function PiDialog({
  value: v,
  sessionName,
  onReply,
}: {
  value: PiRequest;
  sessionName?: string;
  onReply: (value: any) => void;
}) {
  const [text, setText] = useState(v.prefill || "");
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const send = async (response: any) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try { await onReply(response); } finally { sendingRef.current = false; setSending(false); }
  };
  const answerLists = Object.fromEntries((v.questions || []).map((q) => {
    const typed = custom[q.id]?.trim();
    return [q.id, typed && !q.multiSelect ? [typed] : [...(answers[q.id] || []), ...(typed ? [typed] : [])]];
  }));
  return (
    <Modal
      title={v.title || "Pi needs your input"}
      subtitle={sessionName}
      onClose={() => void send({ cancelled: true })}
    >
      <div className="dialog-form">
        {v.message && <pre className="agent-request-detail">{v.message}</pre>}
        {v.url && <button className="secondary" onClick={() => api("external:open", v.url).catch(() => {})}>Open authorization page ↗</button>}
        {v.method === "custom" ? <PiCustomControl lines={v.lines || []} onInput={(input) => send({ input })} /> : v.questions ? <>
          {v.questions.map((q) => <fieldset className="agent-question" key={q.id}>
            <legend>{q.header ? `${q.header} · ` : ""}{q.question}</legend>
            {q.options?.map((option) => <label className="agent-question-option" key={option.label}>
              <input type={q.multiSelect ? "checkbox" : "radio"} name={q.id} checked={!!answers[q.id]?.includes(option.label)} disabled={sending}
                onChange={() => setAnswers((old) => ({ ...old, [q.id]: q.multiSelect ? old[q.id]?.includes(option.label) ? old[q.id].filter((label) => label !== option.label) : [...(old[q.id] || []), option.label] : [option.label] }))} />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>)}
            <input type={q.isSecret ? "password" : "text"} aria-label={q.question} placeholder={q.options?.length ? "Or write your answer" : "Your answer"}
              disabled={sending} value={custom[q.id] || ""} onChange={(e) => setCustom((old) => ({ ...old, [q.id]: e.target.value }))} />
          </fieldset>)}
          <div className="dialog-actions"><button className="primary" disabled={sending || v.questions.some((q) => !custom[q.id]?.trim() && !answers[q.id]?.length)}
            onClick={() => void send({ answers: Object.fromEntries(Object.entries(answerLists).map(([id, choices]) => [id, choices.join(", ")])), answerLists,
              selections: Object.fromEntries(v.questions!.map((q) => [q.id, custom[q.id]?.trim() ? [...(q.multiSelect ? answers[q.id] || [] : []), "Other"] : answers[q.id] || []])), notes: custom })}>Send answers</button></div>
        </> : v.method === "select" ? (
          v.options?.map((option) => (
            <button
              className="secondary"
              key={option}
              disabled={sending}
              onClick={() => void send({ value: option })}
            >
              {option}
            </button>
          ))
        ) : v.method === "native" ? <div className="dialog-actions"><button className="primary" disabled={sending} onClick={() => void send({ cancelled: true, native: true })}>Cancel and open Native CLI</button></div>
        : v.method === "form" ? <AgentForm schema={v.schema} disabled={sending} onSend={(content) => void send({ content })} onNative={() => void send({ cancelled: true, native: true })} />
        : v.method === "confirm" ? (
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={sending}
              onClick={() => void send({ confirmed: false })}
            >
              No
            </button>
            <button
              className="primary"
              disabled={sending}
              onClick={() => void send({ confirmed: true })}
            >
              Yes
            </button>
          </div>
        ) : (
          <>
            <textarea
              aria-label={v.title || "Your response"}
              rows={v.method === "editor" ? 8 : 2}
              placeholder={v.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={sending}
                onClick={() => void send({ value: text })}
              >
                Send response
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
