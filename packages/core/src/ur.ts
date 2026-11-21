import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem'

export const urAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function execute(bytes commands, bytes[] inputs) payable',
])

export const CMD = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  PAY_PORTION_FULL_PRECISION: 0x07,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
} as const

export const V4 = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
} as const

export const COMMAND_TYPE_MASK = 0x7f
export const CONTRACT_BALANCE = 1n << 255n
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001'
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002'

export type UrCall = { commands: number[]; inputs: Hex[]; deadline?: bigint }

const UR_SELECTORS = new Set(['0x3593564c', '0x24856bc3'])

const single = parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes')
const batch = parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline), bytes')
const sweepParams = parseAbiParameters('address, address, uint256')
const v4Plan = parseAbiParameters('bytes, bytes[]')
const settleAll = parseAbiParameters('address, uint256')
const settle = parseAbiParameters('address, uint256, bool')
const NATIVE = '0x0000000000000000000000000000000000000000'
const toBytes = (h: Hex) => (h.length > 2 ? h.slice(2).match(/../g)!.map((b) => parseInt(b, 16)) : [])
const fromBytes = (b: number[]): Hex => `0x${b.map((x) => x.toString(16).padStart(2, '0')).join('')}`

export function rewriteV4(input: Hex): { input: Hex; pulls: [Address, bigint][]; surplus: Address[]; fromRouter: Address[] } | null {
  const [actions, params] = decodeAbiParameters(v4Plan, input)
  const acts = toBytes(actions)
  if (acts.length !== params.length) return null
  const outActs: number[] = []
  const outParams: Hex[] = []
  const pulls = new Map<Address, bigint>()
  const surplus = new Set<Address>()
  const fromRouter = new Set<Address>()
  const pull = (currency: Address, amount: bigint) => {
    if (currency === '0x0000000000000000000000000000000000000000' || amount === 0n || amount >= CONTRACT_BALANCE) return false
    pulls.set(currency, (pulls.get(currency) ?? 0n) + amount)
    return true
  }
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    if (a === V4.SETTLE_ALL) {
      const [currency, maxAmount] = decodeAbiParameters(settleAll, params[i])
      if (currency === NATIVE) {
        outActs.push(a)
        outParams.push(params[i])
        continue
      }
      if (!pull(getAddress(currency), maxAmount)) return null
      surplus.add(getAddress(currency))
      outActs.push(V4.SETTLE)
      outParams.push(encodeAbiParameters(settle, [currency, 0n, false]))
    } else if (a === V4.SETTLE) {
      const [currency, amount, payerIsUser] = decodeAbiParameters(settle, params[i])
      if (payerIsUser && currency !== NATIVE && !pull(getAddress(currency), amount)) return null
      if (!payerIsUser && currency !== NATIVE) fromRouter.add(getAddress(currency))
      outActs.push(a)
      outParams.push(payerIsUser && currency !== NATIVE ? encodeAbiParameters(settle, [currency, amount, false]) : params[i])
    } else if (
      a === V4.SWAP_EXACT_IN_SINGLE ||
      a === V4.SWAP_EXACT_IN ||
      a === V4.SWAP_EXACT_OUT_SINGLE ||
      a === V4.SWAP_EXACT_OUT ||
      a === V4.TAKE ||
      a === V4.TAKE_ALL ||
      a === V4.TAKE_PORTION
    ) {
      outActs.push(a)
      outParams.push(params[i])
    } else {
      return null
    }
  }
  return { input: encodeAbiParameters(v4Plan, [fromBytes(outActs), outParams]), pulls: [...pulls], surplus: [...surplus], fromRouter: [...fromRouter] }
}

export const isUr = (data: Hex) => UR_SELECTORS.has(data.slice(0, 10).toLowerCase())

export function decodeUr(data: Hex): UrCall | null {
  if (!isUr(data)) return null
  try {
    const { args } = decodeFunctionData({ abi: urAbi, data })
    const [commands, inputs, deadline] = args as readonly [Hex, readonly Hex[], bigint?]
    const bytes = commands.length > 2 ? commands.slice(2).match(/../g)!.map((b) => parseInt(b, 16)) : []
    if (bytes.length !== inputs.length) return null
    return { commands: bytes, inputs: [...inputs], deadline }
  } catch {
    return null
  }
}

export function encodeUr(u: UrCall): Hex {
  const commands = `0x${u.commands.map((c) => c.toString(16).padStart(2, '0')).join('')}` as Hex
  return u.deadline === undefined
    ? encodeFunctionData({ abi: urAbi, functionName: 'execute', args: [commands, u.inputs] })
    : encodeFunctionData({ abi: urAbi, functionName: 'execute', args: [commands, u.inputs, u.deadline] })
}

export const word = (data: Hex, k: number): bigint => BigInt(`0x${data.slice(2 + 64 * k, 66 + 64 * k).padEnd(64, '0')}`)

export const setWord = (data: Hex, k: number, v: bigint): Hex =>
  `${data.slice(0, 2 + 64 * k)}${v.toString(16).padStart(64, '0')}${data.slice(66 + 64 * k)}` as Hex

export const sweep = (token: Address, recipient: Address = MSG_SENDER, amountMin = 0n): Hex =>
  encodeAbiParameters(sweepParams, [token, recipient, amountMin])

export function swapTokenIn(type: number, input: Hex): Address {
  if (type === CMD.V2_SWAP_EXACT_IN || type === CMD.V2_SWAP_EXACT_OUT) {
    const [, , , path] = decodeAbiParameters(parseAbiParameters('address, uint256, uint256, address[], bool'), input)
    return getAddress(path[0])
  }
  const [, , , path] = decodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), input)
  const hex = path.slice(2)
  return getAddress(`0x${type === CMD.V3_SWAP_EXACT_OUT ? hex.slice(-40) : hex.slice(0, 40)}`)
}

export function nestedPermits(u: UrCall): { token: Address; spender: Address }[] {
  const out: { token: Address; spender: Address }[] = []
  u.commands.forEach((c, i) => {
    const type = c & COMMAND_TYPE_MASK
    try {
      if (type === CMD.PERMIT2_PERMIT) {
        const [p] = decodeAbiParameters(single, u.inputs[i])
        out.push({ token: getAddress(p.details.token), spender: getAddress(p.spender) })
      } else if (type === CMD.PERMIT2_PERMIT_BATCH) {
        const [p] = decodeAbiParameters(batch, u.inputs[i])
        for (const d of p.details) out.push({ token: getAddress(d.token), spender: getAddress(p.spender) })
      }
    } catch {}
  })
  return out
}
