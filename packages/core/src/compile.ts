import { encodeFunctionData, isAddressEqual, zeroAddress, type Address } from 'viem'
import {
  ATOMIC,
  KIND,
  MAX_RESIDUAL,
  MODE,
  SCOPE_EXECUTION_AND_PAYMENT,
  SEL,
  accountAbi,
  delegationAbi,
  e6909Abi,
  erc20Abi,
  nftAbi,
  permit2Abi,
  sealAbi,
} from './constants.js'
import { classify, isGrant } from './registry.js'
import type { Call, Classified, FrameSpec, MinOut, Quirk, SealKey } from './types.js'

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

export type Compiled = { frames: FrameSpec[]; grants: Classified[]; keys: SealKey[]; notes: string[] }
export type CompiledCalls = { calls: Call[]; grants: Classified[]; keys: SealKey[]; notes: string[] }

type Step = Call & { label: string }

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

const frame = (s: Step, atomic: boolean): FrameSpec => ({
  mode: MODE.SENDER,
  flags: atomic ? ATOMIC : 0,
  target: s.to,
  value: s.value ?? 0n,
  data: s.data,
  label: s.label,
})

const keyOf = (c: Classified, nft: boolean) => {
  const family = c.kind === KIND.APPROVE && !nft ? KIND.ERC20 : c.kind
  const id = family === KIND.APPROVE || family === KIND.E6909 ? c.id : 0n
  return `${family}:${lc(c.token)}:${lc(c.spender)}:${id}`
}

const erc20Revoke = (token: Address, spender: Address, residual: bigint): Call => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, residual] }),
})

export function revokeFor(c: Classified, quirk: Quirk, owner: Address, permit2?: Address): Call {
  const residual = quirk.zeroReverts ? MAX_RESIDUAL : 0n
  const to = c.token
  switch (c.kind) {
    case KIND.APPROVE:
      return quirk.nft
        ? { to, data: encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [zeroAddress, c.id] }) }
        : erc20Revoke(to, c.spender, residual)
    case KIND.ERC20:
      return erc20Revoke(to, c.spender, residual)
    case KIND.OPERATOR:
      return { to, data: encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [c.spender, false] }) }
    case KIND.E6909:
      return { to, data: encodeFunctionData({ abi: e6909Abi, functionName: 'approve', args: [c.spender, c.id, 0n] }) }
    case KIND.E6909_OPERATOR:
      return { to, data: encodeFunctionData({ abi: e6909Abi, functionName: 'setOperator', args: [c.spender, false] }) }
    case KIND.DELEGATION:
      return { to, data: encodeFunctionData({ abi: delegationAbi, functionName: 'approveDelegation', args: [c.spender, 0n] }) }
    case KIND.COMET:
      return { to, data: encodeFunctionData({ abi: delegationAbi, functionName: 'allow', args: [c.spender, false] }) }
    case KIND.MORPHO:
      return { to, data: encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [c.spender, false] }) }
    case KIND.RELAYER:
      return { to, data: encodeFunctionData({ abi: delegationAbi, functionName: 'setRelayerApproval', args: [owner, c.spender, false] }) }
    case KIND.ERC777:
      return { to, data: encodeFunctionData({ abi: delegationAbi, functionName: 'revokeOperator', args: [c.spender] }) }
    case KIND.PERMIT2:
      if (!permit2) throw new Error('permit2 address required')
      return { to: permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [c.token, c.spender, 0n, 0] }) }
    default:
      throw new Error(`no revoke for kind ${c.kind}`)
  }
}

export function sealKeys(steps: Call[], sender: Address, permit2?: Address): SealKey[] {
  const out = new Map<string, SealKey>()
  for (const s of steps) {
    const c = classify(s.to, s.data, sender, permit2)
    if (c.kind === KIND.NONE || c.kind === KIND.MALFORMED) continue
    const k: SealKey = { kind: c.kind, token: c.token, spender: c.spender, id: c.kind === KIND.APPROVE || c.kind === KIND.E6909 ? c.id : 0n }
    out.set(`${k.kind}:${lc(k.token)}:${lc(k.spender)}:${k.id}`, k)
  }
  return [...out.values()]
}

