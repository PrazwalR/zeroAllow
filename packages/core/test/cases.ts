import { encodeFunctionData, maxUint256, parseAbi, type Address, type Hex } from 'viem'
import { ATOMIC, CODE, MODE, compile, delegationAbi, e6909Abi, erc20Abi, nftAbi, sealAbi, specExample, verifyFrame, type FrameSpec } from '../src/index.js'

export const S: Address = '0x1111111111111111111111111111111111111111'
export const SEAL: Address = '0x5EA15EA15ea15ea15ea15ea15Ea15eA15eA15ea1'
export const R: Address = '0x2222222222222222222222222222222222222222'
export const T: Address = '0x3333333333333333333333333333333333333333'
export const P2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

const routerAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])
export const approve = (spender: Address, v: bigint): Hex => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, v] })
export const swap = (amt: bigint): Hex => encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [T, T, amt, 0n, S] })

const f = (target: Address | null, data: Hex, atomic: boolean, mode: 0 | 1 | 2 = MODE.SENDER): FrameSpec => ({
  mode,
  flags: atomic ? ATOMIC : 0,
  target,
  value: 0n,
  data,
  label: '',
})
const closer = (outs: { token: Address; amount: bigint }[] = []) =>
  f(SEAL, encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [outs] }), false)
const v = verifyFrame('zeroallow')

const bracket = compile({ sender: S, seal: SEAL, account: 'zeroallow', calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }] }).frames

