import type { Address, Hex } from 'viem'

export type Call = { to: Address; data: Hex; value?: bigint }

export type FrameSpec = {
  mode: 0 | 1 | 2
  flags: number
  target: Address | null
  value: bigint
  data: Hex
  label: string
}

export type Classified = {
  kind: number
  token: Address
  spender: Address
  id: bigint
  amount?: bigint
  on?: boolean
}

export type Quirk = { zeroFirst?: boolean; zeroReverts?: boolean; nft?: boolean }

export type MinOut = { token: Address; amount: bigint }

export type Verdict = { code: number; at: number; reason: string }
