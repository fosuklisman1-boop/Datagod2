/**
 * Long-form copy for the three data network pages, kept as data next to the
 * product registry (lib/seo/products.ts). Static, no I/O.
 *
 * `paragraphs` always render. Each `when` paragraph renders only when the live
 * price table has matching rows, so copy about a switchable sub-product (AT
 * iShare / BigTime) or a bundle kind (Telecel no-expiry) never shows while
 * none is on sale.
 *
 * Copy rules (enforced by data-page-copy.test.ts, on top of products.ts's):
 *  - 150-300 words per page (always-on paragraphs alone reach 150)
 *  - no prices, amounts, ratings or USSD codes: prices come only from the table
 *  - never "instant", "in seconds" or "automatic refund"
 *  - mentions MoMo; no paragraph is shared between networks
 */
import type { DataNet } from "./data-prices"

export type CopyCondition = { type: string } | { validity: string }

export interface DataPageCopy {
  network: DataNet
  /** H2 above the price table. */
  tableHeading: string
  /** H2 above the long-form copy. */
  aboutHeading: string
  paragraphs: string[]
  when: Array<{ condition: CopyCondition; text: string }>
}

export const DATA_PAGE_COPY: Record<DataNet, DataPageCopy> = {
  MTN: {
    network: "MTN",
    tableHeading: "MTN data bundle prices",
    aboutHeading: "Buying MTN data on DATAGOD",
    paragraphs: [
      "Buy MTN data bundles for your own line or send them to any MTN number in Ghana. MTN numbers start with 024, 025, 053, 054, 055 or 059, so check the first three digits before you pay: a bundle sent to the wrong number cannot be taken back.",
      "Most people pay for MTN data with MTN Mobile Money. Top up your DATAGOD wallet from your MoMo account, or with a card through Paystack, and then buy as many MTN bundles as you need from that balance. You approve one MoMo prompt when you fund the wallet, not one for every bundle, which makes it easy to buy for the whole family or office in one sitting.",
      "The table lists the MTN bundle sizes on sale right now and the standard price you pay from your wallet, in Ghana cedis. A size that is out of stock drops off the list, so what you see here is what you can order.",
      "Selling MTN data to friends, classmates or customers? Open a DATAGOD shop, add your own margin on top of these prices and share your shop link. Your customers order from your shop, the data goes to their MTN number, and you withdraw your profit to MoMo.",
    ],
    when: [],
  },
  Telecel: {
    network: "Telecel",
    tableHeading: "Telecel data bundle prices",
    aboutHeading: "Buying Telecel data on DATAGOD",
    paragraphs: [
      "Telecel is the network that used to be Vodafone Ghana. The name changed but the numbers did not, so any line starting with 020 or 050 is a Telecel line and can receive these bundles. If someone tells you they are still on Vodafone, this is the page for them.",
      "You do not need a Telecel line yourself to buy. Fund your DATAGOD wallet with MoMo or a card through Paystack, pick a Telecel bundle, type the Telecel number it should go to and pay from the wallet. Every order is saved in your order history so you can check when it went through.",
      "The table shows each Telecel bundle we sell today with its current price from your wallet, in Ghana cedis. Where a bundle's validity is part of our catalog, it is listed beside the size so you can compare like with like before you buy.",
      "Resellers can add Telecel bundles to their own DATAGOD shop next to MTN and AT, set a selling price and keep the difference as profit.",
    ],
    when: [
      {
        condition: { validity: "No expiry" },
        text: "Bundles marked No expiry in the table do not run out after a set number of days. The data stays on the line until it is used up, which suits people who only go online now and then rather than every day.",
      },
    ],
  },
  AT: {
    network: "AT",
    tableHeading: "AT data bundle prices",
    aboutHeading: "Buying AT data on DATAGOD",
    paragraphs: [
      "AT is the network formerly known as AirtelTigo. AT numbers start with 026, 027, 056 or 057, and you can send a bundle to any of them, your own line included. Enter the number carefully, because data delivered to the wrong line cannot be reversed.",
      "Paying works the same way as on every other network here: fund your DATAGOD wallet with MoMo or a card through Paystack, choose an AT bundle, enter the AT number and pay from your balance. Your order history keeps a record of each bundle you send.",
      "The table lists the AT bundles on sale right now with the standard price you pay from your wallet, in Ghana cedis. AT sells more than one kind of data product, so each row also shows its type, and bundles of the same type are listed from smallest to largest.",
      "If you resell data, AT bundles sit in your DATAGOD shop alongside MTN and Telecel. Set your own price and your customers can order AT data from your shop link.",
    ],
    when: [
      {
        condition: { type: "iShare" },
        text: "Rows marked iShare are sent through AT's iShare data-sharing service: the data is shared onto the AT number you enter. Pick the size you need from the iShare rows and type the number it should go to.",
      },
      {
        condition: { type: "BigTime" },
        text: "Rows marked BigTime are AT BigTime data packages, a separate AT product with its own sizes and prices. Compare them with the other AT rows and pick the bundle that fits how much data you use.",
      },
    ],
  },
}

/** Paragraphs to render for a network, given the live table rows. */
export function dataPageParagraphs(
  net: DataNet,
  rows: ReadonlyArray<{ type: string | null; validity: string | null }>,
): string[] {
  const c = DATA_PAGE_COPY[net]
  const extra = c.when
    .filter(({ condition }) =>
      "type" in condition
        ? rows.some((r) => r.type === condition.type)
        : rows.some((r) => r.validity === condition.validity),
    )
    .map((w) => w.text)
  // Conditional paragraphs go after the first two, before the table/reseller notes.
  return [...c.paragraphs.slice(0, 2), ...extra, ...c.paragraphs.slice(2)]
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length
