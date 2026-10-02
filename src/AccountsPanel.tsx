import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Plus, Check, Trash2, LogIn } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, type AccountInventory, type AccountProfile, type SignInProfile, type Settings, type Tab } from "./types";
import { agentNames } from "./settings";

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountInventory>({ profiles: [], defaults: { claude: "", codex: "" } });
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try { const next = await api<AccountInventory>("accounts:list"); if (current === sequence.current) { setAccounts(next); setError(""); } }
    catch (e: any) { if (current === sequence.current) setError(e.message); }
  }, []);
  useEffect(() => { void refresh(); const stop = window.lumen.onAccounts((event) => { if (event.type === "changed") void refresh(); }); return () => { sequence.current++; stop(); }; }, [refresh]);
  return { accounts, error, refresh };
}

export function AccountPicker({ tab, onSelect, onManage, onSignIn }: { tab: Tab; onSelect: (id: string) => void; onManage: () => void; onSignIn: () => void }) {
  const { accounts, error } = useAccounts();
  if (tab.agent === "shell") return null;
  const profiles = accounts.profiles.filter((p) => p.agent === tab.agent);
  return <label className="account-picker" title={error || "Choosing another account starts a new chat in this workspace."}>
    <Users size={13} />
    <select aria-label={`${agentNames[tab.agent]} account`} value={tab.accountId || ""} onChange={(e) => e.target.value === "manage" ? onManage() : e.target.value === "signin" ? onSignIn() : onSelect(e.target.value)}>
      <option value="">CLI default</option>
      {profiles.map((p) => <option key={p.id} value={p.id} disabled={!p.signedIn}>{p.name}{!p.signedIn ? " · sign in first" : ""}</option>)}
      {tab.accountId && !profiles.some((p) => p.id === tab.accountId) && <option value={tab.accountId}>{tab.accountName || "Saved account"}</option>}
      <option value="signin" disabled={tab.busy}>Sign in to this account…</option>
      <option value="manage">Manage accounts…</option>
    </select>
  </label>;
}

export default function AccountsPanel({ settings, onStart }: { settings: Settings; onStart: (profile: AccountProfile) => void }) {
  const { accounts, error: loadError, refresh } = useAccounts();
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const [login, setLogin] = useState<SignInProfile | null>(null);
  const [removing, setRemoving] = useState<string>("");
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setWorking(true); setError("");
    try { await action(); await refresh(); } catch (e: any) { setError(e.message); } finally { lock.current = false; setWorking(false); }
  };
  const signIn = async (p: AccountProfile) => { await api("accounts:login", p.id, settings.agents[p.agent].command); setLogin(p); };
  if (login) return <AccountLogin profile={login} settings={settings} onDone={() => { setLogin(null); void refresh(); }} />;
  return <>
    <h3>One place for all your accounts</h3>
    <p className="muted">Save a login once, then choose it in any Claude or Codex chat. Accounts can run side by side.</p>
    {(error || loadError) && <p className="inline-error" role="alert">{error || loadError}</p>}
    <form className="account-add" onSubmit={(e) => { e.preventDefault(); void run(async () => { const p = await api<AccountProfile>("accounts:add", { agent, name }); setName(""); await signIn(p); }); }}>
      <label className="field"><span>Provider</span><select aria-label="Account provider" value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")} disabled={working}>
        <option value="claude">Claude Code</option><option value="codex">OpenAI · Codex</option>
      </select></label>
      <label className="field"><span>Account name</span><input aria-label="Account name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Personal, Work, Team…" disabled={working} /></label>
      <div className="account-actions"><button className="primary" disabled={working || !name.trim()}><Plus size={14} />Add & sign in</button>
        <button type="button" className="secondary" disabled={working || !name.trim()} onClick={() => void run(async () => { await api("accounts:add", { agent, name, importCurrent: true }); setName(""); })}>Save current CLI login</button></div>
    </form>
    {(["claude", "codex"] as const).map((provider) => <section className="account-group" key={provider}>
      <div className="account-group-heading"><h4>{provider === "claude" ? "Claude Code" : "OpenAI · Codex"}</h4>
        <button className="secondary" disabled={working || !accounts.defaults[provider]} onClick={() => void run(async () => { await api("accounts:system", provider); })}>{!accounts.defaults[provider] && <Check size={12} />}Use CLI default</button></div>
      <button className="secondary" disabled={working} onClick={() => void run(async () => { setLogin(await api<SignInProfile>("accounts:login-default", provider, settings.agents[provider].command)); })}><LogIn size={13} />Sign in to {agentNames[provider]} · CLI default</button>
      {!accounts.profiles.some((p) => p.agent === provider) && <p className="muted account-empty">Using your normal CLI login. Add a named account above to keep another login ready.</p>}
      {accounts.profiles.filter((p) => p.agent === provider).map((p) => <div className="account-card" key={p.id}>
        <div className="account-card-heading"><Users size={17} /><input key={p.name} aria-label={`Rename ${p.name}`} defaultValue={p.name} maxLength={80} disabled={working}
          onBlur={(e) => { if (e.target.value !== p.name) void run(async () => { await api("accounts:change", p.id, { name: e.target.value }); }); }} />
          {accounts.defaults[provider] === p.id && <span className="account-default">Default</span>}</div>
        <p className="muted">{p.email || (p.signedIn ? "Saved login" : "Not signed in")}{p.inUse && " · in use"}</p>
        <div className="account-actions">
          <button className="primary" disabled={working || !p.signedIn} onClick={() => onStart(p)}>Start chat</button>
          <button className="secondary" disabled={working || !p.signedIn || accounts.defaults[provider] === p.id} onClick={() => void run(async () => { await api("accounts:change", p.id, { default: true }); })}>Make default</button>
          <button className="secondary" disabled={working || p.inUse} title={p.inUse ? "Close this account's chats before signing in again." : ""} onClick={() => void run(() => signIn(p))}><LogIn size={13} />{p.signedIn ? "Sign in again" : "Sign in"}</button>
          <button className="secondary" aria-label={`Remove ${p.name} account`} disabled={working || p.inUse} title={p.inUse ? "Close this account's chats before removing it." : ""} onClick={() => setRemoving(p.id)}><Trash2 size={13} /></button>
        </div>
        {removing === p.id && <div className="account-remove"><p>Remove this saved login? Local chat files stay on disk.</p><button className="secondary" onClick={() => setRemoving("")}>Keep account</button><button className="secondary" disabled={working} onClick={() => void run(async () => { await api("accounts:remove", p.id); setRemoving(""); })}>Remove login</button></div>}
      </div>)}
    </section>)}
    {(["grok", "pi"] as const).map((provider) => <section className="account-group" key={provider}><h4>{agentNames[provider]}</h4><p className="muted">Uses your normal {agentNames[provider]} CLI login.</p><button className="secondary" disabled={working} onClick={() => void run(async () => { setLogin(await api<SignInProfile>("accounts:login-default", provider, settings.agents[provider].command)); })}><LogIn size={13} />Sign in to {agentNames[provider]}</button></section>)}
    <p className="settings-note">Choose another account from the chat's account picker to start a fresh chat. Existing chats keep their account after restart. Sign-in uses the CLI's normal browser flow; logins are stored locally on this computer.</p>
  </>;
}

