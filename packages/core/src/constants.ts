import { parseAbi } from 'viem'

export const MODE = { DEFAULT: 0, VERIFY: 1, SENDER: 2 } as const
export const ATOMIC = 4
export const SCOPE_EXECUTION_AND_PAYMENT = 3
export const HEAD_BYTES = 224
export const MAX_RESIDUAL = 1n
export const UNLIMITED = 1n << 255n

export const KIND = {
  NONE: 0,
  APPROVE: 1,
  ERC20: 2,
  OPERATOR: 3,
  PERMIT2: 4,
  E6909: 5,
  E6909_OPERATOR: 6,
  MALFORMED: 7,
} as const

export const CODE = {
  OK: 0,
  SELF_CALL: 1,
  UNPARSEABLE: 2,
  OUTSIDE_BATCH: 3,
  UNSEALED: 4,
} as const

export const CODE_NAME: Record<number, string> = {
  0: 'ok',
  1: 'self-call',
  2: 'unparseable grant',
  3: 'grant outside atomic batch',
  4: 'batch not closed by ZeroAllowSeal.checkFrames',
}

export const SEL = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  increaseApproval: '0xd73dd623',
  approveAndCall: '0x3177029f',
  approveAndCallData: '0xcae9ca51',
  permit2612: '0xd505accf',
  permitDai: '0x8fcbaf0c',
  setApprovalForAll: '0xa22cb465',
  approve6909: '0x426a8493',
  setOperator: '0x558a7297',
  permit2Approve: '0x87517c45',
  permit2PermitSingle: '0x2b67b570',
  permit2PermitBatch: '0x2a2d80d1',
  checkFrames: '0x1135b925',
} as const

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function supportsInterface(bytes4 id) view returns (bool)',
])

export const nftAbi = parseAbi([
  'function approve(address to, uint256 id)',
  'function setApprovalForAll(address operator, bool approved)',
])

export const e6909Abi = parseAbi([
  'function approve(address spender, uint256 id, uint256 amount) returns (bool)',
  'function setOperator(address operator, bool approved) returns (bool)',
])

export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

export const sealAbi = parseAbi([
  'struct Out { address token; uint256 amount; }',
  'struct Key { uint8 kind; address token; address spender; uint256 id; }',
  'function snapshot(address[] tokens)',
  'function checkFrames(Out[] outs)',
  'function check(Key[] keys, Out[] outs)',
  'function isClosed(Key k, address owner) view returns (bool)',
  'error Open(uint8 kind, address token, address spender, uint256 id)',
  'error Unparseable(uint256 frame)',
  'error NotSender()',
  'error NoSnapshot(address token)',
  'error Short(address token, uint256 got, uint256 want)',
])

export const accountAbi = parseAbi([
  'function validate(uint256 sigIndex)',
  'function owner() view returns (address)',
  'error Rejected(uint256 code, uint256 frame)',
  'error BadSignature()',
])
