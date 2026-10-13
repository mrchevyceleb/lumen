import { useEffect, useRef } from "react";

const keys: Record<string, string> = { ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D", Enter: "\r", Escape: "\x1b", Backspace: "\x7f", Delete: "\x1b[3~", Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~" };
export default function PiCustomControl({ lines, onInput }: { lines: string[]; onInput: (input: string) => Promise<void> }) {
  const host = useRef<HTMLDivElement>(null);
  const sequence = useRef(Promise.resolve());
  useEffect(() => { host.current?.focus(); }, []);
  const send = (data: string) => { sequence.current = sequence.current.then(() => onInput(data)).catch(() => {}); };
  return <div className="pi-custom-control" ref={host} tabIndex={0} role="group" aria-label="Pi extension controls"
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      let data = event.key === "Tab" ? event.shiftKey ? "\x1b[Z" : "\t" : keys[event.key];
      if (!data && event.key.length === 1) data = event.ctrlKey ? String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 31) : event.key;
      if (!data) return;
      event.preventDefault(); event.stopPropagation(); send(event.altKey ? "\x1b" + data : data);
    }} onPaste={(event) => { event.preventDefault(); send(event.clipboardData.getData("text")); }}>
    <pre aria-live="polite">{lines.join("\n")}</pre>
    <div className="pi-control-actions"><button onClick={() => send(keys.ArrowUp)} aria-label="Previous option">↑</button><button onClick={() => send(keys.ArrowDown)} aria-label="Next option">↓</button><button onClick={() => send(" ")}>Toggle</button><button onClick={() => send("\t")}>Next field</button><button className="primary" onClick={() => send("\r")}>Select</button><button onClick={() => send("\x1b")}>Back</button></div>
    <small>Use the arrow keys and Enter. Type to search or edit. Escape goes back.</small>
  </div>;
}
