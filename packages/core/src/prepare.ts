import { encodeFunctionData, type Address, type PublicClient } from 'viem'
import { KIND, SEL, UNLIMITED, erc20Abi } from './constants.js'
import type { CompileInput } from './compile.js'
import { classify } from './registry.js'
import type { Call, Quirk } from './types.js'

const ERC721 = '0x80ac58cd'

async function isNft(client: PublicClient, token: Address) {
  try {
    return await client.readContract({ address: token, abi: erc20Abi, functionName: 'supportsInterface', args: [ERC721] })
  } catch {
    return false
  }
}

export async function prepare(
  client: PublicClient,
  input: CompileInput & { capUnlimited?: boolean },
): Promise<CompileInput & { notes: string[] }> {
  const quirks: Record<string, Quirk> = { ...(input.quirks ?? {}) }
  const current: Record<string, bigint> = { ...(input.current ?? {}) }
  const notes: string[] = []
  const calls: Call[] = []
  for (const call of input.calls) {
    const c = classify(call.to, call.data, input.sender, input.permit2)
    if (c.kind !== KIND.APPROVE || call.data.slice(0, 10) !== SEL.approve) {
      calls.push(call)
      continue
    }
    const key = c.token.toLowerCase()
    if (quirks[key]?.nft === undefined && (await isNft(client, c.token))) quirks[key] = { ...quirks[key], nft: true }
    if (quirks[key]?.nft) {
      calls.push(call)
      continue
    }
    current[`${key}:${c.spender.toLowerCase()}`] = await client.readContract({
      address: c.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.sender, c.spender],
    })
    if (input.capUnlimited !== false && (c.amount ?? 0n) >= UNLIMITED) {
      const bal = await client.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [input.sender] })
      calls.push({ ...call, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.spender, bal] }) })
      notes.push(`unlimited approve on ${c.token} capped to balance ${bal}`)
      continue
    }
    calls.push(call)
  }
  return { ...input, calls, quirks, current, notes }
}
