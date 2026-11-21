import { existsSync, readFileSync } from 'node:fs'
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeDeployData, encodeFunctionData, getContractAddress, maxUint256, parseAbiParameters, type Abi, type Address, type Client, type Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import { ATOMIC, CANONICAL, CMD, CODE, CONTRACT_BALANCE, CREATE2_DEPLOYER, KIND, MODE, MSG_SENDER, PERMIT2, V4, VERIFY_LIMITS, decodeUr, encodeUr, executeAbi, executionsParams, permit2Abi, routeDirect, tighten, v3Hops, v3Path, classify, compile, compileCalls, delegationAbi, erc20Abi, guard, nftAbi, sealAbi, specExample, sweep } from '../src/index.js'
import { buildVectors } from '../scripts/vectors.js'
import { P2, R, S, SEAL, T, approve, cases, delegations, swap } from './cases.js'

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

describe('delegation grants', () => {
  test('classified with spender and revoked in kind', () => {
    const kinds = delegations.map((d) => classify(T, d, S))
    expect(kinds.map((c) => c.kind)).toEqual([KIND.DELEGATION, KIND.COMET, KIND.MORPHO, KIND.RELAYER, KIND.ERC777])
    expect(kinds.every((c) => c.spender === R)).toBe(true)
    const { frames } = compile({ sender: S, seal: SEAL, calls: delegations.map((data) => ({ to: T, data })) })
    const revokes = frames.filter((f) => f.label === 'revoke').map((f) => decodeFunctionData({ abi: delegationAbi, data: f.data }))
    expect(revokes.map((r) => [r.functionName, r.args])).toEqual([
      ['approveDelegation', [R, 0n]],
      ['allow', [R, false]],
      ['setAuthorization', [R, false]],
      ['setRelayerApproval', [S, R, false]],
      ['revokeOperator', [R]],
    ])
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

  test('several calls without grants still form one atomic batch', () => {
    const { frames } = compile({ sender: S, seal: SEAL, calls: [{ to: T, data: swap(1n) }, { to: R, data: swap(1n) }] })
    expect(labels(frames)).toEqual(['verify', 'call 0+', 'call 1'])
  })

  test('spec example shape leaves the batch unsealed', () => {
    const frames = specExample({ calls: [{ to: T, data: approve(R, maxUint256) }, { to: R, data: swap(1n) }] })
    expect(labels(frames)).toEqual(['verify', 'call 0+', 'call 1'])
    expect(guard(frames, S, SEAL)).toMatchObject({ code: CODE.UNSEALED, at: 1 })
  })
})

const UR: Address = '0x4444444444444444444444444444444444444444'
const W: Address = '0x5555555555555555555555555555555555555555'
const v3In = (payerIsUser: boolean, amount: bigint, path: Hex, extra = true) =>
  extra
    ? encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool, uint256[]'), [MSG_SENDER, amount, 1n, path, payerIsUser, []])
    : encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [MSG_SENDER, amount, 1n, path, payerIsUser])
const permitIn = encodeAbiParameters(parseAbiParameters('((address, uint160, uint48, uint48), address, uint256), bytes'), [[[T, 5n, 9, 0], UR, 9n], '0x1234'])
const urCall = (commands: number[], inputs: Hex[], value = 0n) => ({ to: UR, data: encodeUr({ commands, inputs, deadline: 99n }), value })
const p2Approve = encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [T, UR, (1n << 160n) - 1n, 2 ** 48 - 1] })
const nobody = {} as Client

