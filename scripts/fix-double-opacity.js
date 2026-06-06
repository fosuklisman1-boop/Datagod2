/* Fix double-opacity artifacts from the reskin codemod, e.g.
   "from-primary/5/60" -> "from-primary/5", "bg-muted/40/50" -> "bg-muted/40".
   Only primary/muted got an injected opacity, so only they can double up. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const re = /-(primary|muted)\/(\d+)\/(\d+)/g;

let files = 0, hits = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith(".tsx")) continue;
    const src = fs.readFileSync(full, "utf8");
    const out = src.replace(re, (_m, tok, a) => { hits++; return `-${tok}/${a}`; });
    if (out !== src) { fs.writeFileSync(full, out, "utf8"); files++; }
  }
}
["app", "components"].forEach((d) => walk(path.join(ROOT, d)));
console.log(`Fixed ${hits} double-opacity classes across ${files} files.`);
