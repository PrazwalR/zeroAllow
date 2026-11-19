import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  maxUint256,
  numberToHex,
  parseAbi,
  zeroAddress,
  type Address,
  type Client,
  type Hex,
} from 'viem'
import { readContract } from 'viem/actions'
import { KIND, PERMIT2, erc20Abi } from './constants.js'
import type { CompileInput } from './compile.js'
import { classify, isGrant } from './registry.js'
import type { Call } from './types.js'
import { CMD, COMMAND_TYPE_MASK, CONTRACT_BALANCE, MSG_SENDER, ADDRESS_THIS, decodeUr, encodeUr, setWord, swapTokenIn, sweep, word } from './ur.js'

export const v2RouterAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function factory() view returns (address)',
])

export const v3RouterAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'struct ExactInputSingleParamsV1 { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct ExactInputParamsV1 { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256)',
  'function exactInput(ExactInputParams params) payable returns (uint256)',
  'function exactInputSingle(ExactInputSingleParamsV1 params) payable returns (uint256)',
  'function exactInput(ExactInputParamsV1 params) payable returns (uint256)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function factory() view returns (address)',
])

const factoryAbi = parseAbi([
  'function getPair(address a, address b) view returns (address)',
  'function getPool(address a, address b, uint24 fee) view returns (address)',
])

export const swapperAbi = parseAbi([
  'function swapV2(address[] pairs, address tokenIn, uint256 minOut, address to, uint256 deadline, uint256 feeBps) returns (uint256)',
  'function swapV3(bytes path, address factory, uint256 amountIn, uint256 minOut, address to, uint256 deadline) returns (uint256)',
  'error Expired()',
  'error Locked()',
  'error BadPath(uint256 hop)',
  'error NothingIn(uint256 hop)',
  'error Slippage(uint256 got, uint256 want)',
  'error NotPool()',
  'error Overpay(uint256 owed, uint256 max)',
])

const SEL = {
  v2: new Set(['0x38ed1739', '0x5c11d795']),
  v3Single02: '0x04e45aaf',
  v3Single1: '0x414bf389',
  v3Path02: '0xb858183f',
  v3Path1: '0xc04b8d59',
  multicallDeadline: '0x5ae401dc',
  multicall: '0xac9650d8',
}

export type DirectOptions = { swapper: Address; feeBps?: Record<string, bigint> }

type Rewrite = { calls: Call[]; note: string } | null
type Ctx = { client: Client; sender: Address; o: DirectOptions; deadline?: bigint }

const transfer = (token: Address, to: Address, amount: bigint): Call => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
})

async function factoryOf(client: Client, router: Address): Promise<Address | null> {
  try {
    return getAddress(await readContract(client, { address: router, abi: v2RouterAbi, functionName: 'factory' }))
  } catch {
    return null
  }
}

async function pairsFor(client: Client, factory: Address, path: readonly Address[]): Promise<Address[] | null> {
  const pairs: Address[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    const p = await readContract(client, { address: factory, abi: factoryAbi, functionName: 'getPair', args: [path[i], path[i + 1]] }).catch(() => zeroAddress)
    if (p === zeroAddress) return null
    pairs.push(getAddress(p))
  }
  return pairs.length ? pairs : null
}

export function v3Hops(path: Hex): { a: Address; fee: number; b: Address }[] | null {
  const h = path.slice(2)
  if (h.length < 86 || (h.length - 40) % 46 !== 0) return null
  const hops = []
  for (let o = 0; o + 86 <= h.length; o += 46) {
    hops.push({ a: getAddress(`0x${h.slice(o, o + 40)}`), fee: parseInt(h.slice(o + 40, o + 46), 16), b: getAddress(`0x${h.slice(o + 46, o + 86)}`) })
  }
  return hops
}

export const v3Path = (hops: { a: Address; fee: number; b: Address }[]): Hex =>
  concatHex([hops[0].a, ...hops.flatMap((h) => [numberToHex(h.fee, { size: 3 }), h.b])])

