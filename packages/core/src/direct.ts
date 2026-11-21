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
import { CMD, COMMAND_TYPE_MASK, CONTRACT_BALANCE, MSG_SENDER, ADDRESS_THIS, decodeUr, encodeUr, isUr, rewriteV4, setWord, swapTokenIn, sweep, word } from './ur.js'
import { decodeAbiParameters, parseAbiParameters } from 'viem'

export const v2RouterAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function factory() view returns (address)',
])

export const swapRouter02V2Abi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to) payable returns (uint256)',
  'function factoryV2() view returns (address)',
])

export const v2ExactOutAbi = parseAbi([
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[])',
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
  'function swapV2ExactOut(address[] pairs, address tokenIn, uint256 amountOut, uint256 amountInMax, address to, uint256 deadline, uint256 feeBps) returns (uint256)',
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
  v2ExactOut: '0x8803dbee',
  v2In02: '0x472b43f3',
  v2Out02: '0x42712a67',
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

type V2Plan = { exactOut: boolean; amount: bigint; limit: bigint; path: readonly Address[]; to: Address; deadline: bigint; factory: Address | null }

async function v2Plan(ctx: Ctx, router: Address, p: V2Plan): Promise<Rewrite> {
  if (!p.factory || p.amount === 0n) return null
  const pairs = await pairsFor(ctx.client, p.factory, p.path)
  if (!pairs) return null
  const feeBps = ctx.o.feeBps?.[router.toLowerCase()] ?? 30n
  const tokenIn = getAddress(p.path[0])
  if (!p.exactOut) {
    return {
      calls: [
        transfer(tokenIn, pairs[0], p.amount),
        { to: ctx.o.swapper, data: encodeFunctionData({ abi: swapperAbi, functionName: 'swapV2', args: [pairs, tokenIn, p.limit, p.to, p.deadline, feeBps] }) },
      ],
      note: `direct: ${router} V2 swap sent straight to ${pairs.length} pair(s)`,
    }
  }
  return {
    calls: [
      transfer(tokenIn, ctx.o.swapper, p.limit),
      { to: ctx.o.swapper, data: encodeFunctionData({ abi: swapperAbi, functionName: 'swapV2ExactOut', args: [pairs, tokenIn, p.amount, p.limit, p.to, p.deadline, feeBps] }) },
    ],
    note: `direct: ${router} V2 exact-output swap paid from the swapper, unused input refunded`,
  }
}

async function factoryV2Of(client: Client, router: Address): Promise<Address | null> {
  try {
    return getAddress(await readContract(client, { address: router, abi: swapRouter02V2Abi, functionName: 'factoryV2' }))
  } catch {
    return null
  }
}

async function v2Swap(ctx: Ctx, router: Address, data: Hex): Promise<Rewrite> {
  const sel = data.slice(0, 10).toLowerCase()
  if (sel === SEL.v2ExactOut) {
    const { args } = decodeFunctionData({ abi: v2ExactOutAbi, data })
    const [amountOut, amountInMax, path, to, deadline] = args
    return v2Plan(ctx, router, { exactOut: true, amount: amountOut, limit: amountInMax, path, to: getAddress(to), deadline, factory: await factoryOf(ctx.client, router) })
  }
  if (sel === SEL.v2In02 || sel === SEL.v2Out02) {
    const { args } = decodeFunctionData({ abi: swapRouter02V2Abi, data })
    const [amount, limit, path, rawTo] = args as readonly [bigint, bigint, readonly Address[], Address]
    let to = getAddress(rawTo)
    if (to === MSG_SENDER) to = ctx.sender
    if (to === ADDRESS_THIS || to === router) return null
    return v2Plan(ctx, router, { exactOut: sel === SEL.v2Out02, amount, limit, path, to, deadline: ctx.deadline ?? maxUint256, factory: await factoryV2Of(ctx.client, router) })
  }
  const { args } = decodeFunctionData({ abi: v2RouterAbi, data })
  const [amountIn, amountOutMin, path, to, deadline] = args as readonly [bigint, bigint, readonly Address[], Address, bigint]
  return v2Plan(ctx, router, { exactOut: false, amount: amountIn, limit: amountOutMin, path, to: getAddress(to), deadline, factory: await factoryOf(ctx.client, router) })
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

const permit2Batch = parseAbiParameters('(address from, address to, uint160 amount, address token)[]')
const permit2Pull = parseAbiParameters('address, address, uint160')
const tokenTo = parseAbiParameters('address, address')
const toOnly = parseAbiParameters('address')

function urSwap(sender: Address, router: Address, data: Hex, value: bigint): Rewrite {
  const u = decodeUr(data)
  if (!u) return null
  const pulls = new Map<Address, bigint>()
  const surplus = new Set<Address>()
  const spends: { token: Address | null; to: Address | null }[] = []
  const direct: Call[] = []
  const commands: number[] = []
  const inputs: Hex[] = []
  let started = false
  const keep = (c: number, input: Hex) => {
    started = true
    commands.push(c)
    inputs.push(input)
  }
  for (let i = 0; i < u.commands.length; i++) {
    const c = u.commands[i]
    const type = c & COMMAND_TYPE_MASK
    const input = u.inputs[i]
    if (type === CMD.PERMIT2_PERMIT || type === CMD.PERMIT2_PERMIT_BATCH) continue
    if (type === CMD.PERMIT2_TRANSFER_FROM) {
      if (started) return null
      const [token, rawTo, amount] = decodeAbiParameters(permit2Pull, input)
      const to = getAddress(rawTo)
      if (amount === 0n || to === MSG_SENDER) continue
      if (to === ADDRESS_THIS || to === router) pulls.set(getAddress(token), (pulls.get(getAddress(token)) ?? 0n) + amount)
      else direct.push(transfer(getAddress(token), to, amount))
      continue
    }
    if (type === CMD.PERMIT2_TRANSFER_FROM_BATCH) {
      if (started) return null
      const [details] = decodeAbiParameters(permit2Batch, input)
      for (const d of details) {
        const to = getAddress(d.to)
        if (getAddress(d.from) !== sender || to === MSG_SENDER || to === ADDRESS_THIS) return null
        if (d.amount === 0n) continue
        if (to === router) pulls.set(getAddress(d.token), (pulls.get(getAddress(d.token)) ?? 0n) + d.amount)
        else direct.push(transfer(getAddress(d.token), to, d.amount))
      }
      continue
    }
    if (type === CMD.V3_SWAP_EXACT_IN || type === CMD.V3_SWAP_EXACT_OUT || type === CMD.V2_SWAP_EXACT_IN || type === CMD.V2_SWAP_EXACT_OUT) {
      if (word(input, 4) === 0n) {
        spends.push({ token: swapTokenIn(type, input), to: null })
        keep(c, input)
        continue
      }
      const exactIn = type === CMD.V3_SWAP_EXACT_IN || type === CMD.V2_SWAP_EXACT_IN
      const amount = word(input, exactIn ? 1 : 2)
      if (amount === 0n || amount >= CONTRACT_BALANCE) return null
      const token = swapTokenIn(type, input)
      pulls.set(token, (pulls.get(token) ?? 0n) + amount)
      surplus.add(token)
      keep(c, setWord(input, 4, 0n))
      continue
    }
    if (type === CMD.V4_SWAP) {
      const v4 = rewriteV4(input)
      if (!v4) return null
      for (const [token, amount] of v4.pulls) pulls.set(token, (pulls.get(token) ?? 0n) + amount)
      for (const t of v4.surplus) surplus.add(t)
      for (const t of v4.fromRouter) spends.push({ token: t, to: null })
      keep(c, v4.input)
      continue
    }
    if (type === CMD.SWEEP || type === CMD.PAY_PORTION || type === CMD.PAY_PORTION_FULL_PRECISION) {
      const [token, to] = decodeAbiParameters(tokenTo, input)
      spends.push({ token: getAddress(token), to: getAddress(to) })
      keep(c, input)
      continue
    }
    if (type === CMD.UNWRAP_WETH) {
      spends.push({ token: null, to: getAddress(decodeAbiParameters(toOnly, input)[0]) })
      keep(c, input)
      continue
    }
    if (
      type === CMD.BALANCE_CHECK_ERC20 ||
      (type === CMD.WRAP_ETH && value > 0n)
    ) {
      keep(c, input)
      continue
    }
    return null
  }
  if (!pulls.size && !direct.length) return null
  const ours = (a: Address) => a === MSG_SENDER || a === ADDRESS_THIS || a === router || a === getAddress(sender)
  for (const s of spends) {
    const hit = s.token === null ? surplus.size > 0 : surplus.has(s.token)
    if (hit && (s.to === null || !ours(s.to))) return null
  }
  for (const token of pulls.keys()) {
    commands.push(CMD.SWEEP)
    inputs.push(sweep(token))
  }
  if (value > 0n) {
    commands.push(CMD.SWEEP)
    inputs.push(sweep('0x0000000000000000000000000000000000000000'))
  }
  return {
    calls: [
      ...direct,
      ...[...pulls].map(([token, amount]) => transfer(token, router, amount)),
      { to: router, data: encodeUr({ commands, inputs, deadline: u.deadline }), value },
    ],
    note: `direct: ${router} Universal Router swap paid from its own balance (payerIsUser=false), no Permit2 grant or pull, leftovers swept back`,
  }
}

async function rewrite(ctx: Ctx, call: Call): Promise<Rewrite> {
  if ((call.value ?? 0n) > 0n && !isUr(call.data)) return null
  const router = getAddress(call.to)
  const sel = call.data.slice(0, 10).toLowerCase()
  try {
    if (SEL.v2.has(sel) || sel === SEL.v2ExactOut || sel === SEL.v2In02 || sel === SEL.v2Out02) return await v2Swap(ctx, router, call.data)
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
    return urSwap(ctx.sender, router, call.data, call.value ?? 0n)
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
