import { useEffect, useRef } from "react";
import { api, type AgentControlRequest, type Tab, type PiRequest } from "./types";

export const settleControl = () => new Promise((resolve) => setTimeout(resolve, 50));
export function taskView(tab: Tab, requests: { session: string; request: PiRequest }[], full = true) {
  const pendingRequests = requests.filter((r) => r.session === tab.id).map((r) => r.request);
  return {
    id: tab.controlId || tab.id, name: tab.name, agent: tab.agent, owner: tab.managedBy || "",
    root: tab.projectless ? "" : tab.root, cwd: tab.cwd, mode: tab.mode,
    accountId: tab.accountId || "", accountName: tab.accountName || "CLI default",
    model: tab.model || "", effort: tab.effort || "", workMode: tab.workMode || "",
    busy: tab.busy, phase: tab.phase || "", exitCode: tab.exitCode ?? null,
    status: pendingRequests.length ? "needs-input" : tab.busy ? "working" : tab.queuePaused && tab.queuedMessages?.length ? "queue-paused" : tab.queuedMessages?.length ? "queued" : tab.exitCode && tab.exitCode !== 0 ? "failed" : "idle",
    contextTokens: tab.contextTokens ?? null, contextWindow: tab.contextWindow ?? null,
    queuePaused: !!tab.queuePaused, queuedMessages: tab.queuedMessages || [], pendingRequests,
    ...(full ? { messages: tab.messages.slice(-200).map((m) => ({ ...m, text: m.text.slice(-80000) })), transcriptLimited: tab.messages.length > 200 || tab.messages.some((m) => m.text.length > 80000) } : { messageCount: tab.messages.length }),
  };
}
export function useAgentControl(ready: boolean, handler: (request: AgentControlRequest) => Promise<unknown>) {
  const current = useRef(handler); current.current = handler;
  useEffect(() => {
    if (!ready) return;
    let chain = Promise.resolve(), alive = true;
    const unsubscribe = window.lumen.onAgentControl((request) => {
      const run = async () => {
        if (!alive) return;
        try {
          await settleControl();
          if (!await api("agent-control:claim", request.requestId)) return;
          const data = await current.current(request); await api("agent-control:reply", request.requestId, { data });
        }
        catch (e: any) { await api("agent-control:reply", request.requestId, { error: e.message, status: e.status || 409 }); }
      };
      if (["list", "get"].includes(request.action)) void run().catch(() => {});
      else chain = chain.then(run).catch(() => {});
    });
    void api("agent-control:ready", true);
    return () => { alive = false; unsubscribe(); void api("agent-control:ready", false); };
  }, [ready]);
}
