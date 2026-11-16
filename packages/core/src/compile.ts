import { encodeFunctionData, isAddressEqual, zeroAddress, type Address } from 'viem'
import {
  ATOMIC,
  KIND,
  MAX_RESIDUAL,
  MODE,
  SCOPE_EXECUTION_AND_PAYMENT,
  SEL,
  accountAbi,
  e6909Abi,
  erc20Abi,
  nftAbi,
  permit2Abi,
  sealAbi,
} from './constants.js'
import { classify, isGrant } from './registry.js'
import type { Call, Classified, FrameSpec, MinOut, Quirk } from './types.js'

export type AccountKind = 'eoa' | 'zeroallow'

export type CompileInput = {
  sender: Address
  calls: Call[]
  seal: Address
  permit2?: Address
  account?: AccountKind
  minOut?: MinOut[]
  quirks?: Record<string, Quirk>
  current?: Record<string, bigint>
}

export type Compiled = { frames: FrameSpec[]; grants: Classified[]; notes: string[] }

const lc = (a: Address) => a.toLowerCase()
const pair = (token: Address, spender: Address) => `${lc(token)}:${lc(spender)}`

export function verifyFrame(account: AccountKind = 'eoa'): FrameSpec {
  return {
    mode: MODE.VERIFY,
    flags: SCOPE_EXECUTION_AND_PAYMENT,
    target: null,
    value: 0n,
    data: account === 'zeroallow' ? encodeFunctionData({ abi: accountAbi, functionName: 'validate', args: [0n] }) : '0x',
    label: 'verify',
  }
}

const sender = (call: Call, label: string, atomic: boolean): FrameSpec => ({
  mode: MODE.SENDER,
  flags: atomic ? ATOMIC : 0,
  target: call.to,
  value: call.value ?? 0n,
  data: call.data,
  label,
})

const keyOf = (c: Classified, nft: boolean) => {
  const family = c.kind === KIND.APPROVE && !nft ? KIND.ERC20 : c.kind
  const id = family === KIND.ERC20 || family === KIND.OPERATOR || family === KIND.E6909_OPERATOR ? 0n : c.id
  return `${family}:${lc(c.token)}:${lc(c.spender)}:${id}`
}

export function revokeFor(c: Classified, quirk: Quirk, permit2?: Address): Call {
  const residual = quirk.zeroReverts ? MAX_RESIDUAL : 0n
  switch (c.kind) {
    case KIND.APPROVE:
      return quirk.nft
        ? { to: c.token, data: encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [zeroAddress, c.id] }) }
        : { to: c.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.spender, residual] }) }
    case KIND.ERC20:
      return { to: c.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.spender, residual] }) }
    case KIND.OPERATOR:
      return { to: c.token, data: encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [c.spender, false] }) }
    case KIND.E6909:
      return { to: c.token, data: encodeFunctionData({ abi: e6909Abi, functionName: 'approve', args: [c.spender, c.id, 0n] }) }
    case KIND.E6909_OPERATOR:
      return { to: c.token, data: encodeFunctionData({ abi: e6909Abi, functionName: 'setOperator', args: [c.spender, false] }) }
    case KIND.PERMIT2:
      if (!permit2) throw new Error('permit2 address required')
      return { to: permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [c.token, c.spender, 0n, 0] }) }
    default:
      throw new Error(`no revoke for kind ${c.kind}`)
  }
}

export function compile(input: CompileInput): Compiled {
  const quirks = input.quirks ?? {}
  const current = input.current ?? {}
  const notes: string[] = []
  const body: FrameSpec[] = []
  const grants = new Map<string, Classified>()

  if (input.minOut?.length) {
    body.push(
      sender(
        { to: input.seal, data: encodeFunctionData({ abi: sealAbi, functionName: 'snapshot', args: [input.minOut.map((m) => m.token)] }) },
        'seal.snapshot',
        true,
      ),
    )
  }

  input.calls.forEach((call, n) => {
    if (isAddressEqual(call.to, input.sender)) throw new Error(`call ${n} targets the sender; the guard refuses self-calls`)
    const c = classify(call.to, call.data, input.sender, input.permit2)
    if (c.kind === KIND.MALFORMED) throw new Error(`call ${n} is a grant zeroallow cannot parse (e.g. Permit2 batch permit)`)
    const quirk = quirks[lc(c.token)] ?? {}
    if (c.kind === KIND.APPROVE && !quirk.nft && (c.amount ?? 0n) > 0n && call.data.slice(0, 10) === SEL.approve) {
      const existing = current[pair(c.token, c.spender)] ?? 0n
      if ((quirk.zeroFirst || existing > 0n) && !quirk.zeroReverts) {
        body.push(sender({ to: c.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.spender, 0n] }) }, 'zero-first', true))
        notes.push(`zero-first before approve on ${c.token}`)
      }
    }
    body.push(sender(call, c.kind === KIND.NONE ? `call ${n}` : `grant ${n}`, true))
    if (isGrant(c) || (c.kind === KIND.APPROVE && quirk.nft)) grants.set(keyOf(c, !!quirk.nft), c)
  })

  for (const c of grants.values()) {
    const quirk = quirks[lc(c.token)] ?? {}
    body.push(sender(revokeFor(c, quirk, input.permit2), 'revoke', true))
    if (quirk.zeroReverts) notes.push(`revoked to ${MAX_RESIDUAL} wei on ${c.token} (reverts on zero approve)`)
  }

  const touches = body.some((f) => classify(f.target!, f.data, input.sender, input.permit2).kind !== KIND.NONE)
  if (!touches && !input.minOut?.length) {
    return { frames: [verifyFrame(input.account), ...body.map((f) => ({ ...f, flags: 0 }))], grants: [], notes }
  }

  body.push(
    sender(
      { to: input.seal, data: encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [input.minOut ?? []] }) },
      'seal.checkFrames',
      false,
    ),
  )
  return { frames: [verifyFrame(input.account), ...body], grants: [...grants.values()], notes }
}

export function specExample(p: { calls: Call[]; account?: AccountKind }): FrameSpec[] {
  const body = p.calls.map((call, n) => sender(call, `call ${n}`, n < p.calls.length - 1))
  return [verifyFrame(p.account), ...body]
}
