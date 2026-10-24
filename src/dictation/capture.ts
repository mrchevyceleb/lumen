// Ported from TARDIS dictation capture: 16kHz WAV sections cut on sustained
// speech, silence trimmed frame by frame, so a click never reaches the model
// (whisper invents a phrase for silent stretches) and "No speech heard" stays
// reachable.
// Keep a real file: production data: inlining is blocked by script-src 'self'.
import workletUrl from "./pcm-worklet.js?url&no-inline";

export function wav(pcm: Int16Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + pcm.length * 2), view = new DataView(bytes);
  const label = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  label(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); label(8, "WAVE"); label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([bytes], { type: "audio/wav" });
}

function pcmFromRms(level: number): Int16Array {
  // One second of steady tone at a level that reads as speech. Only used when
  // Lumen's harness requests a fake microphone (QA capture proof).
  const samples = new Int16Array(16000);
  const amplitude = Math.round(32767 * Math.min(0.9, level));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 160 * i) / 16000));
  return samples;
}

export async function capture(onSection: (audio: Blob) => void, onInterrupted: () => void) {
  const fake = (globalThis as unknown as { __lumenFakeMicLevel?: number }).__lumenFakeMicLevel;
  if (fake !== undefined && fake !== null) {
    return captureFake(onSection, onInterrupted, fake);
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error("Microphone access is not available in this window. Try again, or type your message.");
  const context = new AudioContext();
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined, stopping = false;
  try {
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    await context.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(context, "dictation-pcm");
    const QUIET = 393, FRAME = 320, MIN_SPEECH_FRAMES = 13;
    const samples = new Int16Array(16000 * 60); let length = 0, quiet = 0;
    const above = (from: number) => { for (let i = from; i < from + FRAME; i++) if (Math.abs(samples[i]) >= QUIET) return true; return false; };
    const flush = () => {
      let end = Math.floor(length / FRAME) * FRAME;
      while (end >= FRAME && !above(end - FRAME)) end -= FRAME;
      let speech = 0; for (let i = 0; i < end; i += FRAME) if (above(i)) speech++;
      if (speech >= MIN_SPEECH_FRAMES) onSection(wav(samples.slice(0, end), 16000));
      length = 0; quiet = 0;
    };
    const worklet = node, media = stream;
    let stopped = () => {};
    worklet.port.onmessage = ({ data }) => {
      if (data.pcm) { for (const sample of data.pcm as Int16Array) { samples[length++] = sample; quiet = Math.abs(sample) < QUIET ? quiet + 1 : 0; if (length === samples.length || (length >= 16000 * 35 && quiet > 16000 * 0.4)) flush(); } worklet.port.postMessage("ack"); }
      if (data.interrupted && !stopping) onInterrupted();
      if (data.stopped) stopped();
    };
    context.createMediaStreamSource(stream).connect(worklet); worklet.connect(context.destination);
    stream.getAudioTracks().forEach((track) => { track.onended = () => { if (!stopping) onInterrupted(); }; });
    let stop: Promise<void> | undefined;
    return { stop: () => stop ??= (async () => {
      stopping = true;
      try {
        await new Promise<void>((resolve) => { const timeout = setTimeout(resolve, 1500); stopped = () => { clearTimeout(timeout); resolve(); }; worklet.port.postMessage("stop"); });
      } finally {
        media.getTracks().forEach((track) => track.stop()); worklet.disconnect();
        try { if (context.state !== "closed") await context.close(); } finally { worklet.port.close(); flush(); }
      }
    })() };
  } catch (error) { stream?.getTracks().forEach((track) => track.stop()); await context.close(); throw error; }
}

async function captureFake(onSection: (audio: Blob) => void, onInterrupted: () => void, level: number) {
  void onInterrupted;
  const wavBlob = wav(pcmFromRms(level), 16000);
  let emitted = false;
  const emit = () => { if (!emitted) { emitted = true; if (level >= 0.02) onSection(wavBlob); } };
  const timer = setTimeout(emit, 450);
  let stop: Promise<void> | undefined;
  return { stop: () => stop ??= Promise.resolve().then(() => { clearTimeout(timer); emit(); }) };
}

export async function dictationChunk(id: string, audio: Blob): Promise<{ text: string; warning?: string }> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  return window.lumen.invoke<{ text: string; warning?: string }>("dictation:chunk", id, bytes);
}
