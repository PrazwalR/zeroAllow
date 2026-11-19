import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Client } from 'viem'
import { readContract } from 'viem/actions'
import { KIND, erc20Abi } from './constants.js'
import type { CompileInput } from './compile.js'
import { classify, isGrant } from './registry.js'
import type { Call } from './types.js'

export const v2RouterAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function factory() view returns (address)',
])
const factoryAbi = parseAbi(['function getPair(address a, address b) view returns (address)'])
export const swapperAbi = parseAbi([
  'function swapV2(address[] pairs, address tokenIn, uint256 minOut, address to, uint256 deadline, uint256 feeBps) returns (uint256)',
  'error Expired()',
  'error BadPath(uint256 hop)',
  'error NothingIn(uint256 hop)',
  'error Slippage(uint256 got, uint256 want)',
])

const V2_SWAPS = new Set(['0x38ed1739', '0x5c11d795'])

export type DirectOptions = { swapper: Address; feeBps?: Record<string, bigint> }

async function pairsFor(client: Client, router: Address, path: readonly Address[]): Promise<Address[] | null> {
  try {
    const factory = await readContract(client, { address: router, abi: v2RouterAbi, functionName: 'factory' })
    const pairs: Address[] = []
    for (let i = 0; i + 1 < path.length; i++) {
      const p = await readContract(client, { address: factory, abi: factoryAbi, functionName: 'getPair', args: [path[i], path[i + 1]] })
      if (p === zeroAddress) return null
      pairs.push(getAddress(p))
    }
    return pairs.length ? pairs : null
  } catch {
    return null
  }
}

export async function routeDirect<T extends CompileInput>(client: Client, input: T, o: DirectOptions): Promise<T & { notes: string[] }> {
  const notes: string[] = []
  const rewritten = new Set<string>()
  const kept = new Set<string>()
  const routed: Call[] = []
  for (const call of input.calls) {
    const router = getAddress(call.to)
    if (!V2_SWAPS.has(call.data.slice(0, 10).toLowerCase()) || (call.value ?? 0n) > 0n) {
      routed.push(call)
      kept.add(router)
      continue
    }
    const { args } = decodeFunctionData({ abi: v2RouterAbi, data: call.data })
    const [amountIn, amountOutMin, path, to, deadline] = args as readonly [bigint, bigint, readonly Address[], Address, bigint]
    const pairs = await pairsFor(client, router, path)
    if (!pairs) {
      routed.push(call)
      kept.add(router)
      notes.push(`direct: kept ${router} swap, pairs not found`)
      continue
    }
    const feeBps = o.feeBps?.[router.toLowerCase()] ?? 30n
    routed.push(
      { to: getAddress(path[0]), data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pairs[0], amountIn] }) },
      { to: o.swapper, data: encodeFunctionData({ abi: swapperAbi, functionName: 'swapV2', args: [pairs, getAddress(path[0]), amountOutMin, to, deadline, feeBps] }) },
    )
    rewritten.add(router)
    notes.push(`direct: ${router} swap sent straight to ${pairs.length} pair(s), the router is never approved or called`)
  }
  const calls = routed.filter((c) => {
    const k = classify(c.to, c.data, input.sender, input.permit2)
    const drop =
      isGrant(k) && (k.kind === KIND.APPROVE || k.kind === KIND.ERC20 || k.kind === KIND.PERMIT2) && rewritten.has(k.spender) && !kept.has(k.spender)
    if (drop) notes.push(`direct: dropped ${k.kind === KIND.PERMIT2 ? 'permit2 ' : ''}approval of ${k.token} to ${k.spender}`)
    return !drop
  })
  return { ...input, calls, notes }
}
