import Link from "next/link"
import { V2_BASE_URL } from "@/lib/api-v2/docs/registry"
import { CodeBlock } from "./CodeTabs"
import { StepList } from "./StepList"

const STEPS = [
  "Create a test key in your dashboard under Developer. Test keys never touch real money.",
  "Send your first call to the sandbox with the key in the Authorization header, as shown below.",
  "Try a data purchase in the sandbox, including one that fails. See Testing failures in the sandbox section.",
  "When you are ready, follow the Go live checklist to request a live key.",
]

const SAMPLE = `curl ${V2_BASE_URL}/account/role \\\n  -H "Authorization: YOUR_TEST_KEY"`

/** Four steps and one runnable call, shown at the top of the hub. Static server markup. */
export function QuickStart() {
  return (
    <section aria-labelledby="quick-start-title" className="space-y-5 rounded-2xl border border-white/60 bg-card p-4 clay sm:p-6 lg:p-8">
      <div className="space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">Quick start</p>
        <h2 id="quick-start-title" className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          Your first call in a few minutes
        </h2>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <StepList steps={STEPS} />
        <div className="min-w-0 space-y-3">
          <CodeBlock code={SAMPLE} title="cURL" copyLabel="cURL command" />
          <p className="text-sm text-muted-foreground">
            Ready to build? Start from a{" "}
            <Link href="/developers/starter-kits" className="font-semibold text-primary underline-offset-4 hover:underline">
              starter kit
            </Link>{" "}
            or read the{" "}
            <Link href="/developers/go-live" className="font-semibold text-primary underline-offset-4 hover:underline">
              Go live checklist
            </Link>
            .
          </p>
        </div>
      </div>
    </section>
  )
}