const p2approve = encodeFunctionData({
  abi: parseAbi(['function approve(address,address,uint160,uint48)']),
  functionName: 'approve',
  args: [T, R, 5n, 0],
})
const permit = (owner: Address) =>
  encodeFunctionData({
    abi: parseAbi(['function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']),
    functionName: 'permit',
    args: [owner, R, 1n, 1n, 27, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`],
  })

export const delegations: Hex[] = [
  encodeFunctionData({ abi: delegationAbi, functionName: 'approveDelegation', args: [R, 5n] }),
  encodeFunctionData({ abi: delegationAbi, functionName: 'allow', args: [R, true] }),
  encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [R, true] }),
  encodeFunctionData({ abi: delegationAbi, functionName: 'setRelayerApproval', args: [S, R, true] }),
  encodeFunctionData({ abi: delegationAbi, functionName: 'authorizeOperator', args: [R] }),
]
const delegationNames = ['credit delegation', 'comet allow', 'morpho authorization', 'balancer relayer', 'erc777 operator']

const revokeAll: FrameSpec[] = [v]
for (let i = 0; i < 62; i++) revokeAll.push(f(T, approve(R, 0n), true))
revokeAll.push(closer())

const stress: FrameSpec[] = [v]
for (let i = 0; i < 31; i++) stress.push(f(T, approve(R, 1n), true), f(T, approve(R, 0n), true))
stress.push(closer())

export type Case = { name: string; frames: FrameSpec[]; code: number; at: number; permit2?: Address }

export const cases: Case[] = [
  { name: 'compiled bracket', frames: bracket, code: CODE.OK, at: 0 },
  { name: 'spec example 2 approve+swap', frames: specExample({ account: 'zeroallow', calls: [{ to: T, data: approve(R, maxUint256) }, { to: R, data: swap(1n) }] }), code: CODE.UNSEALED, at: 1 },
  { name: 'grant outside batch', frames: bracket.map((x, i) => (i === 1 ? { ...x, flags: 0 } : x)), code: CODE.OUTSIDE_BATCH, at: 1 },
  { name: 'self call', frames: [v, f(T, approve(R, 1n), true), f(S, '0xb61d27f6', true), closer()], code: CODE.SELF_CALL, at: 2 },
  { name: 'null target is self', frames: [v, f(null, '0x', false)], code: CODE.SELF_CALL, at: 1 },
  { name: 'closer wrong target', frames: [v, f(T, approve(R, 1n), true), f(R, encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [[]] }), false)], code: CODE.UNSEALED, at: 1 },
  { name: 'closer wrong selector', frames: [v, f(T, approve(R, 1n), true), f(SEAL, encodeFunctionData({ abi: sealAbi, functionName: 'snapshot', args: [[]] }), false)], code: CODE.UNSEALED, at: 1 },
  { name: 'short approve', frames: [v, f(T, approve(R, 1n).slice(0, 74) as Hex, true), closer()], code: CODE.UNPARSEABLE, at: 1 },
  { name: 'operator unsealed', frames: [v, f(T, encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [R, true] }), true), f(R, swap(1n), false)], code: CODE.UNSEALED, at: 1 },
  { name: 'permit for other owner', frames: [v, f(T, permit(R), true), f(R, swap(1n), false)], code: CODE.OK, at: 0 },
  { name: 'permit for sender unsealed', frames: [v, f(T, permit(S), true), f(R, swap(1n), false)], code: CODE.UNSEALED, at: 1 },
  { name: 'permit2 approve unsealed', frames: [v, f(P2, p2approve, true), f(R, swap(1n), false)], code: CODE.UNSEALED, at: 1, permit2: P2 },
  { name: 'permit2 selector off permit2', frames: [v, f(R, p2approve, true), f(R, swap(1n), false)], code: CODE.OK, at: 0, permit2: P2 },
  { name: 'permit2 batch permit', frames: [v, f(P2, `0x2a2d80d1${S.slice(2).padStart(64, '0')}${'00'.repeat(64)}`, true), closer()], code: CODE.UNPARSEABLE, at: 1, permit2: P2 },
  { name: 'default mode ignored', frames: [v, f(T, approve(R, 1n), false, MODE.DEFAULT)], code: CODE.OK, at: 0 },
  { name: 'second batch unsealed', frames: [v, f(T, approve(R, 1n), true), f(T, approve(R, 0n), true), closer(), f(T, approve(R, 1n), true), f(R, swap(1n), false)], code: CODE.UNSEALED, at: 4 },
  { name: 'erc6909', frames: compile({ sender: S, seal: SEAL, account: 'zeroallow', calls: [{ to: T, data: encodeFunctionData({ abi: e6909Abi, functionName: 'approve', args: [R, 7n, 9n] }) }, { to: T, data: encodeFunctionData({ abi: e6909Abi, functionName: 'setOperator', args: [R, true] }) }] }).frames, code: CODE.OK, at: 0 },
  { name: 'compiled with min out', frames: compile({ sender: S, seal: SEAL, account: 'zeroallow', minOut: [{ token: T, amount: 5n }], calls: [{ to: T, data: approve(R, 100n) }, { to: R, data: swap(100n) }] }).frames, code: CODE.OK, at: 0 },
  { name: '64 frame stress', frames: stress, code: CODE.OK, at: 0 },
  { name: '64 frame revoke-all', frames: revokeAll, code: CODE.OK, at: 0 },
  ...delegations.map((d, i) => ({ name: `${delegationNames[i]} unsealed`, frames: [v, f(T, d, true), f(R, swap(1n), false)], code: CODE.UNSEALED, at: 1 })),
  { name: 'compiled delegations', frames: compile({ sender: S, seal: SEAL, account: 'zeroallow', calls: delegations.map((data) => ({ to: T, data })) }).frames, code: CODE.OK, at: 0 },
  { name: 'relayer for another sender', frames: [v, f(T, encodeFunctionData({ abi: delegationAbi, functionName: 'setRelayerApproval', args: [R, R, true] }), true), f(R, swap(1n), false)], code: CODE.OK, at: 0 },
  { name: 'short relayer approval', frames: [v, f(T, delegations[3].slice(0, 138) as Hex, true), closer()], code: CODE.UNPARSEABLE, at: 1 },
  { name: 'short erc777 operator', frames: [v, f(T, delegations[4].slice(0, 40) as Hex, true), closer()], code: CODE.UNPARSEABLE, at: 1 },
]
