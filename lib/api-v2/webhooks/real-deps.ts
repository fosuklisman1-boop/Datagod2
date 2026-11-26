// Real wiring for webhook delivery (cron route and the Send-test route): system DNS with every address returned, and the
// pinned HTTPS transport. Tests use fakes instead.
import { lookup } from "dns/promises"
import { httpsPost } from "./send"
import type { CycleDeps } from "./worker"

export const realCycleDeps: CycleDeps = {
  now: () => new Date(),
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family })),
  post: httpsPost,
}