describe('universal router direct route', () => {
  test('payerIsUser flipped in place, permits dropped, input pre-transferred and swept back', async () => {
    const path = v3Path([{ a: T, fee: 3000, b: W }])
    const swapIn = v3In(true, 100n, path)
    const calls = [{ to: T, data: approve(PERMIT2, maxUint256) }, { to: PERMIT2, data: p2Approve }, urCall([CMD.PERMIT2_PERMIT, CMD.V3_SWAP_EXACT_IN], [permitIn, swapIn])]
    const r = await routeDirect(nobody, { sender: S, seal: SEAL, calls }, { swapper: R })
    expect(r.calls.map((c) => c.to)).toEqual([T, UR])
    expect(decodeFunctionData({ abi: erc20Abi, data: r.calls[0].data }).args).toEqual([UR, 100n])
    const u = decodeUr(r.calls[1].data)!
    expect(u.commands).toEqual([CMD.V3_SWAP_EXACT_IN, CMD.SWEEP])
    expect(u.deadline).toBe(99n)
    expect(u.inputs[0]).toBe(`${swapIn.slice(0, 2 + 64 * 4)}${'0'.repeat(64)}${swapIn.slice(66 + 64 * 4)}`)
    expect(decodeAbiParameters(parseAbiParameters('address, address, uint256'), u.inputs[1])).toEqual([T, MSG_SENDER, 0n])
    expect(r.notes.filter((n) => n.includes('dropped'))).toHaveLength(2)
  })

  test('exact out pulls the max from the last token of the path and sweeps it', async () => {
    const path = v3Path([{ a: W, fee: 500, b: T }])
    const out = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [MSG_SENDER, 7n, 300n, path, true])
    const r = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [urCall([CMD.V3_SWAP_EXACT_OUT], [out])] }, { swapper: R })
    expect(r.calls[0]).toMatchObject({ to: T })
    expect(decodeFunctionData({ abi: erc20Abi, data: r.calls[0].data }).args).toEqual([UR, 300n])
    expect(decodeUr(r.calls[1].data)!.commands).toEqual([CMD.V3_SWAP_EXACT_OUT, CMD.SWEEP])
  })

  test('falls back on unknown commands, malformed V4 plans, contract-balance amounts and late Permit2 pulls', async () => {
    const path = v3Path([{ a: T, fee: 3000, b: W }])
    const pull = encodeAbiParameters(parseAbiParameters('address, address, uint160'), [T, UR, 5n])
    for (const call of [
      urCall([0x10], ['0x']),
      urCall([0x12], ['0x']),
      urCall([CMD.V3_SWAP_EXACT_IN], [v3In(true, 1n << 255n, path)]),
      urCall([CMD.V3_SWAP_EXACT_IN, CMD.PERMIT2_TRANSFER_FROM], [v3In(false, 5n, path), pull]),
    ]) {
      const r = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [{ to: T, data: approve(PERMIT2, 5n) }, call] }, { swapper: R })
      expect(r.calls).toEqual([{ to: T, data: approve(PERMIT2, 5n) }, call])
    }
  })

  test('leading PERMIT2_TRANSFER_FROM becomes a plain transfer; ETH value is kept and swept back', async () => {
    const path = v3Path([{ a: T, fee: 3000, b: W }])
    const swapAll = v3In(false, 1n << 255n, path)
    const toRouter = encodeAbiParameters(parseAbiParameters('address, address, uint160'), [T, '0x0000000000000000000000000000000000000002', 5n])
    const r = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [{ to: T, data: approve(PERMIT2, 5n) }, urCall([CMD.PERMIT2_TRANSFER_FROM, CMD.V3_SWAP_EXACT_IN], [toRouter, swapAll])] }, { swapper: R })
    expect(r.calls.map((c) => c.to)).toEqual([T, UR])
    expect(decodeFunctionData({ abi: erc20Abi, data: r.calls[0].data }).args).toEqual([UR, 5n])
    expect(decodeUr(r.calls[1].data)!.commands).toEqual([CMD.V3_SWAP_EXACT_IN, CMD.SWEEP])

    const toPair = encodeAbiParameters(parseAbiParameters('address, address, uint160'), [T, W, 7n])
    const v2In = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, address[], bool'), [MSG_SENDER, 0n, 1n, [T, W], false])
    const p = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [urCall([CMD.PERMIT2_TRANSFER_FROM, CMD.V2_SWAP_EXACT_IN], [toPair, v2In])] }, { swapper: R })
    expect(decodeFunctionData({ abi: erc20Abi, data: p.calls[0].data }).args).toEqual([W, 7n])
    expect(decodeUr(p.calls[1].data)!.commands).toEqual([CMD.V2_SWAP_EXACT_IN])

    const e = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [urCall([CMD.V3_SWAP_EXACT_IN], [v3In(true, 5n, path)], 3n)] }, { swapper: R })
    expect(e.calls[1].value).toBe(3n)
    const u = decodeUr(e.calls[1].data)!
    expect(u.commands).toEqual([CMD.V3_SWAP_EXACT_IN, CMD.SWEEP, CMD.SWEEP])
    expect(decodeAbiParameters(parseAbiParameters('address, address, uint256'), u.inputs[2])[0]).toBe('0x0000000000000000000000000000000000000000')
  })

  test('keeps the bracket when the plan could move the pre-funded surplus to someone else', async () => {
    const X: Address = '0x000000000000000000000000000000000000bad1'
    const v2Out = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, address[], bool'), [MSG_SENDER, 1n, 1000n, [T, W], true])
    const route = (commands: number[], inputs: Hex[]) => routeDirect(nobody, { sender: S, seal: SEAL, calls: [urCall(commands, inputs)] }, { swapper: R })
    const unwrap = encodeAbiParameters(parseAbiParameters('address, uint256'), [X, 0n])
    const portion = encodeAbiParameters(parseAbiParameters('address, address, uint256'), [T, X, 10_000n])
    const spendSurplus = v3In(false, 999n, v3Path([{ a: T, fee: 3000, b: W }]))
    for (const [c, i] of [
      [CMD.SWEEP, sweep(T, X)],
      [CMD.PAY_PORTION, portion],
      [CMD.UNWRAP_WETH, unwrap],
      [CMD.V3_SWAP_EXACT_IN, spendSurplus],
    ] as [number, Hex][]) {
      expect((await route([CMD.V2_SWAP_EXACT_OUT, c], [v2Out, i])).calls.map((k) => k.to)).toEqual([UR])
    }
    expect((await route([CMD.V2_SWAP_EXACT_OUT, CMD.SWEEP], [v2Out, sweep(T, MSG_SENDER)])).calls.map((k) => k.to)).toEqual([T, UR])
    const v3InUser = v3In(true, 1000n, v3Path([{ a: T, fee: 3000, b: W }]))
    expect((await route([CMD.V3_SWAP_EXACT_IN, CMD.SWEEP], [v3InUser, sweep(T, X)])).calls.map((k) => k.to)).toEqual([UR])
    expect((await route([CMD.V3_SWAP_EXACT_IN, CMD.SWEEP], [v3InUser, sweep(T, MSG_SENDER)])).calls.map((k) => k.to)).toEqual([T, UR])
    expect((await route([CMD.V2_SWAP_EXACT_OUT, CMD.SWEEP], [v2Out, sweep(W, X)])).calls.map((k) => k.to)).toEqual([T, UR])

    const plan = (acts: number[], params: Hex[]) =>
      encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [`0x${acts.map((a) => a.toString(16).padStart(2, '0')).join('')}`, params])
    const two = (a: Address, n: bigint) => encodeAbiParameters(parseAbiParameters('address, uint256'), [a, n])
    const fromRouter = encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [T, CONTRACT_BALANCE, false])
    const take = encodeAbiParameters(parseAbiParameters('address, address, uint256'), [T, X, 0n])
    const v4 = plan([V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE_ALL, V4.TAKE_ALL, V4.SETTLE, V4.TAKE], ['0x1234', two(T, 1000n), two(W, 1n), fromRouter, take])
    expect((await route([CMD.V4_SWAP], [v4])).calls.map((k) => k.to)).toEqual([UR])
  })

  test('bracket fallback revokes Permit2 allowances granted inside router commands', () => {
    const path = v3Path([{ a: T, fee: 3000, b: W }])
    const ur = urCall([CMD.PERMIT2_PERMIT, 0x10], [permitIn, '0x'])
    const { frames } = compile({ sender: S, seal: SEAL, permit2: P2, account: 'zeroallow', calls: [{ to: T, data: approve(P2, maxUint256) }, ur] })
    const revoke = frames.find((f) => f.target === P2 && f.label === 'revoke')!
    expect(decodeFunctionData({ abi: permit2Abi, data: revoke.data }).args).toEqual([T, UR, 0n, 0])
    expect(guard(frames, S, SEAL, P2).code).toBe(CODE.OK)
    expect(() => compile({ sender: S, seal: SEAL, calls: [ur] })).toThrow(/Permit2 address/)
    expect(v3Hops(path)).toEqual([{ a: T, fee: 3000, b: W }])
  })
})

