import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { KIND, SEL } from './constants.js'
import type { Classified } from './types.js'

const word = (data: Hex, k: number): bigint => {
  const start = 10 + 64 * k
  return BigInt('0x' + data.slice(start, start + 64).padEnd(64, '0'))
}

const addr = (data: Hex, k: number): Address => getAddress('0x' + (word(data, k) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0'))

const same = (a: Address, b: Address) => isAddressEqual(a, b)

export function classify(target: Address, data: Hex, owner: Address, permit2?: Address): Classified {
  const len = (data.length - 2) / 2
  const none: Classified = { kind: KIND.NONE, token: target, spender: zeroAddress, id: 0n }
  if (len < 4) return none
  const s = data.slice(0, 10).toLowerCase()
  let need = 0
  let c: Classified = none
  if (s === SEL.approve) {
    need = 2
    const spender = addr(data, 0)
    c = { kind: same(spender, zeroAddress) ? KIND.NONE : KIND.APPROVE, token: target, spender, id: word(data, 1), amount: word(data, 1) }
  } else if (s === SEL.increaseAllowance || s === SEL.increaseApproval || s === SEL.approveAndCall || s === SEL.approveAndCallData) {
    need = 2
    c = { kind: KIND.ERC20, token: target, spender: addr(data, 0), id: 0n, amount: word(data, 1) }
  } else if (s === SEL.permit2612 || s === SEL.permitDai) {
    need = 2
    if (same(addr(data, 0), owner)) c = { kind: KIND.ERC20, token: target, spender: addr(data, 1), id: 0n }
  } else if (s === SEL.setApprovalForAll) {
    need = 2
    c = { kind: KIND.OPERATOR, token: target, spender: addr(data, 0), id: 0n, on: word(data, 1) !== 0n }
  } else if (s === SEL.approve6909) {
    need = 3
    c = { kind: KIND.E6909, token: target, spender: addr(data, 0), id: word(data, 1), amount: word(data, 2) }
  } else if (s === SEL.setOperator) {
    need = 2
    c = { kind: KIND.E6909_OPERATOR, token: target, spender: addr(data, 0), id: 0n, on: word(data, 1) !== 0n }
  } else if (s === SEL.approveDelegation) {
    need = 2
    c = { kind: KIND.DELEGATION, token: target, spender: addr(data, 0), id: 0n, amount: word(data, 1) }
  } else if (s === SEL.allow) {
    need = 2
    c = { kind: KIND.COMET, token: target, spender: addr(data, 0), id: 0n, on: word(data, 1) !== 0n }
  } else if (s === SEL.setAuthorization) {
    need = 2
    c = { kind: KIND.MORPHO, token: target, spender: addr(data, 0), id: 0n, on: word(data, 1) !== 0n }
  } else if (s === SEL.setRelayerApproval) {
    need = 3
    if (same(addr(data, 0), owner)) c = { kind: KIND.RELAYER, token: target, spender: addr(data, 1), id: 0n, on: word(data, 2) !== 0n }
  } else if (s === SEL.authorizeOperator) {
    need = 1
    c = { kind: KIND.ERC777, token: target, spender: addr(data, 0), id: 0n, on: true }
  } else if (permit2 && !same(permit2, zeroAddress) && same(target, permit2)) {
    if (s === SEL.permit2Approve) {
      need = 4
      c = { kind: KIND.PERMIT2, token: addr(data, 0), spender: addr(data, 1), id: 0n, amount: word(data, 2) }
    } else if (s === SEL.permit2PermitSingle) {
      need = 8
      if (same(addr(data, 0), owner)) c = { kind: KIND.PERMIT2, token: addr(data, 1), spender: addr(data, 5), id: 0n, amount: word(data, 2) }
    } else if (s === SEL.permit2PermitBatch) {
      need = 3
      if (same(addr(data, 0), owner)) c = { ...none, kind: KIND.MALFORMED }
    }
  }
  if (need && len < 4 + 32 * need) return { ...c, kind: KIND.MALFORMED }
  return c
}

export function isGrant(c: Classified): boolean {
  switch (c.kind) {
    case KIND.APPROVE:
    case KIND.E6909:
    case KIND.PERMIT2:
    case KIND.DELEGATION:
      return c.amount === undefined || c.amount > 0n
    case KIND.ERC20:
    case KIND.ERC777:
      return true
    case KIND.OPERATOR:
    case KIND.E6909_OPERATOR:
    case KIND.COMET:
    case KIND.MORPHO:
    case KIND.RELAYER:
      return c.on === true
    default:
      return false
  }
}
