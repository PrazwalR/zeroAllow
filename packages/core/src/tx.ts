import {
  FRAME_TX_INTRINSIC_COST,
  FRAME_TX_PER_FRAME_COST,
  SIG_VERIFY_COST,
  assertValidFrameTx,
  encodeFrameTx,
  getFrameNonceSeq,
  sendRawFrameTransaction,
  signFrameTx,
  simulateFrameTransaction,
  type FrameTransaction,
} from '@jaw.id/frametx-kit'
import type { Address, EIP1193RequestFn, Hex } from 'viem'
import { MODE } from './constants.js'
import type { FrameSpec } from './types.js'

export type Limits = { execution: bigint; state: bigint }
export type Rpc = { request: EIP1193RequestFn }

export const MAX_VERIFY_GAS = 100_000n
export const VERIFY_LIMITS: Limits = { execution: MAX_VERIFY_GAS - SIG_VERIFY_COST[1], state: 0n }
export const SENDER_LIMITS: Limits = { execution: 300_000n, state: 250_000n }
export const TX_MAX_GAS_LIMIT = 16_777_216n
const CALLDATA_MARGIN = 400_000n

const budgetFor = (frames: FrameSpec[]) => {
  const verifies = BigInt(frames.filter((f) => f.mode === MODE.VERIFY).length)
  return TX_MAX_GAS_LIMIT - FRAME_TX_INTRINSIC_COST - FRAME_TX_PER_FRAME_COST * BigInt(frames.length) - VERIFY_LIMITS.execution * verifies - CALLDATA_MARGIN
}

export function fitLimits(frames: FrameSpec[]): (f: FrameSpec, i: number) => Limits {
  const others = BigInt(frames.filter((f) => f.mode !== MODE.VERIFY).length)
  const budget = budgetFor(frames)
  const per = others > 0n && budget / others < SENDER_LIMITS.execution ? budget / others : SENDER_LIMITS.execution
  return (f) => (f.mode === MODE.VERIFY ? VERIFY_LIMITS : { execution: per, state: SENDER_LIMITS.state })
}

export type BuildParams = {
  chainId: bigint
  sender: Address
  signer: Address
  frames: FrameSpec[]
  nonceSeq: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  limits?: (f: FrameSpec, i: number) => Limits
}

export function buildTx(p: BuildParams): FrameTransaction {
  const limits = p.limits ?? fitLimits(p.frames)
  return {
    chainId: p.chainId,
    nonceKeys: [0n],
    nonceSeq: p.nonceSeq,
    sender: p.sender,
    frames: p.frames.map((f, i) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: limits(f, i),
      value: f.value,
      data: f.data,
    })),
    signatures: [{ scheme: 1, signer: p.signer, msg: '0x', signature: '0x' }],
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    maxFeePerGas: p.maxFeePerGas,
    maxFeePerBlobGas: 0n,
    blobVersionedHashes: [],
  }
}

export async function fees(rpc: Rpc) {
  const gasPrice = BigInt((await rpc.request({ method: 'eth_gasPrice' } as never)) as Hex)
  const tip = gasPrice / 10n || 1n
  return { maxFeePerGas: gasPrice * 2n + tip, maxPriorityFeePerGas: tip }
}

export async function prepareTx(rpc: Rpc, p: Omit<BuildParams, 'nonceSeq' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>) {
  const [nonceSeq, f] = await Promise.all([getFrameNonceSeq(rpc, { address: p.sender }), fees(rpc)])
  return buildTx({ ...p, nonceSeq, ...f })
}

export async function signAndEncode(tx: FrameTransaction, key: Hex): Promise<{ tx: FrameTransaction; raw: Hex }> {
  const signed = await signFrameTx(tx, key)
  assertValidFrameTx(signed)
  return { tx: signed, raw: encodeFrameTx(signed) }
}

export const simulate = (rpc: Rpc, raw: Hex) => simulateFrameTransaction(rpc, raw)
export const broadcast = (rpc: Rpc, raw: Hex) => sendRawFrameTransaction(rpc, raw)

export async function planTx(rpc: Rpc, p: Omit<BuildParams, 'nonceSeq' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'limits'>, key: Hex) {
  const [nonceSeq, fee] = await Promise.all([getFrameNonceSeq(rpc, { address: p.sender }), fees(rpc)])
  const fit = fitLimits(p.frames)
  const lim = p.frames.map((f, i) => fit(f, i))
  const run = async (l: Limits[]) => {
    const signed = await signAndEncode(buildTx({ ...p, nonceSeq, ...fee, limits: (_, i) => l[i] }), key)
    return { ...signed, sim: await simulate(rpc, signed.raw) }
  }
  const tighten = (used: bigint, i: number): Limits =>
    p.frames[i].mode === MODE.VERIFY ? VERIFY_LIMITS : { execution: (used * 13n) / 10n + 10_000n, state: SENDER_LIMITS.state }
  let cur = await run(lim)
  for (let round = 0; round < 4; round++) {
    const fr = cur.sim.frames
    if (!cur.sim.valid || !fr) return cur
    if (cur.sim.executionStatus === 'success') {
      const tight = await run(fr.map((f, i) => tighten(f.gasUsed, i)))
      return tight.sim.valid && tight.sim.executionStatus === 'success' ? tight : cur
    }
    const bad = fr.findIndex((f, i) => !f.succeeded && f.gasUsed > 0n && f.gasUsed * 100n >= lim[i].execution * 99n)
    if (bad < 0) return cur
    fr.forEach((f, i) => {
      if (f.succeeded && i !== bad) lim[i] = tighten(f.gasUsed, i)
    })
    const others = lim.reduce((a, l, i) => (i === bad || p.frames[i].mode === MODE.VERIFY ? a : a + l.execution), 0n)
    const room = budgetFor(p.frames) - others
    if (room <= lim[bad].execution) return cur
    lim[bad] = { execution: room, state: SENDER_LIMITS.state }
    cur = await run(lim)
  }
  return cur
}

export async function waitReceipt(rpc: Rpc, hash: Hex, timeout = 120_000) {
  const { frameActions } = await import('@jaw.id/frametx-kit/viem')
  return frameActions(rpc).waitForFrameTransactionReceipt({ hash, timeout })
}
