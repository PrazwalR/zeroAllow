import { readFileSync } from 'node:fs'
import { decodeFunctionData, encodeFunctionData, maxUint256 } from 'viem'
import { describe, expect, test } from 'vitest'
import { ATOMIC, CODE, KIND, MODE, classify, compile, erc20Abi, guard, nftAbi, sealAbi, specExample } from '../src/index.js'
import { buildVectors } from '../scripts/vectors.js'
import { P2, R, S, SEAL, T, approve, cases, swap } from './cases.js'

const labels = (fs: { label: string; flags: number }[]) => fs.map((f) => `${f.label}${f.flags & ATOMIC ? '+' : ''}`)

describe('classify', () => {
  test('erc20 approve and zero spender', () => {
    expect(classify(T, approve(R, 5n), S).kind).toBe(KIND.APPROVE)
    expect(classify(T, approve('0x0000000000000000000000000000000000000000', 5n), S).kind).toBe(KIND.NONE)
  })
  test('permit2 only on the permit2 address', () => {
    const d = `0x87517c45${T.slice(2).padStart(64, '0')}${R.slice(2).padStart(64, '0')}${'00'.repeat(64)}` as const
    expect(classify(P2, d, S, P2)).toMatchObject({ kind: KIND.PERMIT2, token: T, spender: R })
    expect(classify(R, d, S, P2).kind).toBe(KIND.NONE)
  })
})

describe('compile', () => {
  test('bracket layout', () => {
    const { frames, grants } = compile({ sender: S, seal: SEAL, calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }] })
    expect(labels(frames)).toEqual(['verify', 'grant 0+', 'call 1+', 'revoke+', 'seal.checkFrames'])
    expect(frames[0].mode).toBe(MODE.VERIFY)
    expect(grants).toHaveLength(1)
    const revoke = decodeFunctionData({ abi: erc20Abi, data: frames[3].data })
    expect(revoke.args).toEqual([R, 0n])
    expect(guard(frames, S, SEAL).code).toBe(CODE.OK)
  })

  test('usdt-style and existing allowance zero first', () => {
    const { frames } = compile({
      sender: S,
      seal: SEAL,
      calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }],
      current: { [`${T.toLowerCase()}:${R.toLowerCase()}`]: 7n },
    })
    expect(labels(frames)).toEqual(['verify', 'zero-first+', 'grant 0+', 'call 1+', 'revoke+', 'seal.checkFrames'])
  })

  test('bnb-style revokes to one wei and skips zero first', () => {
    const { frames, notes } = compile({
      sender: S,
      seal: SEAL,
      calls: [{ to: T, data: approve(R, 100n) }],
      quirks: { [T.toLowerCase()]: { zeroReverts: true, zeroFirst: true } },
    })
    expect(labels(frames)).toEqual(['verify', 'grant 0+', 'revoke+', 'seal.checkFrames'])
    expect(decodeFunctionData({ abi: erc20Abi, data: frames[2].data }).args).toEqual([R, 1n])
    expect(notes.join()).toContain('1 wei')
  })

  test('nft single approval revokes to the zero address, operator revokes to false', () => {
    const { frames } = compile({
      sender: S,
      seal: SEAL,
      calls: [
        { to: T, data: encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [R, 0n] }) },
        { to: T, data: encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [R, true] }) },
      ],
      quirks: { [T.toLowerCase()]: { nft: true } },
    })
    expect(decodeFunctionData({ abi: nftAbi, data: frames[3].data }).args).toEqual(['0x0000000000000000000000000000000000000000', 0n])
    expect(decodeFunctionData({ abi: nftAbi, data: frames[4].data }).args).toEqual([R, false])
  })

  test('dedupes revokes per token and spender', () => {
    const { frames } = compile({ sender: S, seal: SEAL, calls: [{ to: T, data: approve(R, 1n) }, { to: T, data: approve(R, 2n) }] })
    expect(frames.filter((f) => f.label === 'revoke')).toHaveLength(1)
  })

  test('min out adds a snapshot and passes outs to the seal', () => {
    const { frames } = compile({ sender: S, seal: SEAL, minOut: [{ token: T, amount: 9n }], calls: [{ to: T, data: approve(R, 1n) }] })
    expect(frames[1].label).toBe('seal.snapshot')
    expect(decodeFunctionData({ abi: sealAbi, data: frames.at(-1)!.data }).args).toEqual([[{ token: T, amount: 9n }]])
  })

  test('refuses self calls and unparseable grants', () => {
    expect(() => compile({ sender: S, seal: SEAL, calls: [{ to: S, data: '0x' }] })).toThrow(/self/)
    const batch = `0x2a2d80d1${S.slice(2).padStart(64, '0')}${'00'.repeat(64)}` as const
    expect(() => compile({ sender: S, seal: SEAL, permit2: P2, calls: [{ to: P2, data: batch }] })).toThrow(/cannot parse/)
  })

  test('no grants means no seal', () => {
    const { frames } = compile({ sender: S, seal: SEAL, calls: [{ to: R, data: swap(1n) }] })
    expect(labels(frames)).toEqual(['verify', 'call 0'])
  })

  test('spec example shape leaves the batch unsealed', () => {
    const frames = specExample({ calls: [{ to: T, data: approve(R, maxUint256) }, { to: R, data: swap(1n) }] })
    expect(labels(frames)).toEqual(['verify', 'call 0+', 'call 1'])
    expect(guard(frames, S, SEAL)).toMatchObject({ code: CODE.UNSEALED, at: 1 })
  })
})

describe('golden vectors', () => {
  test.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(guard(c.frames, S, SEAL, c.permit2)).toMatchObject({ code: c.code, at: c.at })
  })

  test('vectors/guard.json is current', () => {
    const disk = JSON.parse(readFileSync(new URL('../../../vectors/guard.json', import.meta.url), 'utf8'))
    expect(disk).toEqual(JSON.parse(JSON.stringify(buildVectors())))
  })
})
