import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

it("emits the AudioWorklet as a same-origin file allowed by Lumen's strict script CSP", async () => {
  // Test production asset handling: dev/test URLs do not expose Vite's data-URL
  // inlining, and widening script-src to data: would weaken the app's CSP.
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      rolldownOptions: {
        input: fileURLToPath(new URL("../src/dictation/capture.ts", import.meta.url)),
        preserveEntrySignatures: "strict",
      },
    },
  });
  const { output } = Array.isArray(result) ? result[0] : result;
  expect(output.some((file) => file.type === "asset" && /pcm-worklet-.*\.js$/.test(file.fileName))).toBe(true);
  const entry = output.find((file) => file.type === "chunk" && file.isEntry);
  expect(entry?.type === "chunk" && entry.code).not.toContain("data:text/javascript");
});
