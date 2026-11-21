import { decodeFunctionData, encodeFunctionData, type Address, type Client, type Hex } from 'viem'
import { getFrameNonceSeq } from '@jaw.id/frametx-kit'
import { simulateCalls } from 'viem/actions'
import { KIND, SEL, erc20Abi, permit2Abi } from './constants.js'
import { compile, compileCalls, type CompileInput } from './compile.js'
import { classify } from './registry.js'
import { buildTx, fees, fitLimits, signAndEncode, simulate, type Rpc } from './tx.js'

export type Oracle = (input: CompileInput) => Promise<boolean>

type Slot = { index: number; amount: bigint; max: bigint; label: string; set: (v: bigint) => Hex }

const MAX_160 = (1n << 160n) - 1n

function slots(input: CompileInput): Slot[] {
  const out: Slot[] = []
  input.calls.forEach((c, index) => {
    const sel = c.data.slice(0, 10).toLowerCase()
    const k = classify(c.to, c.data, input.sender, input.permit2)
    if ((k.amount ?? 0n) === 0n) return
    if (k.kind === KIND.APPROVE && sel === SEL.approve && !input.quirks?.[c.to.toLowerCase()]?.nft) {
      out.push({
        index,
        amount: k.amount!,
        max: (1n << 256n) - 1n,
        label: `approve(${k.spender}) on ${c.to}`,
        set: (v) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [k.spender, v] }),
      })
    } else if (k.kind === KIND.PERMIT2 && sel === SEL.permit2Approve) {
      const { args } = decodeFunctionData({ abi: permit2Abi, data: c.data })
      const [token, spender, , expiration] = args as readonly [Address, Address, bigint, number]
      out.push({
        index,
        amount: k.amount!,
        max: MAX_160,
        label: `Permit2 approve(${spender}) on ${token}`,
        set: (v) => encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, spender, v, expiration] }),
      })
    }
  })
  return out
}

export function statedAmounts(input: CompileInput): bigint[] {
  const seen = new Set<bigint>()
  for (const c of input.calls) {
    if (classify(c.to, c.data, input.sender, input.permit2).kind !== KIND.NONE) continue
    for (let o = 10; o + 64 <= c.data.length; o += 64) seen.add(BigInt(`0x${c.data.slice(o, o + 64)}`))
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function tighten<T extends CompileInput>(input: T, oracle: Oracle): Promise<T & { notes: string[] }> {
  const notes: string[] = []
  const ss = slots(input)
  if (!ss.length) return { ...input, notes }
  const at = (amounts: bigint[]): T => ({
    ...input,
    calls: input.calls.map((c, i) => {
      const s = ss.findIndex((x) => x.index === i)
      return s < 0 ? c : { ...c, data: ss[s].set(amounts[s]) }
    }),
  })
  const ask = async (amounts: bigint[]) => {
    try {
      return await oracle(at(amounts))
    } catch {
      return null
    }
  }
  const base = ss.map((s) => s.amount)
  const first = await ask(base)
  if (first !== true) {
    notes.push(first === null ? 'tighten: simulation unavailable on this node; amounts kept' : 'tighten: the transaction does not simulate as given; amounts kept')
    return { ...input, notes }
  }
  const stated = statedAmounts(input)
  const chosen = [...base]
  for (let s = 0; s < ss.length; s++) {
    const cands = stated.filter((w) => w > 0n && w < ss[s].amount && w <= ss[s].max)
    let lo = 0
    let hi = cands.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const trial = [...base]
      trial[s] = cands[mid]
      if ((await ask(trial)) === true) hi = mid
      else lo = mid + 1
    }
    if (lo < cands.length) chosen[s] = cands[lo]
  }
  if (chosen.every((v, i) => v === base[i])) {
    notes.push('tighten: no smaller stated amount works; amounts kept')
    return { ...input, notes }
  }
  if ((await ask(chosen)) !== true) {
    notes.push('tighten: the tightened amounts fail together; amounts kept')
    return { ...input, notes }
  }
  ss.forEach((s, i) => {
    if (chosen[i] !== base[i]) notes.push(`tighten: ${s.label} ${base[i]} -> ${chosen[i]}`)
  })
  return { ...at(chosen), notes }
}

export function frameOracle(rpc: Rpc, p: { chainId: bigint; signer: Address; key: Hex }): Oracle {
  let cache: Promise<[bigint, Awaited<ReturnType<typeof fees>>]> | undefined
  return async (input) => {
    const { frames } = compile(input)
    cache ??= Promise.all([getFrameNonceSeq(rpc, { address: input.sender }), fees(rpc)])
    const [nonceSeq, f] = await cache
    const tx = buildTx({ chainId: p.chainId, sender: input.sender, signer: p.signer, frames, nonceSeq, ...f, limits: fitLimits(frames, 2_000_000n) })
    const { raw } = await signAndEncode(tx, p.key)
    const sim = await simulate(rpc, raw)
    return sim.valid && sim.executionStatus === 'success'
  }
}

export function callsOracle(client: Client): Oracle {
  return async (input) => {
    const { calls } = compileCalls(input)
    const { results } = await simulateCalls(client, { account: input.sender, calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })) })
    return results.every((r) => r.status === 'success')
  }
}
