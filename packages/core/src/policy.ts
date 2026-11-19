import { bytesToBigInt, bytesToHex, concatHex, getAddress, hexToBytes, isAddressEqual, numberToHex, padHex, sliceHex, size, type Address, type Hex } from 'viem'
import { ATOMIC, CODE, CODE_NAME, HEAD_BYTES, KIND, MODE, SEL } from './constants.js'
import { classify } from './registry.js'
import type { FrameSpec, Verdict } from './types.js'

const resolve = (f: FrameSpec, sender: Address): Address => f.target ?? sender

const verdict = (code: number, at = 0): Verdict => ({ code, at, reason: CODE_NAME[code] ?? 'unknown' })

const MASK_160 = (1n << 160n) - 1n

export const isDispatched = (f: FrameSpec, sender: Address) =>
  f.mode === MODE.SENDER && isAddressEqual(resolve(f, sender), sender) && size(f.data) >= 4 && f.data.slice(0, 10).toLowerCase() === SEL.execute7579

export function virtualFrames(data: Hex): { code: number; frames: FrameSpec[] } {
  const d = hexToBytes(data)
  const len = BigInt(d.length)
  const at = (b: bigint) => bytesToBigInt(d.subarray(Number(b), Number(b) + 32))
  const bad = { code: CODE.UNPARSEABLE, frames: [] as FrameSpec[] }
  const fr = (target: bigint, flags: number, value: bigint, from: bigint, n: bigint): FrameSpec => ({
    mode: MODE.SENDER,
    flags,
    target: getAddress(`0x${(target & MASK_160).toString(16).padStart(40, '0')}`),
    value,
    data: bytesToHex(d.subarray(Number(from), Number(from + n))),
    label: '',
  })
  if (len < 0x64n) return bad
  const mode = at(4n)
  const callType = mode >> 248n
  const execType = (mode >> 240n) & 0xffn
  if (callType > 1n || execType > 1n) return { code: CODE.SELF_CALL, frames: [] }
  const off = at(0x24n)
  if (off > len - 0x24n) return bad
  const ec = 4n + off + 32n
  const ecLen = at(4n + off)
  if (ecLen > len - ec) return bad
  const end = ec + ecLen
  if (callType === 0n) {
    if (ecLen < 52n) return bad
    return { code: CODE.OK, frames: [fr(at(ec) >> 96n, 0, at(ec + 20n), ec + 52n, ecLen - 52n)] }
  }
  if (ecLen < 32n) return bad
  const aOff = at(ec)
  if (aOff > ecLen - 32n) return bad
  const heads = ec + aOff + 32n
  const n = at(heads - 32n)
  if (n > (end - heads) / 32n) return bad
  const frames: FrameSpec[] = []
  for (let k = 0n; k < n; k++) {
    const tOff = at(heads + 32n * k)
    if (tOff > end - heads || end - heads - tOff < 96n) return bad
    const t = heads + tOff
    const cOff = at(t + 64n)
    if (cOff > end - t || end - t - cOff < 32n) return bad
    const c = t + cOff
    const cLen = at(c)
    if (cLen > end - c - 32n) return bad
    frames.push(fr(at(t), execType === 0n && k + 1n < n ? ATOMIC : 0, at(t + 32n), c + 32n, cLen))
  }
  return { code: CODE.OK, frames }
}

export function guard(frames: FrameSpec[], sender: Address, seal: Address, permit2?: Address, dispatch = false): Verdict {
  if (dispatch) {
    const neutral = new Set<number>()
    for (let i = 0; i < frames.length; i++) {
      if (!isDispatched(frames[i], sender)) continue
      const v = virtualFrames(frames[i].data)
      const code = v.code === CODE.OK ? guard(v.frames, sender, seal, permit2).code : v.code
      if (code !== CODE.OK) return verdict(code, i)
      neutral.add(i)
    }
    frames = frames.map((f, i) => (neutral.has(i) ? { ...f, mode: MODE.DEFAULT } : f))
  }
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