async function poolsExist(client: Client, factory: Address, path: Hex): Promise<boolean> {
  const hops = v3Hops(path)
  if (!hops) return false
  for (const h of hops) {
    const p = await readContract(client, { address: factory, abi: factoryAbi, functionName: 'getPool', args: [h.a, h.b, h.fee] }).catch(() => zeroAddress)
    if (p === zeroAddress) return false
  }
  return true
}

async function v2Swap(ctx: Ctx, router: Address, data: Hex): Promise<Rewrite> {
  const { args } = decodeFunctionData({ abi: v2RouterAbi, data })
  const [amountIn, amountOutMin, path, to, deadline] = args as readonly [bigint, bigint, readonly Address[], Address, bigint]
  const factory = await factoryOf(ctx.client, router)
  const pairs = factory && (await pairsFor(ctx.client, factory, path))
  if (!pairs) return null
  const feeBps = ctx.o.feeBps?.[router.toLowerCase()] ?? 30n
  return {
    calls: [
      transfer(getAddress(path[0]), pairs[0], amountIn),
      { to: ctx.o.swapper, data: encodeFunctionData({ abi: swapperAbi, functionName: 'swapV2', args: [pairs, getAddress(path[0]), amountOutMin, to, deadline, feeBps] }) },
    ],
    note: `direct: ${router} V2 swap sent straight to ${pairs.length} pair(s)`,
  }
}

async function v3Swap(ctx: Ctx, router: Address, data: Hex, v1: boolean): Promise<Rewrite> {
  const { functionName, args } = decodeFunctionData({ abi: v3RouterAbi, data })
  const p = (args as readonly Record<string, unknown>[])[0]
  let path: Hex
  if (functionName === 'exactInputSingle') {
    if ((p.sqrtPriceLimitX96 as bigint) !== 0n) return null
    path = v3Path([{ a: getAddress(p.tokenIn as Address), fee: Number(p.fee), b: getAddress(p.tokenOut as Address) }])
  } else {
    path = p.path as Hex
  }
  const amountIn = p.amountIn as bigint
  let recipient = getAddress(p.recipient as Address)
  if (!v1 && recipient === MSG_SENDER) recipient = ctx.sender
  if ((!v1 && recipient === ADDRESS_THIS) || recipient === router || amountIn === 0n) return null
  const factory = await factoryOf(ctx.client, router)
  if (!factory || !(await poolsExist(ctx.client, factory, path))) return null
  const deadline = v1 ? (p.deadline as bigint) : (ctx.deadline ?? maxUint256)
  const hops = v3Hops(path)!
  return {
    calls: [
      transfer(hops[0].a, ctx.o.swapper, amountIn),
      { to: ctx.o.swapper, data: encodeFunctionData({ abi: swapperAbi, functionName: 'swapV3', args: [path, factory, amountIn, p.amountOutMinimum as bigint, recipient, deadline] }) },
    ],
    note: `direct: ${router} V3 swap paid by the swapper through ${hops.length} pool callback(s)`,
  }
}

