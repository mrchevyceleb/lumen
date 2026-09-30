const fs = require("node:fs");
const path = require("node:path");

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const clamp = (factor) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));

function installZoom(contents, dataDir) {
  const preference = path.join(dataDir, "zoom.json");
  let factor = 1;
  try {
    const saved = JSON.parse(fs.readFileSync(preference, "utf8"));
    if (Number.isFinite(saved.factor)) factor = clamp(saved.factor);
  } catch {
    // Missing or invalid preferences start at the normal size.
  }

  const apply = () => contents.setZoomFactor(factor);
  apply();
  contents.on("did-finish-load", apply);
  contents.on("before-input-event", (event, input) => {
    if (!(input.control || input.meta) || input.alt || input.isComposing) return;
    let change;
    if (input.key === "+" || input.key === "=" || input.code === "NumpadAdd")
      change = 0.1;
    else if (input.key === "-" || input.code === "NumpadSubtract") change = -0.1;
    else if (input.key === "0" || input.code === "Numpad0") change = 0;
    else return;

    // Keep these keys out of Monaco, xterm, and the CLI even at the zoom limits.
    event.preventDefault();
    if (input.type !== "keyDown") return;
    const next = change === 0 ? 1 : clamp(Math.round((factor + change) * 100) / 100);
    if (next === factor) return;
    factor = next;
    apply();
    try {
      // A separate file prevents theme/settings saves from overwriting the zoom.
      // Synchronous atomic replacement also preserves the last key on quick exit.
      fs.writeFileSync(`${preference}.tmp`, JSON.stringify({ factor }));
      fs.renameSync(`${preference}.tmp`, preference);
    } catch (error) {
      console.warn("Could not save UI zoom:", error.message);
    }
  });
}

module.exports = { installZoom };
