import { parseAbi } from 'viem'

export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const CANONICAL = {
  frameOps: '0x22679371820E523224cfBA585535EDA1d26fE6C1',
  seal: '0xfC483f5Bade6Da527BF04CAC05195BA04CAf5560',
  swapper: '0x19265c4a23d0F4c1A5eB1aC7fE9B935cF18FfAe9',
  policy: '0xbcF16943adAf0007854d245073775144E2e17dA7',
} as const

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
  DELEGATION: 7,
  COMET: 8,
  MORPHO: 9,
  RELAYER: 10,
  ERC777: 11,
  MALFORMED: 255,
} as const

export const KIND_NAME: Record<number, string> = {
  1: 'approve',
  2: 'erc20 allowance',
  3: 'operator',
  4: 'permit2',
  5: 'erc6909 allowance',
  6: 'erc6909 operator',
  7: 'credit delegation',
  8: 'comet manager',
  9: 'morpho authorization',
  10: 'balancer relayer',
  11: 'erc777 operator',
}

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
  approveDelegation: '0xc04a8a10',
  allow: '0x110496e5',
  setAuthorization: '0xeecea000',
  setRelayerApproval: '0xfa6e671d',
  authorizeOperator: '0x959b8c3f',
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
  'function transfer(address to, uint256 amount) returns (bool)',
  'function supportsInterface(bytes4 id) view returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

export const nftAbi = parseAbi([
  'function approve(address to, uint256 id)',
  'function setApprovalForAll(address operator, bool approved)',
  'function getApproved(uint256 id) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function ownerOf(uint256 id) view returns (address)',
])

export const e6909Abi = parseAbi([
  'function approve(address spender, uint256 id, uint256 amount) returns (bool)',
  'function setOperator(address operator, bool approved) returns (bool)',
  'function allowance(address owner, address spender, uint256 id) view returns (uint256)',
  'function isOperator(address owner, address spender) view returns (bool)',
])

export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

export const delegationAbi = parseAbi([
  'function approveDelegation(address delegatee, uint256 amount)',
  'function borrowAllowance(address fromUser, address toUser) view returns (uint256)',
  'function allow(address manager, bool isAllowed)',
  'function isAllowed(address owner, address manager) view returns (bool)',
  'function setAuthorization(address authorized, bool newIsAuthorized)',
  'function isAuthorized(address authorizer, address authorized) view returns (bool)',
  'function setRelayerApproval(address sender, address relayer, bool approved)',
  'function hasApprovedRelayer(address user, address relayer) view returns (bool)',
  'function authorizeOperator(address operator)',
  'function revokeOperator(address operator)',
  'function isOperatorFor(address operator, address tokenHolder) view returns (bool)',
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

export const policyAbi = parseAbi(['function check() view returns (uint256 code, uint256 frame)', 'function enforce() view', 'error Rejected(uint256 code, uint256 frame)'])

export const accountAbi = parseAbi([
  'function validate(uint256 sigIndex)',
  'function owner() view returns (address)',
  'error Rejected(uint256 code, uint256 frame)',
  'error BadSignature()',
])
