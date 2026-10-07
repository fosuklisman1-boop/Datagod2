// scripts/hubtel-simulate.ts
// Usage: BASE_URL=http://localhost:3000 FLOW=data npx tsx scripts/hubtel-simulate.ts [USSD|Webstore|Hubtel-App]
// FLOW = data (default) | airtime | rc | rccheck | afa
// Export HUBTEL_WEBHOOK_SECRET in your shell/environment first rather than typing it inline (shell history).
// The secret is sent in the x-hubtel-secret header. NEVER point BASE_URL at production (see
// docs/hubtel-ussd-runbook.md): the fulfilment step runs the REAL order handler (provider data,
// Digiwapy airtime, voucher SMS, AFA registration).
// SHOP=1 walks SHOP mode (set Mode = "Shop USSD" on /admin/ussd-hubtel first): it enters SHOP_CODE
// (an ACTIVE code with tokens in that non-production project; each run spends one token), then
// FLOW = data (default) | airtime | rc from the shop's menu (no afa / rccheck in shop mode).
// SHOP_CODE is REQUIRED with SHOP=1 (no default: a guessed code could spend a token on a real shop).
// REPLAY=1 posts the SAME fulfilment payload twice and prints both responses (duplicate-delivery check).
// The SessionId is printed at start. SESSION_ID=<printed id> re-uses it: with SHOP=1 the script then
// stops right after the code step (token-billing re-check: the balance must NOT drop again).
// Optional env: MOBILE (caller, 233...), RECIPIENT, AMOUNT (airtime), VOUCHER (PIN/Serial), GHCARD, SESSION_ID.
const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const SECRET = process.env.HUBTEL_WEBHOOK_SECRET ?? ""
const platform = process.argv[2] ?? "USSD"
const flow = process.env.FLOW ?? "data"
// AFA needs an MTN caller; the other flows default to the Plan 1 test number.
const mobile = process.env.MOBILE ?? (flow === "afa" ? "233244123456" : "233200585542")
const recipient = process.env.RECIPIENT ?? "0244123456"
const replay = process.env.REPLAY === "1"
const authHeaders = { "Content-Type": "application/json", "x-hubtel-secret": SECRET }
const reusedSession = !!process.env.SESSION_ID
const sessionId = process.env.SESSION_ID || "sim" + Date.now().toString(16)

/** An input, or a function of the current screen returning the input ("" skips the step). */
type Step = string | ((screen: string) => string)

/** The digit of the numbered line whose label starts with `label`. */
const pick = (label: string) => (screen: string): string => {
  const line = screen.split("\n").find(l => /^\d+\.\s/.test(l) && l.replace(/^\d+\.\s*/, "").startsWith(label))
  if (!line) throw new Error(`"${label}" not offered on:\n${screen}`)
  return line.split(".")[0]
}

const FLOWS: Record<string, { menu: string; steps: Step[] }> = {
  // MTN, first package, recipient
  data: { menu: "Buy Data Bundle", steps: ["1", "1", recipient] },
  // recipient, amount the caller pays (an unknown prefix would add a network-pick screen)
  airtime: { menu: "Buy Airtime", steps: [recipient, process.env.AMOUNT ?? "1"] },
  // Buy Vouchers, first board in stock, quantity 1
  rc: { menu: "Results Checker", steps: [pick("Buy Vouchers"), "1", "1"] },
  // Check Results, WASSCE, School, own voucher (when the combo is offered), PIN/serial, index, year, DOB, WhatsApp
  rccheck: {
    menu: "Results Checker",
    steps: [
      pick("Check Results"), "1", "1",
      screen => (screen.includes("I have a voucher") ? "2" : ""),
      process.env.VOUCHER ?? "012345678912/WGR1900112581",
      "0070202043", "2024", "15/06/2008", recipient,
    ],
  },
  // full name, Ghana Card, town, region
  afa: { menu: "AFA Registration", steps: ["Test Customer", process.env.GHCARD ?? "GHA-123456789-0", "Accra", "Greater Accra"] },
}

