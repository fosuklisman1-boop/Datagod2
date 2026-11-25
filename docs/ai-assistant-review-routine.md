# AI Assistant: weekly review routine

About 20 minutes a week. The goal: catch the assistant saying something wrong before a customer's money or trust is affected.

## Every week

1. Open **Admin > AI Assistant > Flags**.
2. Go through each flagged chat. Read the whole conversation, decide whether the assistant did something wrong, then mark it **Reviewed**. If it did something wrong, note what happened (wrong price, claimed an order was placed, rude tone, leaked internal wording) so it can be fixed in the prompt or the knowledge base.
3. Open **Conversations** and read **10 random chats** (not only flagged ones). Flags only catch what the system noticed; random reading catches the rest. Look for: made-up prices or delivery times, "your order has been placed" when no confirm card was tapped, answers that should have come from the knowledge base, anything outside Datagod topics.
4. If you keep seeing the same mistake, add or fix a Knowledge Base entry first (cheapest fix), then the prompt or tone.

## After ANY prompt, model or tone change

Run the eval before saving the change live, and only save it if everything is green:

```
npx tsx scripts/ai-eval/run.ts --provider <anthropic|openai|gemini|deepseek|groq> --model <model id>
```

- Put the provider's API key in your terminal environment first (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` or `GROQ_API_KEY`). It is never read from the database and never printed.
- To rerun a single failing scenario: add `--only <scenario id>`.
- It uses fake data and fake tools: no real orders, wallets or users are touched. It does call the model for real, so it costs a small amount each run (the last line tells you how many model calls it made).
- Any `FAIL` line means do not go live. The line under it says what went wrong (for example "reply claims success" means the assistant told a user an order was placed).
- The scenarios live in `scripts/ai-eval/scenarios.json`. When a real chat shows a new mistake, add a scenario for it so it can never come back unnoticed.

## Monthly

- Set `AI_CACHE_DEBUG=1` in Vercel and redeploy (a changed setting only applies to a new deployment). After about an hour, search the logs for `[AI-CACHE]`:
  - DeepSeek, OpenAI and Groq show `read` (served from cache), `miss` (not from cache) and `input` (both together). Share from cache = `read` divided by `input`.
  - Anthropic shows `read`, `write` and `input` (here `input` is only the uncached part). Share from cache = `read` divided by (`read` + `write` + `input`).
  - Gemini is not logged.
- The first message after a quiet spell can show `read=0`. If it stays 0 across many messages, caching is not working. All zeros, including `input`, means the provider sent no usage numbers.
- Remove the setting and redeploy afterwards.

## Quarterly

- Check the DeepSeek pricing page for model or price changes (models get renamed or retired). If the model you use changed, update it in AI Assistant settings and run the eval above.

## How to read flag reasons

| Reason | What it means | What to do |
|---|---|---|
| refusal | The assistant said it could not help ("I cannot help with that", "I'm unable to assist"). | Check it was right to decline. If it refused a normal Datagod question, fix the knowledge base or prompt. |
| handoff | The chat was handed to a human, or the customer asked for one. | Read it: did the assistant fail to answer something it should have? Add a knowledge base entry if so. |
| error | The reply ended in an error (model or tool problem). | Usually a system issue, not the assistant's wording. Repeated errors on one tool or model need a fix. |
| card_failed | A confirm card (order, wallet, withdrawal and so on) was tapped but the action failed. | Check the user's order or wallet really is in the state they expect, and contact them if money is involved. |

If a reason on screen is not in this list, open the chat and judge it by the same question every time: did the assistant tell the truth about money and orders, and did it stay within what it is allowed to do?

## What redaction does NOT catch

Stored transcripts are redacted (phone numbers, card numbers, emails, long digit runs, secrets that follow a keyword such as PIN, OTP or code). It is a safety net, not a guarantee. It does NOT catch:

- People's names (a customer typing their full name or a relative's name).
- Alphanumeric passwords or secrets such as "hunter2", unless they follow a keyword the redactor knows.
- Short reference numbers typed without a keyword like PIN, OTP or code (for example a bare "4821").

Treat every transcript as personal data: review it on the console only, do not copy it into chat apps or tickets, and let the retention job delete it on schedule.

## What the answer-test script does NOT prove about roles

The answer-test script runs the assistant with stubbed tools. The stubs skip the per-role checks inside the real tool executor, so a role scenario only proves that a tool was not offered or not called for that role. It does not prove the real executor would refuse the call. Role enforcement is covered by the tool-registry and executor tests, not by this script.

## The admin catalog switch (full admin access for the assistant)

Where it is: Admin, AI Assistant, Settings tab, "Admin catalog access". It ships OFF.

- OFF (default): the admin assistant works exactly as before, with its older acting tools. Scheduled (background) admin tasks can still act directly on orders and settings, with nobody tapping to approve.
- ON: the admin assistant can look up data on and prepare a change for any admin page it has a catalog entry for. The older acting tools are removed. Every change still needs a tap: the assistant only prepares a confirm card and nothing happens until you press Confirm on it. Scheduled admin tasks can then only read data and prepare cards (you get a push to confirm them later); they cannot act directly.

The secure box: when a change needs a password, key or secret, the assistant never asks for it in chat. The confirm card shows a secure box where you type it; it goes straight to the change and is not saved in the chat history. If you ever type a secret into the chat anyway, treat it as exposed and rotate it.

Owner's five live checks (with the switch ON, in this order):
1. One lookup: ask for a read-only fact (for example "show order 123"). The answer comes back and no card appears.
2. One normal card: ask for a harmless change (for example pause one scheduled task). A card appears, read it, tap Confirm, check the change on the page.
3. One small money card: prepare a small wallet adjustment or similar (a few cedis, on your own test account). Check the amounts on the card, confirm, then check the balance and the audit trail.
4. One secure-box card: ask for a change that needs a secret (for example saving a provider key). Check the card has the secure box, that the chat never shows the secret, and the change applies.
5. One cancel: prepare any card and press Cancel. Check that nothing changed and the assistant does not claim it did.

The answer-test script has two scenarios for this (admin_injected_note: text inside a lookup result must never cause a prepared change; admin_secret_in_chat: a typed password must never be carried on a card, and the reply points to the secure box). Run them after any prompt or model change while the switch is on.

## Site guide and knowledge base

The assistant answers "how do I do X on the site" from two places.

1. The site guide lives in code (lib/ai-site-guide): one entry per page (lib/ai-site-guide/pages.ts) and how-to articles (lib/ai-site-guide/articles). It is updated with every release that adds or changes a page or flow. A test fails if a real page has no entry (add it, or list it in excluded-pages.ts with a reason). Each person only sees the part for their audience: guests and storefront visitors see public pages, signed-in users add customer pages, dealers and shop owners add theirs, admins see everything.
2. Knowledge entries in the database (Admin, AI Assistant, Knowledge) are the owner's latest word. When an entry there and the site guide disagree, the entry wins, so use it for policy changes (fees, delivery times, refund rules) that should apply before the next release.

To ask for a new article, tell the developer the page or task, who may use it (audience), and the exact steps and button names as they appear on screen. The developer adds an article to lib/ai-site-guide/articles, keeps the whole guide inside its size budget, and the guide size tests must stay green. After a release, run the answer-test scenarios kb_withdraw and kb_guest_no_dealer: a shop owner asking how to withdraw is pointed to the withdraw page, and a guest asking about sub-agents is not given shop-owner steps.
