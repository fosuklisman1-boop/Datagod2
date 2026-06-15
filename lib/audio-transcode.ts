// lib/audio-transcode.ts
//
// Transcode a WhatsApp voice note (Opus in an Ogg container) to MP3 so it plays in
// Safari, which supports neither the Opus codec nor the Ogg container. Pure WASM
// decode + pure-JS encode — no ffmpeg binary. Voice notes are mono; a stereo clip
// (rare) is averaged to mono. Used by the inbound webhook for audio/ogg|audio/opus.
import { OggOpusDecoder } from "ogg-opus-decoder"
import { Mp3Encoder } from "@breezystack/lamejs"

/** Float32 [-1,1] samples → Int16 PCM (what the MP3 encoder expects). */
function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

export async function opusOggToMp3(ogg: Uint8Array): Promise<Uint8Array> {
  const decoder = new OggOpusDecoder()
  await decoder.ready
  let channelData: Float32Array[]
  let sampleRate: number
  try {
    const decoded = await decoder.decodeFile(ogg)
    channelData = decoded.channelData
    sampleRate = decoded.sampleRate
  } finally {
    decoder.free()
  }
  if (!channelData?.length || !channelData[0]?.length) {
    throw new Error("opus decode produced no audio")
  }

  // Mix to mono.
  let mono: Float32Array
  if (channelData.length === 1) {
    mono = channelData[0]
  } else {
    const [l, r] = channelData
    mono = new Float32Array(l.length)
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + (r[i] ?? l[i])) / 2
  }

  const pcm = floatToInt16(mono)
  const encoder = new Mp3Encoder(1, sampleRate, 64) // mono, 64 kbps — ample for voice
  const chunks: Uint8Array[] = []
  const BLOCK = 1152 // one MP3 frame
  for (let i = 0; i < pcm.length; i += BLOCK) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK))
    if (buf.length > 0) chunks.push(buf)
  }
  const end = encoder.flush()
  if (end.length > 0) chunks.push(end)

  const total = chunks.reduce((n, c) => n + c.length, 0)
  if (total === 0) throw new Error("mp3 encode produced no output")
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}
