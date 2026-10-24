// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dictation } from "../src/dictation/Dictation";
import * as store from "../src/dictation/store";

const audio = vi.hoisted(() => ({ capture: vi.fn(), dictationChunk: vi.fn() }));
vi.mock("../src/dictation/capture", () => audio);
vi.mock("../src/dictation/store", async (original) => {
  const actual = await original<typeof import("../src/dictation/store")>();
  return { ...actual, saveSection: vi.fn(actual.saveSection), clearRecording: vi.fn(actual.clearRecording) };
});
const storage = await vi.importActual<typeof store>("../src/dictation/store");

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, chatId: string, emit: () => void;
const onText = vi.fn();
const onActive = vi.fn();
const blob = new Blob(["audio"], { type: "audio/wav" });
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => void) {
  for (let i = 0; i < 150; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { check(); return; } catch (error) { if (i === 149) throw error; }
  }
}
function button(label: string) {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(el, label).not.toBeNull();
  return el!;
}
const mount = () => act(async () => { root.render(<Dictation chatId={chatId} onText={onText} onActive={onActive} />); });
const click = (label: string) => act(async () => { button(label).click(); });
async function saved(section: Partial<store.Section>) {
  const record = { scope: chatId, id: crypto.randomUUID(), next: 1, updatedAt: Date.now() };
  await store.saveSection(record, { session: record.id, index: 0, ...section });
  return record;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.saveSection).mockImplementation(storage.saveSection);
  vi.mocked(store.clearRecording).mockImplementation(storage.clearRecording);
  window.lumen = { invoke: vi.fn(async () => ({ configured: true })) } as any;
  audio.dictationChunk.mockResolvedValue({ text: "Dictated words." });
  audio.capture.mockImplementation(async (onSection: (audio: Blob) => void) => {
    let emitted = false;
    emit = () => { if (!emitted) { emitted = true; onSection(blob); } };
    return { stop: vi.fn(async () => { emit(); }) };
  });
  chatId = crypto.randomUUID();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

it("waits for the old chat's final flush before offering recovery on a quick remount", async () => {
  const tail = deferred();
  const stop = vi.fn(() => tail.promise.then(() => emit()));
  audio.capture.mockImplementationOnce(async (onSection: (audio: Blob) => void) => {
    emit = () => onSection(blob);
    return { stop };
  });
  await mount(); await until(() => button("Dictate a message"));
  await click("Dictate a message"); await until(() => button("Stop dictation and insert text"));
  await act(async () => { root.render(null); });
  await mount();
  await until(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(document.querySelector('[aria-label="Recover saved dictation"]')).toBeNull();
  await act(async () => { tail.resolve(); });
  await until(() => button("Recover saved dictation"));
  expect((await store.loadRecording(chatId))?.next).toBe(1);
  await click("Recover saved dictation");
  await until(() => expect(onText).toHaveBeenCalledWith("Dictated words."));
  expect(onText).toHaveBeenCalledTimes(1);
  expect(await store.loadRecording(chatId)).toBeUndefined();
});

it("keeps and finishes audio when the microphone is interrupted during startup", async () => {
  audio.capture.mockImplementationOnce(async (onSection: (audio: Blob) => void, interrupted: () => void) => {
    interrupted();
    return { stop: async () => { onSection(blob); } };
  });
  await mount(); await until(() => button("Dictate a message"));
  await click("Dictate a message");
  await until(() => expect(onText).toHaveBeenCalledWith("Dictated words."));
  expect(document.body.textContent).toContain("Microphone paused or disconnected");
  expect(onText).toHaveBeenCalledTimes(1);
});

it("reports a stop failure without getting stuck and retries the saved audio", async () => {
  audio.capture.mockImplementationOnce(async (onSection: (audio: Blob) => void) => ({
    stop: async () => { onSection(blob); throw new Error("Microphone could not close"); },
  }));
  await mount(); await until(() => button("Dictate a message"));
  await click("Dictate a message"); await until(() => button("Stop dictation and insert text"));
  await click("Stop dictation and insert text");
  await until(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Microphone could not close"));
  expect(onText).not.toHaveBeenCalled();
  await click("Retry dictation");
  await until(() => expect(onText).toHaveBeenCalledWith("Dictated words."));
  expect(onText).toHaveBeenCalledTimes(1);
});

it("keeps completion warnings visible, including recovered warnings, without reinserting on a failed clear", async () => {
  const warning = "AI cleanup was unavailable. Your original transcript was kept.";
  await saved({ text: "Original words.", warning });
  vi.mocked(store.clearRecording).mockRejectedValueOnce(new Error("Storage busy"));
  await mount(); await until(() => button("Recover saved dictation"));
  await click("Recover saved dictation"); await until(() => button("Retry dictation"));
  expect(onText).toHaveBeenCalledTimes(1);
  await click("Retry dictation"); await until(() => button("Dismiss dictation notice"));
  expect(onText).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain(warning);
  expect(audio.dictationChunk).not.toHaveBeenCalled();
  await click("Dismiss dictation notice");
  await until(() => expect(document.querySelector('[aria-label="Message dictation"]')).toBeNull());
});

it("makes a silent recording's completion notice reachable", async () => {
  audio.capture.mockResolvedValueOnce({ stop: async () => {} });
  await mount(); await until(() => button("Dictate a message"));
  await click("Dictate a message"); await until(() => button("Stop dictation and insert text"));
  await click("Stop dictation and insert text");
  await until(() => button("Dismiss dictation notice"));
  expect(document.body.textContent).toContain("No speech heard");
  expect(onText).not.toHaveBeenCalled();
});

it("locks discard against overlapping recovery and reports storage failure instead of rejecting unhandled", async () => {
  const record = await saved({ text: "Do not insert this." });
  const clearing = deferred();
  vi.mocked(store.clearRecording).mockReturnValueOnce(clearing.promise);
  await mount(); await until(() => button("Recover saved dictation"));
  const retry = button("Recover saved dictation");
  await act(async () => { button("Discard dictation").click(); retry.click(); });
  expect(onText).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Discarding…");
  await act(async () => { clearing.reject(new Error("Disk busy")); });
  await until(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Disk busy"));
  expect((await store.loadRecording(chatId))?.id).toBe(record.id);
  await click("Discard dictation"); await until(() => button("Dictate a message"));
  expect(await store.loadRecording(chatId)).toBeUndefined();
  expect(onText).not.toHaveBeenCalled();
});

it("serializes repeated Retry clicks while re-saving unsaved sections", async () => {
  vi.mocked(store.saveSection).mockRejectedValueOnce(new Error("Storage unavailable"));
  await mount(); await until(() => button("Dictate a message"));
  await click("Dictate a message"); await until(() => button("Stop dictation and insert text"));
  await act(async () => { emit(); }); await until(() => button("Retry dictation"));
  const saving = deferred();
  vi.mocked(store.saveSection).mockImplementationOnce(async (record, section) => { await saving.promise; await storage.saveSection(record, section); });
  const retry = button("Retry dictation");
  await act(async () => { retry.click(); retry.click(); });
  expect(store.saveSection).toHaveBeenCalledTimes(2); // initial failure + one retry
  await act(async () => { saving.resolve(); });
  await until(() => expect(onText).toHaveBeenCalledWith("Dictated words."));
  expect(onText).toHaveBeenCalledTimes(1);
  expect(audio.dictationChunk).toHaveBeenCalledTimes(1);
});
