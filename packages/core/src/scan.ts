import { getAddress, numberToHex, pad, zeroAddress, type Address, type Client, type Hex } from 'viem'
import { getBlock, readContract } from 'viem/actions'
import { KIND, KIND_NAME, MAX_RESIDUAL, PERMIT2, delegationAbi, e6909Abi, erc20Abi, nftAbi, permit2Abi } from './constants.js'
import { revokeFor } from './compile.js'
import type { Call, SealKey } from './types.js'

export const TOPIC = {
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  approvalForAll: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  permit2Approval: '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b',
  permit2Permit: '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec',
  e6909Approval: '0xb3fd5071835887567a0671151121894ddccc2842f1d10bedad13e0d17cace9a7',
  e6909Operator: '0xceb576d9f15e4e200fdb5096d64d5dfd667e16def20c1eefd14256d8e3faa267',
  borrowDelegated: '0xda919360433220e13b51e8c211e490d148e61a3bd53de8c097194e458b97f3e1',
  setAuthorization: '0xd5e969f01efe921d3f766bdebad25f0a05e3f237311f56482bf132d0326309c0',
  relayerChanged: '0x46961fdb4502b646d5095fba7600486a8ac05041d55cdf0f16ed677180b5cad8',
  authorizedOperator: '0xf4caeb2d6ca8932a215a353d0703c326ec2d81fc68170f320eb2ab49e9df61f9',
} as const

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockTimestamp?: Hex }

export type Finding = {
  key: SealKey
  label: string
  nft: boolean
  amount: bigint
  unlimited: boolean
  balance: bigint | null
  exposure: bigint | null
  symbol: string | null
  decimals: number | null
  lastBlock: bigint
  lastAt: number | null
  ageDays: number | null
}

export type ScanOptions = { owner: Address; fromBlock?: bigint; toBlock?: bigint; permit2?: Address; now?: number }

const asAddr = (t: Hex | undefined): Address => getAddress(`0x${(t ?? '0x').slice(-40).padStart(40, '0')}`)

