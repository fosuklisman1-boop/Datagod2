/* Map literal bg-white -> bg-card so surfaces theme correctly in dark mode.
   Invisible in light mode (bg-card == white there). Preserves opacity suffix
   (bg-white/95 -> bg-card/95). Skips shell files tuned by hand. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(
  ["components/layout/sidebar.tsx", "components/layout/header.tsx",
   "components/layout/bottom-nav.tsx", "components/layout/dashboard-layout.tsx"]
    .map((p) => path.join(ROOT, p.replace(/\//g, path.sep)))
);
// bg-white not followed by a word char or hyphen (so not bg-white-ish); opacity /xx allowed.
const re = /(^|[\s"'`{:])bg-white(?![\w-])/g;
let files = 0, hits = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith(".tsx") || SKIP.has(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    const out = src.replace(re, (_m, b) => { hits++; return `${b}bg-card`; });
    if (out !== src) { fs.writeFileSync(full, out, "utf8"); files++; }
  }
}
["app", "components"].forEach((d) => walk(path.join(ROOT, d)));
console.log(`bg-white -> bg-card: ${hits} replacements across ${files} files.`);
