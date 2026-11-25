import type { SiteArticle } from "../types"

/**
 * How-to articles for becoming an agent, running a shop, pricing and profit, sub-agents, the USSD / WhatsApp /
 * text-order channels, and shop customers. Written from the real pages: app/join, app/dashboard/my-shop,
 * shop-pricing, shop-profit-logs, sub-agents, sub-agent-catalog, buy-stock, ussd-shop, text-orders, customers,
 * blocked-numbers, sms/compose, app/join/shop/[handle], components/shop/SubAgentRequestForm, and the shop USSD
 * flow in lib/ussd-hubtel/flows/shop.ts.
 *
 * No numbers at all: prices, fees, costs, limits and dial codes are configurable, so every article says "shown on
 * the page". Switchable features (text orders, blocked numbers, USSD / WhatsApp activation, open joining) say
 * "may not be available on your account yet". Withdrawals live in the money article `withdraw-shop-profit`.
 */
export const SHOP_ARTICLES: SiteArticle[] = [
  {
    id: "become-a-dealer-or-agent",
    title: "Become a dealer or agent and start selling",
    audiences: ["public", "customer"],
    keywords: ["become agent", "become dealer", "reseller", "start selling", "sell data", "open shop", "join", "sign up", "upgrade", "wholesale", "make money", "business", "agent"],
    summary: "How to start reselling data: sign up, open your own shop from My shop, and upgrade to a dealer plan for cheaper prices. Plans and prices come from the pages.",
    body: `What it is: the way to start selling data, airtime and more to your own customers. You get your own shop link and set your own prices. A dealer plan gives you cheaper wholesale prices, so your profit is bigger.

Who can use it: anyone. You need an account first.

Where: Become a reseller (/join) explains the benefits and has the sign-up button. Once you are logged in, open My shop (/dashboard/my-shop) to create your shop, and Upgrade to dealer (/dashboard/upgrade) for a dealer plan.

How:
1. Open Become a reseller and tap the sign-up button, or sign up from Sign up (/auth/signup). If you already have an account, log in instead.
2. Verify your phone number with the code sent by SMS.
3. Log in and open My shop to create your shop. See the article on creating your shop.
4. To get dealer prices, open Upgrade to dealer, pick a plan and pay. See the article on dealer plans (dealer-upgrade-subscription). The price and length of each plan are shown on that page.
5. Set your selling prices from your shop's pricing page and share your shop link.

What happens next: your customers buy from your shop link and your profit is added to your balance for every sale. You can later invite sub-agents to sell under you.

If something goes wrong:
- You do not see My shop in your menu: shop creation may not be available on your account yet. Ask in Support chat (/dashboard/complaints).
- Paid for a dealer plan but nothing changed: open Support chat with your payment reference.
- Another agent sent you an invite link: use that link to join under their network instead.`,
  },
  {
    id: "create-your-shop",
    title: "Create your shop (storefront)",
    audiences: ["customer", "dealer", "shop_owner"],
    keywords: ["create shop", "open shop", "my shop", "storefront", "shop name", "logo", "description", "new shop", "start shop", "shop link", "pending approval", "go live"],
    summary: "Create your own storefront on the My shop page with a name, description and logo. Then set prices so it opens. Covers the Pending Approval and setup states.",
    body: `What it is: your own page where customers buy data, airtime and more from you at your prices.

Who can use it: logged-in users whose account allows running a shop. If the My shop page or the menu is missing for you, shop creation may not be available on your account yet.

Where: My shop (/dashboard/my-shop). Later, edit your shop name, logo, description and contacts on Shop profile (/dashboard/shop-profile).

How:
1. Open My shop. If you have no shop yet you see a form.
2. Type your Shop Name. It is required. Add a Description and a Shop Logo if you like.
3. Tap Create Shop.
4. Open Shop pricing (/dashboard/shop-pricing) and save your prices. See the article on pricing and profit.
5. Copy your shop link from My shop and share it. See the article on sharing your link.

What happens next: the top of My shop shows a status badge. "Active" means customers can buy. "Pending Approval" means the shop opens once it is approved. If the badge says "Setting up: set your prices to open", tap it and save your prices, then your shop opens. My shop also shows your sales, profit, orders and quick links to everything else.

If something goes wrong:
- Shop name is required: type a name and try again.
- Still Pending Approval after a while, or Create Shop fails: open Support chat (/dashboard/complaints).
- Customers say the link does not work: check the badge says Active and that you saved prices.`,
  },
  {
    id: "shop-pricing-and-profit",
    title: "Set your shop prices and understand your profit",
    audiences: ["shop_owner"],
    keywords: ["pricing", "price", "selling price", "profit", "margin", "markup", "bulk pricing", "cost price", "earnings", "profit logs", "set price", "afa price", "airtime profit", "results checker", "in stock", "out of stock"],
    summary: "Set what you charge on Shop pricing, see your profit on each sale, and check every entry on Profit logs. Prices and costs are shown on the pages.",
    body: `What it is: you choose the selling price for each product in your shop. The difference between what you charge and your cost is your profit. Your cost is shown next to each product.

Who can use it: shop owners and sub-agents.

Where: Shop pricing (/dashboard/shop-pricing). See your profit on Shop dashboard (/dashboard/shop-dashboard) and every entry on Profit logs (/dashboard/shop-profit-logs).

How:
1. Open Shop pricing and choose a tab: Data Bundles, Airtime, Results Checker or AFA Registration.
2. For data, pick a network, type your selling price on each package and tap Save. You can mark a network in stock or out of stock.
3. To change many packages at once, switch to Bulk Pricing, pick the network and the type of change, check the preview table and apply it.
4. For airtime and Results Checker you set your own profit on top of the cost. For AFA Registration you type the full price you want to charge. Clearing it turns AFA off in your shop.
5. Tap Save All & Go Live to save everything at once.

What happens next: new prices show on your storefront. When a customer's payment goes through, your profit for that sale is added to your balance and appears on Profit logs. Your balance is on My shop (/dashboard/my-shop). To take profit out, see the article withdraw-shop-profit.

If something goes wrong:
- A price will not save: the page tells you when a price is too low. Raise it and save again.
- Cost prices did not load: tap the retry button on the page.
- A profit entry looks missing: check Shop orders (/dashboard/shop-orders), then open Support chat (/dashboard/complaints).`,
  },
  {
    id: "share-your-shop-link",
    title: "Share your shop link and get customers",
    audiences: ["shop_owner"],
    keywords: ["share", "shop link", "link", "qr code", "whatsapp", "storefront notice", "announcement", "customers", "promote", "advertise", "copy link", "status", "get customers", "contact button"],
    summary: "Copy your shop link, share it on WhatsApp or as a QR code, and post a storefront notice. Where to find each option.",
    body: `What it is: your shop link is the web address customers open to buy from you. Sharing it is how you get sales.

Who can use it: shop owners and sub-agents.

Where: My shop (/dashboard/my-shop) shows your link with a Copy button. Customers (/dashboard/customers) has a QR code and a WhatsApp share button. Shop settings (/dashboard/my-shop/settings) holds your WhatsApp contact link.

How:
1. Open My shop and tap Copy next to your link. The button beside it opens your storefront so you can check how it looks.
2. Paste the link in WhatsApp groups, your status, Facebook or SMS.
3. On Customers, under Grow Your Shop, tap WhatsApp to share it or QR to show a code people can scan. After you save prices on Shop pricing, a popup also offers Share on WhatsApp.
4. To tell shoppers about a promo, type it in Storefront Notice on My shop and tap Save Notice. Clear the box and save to remove it.
5. To show a WhatsApp contact button on your storefront, add your WhatsApp link on Shop settings.

What happens next: anyone who opens the link sees your prices and can pay with Mobile Money without making an account. Orders appear on Shop orders (/dashboard/shop-orders).

If something goes wrong:
- The link shows "not found": check your shop is Active on My shop.
- Prices look empty: save your prices first on Shop pricing (/dashboard/shop-pricing).
- Other problems: open Support chat (/dashboard/complaints).`,
  },
  {
    id: "sub-agents-manage",
    title: "Invite and manage sub-agents under your shop",
    audiences: ["shop_owner"],
    keywords: ["sub agent", "sub-agent", "invite", "agents", "recruit", "network", "wholesale", "catalog", "approve", "decline", "request", "sign-up link", "earnings", "profit history", "remove sub agent"],
    summary: "Invite resellers to sell under your shop, approve their requests, set the wholesale prices they pay, and see what you earn from their sales.",
    body: `What it is: sub-agents are resellers who sell under your shop. They buy from you at wholesale prices you set and sell at their own prices. You earn the difference on each of their completed orders.

Who can use it: shop owners whose account allows managing sub-agents.

Where: Sub-agents (/dashboard/sub-agents) and Sub-agent catalog (/dashboard/sub-agent-catalog).

How:
1. Open Sub-agents. To invite someone, tap Invite Sub-Agent. Phone and email are optional. Share the invite link it creates.
2. Or share your permanent sub-agent sign-up link shown at the top of the page. Anyone who opens it can register under your shop.
3. Under Pending Requests, tap Approve or Decline for people who asked from your storefront.
4. Open Sub-agent catalog and set the wholesale price your sub-agents pay for each package. The page shows your margin. Use Bulk Pricing to change many at once.
5. On Sub-agents, the Sub-Agents tab lists your agents with their orders, sales and your earnings. Profit History lists each order that earned you a share.

What happens next: sub-agents see only the packages you priced. Their purchases come out of their wallet. When a sub-agent's order completes, your share is added to your profit. You can remove a sub-agent from the list at any time.

If something goes wrong:
- A sub-agent sees no packages: set prices for them on Sub-agent catalog first.
- An invite will not open: create a new one.
- No requests appear: your storefront may be set to let people join straight away. See the article on joining a shop as a sub-agent.
- Other problems: open Support chat (/dashboard/complaints).`,
  },
  {
    id: "sub-agent-join-a-shop",
    title: "Join a shop as a sub-agent",
    audiences: ["public", "customer"],
    keywords: ["join shop", "sub agent", "sub-agent", "join now", "apply now", "invite link", "invite code", "become sub agent", "under a shop", "reseller", "request", "wholesale prices", "join under"],
    summary: "Start your own shop under another shop owner. Use their invite or sign-up link, or the Join Now or Apply Now button on their storefront.",
    body: `What it is: a way to start selling under an existing shop owner. You buy from them at their wholesale prices and sell at your own prices.

Who can use it: anyone. You can sign up as part of joining.

Where: Join a shop (/join/shop/:handle) is the sign-up page for one shop. If the owner gave you an invite code, use Join with invite (/join/:code). Shops show the button on their Shop storefront (/shop/:slug).

How:
1. Open the link the shop owner sent you, or open their storefront and tap Join Now. If the button says Apply Now instead, fill in your name and phone, add a short message and send the request. The owner then reviews it and contacts you.
2. On the join page you see Your Wholesale Prices. These are your costs, so sell above them to make profit.
3. Fill in your name, email, a password and your phone number. Tap to send the code and type the code from the SMS to verify the number.
4. Type Your Shop Name and submit. If asked, confirm your email.

What happens next: your own shop is created under theirs and you land on the page to set your prices. Once your prices are saved your shop opens. You can then buy stock from your parent shop's wholesale prices from the Buy Data page in your menu.

If something goes wrong:
- "This shop isn't taking sub-agents": joining may not be open for that shop. Ask the owner.
- Code not arriving: check the phone number and request it again.
- Already have an account: log in from the page, then continue.`,
  },
  {
    id: "sub-agent-buy-stock",
    title: "Sub-agents: buy data at your parent shop's prices",
    audiences: ["shop_owner"],
    keywords: ["buy stock", "buy data", "sub agent", "parent shop", "wholesale", "stock", "wallet", "restock", "supplier shop", "my cost", "resell"],
    summary: "If you are a sub-agent, buy data from your parent shop's wholesale prices and pay from your wallet. Then sell at your own prices.",
    body: `What it is: a page for sub-agents to buy data at their parent shop's wholesale prices. It is the same wallet payment as a normal data purchase, but at your cost price.

Who can use it: sub-agents only. This page is not shown to shop owners who have no parent shop.

Where: Buy data (sub-agent) (/dashboard/buy-stock). Your wallet is at Wallet (/dashboard/wallet).

How:
1. Open Buy data (sub-agent). Your wallet balance is at the top.
2. Tap a network. Only networks your parent shop has priced are active.
3. Search or scroll to the package and tap it.
4. Type the number that should receive the data and confirm.

What happens next: the price is taken from your wallet and you see "Purchase successful". The data is delivered to the number you typed. Your own customers still buy from your shop at the prices you set on Shop pricing (/dashboard/shop-pricing), and your profit is the difference between your price and your cost.

If something goes wrong:
- No packages: your parent shop has not priced them for you yet. Ask them to set prices on their Sub-agent catalog.
- Not enough balance: add money on the Wallet page when top-up is available.
- Order stuck or failed: check My orders (/dashboard/my-orders) and then open Support chat (/dashboard/complaints).`,
  },
  {
    id: "ussd-shop-setup",
    title: "Let customers buy from your shop by USSD",
    audiences: ["shop_owner"],
    keywords: ["ussd", "shop code", "dial", "activate", "activation", "display name", "ussd shop", "dial code", "helpline", "customers dial", "ussd orders", "recent orders", "share code"],
    summary: "Activate your shop's USSD code so customers can buy by dialling. Where to find your code, the dial code to share, and the display name.",
    body: `What it is: customers without internet can dial a USSD code, type your shop code and buy from your shop. Payment is a Mobile Money prompt.

Who can use it: shop owners whose account allows the bot tools. If you see no shop code, USSD may not be available on your account yet.

Where: USSD / WhatsApp bot (/dashboard/ussd-shop), USSD tab. A shortcut to set it up is also on My shop (/dashboard/my-shop).

How:
1. Open USSD / WhatsApp bot. Your Shop Code is shown in the blue box. Tap the copy button to copy it.
2. If it says Activation required, the one-time fee is shown on the page. Tap Activate with Wallet. You need enough money in your wallet.
3. Optional: set a USSD Display Name. It replaces your shop name on USSD and WhatsApp bot screens only. Clear it to go back to your shop name.
4. Share the message under How Your Customers Use It. It has the dial code and your shop code.

What happens next: customers dial, type your shop code, choose what to buy, enter the number and approve the Mobile Money prompt. Your prices and profit are the same as on your storefront. The Recent Orders list on the page shows what was bought through USSD. Customers also see your helpline line if your phone number is on file.

If something goes wrong:
- Insufficient wallet balance: top up on Wallet (/dashboard/wallet) when available, then activate again.
- Status shows Suspended or Inactive: open Support chat (/dashboard/complaints).
- Customers say the code is wrong: they must type your exact shop code at the prompt.`,
  },
  {
    id: "ussd-buy-from-a-shop",
    title: "Buy from a shop on USSD (shop code)",
    audiences: ["public"],
    keywords: ["ussd", "shop code", "dial", "no internet", "buy data ussd", "last shop", "remembered shop", "helpline", "enter shop code", "momo prompt", "dial code", "shop menu"],
    summary: "How to buy from a Datagod shop by dialling a USSD code and typing the seller's shop code. The app remembers your last shop.",
    body: `What it is: a way to buy from a shop without internet. You dial a code on your phone and type the shop's code.

Who can use it: anyone with a phone and a Mobile Money wallet. No account needed.

Where: on your phone's dialer. The shop owner gives you the dial code and their shop code. You can also see both on their message or their shop page. The online version is the Shop storefront (/shop/:slug).

How:
1. Dial the shop dial code the seller gave you.
2. At "Enter shop code:" type the seller's shop code.
3. If you used a shop before, the first option on that screen is the shop you last used. Pick that number to go straight there without typing the code.
4. The shop menu shows the shop name and, if the seller added one, a Helpline line with their phone number. Choose what you want to buy and follow the screens: network, package, and the number to receive it.
5. Approve the Mobile Money prompt on your phone with your PIN.

What happens next: the order is placed after payment is confirmed and the data is delivered to the number you chose. You can check it on the shop's Shop order status (/shop/:slug/order-status) page.

If something goes wrong:
- "Invalid code. Try again.": check the shop code with the seller. After a few wrong tries you are asked to try again later.
- No prompt on your phone: check your Mobile Money number and try again.
- A problem with an order: call the helpline shown on the shop menu, or use the shop's contact details.`,
  },
  {
    id: "whatsapp-shop-bot",
    title: "Let customers order from your shop on WhatsApp",
    audiences: ["shop_owner"],
    keywords: ["whatsapp", "whatsapp bot", "shop bot", "whatsapp shop", "activate whatsapp", "whatsapp link", "bot", "order on whatsapp", "customers whatsapp", "activation fee"],
    summary: "Activate the WhatsApp shop bot so customers can order data, airtime and results checkers on WhatsApp. Activation, the link to share, and what customers do.",
    body: `What it is: a WhatsApp chat bot for your shop. Customers can order Data, Airtime and Results Checker vouchers by chatting.

Who can use it: shop owners whose account allows the bot tools. The WhatsApp bot may not be available on your account yet. You also need your USSD shop code to be active.

Where: USSD / WhatsApp bot (/dashboard/ussd-shop), WhatsApp Bot tab.

How:
1. Open USSD / WhatsApp bot and tap the WhatsApp Bot tab.
2. If it shows Not Activated, you see Activation required. The fee is shown on the page, and it can be free. Tap Activate WhatsApp Shop. It is paid from your wallet.
3. When it is Active you see your WhatsApp shop link. Copy it and share it with customers.
4. Under How Your Customers Use It, copy the instructions for them.

What happens next: customers open your link, send your shop code, choose Data, Airtime or Results Checker, pick a bundle and the number, and approve the Mobile Money prompt. They get the same prices as your storefront.

If something goes wrong:
- "WhatsApp number not yet configured": the link is not ready yet. Check back later.
- Shows Paused or a note to activate your shop code first: activate the USSD tab first. If the code is suspended, open Support chat (/dashboard/complaints).
- Insufficient wallet balance: top up on Wallet (/dashboard/wallet) when available.`,
  },
  {
    id: "text-to-buy-shop",
    title: "Text orders: customers buy from your shop by SMS",
    audiences: ["shop_owner"],
    keywords: ["text to buy", "text order", "text orders", "sms order", "order by sms", "sms", "shop number", "customers text", "sms credits", "text buy", "share message"],
    summary: "Customers text a size and your shop code to a number and approve a MoMo prompt. See your shop number, a share message and recent text orders.",
    body: `What it is: customers order data by sending an SMS instead of using an app or USSD. They pay with a Mobile Money prompt.

Who can use it: shop owners whose account allows text orders. Text orders may not be available on your account yet. If the page says your shop number and code will show soon, it is not open for your shop.

Where: Text orders (/dashboard/text-orders).

How:
1. Open Text orders. If it is open, under How your customers order you see your shop number and your shop code.
2. Tap Copy message to share and paste the message in your WhatsApp status or groups.
3. Customers text the size and your shop code to the shop number, for example the size followed by your code. They get the price and a Mobile Money prompt.
4. Next time they only text the size, because your shop is remembered.
5. Keep SMS credits topped up. The page shows SMS credits left and a Top up button to buy more on SMS home (/dashboard/sms).

What happens next: the data is delivered after payment. Recent text orders lists them with the number the data went to, partly hidden. Prices and profit are the same as your USSD shop.

If something goes wrong:
- A banner on the page tells you if your SMS credits or sender name need attention.
- No orders: share your shop number and code again.
- Other problems: open Support chat (/dashboard/complaints).`,
  },
  {
    id: "shop-sms-customers",
    title: "Send SMS to your shop customers and set order texts",
    audiences: ["shop_owner"],
    keywords: ["sms", "message customers", "broadcast", "promo", "send sms", "bulk sms", "my customers", "sender id", "sender name", "order confirmation", "customer order sms", "compose", "credits"],
    summary: "Text promos to your shop customers from Send SMS, and turn the order confirmation text on or off. Needs SMS credits.",
    body: `What it is: SMS tools for your shop. You can send a message to your customers, and your shop can text each customer a confirmation when they order.

Who can use it: shop owners whose account allows SMS. SMS needs credits. Prices of credits are shown on SMS credits (/dashboard/sms/credits).

Where: SMS home (/dashboard/sms), Send SMS (/dashboard/sms/compose), and My shop (/dashboard/my-shop) for the order text switch.

How:
1. Open Send SMS. In the recipients area choose the My customers tab to pick people who bought from your shop. Paste and Groups tabs let you type numbers or use a saved group.
2. Write your message and send it. It uses your SMS credits.
3. To buy credits, open SMS credits.
4. To control the confirmation text, open My shop and use the Customer order SMS switch.
5. For your own sender name on those texts, request one on Business SMS (/dashboard/sms/business). The advice banner on My shop links you there.

What happens next: your message is sent and each send is listed on SMS records (/dashboard/sms/records) with delivery details. Order confirmation texts go out for each order while the switch is on.

If something goes wrong:
- No credits: buy some on SMS credits, then send again.
- The My customers tab is empty: you have no saved customers yet.
- A message did not arrive: open that send on SMS records, or ask in Support chat (/dashboard/complaints).`,
  },
  {
    id: "shop-customers-list",
    title: "See your shop customers and repeat buyers",
    audiences: ["shop_owner"],
    keywords: ["customers", "customer list", "repeat buyers", "top spenders", "most orders", "recent", "search customers", "who bought", "total revenue", "shop customers", "buyers"],
    summary: "The Customers page lists everyone who bought from your shop. Sort by Recent, Top Spenders or Most Orders and search by phone or name.",
    body: `What it is: a list of everyone who has bought from your shop, with how much they spent and how often.

Who can use it: shop owners and sub-agents.

Where: Shop customers (/dashboard/customers).

How:
1. Open Customers. The top shows your totals: customers, orders and revenue.
2. Use the search box to find a customer by phone, name or email.
3. Sort the list with the tabs: Recent, Top Spenders or Most Orders.
4. Use Grow Your Shop to copy your link, share it on WhatsApp or show the QR code.
5. To text your customers, tap Message your customers. It opens Send SMS (/dashboard/sms/compose).

What happens next: new buyers appear after their first order. Repeat buyers climb the Most Orders and Top Spenders tabs, which helps you spot your best customers for promos.

If something goes wrong:
- A customer is missing: check Shop orders (/dashboard/shop-orders) to see whether their payment went through.
- The page is empty: you have no orders yet. Share your link to get started.
- Other problems: open Support chat (/dashboard/complaints).`,
  },
  {
    id: "shop-blocked-numbers",
    title: "Blocked numbers: numbers that could not receive your orders",
    audiences: ["shop_owner"],
    keywords: ["blocked numbers", "blocked", "mtn number", "not activated", "refused", "ready", "waiting for activation", "expired", "export", "cannot order", "number registration", "copy ready numbers"],
    summary: "See MTN numbers customers tried to buy for that could not be ordered yet, with their status. Export the list and copy the ones that are ready.",
    body: `What it is: some MTN numbers cannot be ordered for until they are activated for data. This page lists numbers your customers tried on your shop, or you tried on your own orders, and shows when they are ready.

Who can use it: shop owners. This list may not be available on your account yet. If it is not on, the page says so.

Where: Blocked numbers (/dashboard/blocked-numbers).

How:
1. Open Blocked numbers. If it is on, you see My shops (numbers your customers tried) and My orders (numbers refused on your dashboard and API orders).
2. Filter by status: Waiting for activation, Ready or Expired. You can also pick dates.
3. Tap Export to download the list.
4. On My orders, tap Copy ready numbers to copy the numbers you can order again.

What happens next: when a number becomes Ready, a new order for it can go through. Tell the customer to try again or place the order yourself. Expired numbers need a fresh attempt.

If something goes wrong:
- "No blocked numbers" is good news: nothing needs action.
- A number stays in Waiting for activation: ask the number's owner to check that the number can receive data.
- Other problems: open Support chat (/dashboard/complaints).`,
  },
]
