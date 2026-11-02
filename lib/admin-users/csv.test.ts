import { describe, it, expect } from "vitest"
import { allDataCsv, emailsCsv, exportLabel, phonesCsv, triggerCsvDownload } from "./csv"

const u = {
  email: "a@x.com", phoneNumber: "0244000000", role: "dealer", walletBalance: 1.5, shopBalance: 0,
  shop: { shop_name: 'Ama "Best" Data' }, customerCount: 3, created_at: "2026-01-01T00:00:00Z",
}

describe("users CSV", () => {
  it("emails and phones", () => {
    expect(emailsCsv([u, { email: "b@x.com" }])).toBe("Email\na@x.com\nb@x.com")
    expect(phonesCsv([u, { phoneNumber: "" }])).toBe("Phone Number\n0244000000\n")
  })
  it("all data, quoted, with embedded quotes doubled", () => {
    expect(allDataCsv([u], () => "1/1/2026")).toBe(
      `"Email","Phone Number","Role","Wallet Balance (GHS)","Shop Balance (GHS)","Shop Name","Total Customers","Joined Date"\n` +
      `"a@x.com","0244000000","dealer","1.50","0.00","Ama ""Best"" Data","3","1/1/2026"`,
    )
  })
  it("labels", () => {
    expect(exportLabel({})).toBe("all")
    expect(exportLabel({ role: "admin" })).toBe("admin")
    expect(exportLabel({ role: "admin", suspended: false })).toBe("admin_filtered")
  })
})

describe("triggerCsvDownload", () => {
  it("downloads through an object URL (not a data: URL) and revokes it", async () => {
    const clicked: Array<{ href: string; download: string }> = []
    const anchor: any = { style: {}, click() { clicked.push({ href: this.href, download: this.download }) } }
    const doc: any = {
      createElement: (tag: string) => { expect(tag).toBe("a"); return anchor },
      body: { appendChild: () => {}, removeChild: () => {} },
    }
    let blob: Blob | null = null
    const revoked: string[] = []
    const url = { createObjectURL: (b: Blob) => { blob = b; return "blob:abc" }, revokeObjectURL: (u: string) => revoked.push(u) }
    triggerCsvDownload("users.csv", "Email\na@x.com", { document: doc, URL: url, defer: (fn) => fn() })
    expect(clicked).toEqual([{ href: "blob:abc", download: "users.csv" }])
    expect(revoked).toEqual(["blob:abc"])
    expect(blob!.type).toBe("text/csv;charset=utf-8")
    expect(await blob!.text()).toBe("Email\na@x.com")
  })
})
