import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
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
} from "./types";
import { defaults, loadSettings, styleVars, agentNames } from "./settings";
import { Modal, IconButton, FileTree, FileIcon, Busy } from "./Components";
import SettingsPanel from "./SettingsPanel";
import Conversation, { AgentMark } from "./Conversation";
import NativeTerminal from "./NativeTerminal";
import ProjectSidebar, { restoreProjects, sameProject, type Project } from "./ProjectSidebar";
import { useUpdates } from "./UpdatesPanel";
import { AccountLogin, AccountPicker, useAccounts } from "./AccountsPanel";
import ContextIndicator from "./ContextIndicator";
import SessionTabs from "./SessionTabs";
const EditorPane = lazy(() => import("./EditorPane"));
const agents: Agent[] = ["shell", "pi", "codex", "claude", "grok"];
const docKey = (doc: { root: string; path: string }) =>
  `${doc.root}|${doc.path}`;
type Bootstrap = {
  recent: string[];
  platform: string;
  agents: Record<string, { available: boolean; file?: string }>;
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
  });
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>(restoreProjects);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const isHiddenProject = (folder: string) => projectsRef.current.some((p) => p.hidden && sameProject(p.root, folder));
  const rememberProject = (folder: string, name?: string, show = false) => {
    if (!folder) return;
    setProjects((old) => old.some((p) => sameProject(p.root, folder)) ? show ? old.map((p) => sameProject(p.root, folder) ? { ...p, hidden: false, collapsed: false } : p) : old : [...old, { root: folder, name: name || folder.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || folder }]);
  };
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [selectedRoot, setSelectedRoot] = useState("");
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
  const [panel, setPanel] = useState<"files" | "git">("files");
  const [sidebar, setSidebar] = useState(true);
  const verticalChats = settings.chatLayout === "vertical" && sidebar;
  useEffect(() => {
    const element = contextBar.current;
    if (!element) return;
    const measure = () => setNativeTop(element.offsetTop + element.offsetHeight);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [activeId, verticalChats]);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeDocKey, setActiveDocKey] = useState("");
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [split, setSplit] = useState(50);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [signIn, setSignIn] = useState<SignInProfile | null>(null);
  const signInLock = useRef(false);
  const [settingsSection, setSettingsSection] = useState("appearance");
  const [agentMenu, setAgentMenu] = useState(false);
  const [agentMenuRoot, setAgentMenuRoot] = useState<string | undefined>();
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const agentMenuTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!agentMenu) return;
    if (!agentMenuRef.current?.contains(document.activeElement)) agentMenuTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    agentMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [agentMenu, agentMenuRoot, verticalChats]);
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
  const piRequest = uiRequests[0];
  const [diff, setDiff] = useState<{
    path: string;
    text: string;
    staged: boolean;
  } | null>(null);
  const [spark, setSpark] = useState<{ x: number; y: number; id: number }[]>(
    [],
  );
  const active = tabs.find((t) => t.id === activeId);
  if (active && !active.projectless) projectTabsRef.current[active.root] = active.id;
  const root = active?.projectless ? "" : active?.root || selectedRoot;
  const rootRef = useRef(root);
  rootRef.current = root;
  const workspace = workspaces[root];
  const checkoutPath = active?.cwd && active.cwd !== active.root ? active.cwd : active?.projectless ? "" : root;
  const statusWorkspace = checkoutPath ? workspaces[checkoutPath] : undefined;
  const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const checkout = statusWorkspace?.git.worktrees.find((tree) => normalizePath(checkoutPath).startsWith(normalizePath(tree.path) + "/") || normalizePath(checkoutPath) === normalizePath(tree.path));
  const linkedCheckout = checkout && statusWorkspace?.git.worktrees[0] !== checkout;
  const checkoutName = (checkout?.path || checkoutPath).replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  useEffect(() => {
    if (!active?.cwd || active.cwd === active.root) return;
    let alive = true;
    api<Workspace>("workspace:open", active.cwd).then((value) => {
      if (alive) setWorkspaces((old) => ({ ...old, [value.root]: value, [active.cwd!]: value }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [active?.id, active?.cwd]);
  const projectDocsRef = useRef<Record<string, string>>({});
  const activeDoc = root ? docs.find((d) => d.root === root && docKey(d) === activeDocKey) || docs.find((d) => d.root === root && docKey(d) === projectDocsRef.current[root]) : undefined;
  if (activeDoc) projectDocsRef.current[root] = docKey(activeDoc);
  useEffect(() => setAttachment(""), [activeId]);
  useEffect(() => {
    api("editor:dirty", docs.filter((d) => d.content !== d.saved).length).catch(
      () => {},
    );
  }, [docs]);
  const notify = useCallback((text: string) => {
    setNotice(text);
  }, []);
  const signInChat = async (id: string) => {
    if (signInLock.current || signIn) return;
    signInLock.current = true;
    try { setSignIn(await api<SignInProfile>("accounts:login-session", id)); }
    catch (e: any) { notify(e.message); }
    finally { signInLock.current = false; }
  };
  const persist = () => {
    try {
      localStorage.setItem(
        "lumen.tabs",
        JSON.stringify(
          tabsRef.current
            .filter(
              (t) => t.mode === "rich" || t.messages.length || t.sessionRef,
            )
            .map((t) => ({
              ...t,
              nativeDraft: undefined,
              mode: "rich",
              busy: false,
              messages: t.messages
                .slice(-200)
                .map((m) => ({ ...m, text: m.text.slice(-80000) })),
            })),
        ),
      );
      localStorage.setItem("lumen.last", rootRef.current);
      localStorage.setItem("lumen.active", activeIdRef.current);
      localStorage.setItem("lumen.projects", JSON.stringify(projectsRef.current));
    } catch {
      notify("Conversation storage is full. Close older tabs to free space.");
    }
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
        persist();
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
  ) => {
    const config = settingsRef.current.agents[agent];
    try {
      const request = {
        root: folder,
        cwd: startCwd,
        agent,
        mode,
        ...config,
        model: resume?.model ?? config.model,
        effort: resume?.effort ?? config.effort ?? "",
        workMode: resume?.workMode || "",
        sessionRef: resume?.sessionRef || "",
        scratchId: resume?.scratchId || scratchId || "",
        controlId: resume?.controlId || "",
        autoCompactTokens: resume?.autoCompactTokens ?? null,
        mcpOverrides: resume?.mcpOverrides || {},
        accountId: resume ? resume.accountId || "" : accountId,
        queuedMessages: resume?.queuedMessages || [],
      };
      let created: { id: string; root: string; cwd: string; projectless: boolean; scratchId: string; controlId: string; accountId: string; accountName: string };
      try { created = await api("session:create", request); }
      catch (error) {
        if (!resume || !startCwd) throw error;
        created = await api("session:create", { ...request, cwd: undefined });
        notify("Saved working folder is unavailable. This chat reopened at its workspace root.");
      }
      const tab: Tab = {
        id: created.id,
        root: created.root,
        cwd: created.cwd,
        projectless: created.projectless,
        scratchId: created.scratchId,
        agent,
        mode,
        name: resume?.name || agentNames[agent],
        accountId: created.accountId,
        accountName: created.accountName,
        color: resume?.color,
        messages: resume?.messages || [],
        draft: resume?.draft || "",
        busy: false,
        sessionRef: resume?.sessionRef,
        model: resume?.model ?? config.model,
        effort: resume?.effort ?? config.effort ?? "",
        workMode: resume?.workMode || "",
        controlId: created.controlId,
        autoCompactTokens: resume?.autoCompactTokens ?? null,
        mcpOverrides: resume?.mcpOverrides || {},
        contextTokens: resume?.contextTokens ?? null,
        contextWindow: resume?.contextWindow ?? null,
        contextStale: resume?.contextTokens != null,
        queuedMessages: resume?.queuedMessages?.map((m) => ({ ...m, state: "queued" })) || [],
        queuePaused: !!resume?.queuedMessages?.length,
      };
      setTabs((old) => [...old, tab]);
      if (!resume || created.projectless || !isHiddenProject(created.root)) {
        setActiveId(tab.id);
        setSelectedRoot(folder);
      }
      if (!created.projectless) rememberProject(created.root, undefined, !resume);
      setAgentMenu(false);
      setAgentMenuRoot(undefined);
      return tab;
    } catch (e: any) {
      notify(e.message);
    }
  };
  const openWorkspace = async (folder?: string) => {
    try {
      const next = await api<Workspace | null>(
        folder ? "workspace:open" : "workspace:choose",
        ...(folder ? [folder] : []),
      );
      if (!next) return;
      setWorkspaces((old) => ({ ...old, [next.root]: next }));
      setSelectedRoot(next.root);
      rememberProject(next.root, next.name, true);
      setDialog(null);
      const existing = tabsRef.current.find((t) => t.id === projectTabsRef.current[next.root]) || tabsRef.current.find((t) => !t.projectless && sameProject(t.root, next.root));
      if (existing) setActiveId(existing.id);
      else await addTab("shell", "rich", next.root);
      setBoot((old) => ({
        ...old,
        recent: [next.root, ...old.recent.filter((x) => x !== next.root)],
      }));
      return next;
    } catch (e: any) {
      notify(e.message);
    }
  };
  const removeProject = (project: Project) => {
    const remaining = projectsRef.current.filter((p) => !p.hidden && !sameProject(p.root, project.root));
    setProjects((old) => old.map((p) => sameProject(p.root, project.root) ? { ...p, hidden: true } : p));
    if (sameProject(rootRef.current, project.root)) {
      const next = remaining.find((p) => p.pinned) || remaining[0];
      const existing = next ? tabsRef.current.find((t) => t.id === projectTabsRef.current[next.root]) || tabsRef.current.find((t) => !t.projectless && sameProject(t.root, next.root)) : tabsRef.current.find((t) => t.projectless);
      setActiveId(existing?.id || "");
      setSelectedRoot(existing && !existing.projectless ? existing.root : "");
      if (!existing && next) void openWorkspace(next.root);
    }
    notify(`${project.name} removed from the sidebar. Chats stay available and running sessions continue. Open the folder again to return.`);
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
        let persisted: Partial<Tab>[] = [];
        try {
          persisted = JSON.parse(localStorage.getItem("lumen.tabs") || "[]");
        } catch {}
        const last = localStorage.getItem("lumen.last");
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
        const savedActive = localStorage.getItem("lumen.active");
        let restoredActive = "";
        const restoring = persisted;
        const savedTab = persisted.find((t) => t.id === savedActive);
        if (savedTab && !restoring.includes(savedTab)) restoring.splice(0, 1, savedTab);
        for (const tab of restoring) {
          if (tab.agent && tab.mode === "rich" && (tab.projectless || (tab.root && opened[tab.root]))) {
            const restored = await addTab(tab.agent, "rich", tab.projectless ? "" : tab.root, tab, tab.cwd);
            if (tab.id === savedActive && restored && (tab.projectless || !isHiddenProject(restored.root))) restoredActive = restored.id;
          }
        }
        if (last && opened[last] && !isHiddenProject(last)) {
          setSelectedRoot(last);
          if (!persisted.some((t) => t.root === last))
            await addTab("shell", "rich", last);
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
              rememberProject(next.root, next.name, true);
              setWorkspaces((old) => ({ ...old, [next.root]: next }));
              const tab = await addTab("shell", "native", next.root, undefined, opened.cwd);
              if (!tab) continue;
              setBoot((old) => ({ ...old, recent: [next.root, ...old.recent.filter((x) => x !== next.root)] }));
              setDialog(null);
              if (opened.file) {
                try {
                  const result = await api("files:read", next.root, opened.file);
                  const doc: Doc = { root: next.root, ...result, saved: result.content };
                  setDocs((old) => old.some((d) => docKey(d) === docKey(doc)) ? old : [...old, doc]);
                  setActiveDocKey(docKey(doc));
                } catch (error: any) { notify(`Terminal opened. ${error.message}`); }
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
      persist();
    }, 800);
    return () => clearTimeout(timer);
  }, [tabs, root, activeId, projects, loaded]);
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
                exited: false,
                contextStale: true,
              }
            : t,
        ),
      );
    } catch (e: any) {
      notify(e.message);
    }
  };
  const openNativeCommand = async (draft: string) => {
    if (!active) return;
    try {
      const result = await api("session:mode", active.id, "native");
      setTabs((old) => old.map((t) => t.id === active.id ? { ...t, mode: result.mode, sessionRef: result.sessionRef, exited: false, contextStale: true, nativeDraft: draft } : t));
    } catch (e: any) { notify(e.message); }
  };
  const refreshGit = async (folder = root) => {
    if (!folder) return;
    try {
      const git = await api("git:status", folder);
      setWorkspaces((old) => Object.fromEntries(Object.entries(old).map(([key, value]) =>
        [key, normalizePath(value.root) === normalizePath(folder) ? { ...value, git } : value])));
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
    const flush = () => {
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
              t.phase = undefined;
              t.turn = e.turn;
              t.started = Date.now();
            } else if (e.type === "done") {
              t.busy = false;
              t.phase = undefined;
              t.exitCode = e.code;
              t.duration = Date.now() - (t.started || Date.now());
              if (e.sessionRef) t.sessionRef = e.sessionRef;
            } else if (e.type === "phase") t.phase = e.phase;
            else if (e.type === "session") t.sessionRef = e.sessionRef;
            else if (e.type === "config") { t.model = e.model; t.effort = e.effort; t.workMode = e.workMode; }
            else if (e.type === "session-controls") { t.autoCompactTokens = e.autoCompactTokens; t.mcpOverrides = e.mcpOverrides; }
            else if (e.type === "context") { t.contextTokens = e.contextTokens; t.contextWindow = e.contextWindow; t.contextStale = false; }
            else if (e.type === "queue") { t.queuedMessages = e.queuedMessages; t.queuePaused = e.queuePaused; }
            else if (e.type === "user-message" && e.messageId && !t.messages.some((m) => m.id === e.messageId)) t.messages.push({ id: e.messageId, role: "user", text: e.text || "", delivery: e.delivery });
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
                    ? e.detail || ""
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
        if (["select", "confirm", "input", "editor", "questions"].includes(request.method))
          setUiRequests((old) => [...old, { session: e.id, request }]);
        else if (request.method === "notify")
          notify(request.message || "Pi notification");
        return;
      }
      if (e.type === "terminal") return;
      queue.push(e);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      cancelAnimationFrame(frame);
    };
  }, []);
  const send = async (text: string) => {
    if (!active) return false;
    const messageId = crypto.randomUUID();
    const message = attachment
      ? `${text}\n\nFile reference: ${attachment}`
      : text;
    if (active.agent !== "shell") {
      try {
        await api("session:submit", active.id, { id: messageId, text: message });
        if (activeIdRef.current === active.id) setAttachment((current) => current === attachment ? "" : current);
        return true;
      } catch (e: any) { notify(e.message); return false; }
    }
    setTabs((old) =>
      old.map((t) =>
        t.id === active.id
          ? {
              ...t,
              busy: true,
              phase: undefined,
              started: Date.now(),
              messages: [
                ...t.messages,
                { id: messageId, role: "user", text: message },
              ],
            }
          : t,
      ),
    );
    try {
      await api("session:send", active.id, message);
      if (activeIdRef.current === active.id) setAttachment((current) => current === attachment ? "" : current);
      return true;
    } catch (e: any) {
      setTabs((old) =>
        old.map((t) => (t.id === active.id ? { ...t, busy: false, messages: t.messages.filter((m) => m.id !== messageId) } : t)),
      );
      notify(e.message);
      return false;
    }
  };
  const closeTab = (tab: Tab) => {
    const action = () => {
      api("session:close", tab.id).catch((e) => notify(e.message));
      setTabs((old) => {
        const next = old.filter((t) => t.id !== tab.id);
        if (activeIdRef.current === tab.id) {
          const sibling = next.filter((t) => tab.projectless ? t.projectless : !t.projectless && sameProject(t.root, tab.root)).at(-1);
          setActiveId(sibling?.id || "");
          setSelectedRoot(tab.projectless ? "" : tab.root);
        }
        return next;
      });
    };
    if (tab.busy)
      setConfirmation({
        title: "Stop and close this tab?",
        text: "This stops the current turn. Your saved files and CLI history remain available.",
        action,
      });
    else action();
  };
  const openFile = async (file: string) => {
    if (!root) return;
    const normalized = file
      .replace(/^file:\/\//, "")
      .replace(/^\//, "")
      .split("#")[0];
    const existing = docs.find((d) => d.root === root && d.path === normalized);
    if (existing) {
      setActiveDocKey(docKey(existing));
      return;
    }
    try {
      const result = await api("files:read", root, normalized);
      const doc: Doc = { root, ...result, saved: result.content };
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
  const gitAction = async (action: string, payload?: any) => {
    if (!root || gitBusy) return false;
    setGitBusy(true);
    try {
      const git = await api("git:action", root, action, payload);
      setWorkspaces((old) => ({ ...old, [root]: { ...old[root], git } }));
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
      if ((e.target as HTMLElement)?.closest(".native-terminal, .modal")) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "s") {
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
        setDialog("worktrees");
      } else if (e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        addTab("shell");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const resize = (event: React.PointerEvent, kind: "sidebar" | "split") => {
    const start = event.clientX;
    const initial = kind === "sidebar" ? sidebarWidth : split;
    const host = event.currentTarget.parentElement!;
    const width = host.clientWidth;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (kind === "sidebar")
        setSidebarWidth(
          Math.min(420, Math.max(200, initial + e.clientX - start)),
        );
      else
        setSplit(
          Math.min(
            75,
            Math.max(25, initial + ((e.clientX - start) / width) * 100),
          ),
        );
    };
    const target = event.currentTarget;
    const end = () => {
      target.removeEventListener("pointermove", move as any);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move as any);
    target.addEventListener("pointerup", end);
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
  const hasNative = tabs.some((t) => t.mode === "native");
  const selectTab = (tab: Tab) => {
    setActiveId(tab.id); setSelectedRoot(tab.projectless ? "" : tab.root);
    if (!tab.projectless) setProjects((old) => old.map((p) => sameProject(p.root, tab.root) && p.collapsed ? { ...p, collapsed: false } : p));
  };
  const tabActions = { onSelect: selectTab, onCustomize: (tab: Tab) => { selectTab(tab); setDialog("tab"); }, onClose: closeTab };
  const toggleChatLayout = () => { setSettings((s) => ({ ...s, chatLayout: s.chatLayout === "vertical" ? "horizontal" : "vertical" })); setSidebar(true); };
  const sessionActions = <div className="tab-actions">
    <IconButton label={settings.chatLayout === "vertical" ? "Use horizontal tabs" : "Use vertical chats"} onClick={toggleChatLayout}>{settings.chatLayout === "vertical" ? <PanelTop size={16} /> : <ListTree size={16} />}</IconButton>
    <div className="agent-menu-anchor">
      <IconButton label="New agent session" active={agentMenu} onClick={() => { setAgentMenuRoot(undefined); setAgentMenu(!agentMenu); }}><Plus size={18} /></IconButton>
      {agentMenu && <div className="agent-menu" id="new-chat-menu" ref={agentMenuRef} role="group" aria-label="Choose an agent" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAgentMenu(false); if (agentMenuTrigger.current?.isConnected) agentMenuTrigger.current.focus(); } }}><div className="menu-label">NEW CHAT{agentMenuRoot !== undefined ? ` · ${agentMenuRoot ? projects.find((p) => sameProject(p.root, agentMenuRoot))?.name || "Project" : "No workspace"}` : ""}</div>
        {agents.map((agent) => <button key={agent} onClick={() => addTab(agent, "rich", agentMenuRoot ?? root)}><AgentMark agent={agent} color={settings.agents[agent].color} size={18} /><span>{agentNames[agent]}</span><small>{agent === "shell" ? "Shell" : boot.agents[agent]?.available ? "Ready" : "Configure"}</small></button>)}
        <div className="menu-divider" /><button onClick={() => addTab("shell", "rich", "")}><TerminalSquare size={17} /><span>New chat without workspace</span></button>
        <button onClick={() => { setAgentMenu(false); setDialog("worktrees"); }}><Layers size={17} /><span>New worktree</span><kbd>Ctrl ⇧ N</kbd></button>
      </div>}
    </div>
    <IconButton label="Settings" onClick={() => setDialog("settings")}><MoreHorizontal size={18} /></IconButton>
  </div>;
  return (
    <div
      className={`app ${verticalChats ? "vertical-layout" : "horizontal-layout"} ${settings.motion ? "" : "motion-off"} ${settings.theme === "Paper" ? "light" : ""}`}
      style={styleVars(settings) as CSSProperties}
      onClick={(e) => {
        if (!settings.playful) return;
        const id = Date.now();
        setSpark((old) => [
          ...old.slice(-8),
          { x: e.clientX, y: e.clientY, id },
        ]);
        setTimeout(
          () => setSpark((old) => old.filter((s) => s.id !== id)),
          700,
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
      <div className="app-body">
        <nav className="rail" aria-label="Workspace panels">
          <div>
            <IconButton
              label="File explorer"
              active={panel === "files" && sidebar}
              onClick={() => {
                setPanel("files");
                setSidebar(true);
              }}
            >
              <Files size={21} />
            </IconButton>
            <IconButton
              label="Source control"
              active={panel === "git" && sidebar}
              onClick={() => {
                setPanel("git");
                setSidebar(true);
              }}
            >
              <GitBranch size={21} />
              {workspace?.git.files.length > 0 && (
                <span className="rail-badge">{workspace.git.files.length}</span>
              )}
            </IconButton>
            <IconButton
              label="Worktrees"
              onClick={() => setDialog("worktrees")}
            >
              <Layers size={21} />
            </IconButton>
            <IconButton label="New terminal" onClick={() => addTab("shell")}>
              <TerminalSquare size={21} />
            </IconButton>
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
        {sidebar && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <ProjectSidebar projects={projects.filter((p) => !p.hidden)} activeRoot={root} ready={loaded}
                tabs={tabs} activeId={activeId} settings={settings} {...tabActions} onLayout={toggleChatLayout} newChatRoot={agentMenu ? agentMenuRoot : undefined}
                onNewChat={(folder) => {
                  const open = () => { setAgentMenuRoot(folder); setAgentMenu(true); };
                  if (folder) void openWorkspace(folder).then((value) => { if (value) open(); }); else open();
                }}
                counts={Object.fromEntries(projects.map((p) => [p.root, tabs.filter((t) => !t.projectless && sameProject(t.root, p.root)).length]))}
                onOpen={(project) => { void openWorkspace(project.root); }} onAdd={() => setDialog("open")}
                onChange={(next) => setProjects((old) => [...next, ...old.filter((p) => p.hidden)])} onRemove={removeProject} />
              {!verticalChats && <button
                className="workspace-switch"
                onClick={() => setDialog("open")}
              >
                <span className="workspace-icon">
                  <FolderOpen size={18} />
                </span>
                <span>
                  <strong>{workspace?.name || (active ? "No workspace" : "Your workspace")}</strong>
                  <small>
                    {workspace?.git.available
                      ? workspace.git.branch
                      : active ? "Open a folder anytime" : "Open a folder to begin"}
                  </small>
                </span>
                <ChevronDown size={13} />
              </button>}
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
                    disabled={!workspace}
                    onClick={() => refreshGit()}
                  >
                    <RefreshCw size={14} />
                  </IconButton>
                  <IconButton
                    label="Hide sidebar"
                    onClick={() => setSidebar(false)}
                  >
                    <PanelLeftClose size={14} />
                  </IconButton>
                </div>
              </div>
              {workspace ? (
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
                        onClick={() => setDialog("worktrees")}
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
                ) : (
                  <GitPanel
                    workspace={workspace}
                    busy={gitBusy}
                    action={gitAction}
                    onDiff={async (file, staged) => {
                      try {
                        setDiff({
                          path: file.path,
                          staged,
                          text: await api("git:diff", root, file.path, staged),
                        });
                      } catch (e: any) {
                        notify(e.message);
                      }
                    }}
                    onFile={openFile}
                    onGitHub={() => {
                      const url = githubURL(workspace.git.remote);
                      if (url)
                        api("external:open", url).catch((e) =>
                          notify(e.message),
                        );
                      else
                        notify(
                          "Add a GitHub origin remote to open this repository.",
                        );
                    }}
                    onWorktree={() => setDialog("worktrees")}
                    onError={notify}
                  />
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
            <div
              className="resizer sidebar-resizer"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(e) => resize(e, "sidebar")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight")
                  setSidebarWidth((n) => Math.min(420, n + 10));
                if (e.key === "ArrowLeft")
                  setSidebarWidth((n) => Math.max(200, n - 10));
              }}
            />
          </>
        )}
        <main className="main">
          {(!verticalChats || !active) && <div className="tabbar">
            {!sidebar && <IconButton label="Show sidebar" onClick={() => setSidebar(true)}><PanelLeftOpen size={17} /></IconButton>}
            <SessionTabs tabs={tabs.filter((tab) => root ? !tab.projectless && sameProject(tab.root, root) : tab.projectless)} activeId={activeId} settings={settings} label="Workspace chats" {...tabActions} />
            {sessionActions}
          </div>}
          {active ? (
            <>
              <div className="contextbar" ref={contextBar}>
                <div>
                  <span
                    className="live-dot"
                    style={{ background: activeColor }}
                  />
                  <span>{workspace?.name || "No workspace"}</span>
                  {verticalChats && <strong className="active-chat-name" title={active.name}>{active.name}</strong>}
                  <ChevronDown size={11} />
                  {workspace ? <button
                    className="branch-chip"
                    onClick={() => setDialog("worktrees")}
                  >
                    <GitBranch size={12} />
                    {workspace.git.branch || "folder"}
                  </button> : <button className="branch-chip" onClick={() => openWorkspace()}>
                    <FolderOpen size={12} />
                    Open workspace
                  </button>}
                </div>
                <div>
                  {active.agent !== "shell" && <ContextIndicator tab={active} />}
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
              </div>
              <div className="workspace-content">
                <div
                  className="session-pane"
                  style={{
                    width: activeDoc && !editorExpanded ? `${split}%` : "100%",
                    display: editorExpanded && activeDoc ? "none" : undefined,
                  }}
                >
                  {active.mode === "rich" && (
                    <Conversation
                      key={active.id}
                      tab={active}
                      settings={settings}
                      onConfig={(change) => setTabs((old) => old.map((t) => t.id === active.id ? { ...t, ...change } : t))}
                      onSend={send}
                      onStop={() =>
                        api("session:stop", active.id).catch((e) =>
                          notify(e.message),
                        )
                      }
                      onFile={openFile}
                      onSignIn={() => void signInChat(active.id)}
                      onFollowFolder={openWorkspace}
                      onNative={(draft) => typeof draft === "string" ? openNativeCommand(draft) : switchView()}
                      attachment={attachment}
                      onAttach={() => {
                        if (activeDoc && activeDoc.root === root)
                          setAttachment(activeDoc.path);
                        else {
                          notify("Open a file to add its path as context.");
                          setDialog("palette");
                        }
                      }}
                      onDetach={() => setAttachment("")}
                    />
                  )}
                </div>
                {activeDoc && (
                  <>
                    {!editorExpanded && (
                      <div
                        className="resizer editor-resizer"
                        role="separator"
                        aria-label="Resize editor"
                        aria-orientation="vertical"
                        tabIndex={0}
                        onPointerDown={(e) => resize(e, "split")}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowRight")
                            setSplit((n) => Math.min(75, n + 2));
                          if (e.key === "ArrowLeft")
                            setSplit((n) => Math.max(25, n - 2));
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
                        docs={docs.filter((d) => d.root === root)}
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
              onOpen={() => openWorkspace()}
              onPath={() => setDialog("open")}
              onStart={() => addTab("shell", "rich", "")}
              onRecent={openWorkspace}
              onSettings={() => setDialog("settings")}
              loaded={loaded}
            />
          )}
          {hasNative && (
            <div
              className="native-layers"
              style={{
                display:
                  active?.mode === "native" && !(editorExpanded && activeDoc)
                    ? "block"
                    : "none",
                top: nativeTop,
                width: activeDoc ? `${split}%` : "100%",
              }}
            >
              {tabs
                .filter((t) => t.mode === "native")
                .map((tab) => (
                  <NativeTerminal
                    draft={tab.nativeDraft}
                    onDismissDraft={() => setTabs((old) => old.map((t) => t.id === tab.id ? { ...t, nativeDraft: undefined } : t))}
                    key={tab.id}
                    id={tab.id}
                    active={activeId === tab.id && active?.mode === "native"}
                    settings={settings}
                    onError={notify}
                  />
                ))}
            </div>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <div className="checkout-status">
          <span className="live-dot" />
          {checkoutPath ? <button className="checkout-location" title={checkout?.path || checkoutPath} aria-label={`Current ${linkedCheckout ? "worktree" : "folder"}: ${checkout?.path || checkoutPath}`}
            onClick={() => linkedCheckout ? setDialog("worktrees") : void openWorkspace(checkoutPath)}>
            <FolderOpen size={12} /><span>{linkedCheckout ? "Worktree" : "Folder"}: {checkoutName}</span>
          </button> : <span>No workspace</span>}
          {statusWorkspace && (
            <>
              <span className="status-divider" />
              <button className="checkout-branch" title={`Branch: ${statusWorkspace.git.branch || "No Git repository"}`} onClick={async () => { await openWorkspace(checkoutPath); setDialog("worktrees"); }}>
                <GitBranch size={12} />
                <span>{statusWorkspace.git.branch || "No Git repository"}</span>
              </button>
              <button
                onClick={() => {
                  setPanel("git");
                  setSidebar(true);
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
          {updateStatus?.phase === "downloaded" && <button className="update-ready" title={`Lumen ${updateStatus.latest} is ready. Close Lumen to install, or restart now.`} onClick={() => api("updates:install").catch((e) => notify(e.message))}><Download size={12} />Update ready</button>}
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
          onError={notify}
          initialSection={settingsSection}
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
          workspace={workspace}
          onClose={() => setDialog(null)}
          onOpen={openWorkspace}
          onCreate={async (branch, base) => {
            if (!root) throw new Error("Open a Git repository first.");
            const next = await api<Workspace>(
              "git:worktree",
              root,
              branch,
              base,
            );
            setWorkspaces((old) => ({ ...old, [next.root]: next }));
            setSelectedRoot(next.root);
            await addTab("shell", "rich", next.root);
            setDialog(null);
            refreshGit(root);
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
            else if (action === "projectless") addTab("shell", "rich", "");
            else if (action === "settings") setDialog("settings");
            else if (action === "worktrees") setDialog("worktrees");
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
              old.map((t) => (t.id === active.id ? { ...t, ...changes } : t)),
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
              await api("session:pi-response", piRequest.session, {
                id: piRequest.request.id,
                ...response,
              });
              setUiRequests((old) => old.filter((value) => value.session !== piRequest.session || value.request.id !== piRequest.request.id));
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
          key={s.id}
          style={{ left: s.x, top: s.y }}
        >
          ✧
        </span>
      ))}
    </div>
  );
}
function Welcome({
  boot,
  onOpen,
  onPath,
  onStart,
  onRecent,
  onSettings,
  loaded,
}: {
  boot: Bootstrap;
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
          {(["pi", "codex", "claude", "grok"] as Agent[]).map((agent) => (
            <span
              key={agent}
              title={
                boot.agents[agent]?.available
                  ? "CLI detected"
                  : "Configure in Settings"
              }
            >
              <AgentMark
                agent={agent}
                color={defaults.agents[agent].color}
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
            {tree.path.replace(/\\/g, "/") ===
            workspace.root.replace(/\\/g, "/") ? (
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
function GitPanel({
  workspace: w,
  busy,
  action,
  onDiff,
  onFile,
  onGitHub,
  onWorktree,
  onError,
}: {
  workspace: Workspace;
  busy: boolean;
  action: (action: string, payload?: any) => Promise<boolean>;
  onDiff: (file: GitFile, staged: boolean) => void;
  onFile: (file: string) => void;
  onGitHub: () => void;
  onWorktree: () => void;
  onError: (text: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"changes" | "history" | "github">("changes");
  const [prs, setPrs] = useState<any[]>([]);
  const [prError, setPrError] = useState("");
  useEffect(() => {
    if (view === "github") {
      let alive = true;
      setPrError("");
      api("git:prs", w.root)
        .then((result) => {
          if (alive) setPrs(result);
        })
        .catch((e) => {
          if (alive)
            setPrError(
              "Install GitHub CLI (gh) and run gh auth login to list pull requests. " +
                e.message,
            );
        });
      return () => {
        alive = false;
      };
    }
  }, [view, w.root]);
  if (!w.git.available)
    return (
      <div className="sidebar-empty">
        <GitBranch size={28} />
        <p>This folder isn't a Git repository.</p>
        <small>Run git init in a terminal to get started.</small>
      </div>
    );
  const staged = w.git.files.filter((f) => f.staged);
  const unstaged = w.git.files.filter((f) => f.unstaged);
  return (
    <div className="git-panel">
      <div className="git-sync">
        <button disabled={busy} onClick={() => action("pull")}>
          <ArrowDownToLine size={14} />
          Pull <small>{w.git.behind}</small>
        </button>
        <button disabled={busy} onClick={() => action("push")}>
          <ArrowUpFromLine size={14} />
          Push <small>{w.git.ahead}</small>
        </button>
        <IconButton
          label="Fetch remotes"
          disabled={busy}
          onClick={() => action("fetch")}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      <div className="git-nav">
        {(["changes", "history", "github"] as const).map((tab) => (
          <button
            key={tab}
            className={view === tab ? "selected" : ""}
            onClick={() => setView(tab)}
          >
            {tab === "github"
              ? "GitHub"
              : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {busy && (
        <div className="git-working">
          <Busy text="Updating repository" />
        </div>
      )}
      {view === "changes" ? (
        <>
          <div className="commit-box">
            <textarea
              aria-label="Commit message"
              placeholder="What's changed?"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !message.trim() || !staged.length}
              onClick={async () => {
                if (await action("commit", { message })) setMessage("");
              }}
            >
              <GitCommitHorizontal size={15} />
              Commit staged changes
            </button>
          </div>
          <div className="git-files-scroll">
            {[
              { name: "STAGED CHANGES", files: staged, staged: true },
              { name: "CHANGES", files: unstaged, staged: false },
            ].map((group) => (
              <div className="git-file-group" key={group.name}>
                <div className="git-group-heading">
                  <span>
                    {group.name}
                    <i>{group.files.length}</i>
                  </span>
                  <IconButton
                    label={group.staged ? "Unstage all" : "Stage all"}
                    disabled={busy || !group.files.length}
                    onClick={() => action(group.staged ? "unstage" : "stage")}
                  >
                    {group.staged ? <Minus size={14} /> : <Plus size={14} />}
                  </IconButton>
                </div>
                {group.files.map((file) => (
                  <div className="git-file-row" key={file.path}>
                    <button
                      className="git-file-name"
                      onClick={() => onDiff(file, group.staged)}
                      title={file.path}
                    >
                      <FileIcon name={file.path} />
                      <span>
                        {file.path.split("/").at(-1)}
                        <small>
                          {file.path.includes("/")
                            ? file.path.slice(0, file.path.lastIndexOf("/"))
                            : ""}
                        </small>
                      </span>
                      <em>{file.code.trim()}</em>
                    </button>
                    <IconButton
                      label={`Open ${file.path}`}
                      onClick={() => onFile(file.path)}
                    >
                      <ExternalLink size={12} />
                    </IconButton>
                    <IconButton
                      label={`${group.staged ? "Unstage" : "Stage"} ${file.path}`}
                      disabled={busy}
                      onClick={() =>
                        action(group.staged ? "unstage" : "stage", {
                          paths: [
                            file.path,
                            ...(file.original ? [file.original] : []),
                          ],
                        })
                      }
                    >
                      {group.staged ? <Minus size={13} /> : <Plus size={13} />}
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
            {!w.git.files.length && (
              <div className="git-clean">
                <span>
                  <Check size={20} />
                </span>
                <strong>All clear.</strong>
                <p>Your working tree is clean.</p>
              </div>
            )}
          </div>
        </>
      ) : view === "history" ? (
        <div className="git-history">
          {w.git.log.map((commit) => (
            <div key={commit.hash}>
              <GitCommitHorizontal size={16} />
              <span>
                <strong>{commit.subject}</strong>
                <small>
                  {commit.author} · {commit.when}
                </small>
                <code>{commit.hash}</code>
              </span>
            </div>
          ))}
          {!w.git.log.length && (
            <p className="dialog-copy">Your first commit will appear here.</p>
          )}
        </div>
      ) : (
        <div className="github-panel">
          <button className="secondary" onClick={onGitHub}>
            <ExternalLink size={14} />
            Open on GitHub
          </button>
          <div className="section-divider">
            <span>OPEN PULL REQUESTS</span>
          </div>
          {prError ? (
            <p className="inline-error">{prError}</p>
          ) : prs.length ? (
            prs.map((pr) => (
              <button
                className="pr-row"
                key={pr.number}
                onClick={() =>
                  api("external:open", pr.url).catch((e) => onError(e.message))
                }
              >
                <GitPullRequest size={15} />
                <span>
                  <strong>{pr.title}</strong>
                  <small>
                    #{pr.number} · {pr.isDraft ? "Draft" : pr.headRefName}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p className="dialog-copy">No open pull requests.</p>
          )}
        </div>
      )}
      <div className="git-bottom">
        <button onClick={onWorktree}>
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
        {v.questions ? <>
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
        ) : v.method === "confirm" ? (
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
