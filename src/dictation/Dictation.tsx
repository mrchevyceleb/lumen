import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, Square, LoaderCircle, X, RotateCcw } from "lucide-react";
import { capture, dictationChunk } from "./capture";
import { loadRecording, saveRecording, loadSection, saveSection, finishSection, clearRecording, type Recording, type Section } from "./store";
import { api } from "../types";
import "./dictation.css";

type Phase = "idle" | "starting" | "recording" | "finishing" | "discarding" | "recover" | "error";

// A chat can remount before its old microphone has flushed. Wait for the old
// owner to finish saving before reading recovery or accepting a new recording.
const settling = new Map<string, Promise<void>>();

// Dictation for the Lumen composer, ported from TARDIS: stop inserts the
// cleaned transcript into the draft at the caret. It never sends on its own:
// in Lumen the draft is the user's words until they press Send.
export function Dictation({ chatId, onText, onActive }: { chatId: string; onText: (text: string) => void; onActive: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("starting"), [error, setError] = useState(""), [seconds, setSeconds] = useState(0), [processed, setProcessed] = useState(0), [notice, setNotice] = useState("");
  const alive = useRef(true), record = useRef<Recording | undefined>(undefined), microphone = useRef<Awaited<ReturnType<typeof capture>> | undefined>(undefined), saving = useRef(Promise.resolve()), working = useRef(false), processing = useRef(0), failure = useRef(false), stopping = useRef(false), unsaved = useRef<Section[]>([]), stopped = useRef(Promise.resolve()), inserted = useRef(false);
  const opening = useRef<ReturnType<typeof capture> | undefined>(undefined), starting = useRef(false);
  const callbacks = useRef({ onText, onActive }); callbacks.current = { onText, onActive };
  const scope = useRef("");
  const update = (next: Phase) => { if (alive.current) { setPhase(next); callbacks.current.onActive(next !== "idle" && next !== "recover"); } };
  const report = (e: unknown, stopRecording = true) => { failure.current = true; if (stopRecording) void stopCapture().catch(() => {}); if (alive.current) { setError(e instanceof Error ? e.message : "Dictation interrupted. Your recording is saved."); if (stopRecording || !microphone.current) update("error"); } };
  const pump = async () => {
    if (working.current || failure.current || !record.current || !alive.current) return;
    working.current = true;
    try {
      while (record.current && processing.current < record.current.next && !failure.current && alive.current) {
        await saving.current;
        const section = await loadSection(record.current.id, processing.current);
        if (!section) throw new Error("A recording section could not be saved. Retry before closing this page.");
        if (section.text === undefined) {
          if (!section.audio) throw new Error("Recording section missing audio.");
          const status = await api<{ configured: boolean }>("dictation:status");
          if (!status.configured) throw new Error("Add your Groq API key in Settings to dictate.");
          const result = await dictationChunk(`${section.session}:${section.index}`, section.audio);
          await finishSection({ session: section.session, index: section.index, ...result });
          if (result.warning && alive.current) setNotice(result.warning);
        }
        processing.current++; if (alive.current) setProcessed(processing.current);
      }
    } catch (e) { if (alive.current) report(e, false); }
    finally { working.current = false; }
  };
  const enqueue = (audio: Blob) => {
    const r = record.current; if (!r) return;
    const section: Section = { session: r.id, index: r.next++, audio }; unsaved.current.push(section);
    const snapshot = { ...r };
    saving.current = saving.current.then(async () => { await saveSection(snapshot, section); unsaved.current = unsaved.current.filter((s) => s !== section); }).catch((e) => { report(e); });
    void saving.current.then(pump);
  };
  const stopCapture = () => {
    const mic = microphone.current; microphone.current = undefined;
    if (!mic) return stopped.current;
    const stop = Promise.resolve().then(() => mic.stop());
    // Surface the first stop failure, but allow Retry to use the saved audio.
    stopped.current = stop.catch(() => {});
    return stop;
  };
  const finish = async (retry = false) => {
    if (stopping.current || starting.current) return; stopping.current = true; update("finishing");
    try {
      if (retry) {
        failure.current = false; setError("");
        await saving.current;
        if (record.current) {
          for (const section of unsaved.current) await saveSection({ ...record.current }, section);
          unsaved.current = [];
        }
      }
      // The worklet flushes its final section during stop; save and transcribe
      // only after that flush lands, or the tail of the dictation is lost.
      await stopCapture(); await saving.current; await pump();
      while (working.current && alive.current) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!alive.current) return;
      if (failure.current) { update("error"); return; }
      const r = record.current; if (!r) { update("idle"); return; }
      const texts: string[] = [];
      for (let i = 0; i < r.next; i++) { const part = await loadSection(r.id, i); if (part?.text === undefined) throw new Error("A section is unfinished. Retry to keep your entire recording."); if (part.text.trim()) texts.push(part.text.trim()); if (part.warning) setNotice(part.warning); }
      const text = texts.join("\n\n");
      if (!alive.current) return;
      // Insert exactly once: if the clear below fails and the user retries,
      // the text is already in their draft and must not land twice.
      if (text && !inserted.current) { callbacks.current.onText(text); inserted.current = true; } else if (!text) setNotice("No speech heard. Try again.");
      await clearRecording(r); record.current = undefined;
      update("idle");
    } catch (e) { report(e); } finally { stopping.current = false; }
  };
  const retry = () => finish(true);
  const discard = async () => {
    if (stopping.current || starting.current) return;
    stopping.current = true; failure.current = true; update("discarding");
    try {
      await stopCapture(); await saving.current;
      while (working.current) await new Promise((resolve) => setTimeout(resolve, 100));
      if (record.current) await clearRecording(record.current);
      record.current = undefined; unsaved.current = []; setError(""); setNotice(""); update("idle");
    } catch (e) { report(e); } finally { stopping.current = false; }
  };
  const start = async () => {
    if (starting.current || stopping.current || record.current) return;
    starting.current = true;
    update("starting"); setError(""); setNotice(""); setSeconds(0); setProcessed(0); processing.current = 0; failure.current = false; stopping.current = false; inserted.current = false; stopped.current = Promise.resolve();
    let pendingMic: ReturnType<typeof capture> | undefined, interrupted = false;
    try {
      const status = await api<{ configured: boolean }>("dictation:status");
      if (!status.configured) throw new Error("Add your Groq API key in Settings to dictate.");
      const r = { scope: scope.current, id: crypto.randomUUID(), next: 0, updatedAt: Date.now() }; record.current = r;
      // Start AudioContext while still inside the user gesture (Safari/iPhone).
      pendingMic = capture(enqueue, () => { if (alive.current) { setNotice("Microphone paused or disconnected. The recorded portion is being kept."); interrupted = true; if (!starting.current) void finish(); } });
      opening.current = pendingMic;
      void pendingMic.catch(() => {});
      await saveRecording(r); const mic = await pendingMic;
      if (!alive.current) { await mic.stop(); return; }
      microphone.current = mic; update("recording");
    } catch (e) { if (pendingMic) await pendingMic.then((mic) => mic.stop()).catch(() => {}); if (alive.current) { setError(e instanceof Error ? e.message : "Dictation interrupted. Your recording is saved."); update("error"); } }
    finally { opening.current = undefined; starting.current = false; if (interrupted && alive.current && microphone.current) void finish(); }
  };
  useEffect(() => {
    alive.current = true; let cancelled = false;
    // Recovery scope is the chat itself: tab ids are persisted with the
    // recovered workspace, so an unfinished recording stays recoverable after
    // a full app restart, not only while this window object lives.
    scope.current = chatId;
    const previous = settling.get(chatId) ?? Promise.resolve();
    void previous.then(() => loadRecording(chatId)).then((r) => { if (alive.current && !cancelled) { record.current = r; update(r ? "recover" : "idle"); } }).catch((e) => { if (!cancelled) report(e); });
    return () => {
      cancelled = true; alive.current = false; callbacks.current.onActive(false);
      const done = (async () => {
        await previous;
        await opening.current?.then((mic) => mic.stop()).catch(() => {});
        await stopCapture().catch(() => {});
        while (starting.current || stopping.current || working.current) await new Promise((resolve) => setTimeout(resolve, 20));
        await saving.current;
      })();
      settling.set(chatId, done);
      void done.finally(() => { if (settling.get(chatId) === done) settling.delete(chatId); });
    };
  // Each instance belongs to exactly one conversation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (phase !== "recording") return; const id = setInterval(() => setSeconds((s) => s + 1), 1000); return () => clearInterval(id); }, [phase]);

  // Inline trigger lives inside the composer pill; the working panel floats
  // above it through a portal so the pill's overflow never clips it.
  const pillRef = useRef<HTMLDivElement | null>(null), [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const panelOpen = phase !== "idle" || !!notice;
  useLayoutEffect(() => {
    if (!panelOpen) { setAnchor(null); return; }
    const measure = () => { const el = pillRef.current; if (!el) return; const r = el.getBoundingClientRect(); setAnchor({ right: r.right, top: r.top }); };
    measure();
    window.addEventListener("scroll", measure, true); window.addEventListener("resize", measure);
    return () => { window.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); };
  }, [panelOpen]);

  const recording = phase === "recording", busy = phase === "starting" || phase === "finishing" || phase === "discarding";
  const trigger = recording
    ? <button type="button" className="dictation-mic is-live" onClick={() => void finish()} aria-label="Stop dictation and insert text" title="Stop & insert into draft"><Square size={14} /></button>
    : busy
      ? <button type="button" className="dictation-mic" disabled aria-label="Dictation working"><LoaderCircle size={17} className="dictation-spin" /></button>
      : phase === "recover" || phase === "error"
        ? <button type="button" className="dictation-mic needs-attention" onClick={() => void retry()} aria-label={phase === "recover" ? "Recover saved dictation" : "Retry dictation"} title={phase === "recover" ? "Recover dictation" : "Retry"}><RotateCcw size={16} /></button>
        : <button type="button" className="dictation-mic" onClick={() => void start()} aria-label="Dictate a message" title="Dictate · Stop inserts it in your draft"><Mic size={18} /></button>;
  const width = Math.min(320, window.innerWidth - 24);
  const panelStyle = anchor ? { left: Math.min(Math.max(anchor.right - width, 12), window.innerWidth - 12 - width), bottom: window.innerHeight - anchor.top + 10, width } : undefined;
  return <>
    <div ref={pillRef} className={`chat-dictation chat-dictation-inline${recording ? " is-recording" : ""}`}>{trigger}</div>
    {panelOpen && anchor && createPortal(<div className={`dictation-panel dictation-float${recording ? " is-recording" : ""}`} role="group" aria-label="Message dictation" style={panelStyle}>
      <div className="dictation-status" role="status">{recording ? <><span className="dictation-dot" />Recording {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</> : busy ? <><LoaderCircle size={16} className="dictation-spin" />{phase === "starting" ? "Opening microphone…" : phase === "discarding" ? "Discarding…" : "Transcribing…"}</> : phase === "recover" ? "Unfinished dictation saved on this device." : phase === "idle" ? "Dictation finished." : "Dictation needs attention."}{processed > 0 && <small>{processed} section{processed === 1 ? "" : "s"} ready</small>}</div>
      {recording && <button type="button" className="dictation-button" onClick={() => void finish()}><Square size={15} />Stop & insert</button>}
      {(phase === "recover" || phase === "error") && <button type="button" className="dictation-button" onClick={() => void retry()}><RotateCcw size={15} />{phase === "recover" ? "Recover dictation" : "Retry"}</button>}
      {!busy && <button type="button" className="dictation-discard" onClick={() => void discard()} aria-label={phase === "idle" ? "Dismiss dictation notice" : "Discard dictation"}><X size={16} /></button>}
      {error && <p role="alert">{error}</p>}
      {notice && <small role="status" className="dictation-notice">{notice}</small>}
    </div>, document.body)}
  </>;
}