const shop = process.env.SHOP === "1"
const shopCode = process.env.SHOP_CODE
const SHOP_FLOWS: Record<string, { menu: string; steps: Step[] }> = {
  // first network the shop sells, first package, recipient
  data: { menu: "Buy Data Bundle", steps: ["1", "1", recipient] },
  // recipient, amount the caller pays (an unknown prefix would add a network-pick screen)
  airtime: { menu: "Buy Airtime", steps: [recipient, process.env.AMOUNT ?? "1"] },
  // first board in stock, quantity 1
  rc: { menu: "Results Checker", steps: ["1", "1"] },
}

let seq = 1
async function interact(type: "Initiation" | "Response", message: string, clientState = "") {
  const res = await fetch(`${BASE}/api/ussd-hubtel/interaction`, {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ Type: type, Mobile: mobile, SessionId: sessionId, ServiceCode: "713", Message: message, Operator: "vodafone", Sequence: seq++, ClientState: clientState, Platform: platform }),
  })
  const json: any = await res.json()
  console.log(`> ${message}\n< [${json.Type}] ${json.Message}\n`)
  return json
}

async function main() {
  const flows = shop ? SHOP_FLOWS : FLOWS
  const f = flows[flow]
  if (!f) throw new Error(`Unknown FLOW "${flow}"${shop ? " in shop mode" : ""}. Use one of: ${Object.keys(flows).join(", ")}`)
  if (shop && !shopCode) {
    throw new Error("SHOP=1 requires SHOP_CODE=<code> (an ACTIVE test shop's code in a NON-production project; each new session spends one token)")
  }
  console.log(`SessionId: ${sessionId}${reusedSession ? " (re-used from SESSION_ID)" : ""}\n`)
  let menu = await interact("Initiation", "*713#")
  if (shop) {
    if (menu.Type !== "response" || !menu.Message.includes("Enter shop code")) {
      return console.log('Not in shop mode (set Mode = "Shop USSD" on /admin/ussd-hubtel) - stopping.')
    }
    menu = await interact("Response", shopCode!)
    if (menu.Type !== "response" || !menu.Message.includes("What would you like to buy?")) {
      return console.log("Shop code refused (invalid, inactive, or no sessions left) - stopping.")
    }
    if (reusedSession) {
      return console.log("Re-used SessionId: shop menu shown. Check token_balance is UNCHANGED - stopping before any order.")
    }
  } else if (menu.Type !== "response" || menu.Message.includes("Enter shop code")) {
    return console.log("The code is in shop mode: run with SHOP=1 SHOP_CODE=<code> - stopping.")
  }
  let reply = await interact("Response", pick(f.menu)(menu.Message))
  for (const step of f.steps) {
    if (reply.Type !== "response") return console.log("Session ended early - stopping.")
    const input = typeof step === "string" ? step : step(reply.Message)
    if (!input) continue
    reply = await interact("Response", input)
  }
  if (reply.Type !== "response") return console.log("Session ended early - stopping.")
  const cart = await interact("Response", "1") // 1. Pay now
  if (cart.Type !== "AddToCart") return console.log("No AddToCart - stopping.")
  const price = cart.Item.Price
  const payload = JSON.stringify({
    SessionId: sessionId, OrderId: "simorder" + Date.now().toString(16), ExtraData: {},
    OrderInfo: { CustomerMobileNumber: mobile, Status: "Paid", Currency: "GHS", Subtotal: price + 1,
      Items: [{ Name: cart.Item.ItemName, Quantity: 1, UnitPrice: price }],
      Payment: { PaymentType: "mobilemoney", AmountPaid: price + 1, AmountAfterCharges: price, IsSuccessful: true } },
  })
  for (let i = 0; i < (replay ? 2 : 1); i++) {
    const res = await fetch(`${BASE}/api/ussd-hubtel/fulfillment`, { method: "POST", headers: authHeaders, body: payload })
    console.log(`fulfilment${replay ? " #" + (i + 1) : ""} ->`, res.status, await res.json())
  }
}
main().catch(e => { console.error(e); process.exit(1) })
