import fs from "node:fs"
import path from "node:path"

export interface ScannedRoute {
  path: string
  method: string
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

function detectMethods(source: string): string[] {
  const found: string[] = []
  for (const m of METHODS) {
    const re = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\s*[=:]|export\\s*\\{[^}]*\\bas\\s+${m}\\b[^}]*\\}`,
    )
    if (re.test(source)) found.push(m)
  }
  return found
}

function toApiPath(relDir: string): string {
  const segs = relDir
    .split(/[\\/]/)
    .filter(Boolean)
    .map((s) => {
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(s)
      if (catchAll) return `:${catchAll[1]}`
      const dyn = /^\[(.+)\]$/.exec(s)
      if (dyn) return `:${dyn[1]}`
      return s
    })
  return ["/api/admin", ...segs].join("/")
}

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (ent.name === "route.ts") out.push(full)
  }
}

/** Lists every exported method of every app/api/admin route file under rootDir (the repo root). */
export function scanAdminRoutes(rootDir: string): ScannedRoute[] {
  const base = path.join(rootDir, "app", "api", "admin")
  const files: string[] = []
  if (fs.existsSync(base)) walk(base, files)
  const seen = new Set<string>()
  const result: ScannedRoute[] = []
  for (const file of files) {
    const apiPath = toApiPath(path.relative(base, path.dirname(file)))
    for (const method of detectMethods(fs.readFileSync(file, "utf8"))) {
      const key = `${method} ${apiPath}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ path: apiPath, method })
    }
  }
  return result.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path < b.path ? -1 : 1,
  )
}
