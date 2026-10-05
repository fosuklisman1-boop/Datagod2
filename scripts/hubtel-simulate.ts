// scripts/hubtel-simulate.ts
// Usage: HUBTEL_WEBHOOK_SECRET=x BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts [USSD|Webstore|Hubtel-App]
// Walks the data-bundle flow with the given inputs, prints each reply, then (if AddToCart) posts a Paid fulfilment.
const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const SECRET = process.env.HUBTEL_WEBHOOK_SECRET ?? ""
const platform = process.argv[2] ?? "USSD"
const mobile = process.env.MOBILE ?? "233200585542"
const recipient = process.env.RECIPIENT ?? "0244123456"
const sessionId = "sim" + Date.now().toString(16)

let seq = 1
async function interact(type: "Initiation" | "Response", message: string, clientState = "") {
  const res = await fetch(`${BASE}/api/ussd-hubtel/interaction?secret=${SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Type: type, Mobile: mobile, SessionId: sessionId, ServiceCode: "713", Message: message, Operator: "vodafone", Sequence: seq++, ClientState: clientState, Platform: platform }),
  })
  const json: any = await res.json()
  console.log(`> ${message}\n< [${json.Type}] ${json.Message}\n`)
  return json
}

async function main() {
  await interact("Initiation", "*713#")
  await interact("Response", "1")          // Buy Data Bundle
  await interact("Response", "1")          // MTN
  await interact("Response", "1")          // first package
  await interact("Response", recipient)    // recipient
  const cart = await interact("Response", "1") // Pay now
  if (cart.Type !== "AddToCart") return console.log("No AddToCart — stopping.")
  const price = cart.Item.Price
  const res = await fetch(`${BASE}/api/ussd-hubtel/fulfillment?secret=${SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      SessionId: sessionId, OrderId: "simorder" + Date.now().toString(16), ExtraData: {},
      OrderInfo: { CustomerMobileNumber: mobile, Status: "Paid", Currency: "GHS", Subtotal: price + 1,
        Items: [{ Name: cart.Item.ItemName, Quantity: 1, UnitPrice: price }],
        Payment: { PaymentType: "mobilemoney", AmountPaid: price + 1, AmountAfterCharges: price, IsSuccessful: true } },
    }),
  })
  console.log("fulfilment →", res.status, await res.json())
}
main().catch(e => { console.error(e); process.exit(1) })
