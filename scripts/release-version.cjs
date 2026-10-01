// CI releases every main push. The source version is a minimum; builds never
// reuse a published or draft version, even when package.json hasn't changed.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const pkg = require("../package.json");
const releases = JSON.parse(execFileSync("gh", ["release", "list", "--repo", "mrchevyceleb/lumen", "--limit", "100", "--json", "tagName"], { encoding: "utf8", windowsHide: true }));
const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const minimum = parse(pkg.version);
if (!minimum) throw new Error("Use a stable major.minor.patch source version.");
const previous = releases.map((r) => parse(r.tagName)).filter(Boolean).sort(compare).at(-1);
const version = previous && compare(previous, minimum) >= 0 ? [previous[0], previous[1], previous[2] + 1].join(".") : minimum.join(".");
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(version);
