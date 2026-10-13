<!-- Saved from Hubtel Commission Services docs (Hubtel last updated 2026-10-12), pasted by user 2026-10-13. Source of truth for the integration. -->
# API REFERENCE (saved from user's paste, 2026-10-13)

**Base:** `https://cs.hubtel.com/commissionservices/{DisbursementAccountNo}/{ServiceID}` . JSON. `Authorization: Basic base64(clientId:secret)`. Example account in docs: 11691.
Flow: POST -> immediate response `0001` pending -> final callback to `CallbackUrl`. If no callback after >=5 min, MUST call Status Check API. Callback source IP: **18.202.122.131** (optional whitelist).

## ServiceIDs
| Service | ServiceID |
|---|---|
| MTN Airtime | fdd76c884e614b1c8f669a3207b09a98 |
| Telecel Airtime | f4be83ad74c742e185224fdae1304800 |
| AirtelTigo (AT) Airtime | dae2142eb5a14c298eace60240c09e4b |
| ECG Prepaid & Postpaid | e6d6bac062b5499cb1ece1ac3d742a84 |
| Telecel Broadband | b9a1aa246ba748f9ba01ca4cdbb3d1d3 |
| MTN Data | b230733cd56b4a0fad820e39f66bc27c |
| Telecel Data | fa27127ba039455da04a2ac8a1613e00 |
| AirtelTigo Data | 06abd92da459428496967612463575ca |
| DSTV | 297a96656b5846ad8b00d5d41b256ea7 |
| GOtv | e6ceac7f3880435cb30b048e9617eb41 |
| Telecel Postpaid Bills | a3ab78c84c6b4976b78a6f393e247a72 (no endpoint docs in paste) |
| Ghana Water | 6c1e8a82d2e84feeb8bfd6be2790d71d |
| StarTimes TV | 6598652d34ea4112949c93c079c501ce |

## Common POST body
`{ Destination, Amount (2dp), CallbackUrl, ClientReference (unique, ours), Extradata?: { bundle, ... } }`
Immediate response: `{ ResponseCode:"0001", Message, Data:{ ClientReference, Amount, TransactionId, Meta:{ Commission:"0.0198" } } }` (Commission is a STRING; known at submit time, repeated in callback).
Final callback: `{ ResponseCode:"0000", Data:{ AmountDebited, TransactionId, ClientReference, Description, ExternalTransactionId, Amount, Charges, Meta:{Commission}, RecipientName } }`. Non-"0000" = FAILED (Description carries the reason, e.g. invalid bundle / unregistered recipient).

## Airtime (MTN / Telecel / AT)
POST, Destination = phone (233XXXXXXXXX), Amount. **Max GHS 100 per request.** No query step.

## Data bundles (MTN / Telecel / AT)
1. Query: `GET .../{ServiceID}?destination={phone}` -> `Data:[{Display, Value, Amount}]` (bundles are per-number and change; ALWAYS query before buy).
2. Buy: POST with `Amount` = bundle price and `Extradata:{bundle: <Value>}`. Mismatch of bundle/amount -> fails.
- MTN Values: `data_bundle_1..4`, `kokrokoo_bundle_1`, `flexi_data_bundle` (repeats for many amounts! Value is NOT unique -> key by Value+Amount), `video_bundle_*`, `social_media_bundle_*`.
- Telecel: Display = plan name, Value = size string e.g. `" 5.7 GB"` / `"25 MB"` (note leading spaces in sample; trim carefully but send exactly what query returned).
- AT: Value like `DATA1, DATA2, DATA5, DATA10, DATA20, DATA50`, Display e.g. "2GB Bundle (GHS 10)".

## Utilities
- **DSTV / GOtv / StarTimes**: Query `?destination={accountNo}` -> name, amountDue, account (StarTimes also bouquet). POST Destination = account number, Amount (any, 2dp). No Extradata.
- **Telecel Broadband**: Query `?destination={landline e.g. 0302450262}` -> name, amountDue, account. POST Destination = landline, Amount, `Extradata:{bundle: <broadband account number, e.g. P0444101>}`.
- **ECG**: Query `?destination={mobile}` lists meters linked to that phone via ECG Power App: `Data:[{Display:"NAME (meterNo)", Value: meterNo, Amount: outstanding}]`. POST Destination = mobile, Amount, `Extradata:{bundle: <meter number; for POSTPAID the account number>}`. **WARNING: POST links the phone to the meter if not already linked.**
- **Ghana Water**: Query `?destination={meterNo}&mobile={phone}` -> name, amountDue, **sessionId (unique per query; must be used in the POST)**. POST Destination = customer phone, Amount, `Extradata:{bundle: <meter no>, Email: <customer email, mandatory>, SessionId}`.

## Transaction Status Check
`GET https://api-txnstatus.hubtel.com/transactions/{COLLECTION_Account_No}/status?clientReference=...` (preferred) | `hubtelTransactionId` | `networkTransactionId`. Basic auth. **IP-whitelisted, max 4 IPs per service.** Note: uses the *Collection* account number (not Disbursement).
Response: `{ message, responseCode, data:{ date, status:"Paid"|"Unpaid", transactionId, externalTransactionId, paymentMethod, clientReference, currencyCode, amount, charges, amountAfterCharges, isFulfilled:true|false|null } }`. Success sample: Paid + isFulfilled true; failure sample: Unpaid + isFulfilled false.

## Response codes (non-0000 = FAILED, except 0001 pending)
| Code | Meaning | Action |
|---|---|---|
| 0000 | success | - |
| 0001 | pending, await callback | - |
| 0005 | HTTP failure/exception, **state UNKNOWN** | do NOT refund blindly; status-check / contact Hubtel RSE |
| 2000 / 2001 | general failure | read callback Description (bad recipient, invalid bundle, ...) |
| 4000 | error / missing mobile value / verification error | check params |
| 4010 | validation errors | required param empty/invalid |
| 4101 | auth denied / prepaid account not found | check Basic auth + Disbursement Account in URL |
| 4103 | permission denied | check API keys |
| 4075 | **insufficient prepaid balance** (Disbursement Account) | top up Disbursement Account; admin alert |

## Doc gaps noted
- Doc typos: Telecel/AT bundle param text says "MTN Data Bundle Query"; GoTV sample callback description says DSTV. Telecel Postpaid Bills has a ServiceID but no endpoint docs.
- Sample header `Authorization: Basic endjeOBiZHhza250fT3==` is a placeholder (not a real secret).
- No documented webhook signature on Commission callbacks (only IP whitelist) -> authenticate callback via unguessable `?secret=`/per-txn token + IP check.