function urSwap(sender: Address, router: Address, data: Hex): Rewrite {
  const u = decodeUr(data)
  if (!u) return null
  const pulls = new Map<Address, bigint>()
  const commands: number[] = []
  const inputs: Hex[] = []
  for (let i = 0; i < u.commands.length; i++) {
    const c = u.commands[i]
    const type = c & COMMAND_TYPE_MASK
    const input = u.inputs[i]
    if (type === CMD.PERMIT2_PERMIT || type === CMD.PERMIT2_PERMIT_BATCH) continue
    if (type === CMD.V3_SWAP_EXACT_IN || type === CMD.V3_SWAP_EXACT_OUT || type === CMD.V2_SWAP_EXACT_IN || type === CMD.V2_SWAP_EXACT_OUT) {
      if (word(input, 4) === 0n) {
        commands.push(c)
        inputs.push(input)
        continue
      }
      const exactIn = type === CMD.V3_SWAP_EXACT_IN || type === CMD.V2_SWAP_EXACT_IN
      const amount = word(input, exactIn ? 1 : 2)
      if (amount === 0n || amount >= CONTRACT_BALANCE) return null
      const token = swapTokenIn(type, input)
      pulls.set(token, (pulls.get(token) ?? 0n) + amount)
      commands.push(c)
      inputs.push(setWord(input, 4, 0n))
      continue
    }
    if (type === CMD.SWEEP || type === CMD.PAY_PORTION || type === CMD.PAY_PORTION_FULL_PRECISION || type === CMD.UNWRAP_WETH || type === CMD.BALANCE_CHECK_ERC20) {
      commands.push(c)
      inputs.push(input)
      continue
    }
    return null
  }
  if (!pulls.size) return null
  for (const token of pulls.keys()) {
    commands.push(CMD.SWEEP)
    inputs.push(sweep(token))
  }
  return {
    calls: [...[...pulls].map(([token, amount]) => transfer(token, router, amount)), { to: router, data: encodeUr({ commands, inputs, deadline: u.deadline }) }],
    note: `direct: ${router} Universal Router swap paid from its own balance (payerIsUser=false), no Permit2 grant, leftovers swept back`,
  }
}

async function rewrite(ctx: Ctx, call: Call): Promise<Rewrite> {
  if ((call.value ?? 0n) > 0n) return null
  const router = getAddress(call.to)
  const sel = call.data.slice(0, 10).toLowerCase()
  try {
    if (SEL.v2.has(sel)) return await v2Swap(ctx, router, call.data)
    if (sel === SEL.v3Single02 || sel === SEL.v3Path02) return await v3Swap(ctx, router, call.data, false)
    if (sel === SEL.v3Single1 || sel === SEL.v3Path1) return await v3Swap(ctx, router, call.data, true)
    if (sel === SEL.multicall || sel === SEL.multicallDeadline) {
      const { args } = decodeFunctionData({ abi: v3RouterAbi, data: call.data })
      const inner = (sel === SEL.multicall ? args[0] : args[1]) as readonly Hex[]
      const deadline = sel === SEL.multicall ? undefined : (args[0] as bigint)
      const out: Call[] = []
      for (const data of inner) {
        const r = await rewrite({ ...ctx, deadline }, { to: router, data })
        if (!r) return null
        out.push(...r.calls)
      }
      return out.length ? { calls: out, note: `direct: ${router} multicall of ${inner.length} swap(s) unwrapped` } : null
    }
    return urSwap(ctx.sender, router, call.data)
  } catch {
    return null
  }
}

export async function routeDirect<T extends CompileInput>(client: Client, input: T, o: DirectOptions): Promise<T & { notes: string[] }> {
  const notes: string[] = []
  const permit2 = getAddress(input.permit2 ?? PERMIT2)
  const rewritten = new Set<Address>()
  const keptRouters = new Set<Address>()
  const routed: Call[] = []
  for (const call of input.calls) {
    const r = await rewrite({ client, sender: input.sender, o }, call)
    if (r) {
      routed.push(...r.calls)
      rewritten.add(getAddress(call.to))
      notes.push(r.note)
      continue
    }
    routed.push(call)
    if (classify(call.to, call.data, input.sender, permit2).kind === KIND.NONE) keptRouters.add(getAddress(call.to))
  }
  const calls = routed.filter((c) => {
    const k = classify(c.to, c.data, input.sender, permit2)
    if (!isGrant(k) || (k.kind !== KIND.APPROVE && k.kind !== KIND.ERC20 && k.kind !== KIND.PERMIT2)) return true
    const spender = getAddress(k.spender)
    const drop = (rewritten.has(spender) && !keptRouters.has(spender)) || (spender === permit2 && rewritten.size > 0 && keptRouters.size === 0)
    if (drop) notes.push(`direct: dropped ${k.kind === KIND.PERMIT2 ? 'Permit2 ' : ''}approval of ${k.token} to ${spender}`)
    return !drop
  })
  return { ...input, calls, notes }
}
