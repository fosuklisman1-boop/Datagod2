/**
 * Tool-stubbed eval harness for the web AI assistant.
 *
 *   npx tsx scripts/ai-eval/run.ts --provider anthropic|openai|gemini|deepseek|groq --model <id> [--only <scenario id>]
 *
 * The API key comes from an environment variable only (never the database, never printed):
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY
 *
 * Real system prompts and real tool definitions are used; tool EXECUTION is stubbed with fixed fake data.
 * No database, no network except the model provider. Exit code 1 if any scenario fails.
 * Every scenario calls the model at least once, so a run costs real money: see the cost note at the end.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

const KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const providerName = arg("provider")
  const model = arg("model")
  const only = arg("only")
  if (!providerName || !KEY_ENV[providerName] || !model) {
    console.error("Usage: npx tsx scripts/ai-eval/run.ts --provider anthropic|openai|gemini|deepseek|groq --model <id> [--only <scenario id>]")
    return 2
  }
  const apiKey = process.env[KEY_ENV[providerName]]
  if (!apiKey) {
    console.error(`Set ${KEY_ENV[providerName]} in your environment first (it is never read from the database).`)
    return 2
  }

  // Modules imported below build Supabase clients at import time; no query is ever made (tools are stubbed).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321"
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "eval-placeholder"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "eval-placeholder"

  const { getProvider } = await import("../../lib/ai-providers")
  const { runScenarios, formatReport } = await import("../../lib/ai-eval/runner")
  type Scenario = import("../../lib/ai-eval/runner").Scenario

  let scenarios = JSON.parse(readFileSync(path.join(__dirname, "scenarios.json"), "utf8")) as Scenario[]
  if (only) scenarios = scenarios.filter((s) => s.id === only)
  if (scenarios.length === 0) {
    console.error(`No scenario matches --only ${only}`)
    return 2
  }

  console.log(`Running ${scenarios.length} scenario(s) on ${providerName} / ${model}. This costs real money: each scenario calls the model at least once.\n`)
  const outcomes = await runScenarios(scenarios, { provider: getProvider(providerName as never, apiKey), model })
  console.log(formatReport(outcomes))
  return outcomes.every((o) => o.pass) ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Never print the key; the message of a provider error does not contain it.
    console.error("Eval run failed:", err instanceof Error ? err.message : "unknown error")
    process.exit(1)
  },
)
