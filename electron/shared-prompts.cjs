const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Shared slash commands are Markdown files available to every agent.
// LUMEN_PROMPTS_DIR wins. Otherwise use the "prompts" folder in Lumen's user
// data (%APPDATA%\Lumen\prompts when installed), falling back to an existing
// legacy shared-config folder so older setups keep their commands.
const userDirectory = () => {
  try { return path.join(require("electron").app.getPath("userData"), "prompts"); }
  catch { return ""; }
};
const legacyDirectory = () => process.platform === "win32"
  ? "C:/GLOBAL-AGENT-CONFIGS/prompts" : path.join(os.homedir(), "GLOBAL-AGENT-CONFIGS", "prompts");
const isDirectory = (dir) => { try { return !!dir && fsSync.statSync(dir).isDirectory(); } catch { return false; } };
const directory = () => {
  if (process.env.LUMEN_PROMPTS_DIR) return process.env.LUMEN_PROMPTS_DIR;
  const preferred = userDirectory();
  if (isDirectory(preferred)) return preferred;
  const legacy = legacyDirectory();
  return isDirectory(legacy) ? legacy : preferred || legacy;
};
const scalar = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
function parse(source) {
  const front = source.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = {};
  for (const line of (front?.[1] || "").split(/\r?\n/)) {
    const field = /^(description|argument-hint):\s*(.*)$/.exec(line);
    if (field) metadata[field[1]] = scalar(field[2]);
  }
  return { body: front ? source.replace(/^\uFEFF/, "").slice(front[0].length).trim() : source.trim(), metadata };
}
async function files() {
  let entries;
  try { entries = await fs.readdir(directory(), { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return []; throw error; }
  return entries.filter((entry) => entry.isFile() && /^[a-z0-9_-]+\.md$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.name);
}
async function read(name) {
  const file = path.join(directory(), name), stat = await fs.stat(file);
  if (stat.size > 200000) throw new Error(`Shared command ${name} exceeds 200 KB.`);
  return { name: name.slice(0, -3), ...parse(await fs.readFile(file, "utf8")) };
}
async function commands() {
  const results = await Promise.allSettled((await files()).map(read));
  return results.filter((result) => result.status === "fulfilled").map(({ value: { name, metadata } }) => ({ name, insertText: `/${name}`,
    description: metadata.description || "Run this shared prompt", argumentHint: metadata["argument-hint"] || "",
    source: "prompt", scope: "Shared", native: false }));
}
async function expand(text) {
  const match = /^\s*\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return text;
  const file = (await files()).find((name) => name.slice(0, -3).toLowerCase() === match[1].toLowerCase());
  if (!file) return text;
  const prompt = await read(file);
  const args = match[2] || "";
  const words = Array.from(args.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g), (word) => word[1] ?? word[2] ?? word[3]);
  let substituted = false;
  let fence = "";
  const body = prompt.body.split("\n").map((line) => {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) { if (!fence) fence = delimiter; else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = ""; return line; }
    // Shell positional variables in code examples are literal. Explicit prompt
    // placeholders still expand there; $$ escapes a literal dollar sign.
    const pattern = /\$\$|\$ARGUMENTS(?:\[(\d+)\])?|\$\{(\d+):-([^}]*)\}|\$\{?(\d+)\}?|\$@/g;
    return line.replace(pattern, (token, index, position, fallback, number) => {
      if (token === "$$") return "$";
      if (fence && !token.startsWith("$ARGUMENTS")) return token;
      substituted = true;
      if (position) return words[Number(position) - 1] || fallback;
      if (index !== undefined) return words[Number(index)] || "";
      if (number) return words[Number(number) - 1] || "";
      return args;
    });
  }).join("\n");
  const result = body + (!substituted && args ? `\n\nUser arguments: ${args}` : "");
  if (result.length > 200000) throw new Error("The expanded shared command exceeds 200,000 characters.");
  return result;
}
function merge(shared, native) {
  const names = new Set(shared.map((command) => command.name.toLowerCase()));
  return [...shared, ...native.filter((command) => !names.has(command.name.toLowerCase()))];
}
module.exports = { commands, expand, merge };