describe('universal router V4_SWAP', () => {
  const plan = (acts: number[], params: Hex[]) =>
    encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [`0x${acts.map((a) => a.toString(16).padStart(2, '0')).join('')}`, params])
  const two = (a: Address, n: bigint) => encodeAbiParameters(parseAbiParameters('address, uint256'), [a, n])
  const swapParams = '0x1234' as Hex

  test('SETTLE_ALL from the user becomes SETTLE(OPEN_DELTA) from the router, input pre-transferred and swept', async () => {
    const call = urCall([CMD.V4_SWAP], [plan([V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE_ALL, V4.TAKE_ALL], [swapParams, two(T, 100n), two(W, 1n)])])
    const r = await routeDirect(nobody, { sender: S, seal: SEAL, calls: [{ to: PERMIT2, data: p2Approve }, call] }, { swapper: R })
    expect(r.calls.map((c) => c.to)).toEqual([T, UR])
    expect(decodeFunctionData({ abi: erc20Abi, data: r.calls[0].data }).args).toEqual([UR, 100n])
    const u = decodeUr(r.calls[1].data)!
    expect(u.commands).toEqual([CMD.V4_SWAP, CMD.SWEEP])
    const [acts, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), u.inputs[0])
    expect(acts).toBe('0x060b0f')
    expect(params[0]).toBe(swapParams)
    expect(decodeAbiParameters(parseAbiParameters('address, uint256, bool'), params[1])).toEqual([T, 0n, false])
    expect(params[2]).toBe(two(W, 1n))
  })

  test('native currency, open-delta user settles and unknown actions keep the bracket', async () => {
    const zero = '0x0000000000000000000000000000000000000000' as Address
    for (const p of [
      plan([V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE_ALL], [swapParams, two(zero, 5n)]),
      plan([V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE], [swapParams, encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [T, 0n, true])]),
      plan([V4.SWAP_EXACT_IN_SINGLE, 0x0d], [swapParams, '0x']),
    ]) {
      const call = urCall([CMD.V4_SWAP], [p])
      expect((await routeDirect(nobody, { sender: S, seal: SEAL, calls: [call] }, { swapper: R })).calls).toEqual([call])
    }
  })
})

