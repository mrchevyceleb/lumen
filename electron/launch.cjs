const fs = require("node:fs/promises");
const path = require("node:path");

function openPaths(argv, cwd = process.cwd()) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--open" && typeof argv[i + 1] === "string")
      result.push(path.resolve(cwd, argv[++i]));
  }
  return result;
}

async function resolveOpenPath(workspace, target) {
  if (typeof target !== "string" || !path.isAbsolute(target))
    throw new Error("Choose a local file or folder.");
  const real = await fs.realpath(target);
  const stat = await fs.stat(real);
  if (!stat.isDirectory() && !stat.isFile())
    throw new Error("Choose a file or folder.");
  const cwd = stat.isDirectory() ? real : path.dirname(real);
  const opened = await workspace.open(cwd);
  return {
    workspace: opened,
    cwd,
    file: stat.isFile() ? path.relative(opened.root, real).replace(/\\/g, "/") : "",
  };
}

module.exports = { openPaths, resolveOpenPath };
