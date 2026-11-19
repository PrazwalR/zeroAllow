import { decodeFunctionResult, encodeFunctionData, type Account, type Address, type Chain, type Client, type Hex } from 'viem'
import { getCapabilities, sendCalls, simulateCalls, waitForCallsStatus } from 'viem/actions'
import { sealAbi } from './constants.js'
import type { Call, SealKey } from './types.js'

export class AtomicityUnavailable extends Error {
  constructor(status: string | undefined) {
    super(`wallet reports atomic=${status ?? 'missing'}; zeroallow refuses a non-atomic batch because a failed seal would leave earlier approvals in place`)
  }
}

const plain = (calls: Call[]) => calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n }))

export async function atomicStatus(wallet: Client, p: { account?: Account | Address; chainId: number }) {
  try {
    const caps = (await getCapabilities(wallet, { account: p.account, chainId: p.chainId })) as { atomic?: { status?: string } }
    return caps.atomic?.status
  } catch {
    return undefined
  }
}

export async function sendAtomic(wallet: Client, p: { account?: Account | Address; chainId: number; calls: Call[]; timeout?: number }) {
  const status = await atomicStatus(wallet, p)
  if (status !== 'supported' && status !== 'ready') throw new AtomicityUnavailable(status)
  const chain = wallet.chain ?? ({ id: p.chainId } as Chain)
  const { id } = await sendCalls(wallet, { ...(p.account ? { account: p.account } : {}), chain, calls: plain(p.calls), forceAtomic: true, experimental_fallback: false } as never)
  const r = await waitForCallsStatus(wallet, { id, timeout: p.timeout ?? 120_000 })
  if (r.atomic === false) throw new AtomicityUnavailable('false in receipt')
  return r
}

export type Preview = { ok: boolean; failedAt: number | null; error: string | null; closed: { key: SealKey; closed: boolean }[] }

export async function previewCalls(client: Client, p: { account: Address; calls: Call[]; keys: SealKey[]; seal: Address }): Promise<Preview> {
  const reads = p.keys.map((k) => ({ to: p.seal, data: encodeFunctionData({ abi: sealAbi, functionName: 'isClosed', args: [k, p.account] }) }))
  const { results } = await simulateCalls(client, { account: p.account, calls: [...plain(p.calls), ...reads] })
  const failedAt = results.slice(0, p.calls.length).findIndex((r) => r.status !== 'success')
  const closed = p.keys.map((key, i) => {
    const r = results[p.calls.length + i]
    const ok = r?.status === 'success' && decodeFunctionResult({ abi: sealAbi, functionName: 'isClosed', data: r.data as Hex })
    return { key, closed: !!ok }
  })
  const failed = failedAt >= 0 ? results[failedAt] : undefined
  return { ok: failedAt < 0, failedAt: failedAt < 0 ? null : failedAt, error: failed?.error?.message?.split('\n')[0] ?? null, closed }
}
