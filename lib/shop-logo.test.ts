import { describe, it, expect, vi } from "vitest"
import { LOGO_MAX_BYTES, uploadShopLogo, validateLogoFile } from "./shop-logo"

function fakeClient(opts: { shop?: { id: string } | null; shopError?: unknown; uploadError?: unknown } = {}) {
  const upload = vi.fn(async () => ({ data: {}, error: opts.uploadError ?? null }))
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: opts.shop === undefined ? { id: "shop-1" } : opts.shop, error: opts.shopError ?? null }) }))
  const client = {
    from: vi.fn(() => ({ select: () => ({ eq }) })),
    storage: {
      from: vi.fn(() => ({
        upload,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }),
      })),
    },
  }
  return { client: client as any, upload, eq }
}

const png = (size = 1000) => ({ type: "image/png", size, arrayBuffer: async () => new ArrayBuffer(size) })

describe("validateLogoFile", () => {
  it("accepts jpg, png and webp up to 2 MB", () => {
    expect(validateLogoFile({ type: "image/jpeg", size: 10 })).toEqual({ ok: true, ext: "jpg" })
    expect(validateLogoFile({ type: "image/png", size: LOGO_MAX_BYTES })).toEqual({ ok: true, ext: "png" })
    expect(validateLogoFile({ type: "image/webp", size: 10 })).toEqual({ ok: true, ext: "webp" })
  })
  it("rejects other types (incl. SVG, which can carry scripts) and empty or oversized files", () => {
    expect(validateLogoFile({ type: "image/svg+xml", size: 10 }).ok).toBe(false)
    expect(validateLogoFile({ type: "text/html", size: 10 }).ok).toBe(false)
    expect(validateLogoFile({ type: "image/png", size: 0 }).ok).toBe(false)
    expect(validateLogoFile({ type: "image/png", size: LOGO_MAX_BYTES + 1 }).ok).toBe(false)
  })
})

describe("uploadShopLogo", () => {
  it("uploads to shop-logos/<the caller's own shop id>/ with the validated content type and returns the public URL", async () => {
    const { client, upload, eq } = fakeClient({ shop: { id: "shop-42" } })
    const r = await uploadShopLogo(client, { userId: "user-7", file: png() })
    expect(eq).toHaveBeenCalledWith("user_id", "user-7")
    expect(upload).toHaveBeenCalledTimes(1)
    const [path, , options] = upload.mock.calls[0] as unknown as [string, unknown, { contentType: string }]
    expect(path).toMatch(/^shop-logos\/shop-42\/\d+\.png$/)
    expect(options.contentType).toBe("image/png")
    expect(r).toEqual({ ok: true, url: `https://cdn.example/${path}` })
  })
  it("a user without a shop gets 404 and nothing is uploaded", async () => {
    const { client, upload } = fakeClient({ shop: null })
    expect(await uploadShopLogo(client, { userId: "u", file: png() })).toEqual({ ok: false, status: 404, error: "Shop not found" })
    expect(upload).not.toHaveBeenCalled()
  })
  it("an invalid file is refused with 400 before any lookup or upload", async () => {
    const { client, upload } = fakeClient()
    const r = await uploadShopLogo(client, { userId: "u", file: { type: "image/svg+xml", size: 10, arrayBuffer: async () => new ArrayBuffer(10) } })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(client.from).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it("a storage error is a 500 with a generic message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient({ uploadError: { message: "bucket exploded" } })
    expect(await uploadShopLogo(client, { userId: "u", file: png() })).toEqual({ ok: false, status: 500, error: "Logo upload failed" })
    err.mockRestore()
  })
})
