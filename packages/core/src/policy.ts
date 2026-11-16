import { concatHex, isAddressEqual, numberToHex, padHex, sliceHex, size, type Address, type Hex } from 'viem'
import { ATOMIC, CODE, CODE_NAME, HEAD_BYTES, KIND, MODE, SEL } from './constants.js'
import { classify } from './registry.js'
import type { FrameSpec, Verdict } from './types.js'

const resolve = (f: FrameSpec, sender: Address): Address => f.target ?? sender

const verdict = (code: number, at = 0): Verdict => ({ code, at, reason: CODE_NAME[code] ?? 'unknown' })

export function guard(frames: FrameSpec[], sender: Address, seal: Address, permit2?: Address): Verdict {
  let end = 0
  let sealed = false
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (f.mode !== MODE.SENDER) continue
    const target = resolve(f, sender)
    if (isAddressEqual(target, sender)) return verdict(CODE.SELF_CALL, i)
    const { kind } = classify(target, f.data, sender, permit2)
    if (kind === KIND.NONE) continue
    if (kind === KIND.MALFORMED) return verdict(CODE.UNPARSEABLE, i)
    if ((f.flags & ATOMIC) === 0) return verdict(CODE.OUTSIDE_BATCH, i)
    if (i >= end) {
      let j = i + 1
      while (j < frames.length && (frames[j].flags & ATOMIC) !== 0) j++
      end = j + 1
      const c = frames[j]
      sealed =
        c !== undefined &&
        c.mode === MODE.SENDER &&
        isAddressEqual(resolve(c, sender), seal) &&
        c.data.slice(0, 10).toLowerCase() === SEL.checkFrames
    }
    if (!sealed) return verdict(CODE.UNSEALED, i)
  }
  return verdict(CODE.OK)
}

export function encodeBlob(frames: FrameSpec[], sender: Address): Hex {
  const w = (v: bigint | number | Hex) => padHex(typeof v === 'string' ? v : numberToHex(v), { size: 32 })
  const parts: Hex[] = [w(frames.length)]
  for (const f of frames) {
    const n = size(f.data)
    const head = n === 0 ? '0x' : sliceHex(f.data, 0, Math.min(n, HEAD_BYTES))
    parts.push(
      w(resolve(f, sender)),
      w(f.mode),
      w(f.flags),
      w(f.value),
      w(n),
      padHex(head, { size: HEAD_BYTES, dir: 'right' }),
    )
  }
  return concatHex(parts)
}
