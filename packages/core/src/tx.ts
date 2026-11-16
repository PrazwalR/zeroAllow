import {
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

export const VERIFY_LIMITS: Limits = { execution: 100_000n, state: 0n }
export const SENDER_LIMITS: Limits = { execution: 300_000n, state: 250_000n }

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
  const limits = p.limits ?? ((f) => (f.mode === MODE.VERIFY ? VERIFY_LIMITS : SENDER_LIMITS))
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

export function tightenLimits(used: bigint[], margin = 13n): (f: FrameSpec, i: number) => Limits {
  return (f, i) => {
    if (f.mode === MODE.VERIFY) return VERIFY_LIMITS
    const exec = ((used[i] ?? SENDER_LIMITS.execution) * margin) / 10n + 10_000n
    return { execution: exec, state: SENDER_LIMITS.state }
  }
}

export async function waitReceipt(rpc: Rpc, hash: Hex, timeout = 120_000) {
  const { frameActions } = await import('@jaw.id/frametx-kit/viem')
  return frameActions(rpc).waitForFrameTransactionReceipt({ hash, timeout })
}
