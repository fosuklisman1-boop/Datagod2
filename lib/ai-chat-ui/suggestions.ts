export type ChatContext = "home" | "storefront" | "dashboard" | "admin"

export interface StorefrontServices {
  sellsData?: boolean
  sellsAirtime?: boolean
  sellsResultsChecker?: boolean
}

export interface WelcomeContent {
  subtitle: string
  tryIt: string
  chips: string[]
}

export function welcomeFor(context: ChatContext, services?: StorefrontServices): WelcomeContent {
  switch (context) {
    case "home":
      return {
        subtitle: "Ask me about data bundles, prices, or how to get started.",
        tryIt: "How do I buy a data bundle?",
        chips: ["What data bundles do you sell?", "How do I create an account?", "How long does delivery take?", "How can I pay?"],
      }
    case "dashboard":
      return {
        subtitle: "Check your orders and wallet balance, or buy for a customer.",
        tryIt: "Where is my last order?",
        chips: ["What is my wallet balance?", "Show my recent orders", "Buy MTN data for a customer", "How do I top up my wallet?"],
      }
    case "admin":
      return {
        subtitle: "Look up orders, users and providers, or prepare an admin action.",
        tryIt: "How many orders failed today?",
        chips: ["Show pending orders", "Find an order by phone number", "Which provider is failing most?", "Summarise today's revenue"],
      }
    case "storefront": {
      const sellsData = services?.sellsData ?? true
      const sellsAirtime = services?.sellsAirtime ?? false
      const sellsChecker = services?.sellsResultsChecker ?? false
      const chips: string[] = []
      if (sellsData) chips.push("What data bundles are available?", "How do I buy a bundle?")
      if (sellsAirtime) chips.push("How do I buy airtime?")
      if (sellsChecker) chips.push("How do I get a results checker?")
      chips.push("How do I track my order?", "How can I contact the shop?")
      const tryIt = sellsData
        ? "Which data bundle is the best value?"
        : sellsAirtime
          ? "How do I buy airtime?"
          : sellsChecker
            ? "How do I get a results checker?"
            : "How do I track my order?"
      const what = [sellsData && "data bundles", sellsAirtime && "airtime", sellsChecker && "results checkers"].filter(Boolean) as string[]
      return {
        subtitle: what.length ? `Ask me about ${what.join(", ")}, or your order.` : "Ask me about this shop or your order.",
        tryIt,
        chips: chips.slice(0, 4),
      }
    }
  }
}

export function followupsFor(context: ChatContext): string[] {
  switch (context) {
    case "home":
      return ["See the prices", "How do I sign up?", "Talk to a person"]
    case "storefront":
      return ["Track my order", "How do I pay?", "Contact the shop"]
    case "dashboard":
      return ["Show my recent orders", "What is my balance?", "Buy data"]
    case "admin":
      return ["Show pending orders", "Any failed orders?", "Today's revenue"]
  }
}