export async function getLogsRange(client: Client, filter: { address?: Address; topics: (Hex | null)[] }, from: bigint, to: bigint): Promise<Log[]> {
  try {
    return (await client.request({
      method: 'eth_getLogs',
      params: [{ ...filter, fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
    } as never)) as Log[]
  } catch (e) {
    if (to <= from) throw e
    const mid = (from + to) / 2n
    return [...(await getLogsRange(client, filter, from, mid)), ...(await getLogsRange(client, filter, mid + 1n, to))]
  }
}

type Seen = { key: SealKey; nft: boolean; block: bigint; at: number | null }

function keyFor(log: Log, owner: Address, permit2: Address): { key: SealKey; nft: boolean } | null {
  const t = log.topics
  const at = getAddress(log.address)
  switch (t[0]) {
    case TOPIC.approval:
      if (t.length === 4) return { key: { kind: KIND.APPROVE, token: at, spender: asAddr(t[2]), id: BigInt(t[3]) }, nft: true }
      return { key: { kind: KIND.APPROVE, token: at, spender: asAddr(t[2]), id: 0n }, nft: false }
    case TOPIC.approvalForAll:
      return { key: { kind: KIND.OPERATOR, token: at, spender: asAddr(t[2]), id: 0n }, nft: true }
    case TOPIC.permit2Approval:
    case TOPIC.permit2Permit:
      if (at !== getAddress(permit2)) return null
      return { key: { kind: KIND.PERMIT2, token: asAddr(t[2]), spender: asAddr(t[3]), id: 0n }, nft: false }
    case TOPIC.e6909Approval:
      return { key: { kind: KIND.E6909, token: at, spender: asAddr(t[2]), id: BigInt(t[3] ?? 0) }, nft: false }
    case TOPIC.e6909Operator:
      return { key: { kind: KIND.E6909_OPERATOR, token: at, spender: asAddr(t[2]), id: 0n }, nft: false }
    case TOPIC.borrowDelegated:
      return { key: { kind: KIND.DELEGATION, token: at, spender: asAddr(t[2]), id: 0n }, nft: false }
    case TOPIC.setAuthorization:
      return { key: { kind: KIND.MORPHO, token: at, spender: asAddr(t[3]), id: 0n }, nft: false }
    case TOPIC.relayerChanged:
      return asAddr(t[2]) === owner ? { key: { kind: KIND.RELAYER, token: at, spender: asAddr(t[1]), id: 0n }, nft: false } : null
    case TOPIC.authorizedOperator:
      return asAddr(t[2]) === owner ? { key: { kind: KIND.ERC777, token: at, spender: asAddr(t[1]), id: 0n }, nft: false } : null
    default:
      return null
  }
}

async function attempt<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch {
    return null
  }
}

async function readState(client: Client, s: Seen, owner: Address, permit2: Address, now: number) {
  const { kind, token, spender, id } = s.key
  const read = (address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) =>
    attempt(() => readContract(client, { address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<unknown>)
  const flag = (v: unknown) => (v === true ? 1n : 0n)
  switch (kind) {
    case KIND.APPROVE:
      if (s.nft) {
        const [approved, holder] = await Promise.all([read(token, nftAbi, 'getApproved', [id]), read(token, nftAbi, 'ownerOf', [id])])
        const live = approved !== null && getAddress(approved as Address) === spender && holder !== null && getAddress(holder as Address) === owner
        return { amount: live ? 1n : 0n, balance: live ? 1n : 0n }
      }
      return { amount: ((await read(token, erc20Abi, 'allowance', [owner, spender])) as bigint | null) ?? 0n, balance: (await read(token, erc20Abi, 'balanceOf', [owner])) as bigint | null }
    case KIND.OPERATOR:
      return { amount: flag(await read(token, nftAbi, 'isApprovedForAll', [owner, spender])), balance: (await read(token, erc20Abi, 'balanceOf', [owner])) as bigint | null }
    case KIND.PERMIT2: {
      const r = (await read(permit2, permit2Abi, 'allowance', [owner, token, spender])) as readonly [bigint, number, number] | null
      const live = r !== null && BigInt(r[1]) >= BigInt(now)
      const [toP2, bal] = await Promise.all([read(token, erc20Abi, 'allowance', [owner, permit2]), read(token, erc20Abi, 'balanceOf', [owner])])
      const cap = toP2 === null ? null : (toP2 as bigint)
      const balance = bal === null ? null : cap === null ? (bal as bigint) : (bal as bigint) < cap ? (bal as bigint) : cap
      return { amount: live ? r![0] : 0n, balance }
    }
    case KIND.E6909:
      return { amount: ((await read(token, e6909Abi, 'allowance', [owner, spender, id])) as bigint | null) ?? 0n, balance: null }
    case KIND.E6909_OPERATOR:
      return { amount: flag(await read(token, e6909Abi, 'isOperator', [owner, spender])), balance: null }
    case KIND.DELEGATION:
      return { amount: ((await read(token, delegationAbi, 'borrowAllowance', [owner, spender])) as bigint | null) ?? 0n, balance: null }
    case KIND.MORPHO:
      return { amount: flag(await read(token, delegationAbi, 'isAuthorized', [owner, spender])), balance: null }
    case KIND.RELAYER:
      return { amount: flag(await read(token, delegationAbi, 'hasApprovedRelayer', [owner, spender])), balance: null }
    case KIND.ERC777:
      return { amount: flag(await read(token, delegationAbi, 'isOperatorFor', [spender, owner])), balance: (await read(token, erc20Abi, 'balanceOf', [owner])) as bigint | null }
    default:
      return { amount: 0n, balance: null }
  }
}

const BOOLEAN = new Set<number>([KIND.OPERATOR, KIND.E6909_OPERATOR, KIND.MORPHO, KIND.RELAYER, KIND.ERC777, KIND.COMET])

export async function scan(client: Client, o: ScanOptions): Promise<Finding[]> {
  const owner = getAddress(o.owner)
  const permit2 = getAddress(o.permit2 ?? PERMIT2)
  const head = await getBlock(client, { blockTag: 'latest' })
  const to = o.toBlock ?? head.number
  const from = o.fromBlock ?? 0n
  const now = o.now ?? Number(head.timestamp)
  const me = pad(owner).toLowerCase() as Hex
  const filters: { address?: Address; topics: (Hex | null)[] }[] = [
    { topics: [TOPIC.approval, me] },
    { topics: [TOPIC.approvalForAll, me] },
    { address: permit2, topics: [TOPIC.permit2Approval, me] },
    { address: permit2, topics: [TOPIC.permit2Permit, me] },
    { topics: [TOPIC.e6909Approval, me] },
    { topics: [TOPIC.e6909Operator, me] },
    { topics: [TOPIC.borrowDelegated, me] },
    { topics: [TOPIC.setAuthorization, null, me] },
    { topics: [TOPIC.relayerChanged, null, me] },
    { topics: [TOPIC.authorizedOperator, null, me] },
  ]
  const logs = (await Promise.all(filters.map((f) => getLogsRange(client, f, from, to)))).flat()
  const seen = new Map<string, Seen>()
  for (const log of logs) {
    const k = keyFor(log, owner, permit2)
    if (!k || k.key.spender === zeroAddress) continue
    const id = `${k.key.kind}:${k.key.token}:${k.key.spender}:${k.nft ? k.key.id : 0n}`
    const block = BigInt(log.blockNumber)
    const prev = seen.get(id)
    if (!prev || block >= prev.block) seen.set(id, { ...k, block, at: log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : null })
  }
  const times = new Map<bigint, number>()
  const out: Finding[] = []
  const list = [...seen.values()]
  for (let i = 0; i < list.length; i += 16) {
    const part = await Promise.all(
      list.slice(i, i + 16).map(async (s) => {
        const st = await readState(client, s, owner, permit2, now)
        const live = BOOLEAN.has(s.key.kind) || s.nft ? st.amount > 0n : st.amount > MAX_RESIDUAL
        if (!live) return null
        let at = s.at
        if (at === null) {
          at = times.get(s.block) ?? Number((await getBlock(client, { blockNumber: s.block })).timestamp)
          times.set(s.block, at)
        }
        const fungible = !BOOLEAN.has(s.key.kind) && !s.nft
        const [symbol, decimals] = fungible
          ? await Promise.all([
              attempt(() => readContract(client, { address: s.key.token, abi: erc20Abi, functionName: 'symbol' })),
              attempt(() => readContract(client, { address: s.key.token, abi: erc20Abi, functionName: 'decimals' })),
            ])
          : [null, null]
        const exposure = fungible && st.balance !== null ? (st.amount < st.balance ? st.amount : st.balance) : st.balance
        const f: Finding = {
          key: s.key,
          label: s.nft && s.key.kind === KIND.APPROVE ? 'nft approve' : KIND_NAME[s.key.kind],
          nft: s.nft,
          amount: st.amount,
          unlimited: fungible && st.amount >= 1n << 128n,
          balance: st.balance,
          exposure,
          symbol: symbol as string | null,
          decimals: decimals === null ? null : Number(decimals),
          lastBlock: s.block,
          lastAt: at,
          ageDays: Math.max(0, Math.floor((now - at) / 86400)),
        }
        return f
      }),
    )
    for (const f of part) if (f) out.push(f)
  }
  const rank = (f: Finding) => f.exposure ?? 0n
  return out.sort((a, b) => (rank(b) > rank(a) ? 1 : rank(b) < rank(a) ? -1 : a.lastBlock < b.lastBlock ? -1 : a.lastBlock > b.lastBlock ? 1 : 0))
}

export function revokeCalls(findings: Finding[], owner: Address, permit2: Address = PERMIT2): Call[] {
  return findings.map((f) => revokeFor({ ...f.key, amount: f.amount }, { nft: f.nft }, owner, permit2))
}

export const revokeKeys = (findings: Finding[]): SealKey[] => findings.map((f) => f.key)
