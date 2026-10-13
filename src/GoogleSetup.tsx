import { useState } from "react";
import { api } from "./types";
export default function GoogleSetup({ available, onInstalled, onError }: { available: boolean; onInstalled: () => Promise<void>; onError: (message: string) => void }) {
  const [installing, setInstalling] = useState(false), [version, setVersion] = useState("");
  return <div className="google-setup"><p className="muted">Gemini models use Google's supported Antigravity CLI (<code>agy</code>). Sign in from a Google chat's account picker. The older Gemini CLI can reject individual Google accounts.</p>
    {!available && <button className="secondary" disabled={installing} onClick={async () => { setInstalling(true); try { const result = await api<{ version: string }>("agents:install-google"); setVersion(result.version); await onInstalled(); } catch (error: any) { onError(error.message); } finally { setInstalling(false); } }}>{installing ? "Installing Google CLI…" : "Install Google CLI"}</button>}
    {version && <p role="status">Antigravity {version} installed.</p>}
    <button className="text-button" onClick={() => void api("external:open", "https://antigravity.google/docs/cli/install/").catch((error) => onError(error.message))}>Google setup guide ↗</button>
  </div>;
}
