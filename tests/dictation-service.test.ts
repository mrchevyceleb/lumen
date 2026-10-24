import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Dictation } = require("../electron/dictation.cjs");
let directory: string, service: InstanceType<typeof Dictation>;

beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), "lumen-dictation-")); service = new Dictation(directory); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

it("replaces keys privately and preserves the old file and status if replacement fails", async () => {
  await fs.writeFile(service.file, JSON.stringify({ groqApiKey: "old-test-key" }), { mode: 0o644 });
  expect(await service.setKey("new-test-key")).toEqual({ configured: true, masked: "…-key" });
  if (process.platform !== "win32") expect((await fs.stat(service.file)).mode & 0o777).toBe(0o600);
  const prior = await fs.readFile(service.file, "utf8");
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(service.setKey("replacement-secret")).rejects.toThrow("Disk unavailable");
  expect(await fs.readFile(service.file, "utf8")).toBe(prior);
  expect(await service.status()).toEqual({ configured: true, masked: "…-key" });
  expect(await fs.readdir(directory)).toEqual(["dictation.json"]);
  await expect(service.setKey(undefined)).rejects.toThrow("Invalid key");
  expect(await fs.readFile(service.file, "utf8")).toBe(prior);
});

it("does not let an in-flight initial status read restore a key removed in Settings", async () => {
  await fs.writeFile(service.file, JSON.stringify({ groqApiKey: "old-test-key" }));
  const readFile = fs.readFile.bind(fs);
  let release!: () => void, read!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { read = resolve; });
  vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args: unknown[]) => {
    const contents = await readFile(...args); read(); await gate; return contents;
  });
  const status = service.status(); await reading;
  const remove = service.setKey(""); release();
  await Promise.all([status, remove]);
  expect(await service.status()).toEqual({ configured: false, masked: "" });
  await expect(fs.stat(service.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps raw transcripts on cleanup failure, caches identical retries, and rejects altered audio", async () => {
  await service.setKey("test-only-key");
  const transcribe = vi.spyOn(service, "transcribe").mockResolvedValue("Keep all my original words.");
  vi.spyOn(service, "cleanup").mockRejectedValue(new Error("Cleanup offline"));
  const wav = Buffer.alloc(46); wav.write("RIFF"); wav.write("WAVE", 8);
  const id = `${crypto.randomUUID()}:0`;
  const [first, retry] = await Promise.all([service.chunk(id, wav), service.chunk(id, wav)]);
  expect(first).toEqual({ text: "Keep all my original words.", warning: expect.stringContaining("original transcript was kept") });
  expect(retry).toEqual(first); expect(transcribe).toHaveBeenCalledTimes(1);
  const altered = Buffer.from(wav); altered[44] = 1;
  await expect(service.chunk(id, altered)).rejects.toThrow("Recording section changed");
  await expect(service.chunk(`${crypto.randomUUID()}:0`, Buffer.alloc(44))).rejects.toThrow("Record a WAV");
});
