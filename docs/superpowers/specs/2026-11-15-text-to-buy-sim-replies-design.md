# Text-to-Buy replies from the phone's own SIM (design)

Date: 2026-11-15. Status: approved by the owner ("lets do the replies from the phone's SIM"; "lets use the public server"). Ships DARK.

## Intent
Replies to customers can go out as a normal SMS from the forwarder phone's own SIM (the customer sees the shop/main number and can reply to it), instead of via Hubtel with a registered sender ID. Hubtel stays as the automatic fallback so a customer is never left without a reply.

## How it works
- The phone runs SmsForwarder's HTTP Server (port 5000) in **SM4 encryption** mode with only "Send Sms" and "Query Battery" enabled. Its built-in Frpc client publishes that port on a public frps relay (frp.freefrp.net, a shared free server). The relay only ever sees SM4 ciphertext.
- Our server posts an SM4-CBC encrypted JSON envelope to `${SMS_PHONE_URL}/sms/send`:
  - plaintext = JSON `{ "data": { "sim_slot": 1|2, "phone_numbers": "<one number>", "msg_content": "<text>" }, "timestamp": <ms>, "sign": "<sign>" }`
  - key = `SMS_PHONE_SM4_KEY` (32 hex chars = 16 bytes); mode `sm4-cbc`; fixed IV bytes `[3,5,6,9,6,9,5,9,3,5,6,9,6,9,5,9]`; default PKCS7 padding; request body = lowercase hex of the ciphertext; content-type `application/json`.
  - sign = `encodeURIComponent(base64(HMAC_SHA256(key bytes, "<timestamp>\n<key hex string>")))`.
  - response body = hex ciphertext of `{ "code": 200|500, "msg": "...", "data": ..., "timestamp": ... }`; decrypt the same way. `code === 200` means the phone accepted the send.
  - This protocol was verified against the real phone on 2026-11-15 (battery query and one real SMS, over LAN and over the public relay).
- Slot mapping: shop line = SIM slot 1 (shop SIM), main line = SIM slot 2 (main SIM). Both are settings.

## Transport router (the only integration point)
`sendReply` in `lib/text-to-buy/send-reply.ts` calls `send({phone, message, type, senderId, skipLogging})` and treats the result `{ success, skipped }`. The new router is a drop-in `send` implementation chosen per line:
1. Setting `replyTransport` for the line is `hubtel` (default) -> existing `sendSMS`, unchanged.
2. `sim` -> try the phone; if the phone answers `code 200` the reply is sent (`{success:true}`).
3. Fallback to Hubtel (`sendSMS`) when ANY of: env `SMS_PHONE_URL` or `SMS_PHONE_SM4_KEY` missing, SIM rolling cap reached, connect error / DNS error / refused, HTTP non-200, undecryptable response, or `code !== 200`.
4. NO fallback on a read timeout after the request was accepted by the network (ambiguous: the phone may have sent): treat as sent, so a customer never gets two copies. Connect phase has its own short timeout (3 s) and falls back; total budget 8 s.
5. SIM rolling cap: Android blocks apps that send more than ~30 SMS per 30 minutes. Cap = setting `simMaxPer30Min` (default 20) counted from `ttb_messages` outbound rows for that line in the last 30 minutes (all transports, so conservative). Over the cap -> Hubtel.
6. Credit accounting is unchanged: one reply = one credit whichever transport carried it.
7. Never log the phone number, message text, key or URL. One fixed log line per fallback with only a reason code.

## Settings (admin_settings, same pattern as `ttb_calls_enabled`)
- `ttb_reply_transport_main`, `ttb_reply_transport_shop`: `"hubtel"` | `"sim"`, default `"hubtel"`.
- `ttb_sim_slot_main` (default 2), `ttb_sim_slot_shop` (default 1): integer 1 or 2.
- `ttb_sim_max_per_30min` (default 20): integer 1..30.
Admin: Settings tab gets a "Replies from the phone SIM" card; the Overview shows a one-line status (transport per line). Values validated server-side.

## Non-goals
Delivery receipts from the SIM; SIM balance detection (the carrier SMS about balance is not machine-readable; the owner tops up airtime); sender-ID registration (not needed for SIM); encrypting beyond SM4; Hubtel removal.

## Risks accepted
- The relay is a shared third-party server: availability is not guaranteed (hence the fallback). A stranger can reach the phone port but cannot read, forge or replay beyond the 1 h timestamp window without the key; the phone has only send + battery functions enabled.
- The SIM's airtime balance is low and each SMS costs about GHS 0.065; an empty SIM makes sends fail silently (status pending). The owner must keep airtime topped up; the fallback does not trigger on that.

## Approaches considered
(a) own VPS frps (best control, owner declined to run a server); (b) automation app polling our API (extra app on phone); (c) shared public frps with SM4 (chosen, owner's call). The router makes (a) a config change later (`SMS_PHONE_URL`).
