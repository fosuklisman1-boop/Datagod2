import { describe, it, expect, vi } from "vitest"
import { checkLogoInput, storeEmbeddedLogo } from "./shop-logo-intake"
import { LOGO_MAX_BYTES } from "./shop-logo"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")
const uri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`

describe("checkLogoInput", () => {
  it("treats null, undefined and blank as no logo", () => {
    for (const v of [null, undefined, "", "   "]) expect(checkLogoInput(v)).toEqual({ kind: "none" })
  })

  it("passes a normal URL through unchanged (trimmed)", () => {
    expect(checkLogoInput("  https://cdn.example.com/a.png ")).toEqual({ kind: "url", url: "https://cdn.example.com/a.png" })
  })

  it("accepts an embedded PNG or JPEG and reports the real type from the file header", () => {
    const png = checkLogoInput(uri("image/png", PNG))
    expect(png).toMatchObject({ kind: "image", contentType: "image/png", ext: "png" })
    const jpeg = checkLogoInput(uri("image/jpeg", JPEG))
    expect(jpeg).toMatchObject({ kind: "image", contentType: "image/jpeg", ext: "jpg" })
    // a lying label: JPEG bytes labelled png are stored as the jpeg they are
    expect(checkLogoInput(uri("image/png", JPEG))).toMatchObject({ kind: "image", contentType: "image/jpeg", ext: "jpg" })
  })

  it("rejects gif, svg, html and non-image data with the same message the profile upload uses", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")
    for (const v of [uri("image/gif", GIF), uri("image/svg+xml", svg), uri("text/html", Buffer.from("<script>")), "data:image/png;base64,"]) {
      expect(checkLogoInput(v)).toEqual({ kind: "invalid", error: "Logo must be a JPG, PNG or WebP image" })
    }
  })

  it("rejects an embedded image over the 2 MB logo limit", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(LOGO_MAX_BYTES)])
    expect(checkLogoInput(uri("image/jpeg", big))).toEqual({ kind: "invalid", error: "Logo must be 2 MB or smaller" })
  })

  it("accepts an embedded image exactly at the limit", () => {
    const edge = Buffer.concat([JPEG, Buffer.alloc(LOGO_MAX_BYTES - JPEG.length)])
    expect(checkLogoInput(uri("image/jpeg", edge)).kind).toBe("image")
  })
})

describe("storeEmbeddedLogo", () => {
  function fakeClient(uploadError: unknown = null) {
    const upload = vi.fn(async () => ({ data: {}, error: uploadError }))
    const client = {
      storage: {
        from: vi.fn(() => ({ upload, getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) })),
      },
    }
    return { client: client as any, upload }
  }

  it("uploads under shop-logos/<shop id>/ with the validated content type and returns the public URL", async () => {
    const { client, upload } = fakeClient()
    const img = checkLogoInput(uri("image/png", PNG)) as Extract<ReturnType<typeof checkLogoInput>, { kind: "image" }>
    const r = await storeEmbeddedLogo(client, "shop-9", img)
    expect(upload).toHaveBeenCalledTimes(1)
    const [path, bytes, opts] = upload.mock.calls[0] as unknown as [string, Buffer, { contentType: string; upsert: boolean }]
    expect(path).toMatch(/^shop-logos\/shop-9\/\d+\.png$/)
    expect(bytes.equals(PNG)).toBe(true)
    expect(opts).toEqual({ contentType: "image/png", upsert: false })
    expect(r).toEqual({ ok: true, url: `https://cdn.example/${path}` })
  })

  it("returns a generic failure when storage errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient({ message: "bucket exploded" })
    const img = checkLogoInput(uri("image/png", PNG)) as Extract<ReturnType<typeof checkLogoInput>, { kind: "image" }>
    expect(await storeEmbeddedLogo(client, "s", img)).toEqual({ ok: false, error: "Logo upload failed" })
    err.mockRestore()
  })
})