describe('tighten', () => {
  const amountOf = (data: Hex) => decodeFunctionData({ abi: erc20Abi, data }).args[1] as bigint
  test('shrinks an approval to the smallest stated amount that still simulates', async () => {
    let asked = 0
    const oracle = async (input: { calls: { data: Hex }[] }) => {
      asked++
      return amountOf(input.calls[0].data) >= 100n
    }
    const t = await tighten({ sender: S, seal: SEAL, calls: [{ to: T, data: approve(R, 1000n) }, { to: R, data: swap(100n) }] }, oracle)
    expect(amountOf(t.calls[0].data)).toBe(100n)
    expect(t.notes.join()).toContain('1000 -> 100')
    expect(asked).toBeLessThanOrEqual(5)
  })

  test('both Permit2 layers tighten independently', async () => {
    const p2 = (data: Hex) => decodeFunctionData({ abi: permit2Abi, data }).args[2] as bigint
    const oracle = async (input: { calls: { data: Hex }[] }) => amountOf(input.calls[0].data) >= 100n && p2(input.calls[1].data) >= 100n
    const calls = [
      { to: T, data: approve(P2, 1000n) },
      { to: P2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [T, R, 1000n, 9] }) },
      { to: R, data: swap(100n) },
    ]
    const t = await tighten({ sender: S, seal: SEAL, permit2: P2, calls }, oracle)
    expect(amountOf(t.calls[0].data)).toBe(100n)
    expect(p2(t.calls[1].data)).toBe(100n)
  })

  test('keeps the amounts when nothing smaller works or simulation is unavailable', async () => {
    const input = { sender: S, seal: SEAL, calls: [{ to: T, data: approve(R, 1000n) }, { to: R, data: swap(100n) }] }
    const strict = await tighten(input, async (i) => amountOf(i.calls[0].data) >= 1000n)
    expect(strict.calls).toEqual(input.calls)
    expect(strict.notes.join()).toContain('no smaller')
    const down = await tighten(input, async () => {
      throw new Error('method not found')
    })
    expect(down.calls).toEqual(input.calls)
    expect(down.notes.join()).toContain('unavailable')
  })
})