export function AccountLogin({ profile, settings, onDone }: { profile: SignInProfile; settings: Settings; onDone: (success: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    const terminal = new Terminal({ fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: settings.terminalFontSize, cursorBlink: true, theme: { background: settings.code, foreground: settings.text, cursor: settings.accent } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!);
    let ready = false, disposed = false, offset = 0; const queued: { data: string; offset: number }[] = [];
    const write = (event: { data: string; offset: number }) => {
      if (event.offset <= offset) return;
      terminal.write(event.data.slice(Math.max(0, offset - (event.offset - event.data.length))));
      offset = event.offset;
    };
    const stop = window.lumen.onAccounts((event) => {
      if (event.id !== profile.id) return;
      if (event.type === "terminal") { const output = { data: event.data || "", offset: event.offset || 0 }; if (ready) write(output); else queued.push(output); }
      if (event.type === "exit") { setFinished(true); if (event.code !== 0) setError("Sign-in did not finish. You can try again."); }
      if (event.type === "authenticated") setAuthenticated(true);
    });
    void api<{ text: string; offset: number; code: number | null; authenticated: boolean }>("accounts:buffer", profile.id).then((buffer) => { if (disposed) return; terminal.write(buffer.text); offset = buffer.offset; ready = true; queued.forEach(write); if (buffer.authenticated) setAuthenticated(true); if (buffer.code !== null) { setFinished(true); if (buffer.code !== 0) setError("Sign-in did not finish. You can try again."); } }).catch((e) => { if (!disposed) setError(e.message); });
    const input = terminal.onData((data) => { void api("accounts:write", profile.id, data).catch((e) => setError(e.message)); });
    const resize = () => { fit.fit(); void api("accounts:resize", profile.id, terminal.cols, terminal.rows).catch(() => {}); };
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize(); terminal.focus();
    return () => { disposed = true; stop(); observer.disconnect(); input.dispose(); terminal.dispose(); void api("accounts:cancel", profile.id).catch(() => {}); };
  }, [profile.id]);
  const success = !error && (authenticated || finished);
  return <div className="account-login"><h3>{profile.name}</h3><p className="muted">{profile.agent === "pi" ? "Open the provider picker below, choose the provider for your model, then complete its OAuth or API-key sign-in." : `Complete ${agentNames[profile.agent]}'s sign-in in your browser. If it asks for a code, paste it below.`} {profile.id.startsWith("cli-default-") ? `This updates your normal ${agentNames[profile.agent]} CLI login, too.` : "Choose the account you want to save here."}</p>
    {profile.agent === "pi" && !finished && !authenticated && <button className="secondary" onClick={() => void api("accounts:write", profile.id, "/login\r").catch((e) => setError(e.message))}>Choose provider</button>}
    <div ref={host} className="account-login-terminal" />{error && <p className="inline-error" role="alert">{error}</p>}
    <div className="account-actions"><button className={success ? "primary" : "secondary"} onClick={() => onDone(success)}>{success ? "Done" : finished ? "Close and try again" : "Cancel sign-in"}</button>{success && <span className="muted">Signed in. Return to your chat and retry your message.</span>}</div></div>;
}
