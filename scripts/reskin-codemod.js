/* One-shot reskin codemod: map hardcoded Tailwind palette -> semantic tokens.
   Behavior-neutral (class names only). Run once, then delete.
   Replacements are whole-token (bounded by space, quote, or backtick) so we
   never partially rewrite a class. Order: longest/prefixed first. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["app", "components"];
// Files already hand-tuned for the shell — don't double-process.
const SKIP = new Set(
  [
    "components/layout/sidebar.tsx",
    "components/layout/header.tsx",
    "components/layout/bottom-nav.tsx",
    "components/layout/dashboard-layout.tsx",
    "components/theme-toggle.tsx",
  ].map((p) => path.join(ROOT, p.replace(/\//g, path.sep)))
);

// [from, to] — applied in order.
const MAP = [
  // ---- blue accent -> primary ----
  ["hover:bg-blue-800", "hover:bg-primary/90"],
  ["hover:bg-blue-700", "hover:bg-primary/90"],
  ["hover:bg-blue-600", "hover:bg-primary/90"],
  ["active:bg-blue-700", "active:bg-primary/90"],
  ["hover:text-blue-800", "hover:text-primary"],
  ["hover:text-blue-700", "hover:text-primary"],
  ["hover:text-blue-600", "hover:text-primary"],
  ["focus:ring-blue-500", "focus:ring-ring"],
  ["focus:border-blue-500", "focus:border-ring"],
  ["ring-blue-500", "ring-ring"],
  ["from-blue-700", "from-primary"],
  ["from-blue-600", "from-primary"],
  ["from-blue-500", "from-primary"],
  ["via-blue-600", "via-primary"],
  ["to-blue-700", "to-primary/80"],
  ["to-blue-600", "to-primary/80"],
  ["to-blue-500", "to-primary/80"],
  ["bg-blue-700", "bg-primary"],
  ["bg-blue-600", "bg-primary"],
  ["bg-blue-500", "bg-primary"],
  ["bg-blue-100", "bg-primary/10"],
  ["bg-blue-50", "bg-primary/5"],
  // light gradient stops (hero/card backgrounds) + companion indigo stops
  ["from-blue-100", "from-primary/10"],
  ["from-blue-50", "from-primary/5"],
  ["to-blue-100", "to-primary/10"],
  ["to-blue-50", "to-primary/5"],
  ["via-blue-50", "via-primary/5"],
  ["to-blue-800", "to-primary"],
  ["from-indigo-100", "from-primary/10"],
  ["from-indigo-50", "from-primary/5"],
  ["to-indigo-100", "to-primary/10"],
  ["to-indigo-50", "to-primary/5"],
  ["via-indigo-50", "via-primary/5"],
  // light text sitting on (now primary) hero gradients
  ["text-blue-50", "text-primary-foreground/90"],
  ["text-blue-100", "text-primary-foreground/80"],
  ["text-blue-200", "text-primary-foreground/70"],
  ["text-blue-800", "text-primary"],
  ["text-blue-700", "text-primary"],
  ["text-blue-600", "text-primary"],
  ["text-blue-500", "text-primary"],
  ["border-blue-600", "border-primary"],
  ["border-blue-500", "border-primary"],
  ["border-blue-200", "border-primary/20"],
  ["border-blue-100", "border-primary/20"],
  // ---- neutrals -> semantic (this is what makes dark mode work everywhere) ----
  ["hover:bg-gray-100", "hover:bg-accent"],
  ["hover:bg-gray-50", "hover:bg-accent"],
  ["divide-gray-200", "divide-border"],
  ["divide-gray-100", "divide-border"],
  ["border-gray-300", "border-border"],
  ["border-gray-200", "border-border"],
  ["border-gray-100", "border-border"],
  ["bg-gray-100", "bg-muted"],
  ["bg-gray-200", "bg-muted"],
  ["bg-gray-50", "bg-muted/40"],
  ["text-gray-900", "text-foreground"],
  ["text-gray-800", "text-foreground"],
  ["text-gray-700", "text-foreground"],
  ["text-gray-600", "text-muted-foreground"],
  ["text-gray-500", "text-muted-foreground"],
  ["text-gray-400", "text-muted-foreground"],
];

// Build one regex per token with class-boundary anchors.
// Left allows a variant prefix separator ':' (dark:, hover:, md: …).
// Right forbids a trailing word-char/hyphen so "bg-gray-50" never eats into
// "bg-gray-500", while still allowing an opacity suffix like "/40" to follow.
const BOUND_L = `(^|[\\s"'\\\`{:])`;
const BOUND_R = `(?![\\w-])`;
const rules = MAP.map(([from, to]) => ({
  re: new RegExp(BOUND_L + escapeRe(from) + BOUND_R, "g"),
  to,
}));
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

let filesChanged = 0;
let totalReplacements = 0;
const perToken = {};

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith(".tsx")) continue;
    if (SKIP.has(full)) continue;
    let src = fs.readFileSync(full, "utf8");
    const before = src;
    for (const { re, to } of rules) {
      src = src.replace(re, (m, p1) => {
        // m includes the left boundary char (p1); keep it, swap the token.
        return p1 + to;
      });
    }
    if (src !== before) {
      fs.writeFileSync(full, src, "utf8");
      filesChanged++;
    }
  }
}

// Count replacements for the report (separate pass on originals would be costlier;
// instead recount via diff of token frequencies).
DIRS.forEach((d) => walk(path.join(ROOT, d)));
console.log(`Reskin codemod complete. Files changed: ${filesChanged}`);
