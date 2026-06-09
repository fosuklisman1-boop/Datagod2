/* Convert murky translucent card surfaces -> solid bg-card for dark mode.
   Matches a gradient run whose stops are ALL light (-50/-100 or primary/5|10),
   which in this codebase is always a card surface (CTAs/heros use -500/-600 or
   bare `from-primary`, which never match). Also: light borders -> border-border,
   bg-slate-50/100 -> muted. Run with --write to apply; default is dry-run report. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const LIGHT = `(?:(?:${PALETTE})-(?:50|100)(?:/\\d+)?|primary/(?:5|10)(?:/\\d+)?)`;
const GRADIENT = new RegExp(
  `bg-gradient-to-(?:br|tr|bl|tl|r|l|t|b)(?:\\s+(?:from|via|to)-${LIGHT})+`,
  "g"
);
const LIGHT_BORDER = new RegExp(
  `(^|[\\s"'\`{])((?:hover:|focus:|group-hover:)?)border-(?:${PALETTE})-(?:100|200|300)(?:/\\d+)?`,
  "g"
);
const SLATE_50 = /(^|[\s"'`{:])bg-slate-50(?![\w/-])/g;
const SLATE_100 = /(^|[\s"'`{:])bg-slate-100(?![\w/-])/g;

const report = {};
let files = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith(".tsx")) continue;
    let src = fs.readFileSync(full, "utf8");
    const before = src;

    src = src.replace(GRADIENT, (m) => { report[m] = (report[m] || 0) + 1; return "bg-card"; });
    src = src.replace(LIGHT_BORDER, (_m, b, pfx) => `${b}${pfx}border-border`);
    src = src.replace(SLATE_50, (_m, b) => `${b}bg-muted/40`);
    src = src.replace(SLATE_100, (_m, b) => `${b}bg-muted`);

    if (src !== before) {
      files++;
      if (WRITE) fs.writeFileSync(full, src, "utf8");
    }
  }
}
["app", "components"].forEach((d) => walk(path.join(ROOT, d)));

console.log(`${WRITE ? "WROTE" : "DRY-RUN"} — files affected: ${files}`);
console.log("\nDistinct gradient runs -> bg-card:");
Object.entries(report).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}x  ${k}`));