function bracket(input: CompileInput) {
  const quirks = input.quirks ?? {}
  const current = input.current ?? {}
  const notes: string[] = []
  const body: Step[] = []
  const grants = new Map<string, Classified>()

  if (input.minOut?.length) {
    body.push({
      to: input.seal,
      data: encodeFunctionData({ abi: sealAbi, functionName: 'snapshot', args: [input.minOut.map((m) => m.token)] }),
      label: 'seal.snapshot',
    })
  }

  input.calls.forEach((call, n) => {
    if (isAddressEqual(call.to, input.sender)) throw new Error(`call ${n} targets the sender; the guard refuses self-calls`)
    const c = classify(call.to, call.data, input.sender, input.permit2)
    if (c.kind === KIND.MALFORMED) throw new Error(`call ${n} is a grant zeroallow cannot parse (e.g. Permit2 batch permit)`)
    const quirk = quirks[lc(c.token)] ?? {}
    if (c.kind === KIND.APPROVE && !quirk.nft && (c.amount ?? 0n) > 0n && call.data.slice(0, 10) === SEL.approve) {
      const existing = current[pair(c.token, c.spender)] ?? 0n
      if ((quirk.zeroFirst || existing > 0n) && !quirk.zeroReverts) {
        body.push({ ...erc20Revoke(c.token, c.spender, 0n), label: 'zero-first' })
        notes.push(`zero-first before approve on ${c.token}`)
      }
    }
    body.push({ ...call, label: c.kind === KIND.NONE ? `call ${n}` : isGrant(c) ? `grant ${n}` : `revoke ${n}` })
    if (isGrant(c) || (c.kind === KIND.APPROVE && quirk.nft)) grants.set(keyOf(c, !!quirk.nft), c)
  })

  for (const c of grants.values()) {
    const quirk = quirks[lc(c.token)] ?? {}
    body.push({ ...revokeFor(c, quirk, input.sender, input.permit2), label: 'revoke' })
    if (quirk.zeroReverts) notes.push(`revoked to ${MAX_RESIDUAL} wei on ${c.token} (reverts on zero approve)`)
  }

  const keys = sealKeys(body, input.sender, input.permit2)
  const sealed = keys.length > 0 || !!input.minOut?.length
  return { body, grants: [...grants.values()], keys, notes, sealed }
}

const keyId = (k: SealKey) => `${k.kind}:${lc(k.token)}:${lc(k.spender)}:${k.id}`

export function compile(input: CompileInput & { keys?: SealKey[] }): Compiled {
  const { body, grants, keys: derived, notes, sealed } = bracket(input)
  const seen = new Set(derived.map(keyId))
  const extra = (input.keys ?? []).filter((k) => !seen.has(keyId(k)))
  if (!sealed && !extra.length) {
    return { frames: [verifyFrame(input.account), ...body.map((s, i) => frame(s, i < body.length - 1))], grants, keys: derived, notes }
  }
  const steps: Step[] = [...body]
  if (extra.length) {
    steps.push({ to: input.seal, data: encodeFunctionData({ abi: sealAbi, functionName: 'check', args: [extra, []] }), label: 'seal.check' })
  }
  const closer: Step = {
    to: input.seal,
    data: encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [input.minOut ?? []] }),
    label: 'seal.checkFrames',
  }
  return { frames: [verifyFrame(input.account), ...steps.map((s) => frame(s, true)), frame(closer, false)], grants, keys: [...derived, ...extra], notes }
}

export function compileCalls(input: Omit<CompileInput, 'account'> & { keys?: SealKey[] }): CompiledCalls {
  const b = bracket(input)
  const { body, grants, notes } = b
  const seen = new Set(b.keys.map(keyId))
  const keys = [...b.keys, ...(input.keys ?? []).filter((k) => !seen.has(keyId(k)))]
  const sealed = b.sealed || keys.length > 0
  const calls: Call[] = body.map(({ label: _, ...c }) => c)
  if (sealed) {
    calls.push({
      to: input.seal,
      data: encodeFunctionData({ abi: sealAbi, functionName: 'check', args: [keys, input.minOut ?? []] }),
    })
  }
  return { calls, grants, keys, notes }
}

export function specExample(p: { calls: Call[]; account?: AccountKind }): FrameSpec[] {
  const body = p.calls.map((call, n) => frame({ ...call, label: `call ${n}` }, n < p.calls.length - 1))
  return [verifyFrame(p.account), ...body]
}
