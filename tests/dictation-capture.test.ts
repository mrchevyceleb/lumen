// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { capture } from "../src/dictation/capture";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete (globalThis as any).__lumenFakeMicLevel; });

it("shares the real microphone's stop promise until its final section has flushed", async () => {
  let close!: () => void, port: any;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  const track = { stop: vi.fn() };
  class Context {
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    createMediaStreamSource = () => ({ connect: () => {} });
    close = async () => { await closed; this.state = "closed"; };
  }
  class Worklet {
    port = port = {
      onmessage: (_: unknown) => {}, close: vi.fn(),
      postMessage: (message: string) => {
        if (message === "stop") queueMicrotask(() => {
          port.onmessage({ data: { pcm: new Int16Array(6400).fill(1000) } });
          port.onmessage({ data: { stopped: true } });
        });
      },
    };
    connect() {}
    disconnect() {}
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  const section = vi.fn();
  const mic = await capture(section, vi.fn());
  const first = mic.stop(), second = mic.stop();
  expect(second).toBe(first);
  await Promise.resolve();
  expect(section).not.toHaveBeenCalled();
  close(); await Promise.all([first, second]);
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(section).toHaveBeenCalledTimes(1);
  expect(section.mock.calls[0][0].type).toBe("audio/wav");
  expect(port.close).toHaveBeenCalledTimes(1);
});

it.each([0, 0.2])("keeps the fake microphone faithful to silence and emits speech only once (level %s)", async (level) => {
  vi.useFakeTimers();
  (globalThis as any).__lumenFakeMicLevel = level;
  const section = vi.fn();
  const mic = await capture(section, vi.fn());
  await vi.advanceTimersByTimeAsync(500);
  const first = mic.stop(); expect(mic.stop()).toBe(first); await first;
  expect(section).toHaveBeenCalledTimes(level === 0 ? 0 : 1);
});
