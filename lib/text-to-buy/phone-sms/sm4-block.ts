/**
 * Pure TypeScript SM4 (GB/T 32907-2016) with CBC + PKCS#7 helpers. No dependencies: it does not rely on the host's OpenSSL
 * (some Linux builds ship OpenSSL without SM4). Unsigned 32-bit arithmetic only (>>> 0). Pure: no I/O, no logging.
 */

const SBOX = new Uint8Array([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
])

const FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc]

const CK: number[] = []
for (let i = 0; i < 32; i++) {
  let w = 0
  for (let j = 0; j < 4; j++) w = ((w << 8) | (((4 * i + j) * 7) & 0xff)) >>> 0
  CK.push(w)
}

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

/** The non-linear tau step: the S-box applied to each byte of the word. */
function tau(x: number): number {
  return (
    ((SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff]) >>> 0
  )
}

const T = (x: number): number => {
  const b = tau(x)
  return (b ^ rotl(b, 2) ^ rotl(b, 10) ^ rotl(b, 18) ^ rotl(b, 24)) >>> 0
}
const Tkey = (x: number): number => {
  const b = tau(x)
  return (b ^ rotl(b, 13) ^ rotl(b, 23)) >>> 0
}

const readWord = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

function roundKeys(key: Uint8Array): number[] {
  if (key.length !== 16) throw new Error("sm4: key must be 16 bytes")
  const k = [readWord(key, 0) ^ FK[0], readWord(key, 4) ^ FK[1], readWord(key, 8) ^ FK[2], readWord(key, 12) ^ FK[3]].map((x) => x >>> 0)
  const rk: number[] = []
  for (let i = 0; i < 32; i++) {
    const n = (k[i] ^ Tkey((k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ CK[i]) >>> 0)) >>> 0
    k.push(n)
    rk.push(n)
  }
  return rk
}

function crypt(rk: number[], block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new Error("sm4: block must be 16 bytes")
  const x = [readWord(block, 0), readWord(block, 4), readWord(block, 8), readWord(block, 12)]
  for (let i = 0; i < 32; i++) {
    x.push((x[i] ^ T((x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i]) >>> 0)) >>> 0)
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 4; i++) {
    const w = x[35 - i]
    out[4 * i] = w >>> 24
    out[4 * i + 1] = (w >>> 16) & 0xff
    out[4 * i + 2] = (w >>> 8) & 0xff
    out[4 * i + 3] = w & 0xff
  }
  return out
}

export function sm4EncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return crypt(roundKeys(key), block)
}

export function sm4DecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return crypt(roundKeys(key).reverse(), block)
}

/** CBC with PKCS#7 padding. Throws only on a bad key or iv length (programmer error); the caller validates the key first. */
export function sm4CbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Buffer {
  if (iv.length !== 16) throw new Error("sm4: iv must be 16 bytes")
  const rk = roundKeys(key)
  const pad = 16 - (plaintext.length % 16)
  const data = new Uint8Array(plaintext.length + pad)
  data.set(plaintext)
  data.fill(pad, plaintext.length)
  const out = Buffer.alloc(data.length)
  let prev: Uint8Array = iv
  for (let o = 0; o < data.length; o += 16) {
    const blk = new Uint8Array(16)
    for (let i = 0; i < 16; i++) blk[i] = data[o + i] ^ prev[i]
    const enc = crypt(rk, blk)
    out.set(enc, o)
    prev = enc
  }
  return out
}

/** CBC + PKCS#7 decrypt. Null on a bad key or iv, a length that is not a positive multiple of 16, or bad padding. Never throws. */
export function sm4CbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Buffer | null {
  try {
    if (iv.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null
    const rk = roundKeys(key).reverse()
    const out = Buffer.alloc(ciphertext.length)
    let prev: Uint8Array = iv
    for (let o = 0; o < ciphertext.length; o += 16) {
      const blk = ciphertext.subarray(o, o + 16)
      const dec = crypt(rk, blk)
      for (let i = 0; i < 16; i++) out[o + i] = dec[i] ^ prev[i]
      prev = blk
    }
    const pad = out[out.length - 1]
    if (pad < 1 || pad > 16 || pad > out.length) return null
    for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) return null
    return out.subarray(0, out.length - pad)
  } catch {
    return null
  }
}
