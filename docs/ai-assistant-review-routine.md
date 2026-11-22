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

- Set `AI_CACHE_DEBUG=1` in Vercel for about an hour, then check the logs: the cache **read** number should be greater than 0. If it is always 0, prompt caching is not working and every message is costing more than it should. Turn the setting off again afterwards.

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
