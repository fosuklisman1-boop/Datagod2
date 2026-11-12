import { describe, it, expect, vi } from "vitest"
import {
  sniffImage, buildAttachmentPath, storeThreadAttachment, signAttachmentUrl, removeAttachments,
  SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_BUCKET,
} from "./support-attachment"

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]
const text = (s: string) => Array.from(new TextEncoder().encode(s))
const u8 = (a: number[]) => new Uint8Array(a)

function fakeDb(opts: { uploadError?: any } = {}) {
  const upload = vi.fn().mockResolvedValue({ error: opts.uploadError ?? null })
  const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://signed" }, error: null })
  const remove = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ upload, createSignedUrl, remove }))
  return { db: { storage: { from } } as any, upload, createSignedUrl, remove, from }
}
const file = (bytes: number[] | Uint8Array, name = "evil name.png", type = "image/png") =>
  new File([(bytes instanceof Uint8Array ? bytes : u8(bytes)) as BlobPart], name, { type })

describe("sniffImage", () => {
  it("recognises JPEG, PNG and WebP by magic bytes", () => {
    expect(sniffImage(u8(JPEG))).toEqual({ mime: "image/jpeg", ext: "jpg" })
    expect(sniffImage(u8(PNG))).toEqual({ mime: "image/png", ext: "png" })
    expect(sniffImage(u8(WEBP))).toEqual({ mime: "image/webp", ext: "webp" })
  })
  it("rejects PDF, HTML, empty, RIFF that is not WebP, and truncated headers", () => {
    expect(sniffImage(u8(text("%PDF-1.7 ...")))).toBeNull()
    expect(sniffImage(u8(text("<html><script>")))).toBeNull()
    expect(sniffImage(new Uint8Array([]))).toBeNull()
    expect(sniffImage(u8([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull()
    expect(sniffImage(u8([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(sniffImage(u8([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45]))).toBeNull()
  })
})

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const T1 = "44444444-4444-4444-8444-444444444444"

describe("buildAttachmentPath", () => {
  it("is threads/<user>/<thread>/<uuid>.<ext>", () => {
    expect(buildAttachmentPath(U1, T1, "png")).toMatch(new RegExp(`^threads/${U1}/${T1}/[0-9a-f-]{36}\\.png$`))
  })
  it("throws when the user or thread id is not a UUID", () => {
    expect(() => buildAttachmentPath("u1", T1, "png")).toThrow()
    expect(() => buildAttachmentPath(U1, "../x", "png")).toThrow()
  })
})

describe("storeThreadAttachment", () => {
  it("uploads a valid image with the sniffed content type and no upsert", async () => {
    const { db, upload, from } = fakeDb()
    const r = await storeThreadAttachment(db, { userId: U1, threadId: T1, file: file(PNG, "my secret name.png") })
    expect(r).toHaveProperty("path")
    expect(from).toHaveBeenCalledWith(SUPPORT_ATTACHMENT_BUCKET)
    const [path, , opts] = upload.mock.calls[0]
    expect(path).toMatch(new RegExp(`^threads/${U1}/${T1}/`))
    expect(path).not.toContain("secret")
    expect(opts).toEqual({ contentType: "image/png", upsert: false })
    expect((r as any).path).toBe(path)
  })
  it("rejects HTML declared as image/png without uploading", async () => {
    const { db, upload } = fakeDb()
    const r = await storeThreadAttachment(db, { userId: U1, threadId: T1, file: file(text("<html>alert(1)</html>")) })
    expect(r).toEqual({ error: "not_image" })
    expect(upload).not.toHaveBeenCalled()
  })
  it("rejects a file over 4 MB before reading its bytes", async () => {
    const { db, upload } = fakeDb()
    const big = file(new Uint8Array(SUPPORT_ATTACHMENT_MAX_BYTES + 1))
    const spy = vi.spyOn(big, "arrayBuffer")
    expect(await storeThreadAttachment(db, { userId: U1, threadId: T1, file: big })).toEqual({ error: "too_large" })
    expect(spy).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it("accepts exactly 4 MB", async () => {
    const { db } = fakeDb()
    const bytes = new Uint8Array(SUPPORT_ATTACHMENT_MAX_BYTES)
    bytes.set(JPEG)
    expect(await storeThreadAttachment(db, { userId: U1, threadId: T1, file: file(bytes, "a.jpg", "image/jpeg") })).toHaveProperty("path")
  })
  it("reports upload_failed on a storage error", async () => {
    const { db } = fakeDb({ uploadError: { message: "nope" } })
    expect(await storeThreadAttachment(db, { userId: U1, threadId: T1, file: file(PNG) })).toEqual({ error: "upload_failed" })
  })
  it("reports upload_failed when reading the file throws", async () => {
    const { db, upload } = fakeDb()
    const f = file(PNG)
    vi.spyOn(f, "arrayBuffer").mockRejectedValue(new Error("read failed"))
    expect(await storeThreadAttachment(db, { userId: U1, threadId: T1, file: f })).toEqual({ error: "upload_failed" })
    expect(upload).not.toHaveBeenCalled()
  })
  it("reports upload_failed, without uploading, when an id is not a UUID", async () => {
    const { db, upload } = fakeDb()
    expect(await storeThreadAttachment(db, { userId: "u1", threadId: T1, file: file(PNG) })).toEqual({ error: "upload_failed" })
    expect(await storeThreadAttachment(db, { userId: U1, threadId: "t1", file: file(PNG) })).toEqual({ error: "upload_failed" })
    expect(upload).not.toHaveBeenCalled()
  })
  it("reports upload_failed when storage throws", async () => {
    const db: any = { storage: { from: () => ({ upload: () => Promise.reject(new Error("x")) }) } }
    expect(await storeThreadAttachment(db, { userId: U1, threadId: T1, file: file(PNG) })).toEqual({ error: "upload_failed" })
  })
})

describe("signAttachmentUrl", () => {
  it("returns null for a null path without touching storage", async () => {
    const { db, from } = fakeDb()
    expect(await signAttachmentUrl(db, null)).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })
  it("signs for 600 seconds", async () => {
    const { db, createSignedUrl } = fakeDb()
    expect(await signAttachmentUrl(db, "threads/u/t/x.png")).toBe("https://signed")
    expect(createSignedUrl).toHaveBeenCalledWith("threads/u/t/x.png", 600)
  })
  it("returns null on error or throw", async () => {
    const db: any = { storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: { message: "x" } }) }) } }
    expect(await signAttachmentUrl(db, "p")).toBeNull()
    const db2: any = { storage: { from: () => { throw new Error("x") } } }
    expect(await signAttachmentUrl(db2, "p")).toBeNull()
  })
})

describe("removeAttachments", () => {
  it("removes in chunks of 100", async () => {
    const { db, remove } = fakeDb()
    await removeAttachments(db, Array.from({ length: 250 }, (_, i) => `p${i}`))
    expect(remove.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50])
  })
  it("does nothing for an empty list and never throws", async () => {
    const { db, remove } = fakeDb()
    await removeAttachments(db, [])
    expect(remove).not.toHaveBeenCalled()
    const bad: any = { storage: { from: () => ({ remove: () => Promise.reject(new Error("x")) }) } }
    await expect(removeAttachments(bad, ["a"])).resolves.toBeUndefined()
  })
})
