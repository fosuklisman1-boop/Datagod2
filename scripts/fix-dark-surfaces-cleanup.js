/* Cleanup pass: orphan via-white/to-*-50 stops left after the main sweep, plus
   slate-50/50 leftovers and from-*-50 to-white health gradients. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const rules = [
  // orphan "bg-card via-white to-<light>" -> bg-card
  [/bg-card\s+via-white\s+to-[a-z]+-50(?:\/\d+)?/g, "bg-card"],
  // "from-<light>-50 to-white" health gradients -> solid tints
  [/from-green-50\s+to-white/g, "bg-success/10"],
  [/from-amber-50\s+to-white/g, "bg-warning/10"],
  // slate leftovers
  [/(^|[\s"'`{:])bg-slate-50\/50/g, "$1bg-muted/40"],
  [/(^|[\s"'`{:])border-slate-50(?![\w/-])/g, "$1border-border"],
];

let files = 0, hits = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith(".tsx")) continue;
    let src = fs.readFileSync(full, "utf8");
    const before = src;
    for (const [re, to] of rules) src = src.replace(re, (...a) => { hits++; return typeof to === "string" && to.includes("$1") ? `${a[1]}${to.slice(2)}` : to; });
    if (src !== before) { fs.writeFileSync(full, src, "utf8"); files++; }
  }
}
["app", "components"].forEach((d) => walk(path.join(ROOT, d)));
console.log(`Cleanup: ${hits} replacements across ${files} files.`);