describe('dispatched (ERC-7579) accounts', () => {
  test('the bracket becomes one revert-all execute batch closed by the seal', () => {
    const { frames } = compile({ sender: S, seal: SEAL, account: 'dispatched', calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }] })
    expect(frames).toHaveLength(2)
    expect(decodeFunctionData({ abi: executeAbi, data: frames[0].data }).functionName).toBe('verify')
    expect(frames[1]).toMatchObject({ mode: MODE.SENDER, target: S, flags: 0 })
    const { args } = decodeFunctionData({ abi: executeAbi, data: frames[1].data })
    expect(args[0]).toBe(`0x01${'00'.repeat(31)}`)
    const [xs] = decodeAbiParameters(executionsParams, args[1] as Hex)
    expect(xs.map((x) => x.target)).toEqual([T, R, T, SEAL])
    expect(guard(frames, S, SEAL, undefined, true).code).toBe(CODE.OK)
    expect(guard(frames, S, SEAL).code).toBe(CODE.SELF_CALL)
  })

  test('verifyData overrides the verify call for third-party accounts', () => {
    const { frames } = compile({ sender: S, seal: SEAL, account: 'dispatched', verifyData: '0xdeadbeef', calls: [{ to: R, data: swap(1n) }] })
    expect(frames[0].data).toBe('0xdeadbeef')
  })
})

describe('compileCalls (erc-5792)', () => {
  test('same bracket closed by seal.check with keys the seal would derive', () => {
    const { calls, keys } = compileCalls({ sender: S, seal: SEAL, calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }] })
    expect(calls.map((c) => c.to)).toEqual([T, R, T, SEAL])
    const closer = decodeFunctionData({ abi: sealAbi, data: calls[3].data })
    expect(closer.functionName).toBe('check')
    expect(closer.args[0]).toEqual([
      { kind: KIND.APPROVE, token: T, spender: R, id: 100n },
      { kind: KIND.APPROVE, token: T, spender: R, id: 0n },
    ])
    expect(keys).toHaveLength(2)
  })

  test('no grants means no seal call', () => {
    expect(compileCalls({ sender: S, seal: SEAL, calls: [{ to: R, data: swap(1n) }] }).calls).toHaveLength(1)
  })
})

describe('revoke-all', () => {
  test('keys the seal cannot derive from frames get a seal.check frame inside the batch', () => {
    const nftKey = { kind: KIND.APPROVE, token: T, spender: R, id: 7n }
    const { frames } = compile({
      sender: S,
      seal: SEAL,
      account: 'zeroallow',
      calls: [{ to: T, data: encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: ['0x0000000000000000000000000000000000000000', 7n] }) }],
      keys: [nftKey],
    })
    expect(labels(frames)).toEqual(['verify', 'call 0+', 'seal.check+', 'seal.checkFrames'])
    expect(decodeFunctionData({ abi: sealAbi, data: frames[2].data }).args[0]).toEqual([nftKey])
    expect(guard(frames, S, SEAL).code).toBe(CODE.OK)
  })
})

describe('limits', () => {
  test('verify frame leaves room for the secp256k1 signature under MAX_VERIFY_GAS', () => {
    expect(VERIFY_LIMITS.execution + 2800n).toBeLessThanOrEqual(100_000n)
  })
})

const out = new URL('../../../contracts/out/', import.meta.url)
describe.skipIf(!existsSync(out))('canonical deployment', () => {
  test('CANONICAL matches CREATE2 of the current build', () => {
    const at = (file: string, name: string, args: unknown[]) => {
      const j = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, out), 'utf8'))
      const bytecode = encodeDeployData({ abi: j.abi as Abi, bytecode: j.bytecode.object as Hex, args })
      return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: `0x${'00'.repeat(32)}`, bytecode })
    }
    expect(at('FrameOps.yul', 'FrameOps', [])).toBe(CANONICAL.frameOps)
    expect(at('ZeroAllowSeal.sol', 'ZeroAllowSeal', [CANONICAL.frameOps, PERMIT2])).toBe(CANONICAL.seal)
    expect(at('ZeroAllowSwapper.sol', 'ZeroAllowSwapper', [])).toBe(CANONICAL.swapper)
    expect(at('ZeroAllowPolicy.sol', 'ZeroAllowPolicy', [CANONICAL.frameOps, CANONICAL.seal, PERMIT2])).toBe(CANONICAL.policy)
    expect(at('ZeroAllowHook.sol', 'ZeroAllowHook', [CANONICAL.seal, PERMIT2])).toBe(CANONICAL.hook)
  })
})

describe('golden vectors', () => {
  test.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(guard(c.frames, S, SEAL, c.permit2, !!c.dispatch)).toMatchObject({ code: c.code, at: c.at })
  })

  test('vectors/guard.json is current', () => {
    const disk = JSON.parse(readFileSync(new URL('../../../vectors/guard.json', import.meta.url), 'utf8'))
    expect(disk).toEqual(JSON.parse(JSON.stringify(buildVectors())))
  })
})
