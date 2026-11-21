import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, parseEther, zeroAddress, type Address } from 'viem'
import { PERMIT2 } from '../packages/core/src/index.js'
import { addr, artifact, deploy, fund, keys, pub, wallet } from './lib.js'

export async function setup() {
  const me = addr(keys.deployer)
  const ops = await deploy('frameOps', 'FrameOps.yul', [], 'FrameOps')
  const seal = await deploy('seal', 'ZeroAllowSeal.sol', [ops, PERMIT2])
  const usdc = await deploy('usdc', 'Mocks.sol', ['USD Coin', 'USDC'], 'MockERC20')
  const weth = await deploy('weth', 'Mocks.sol', ['Wrapped Ether', 'WETH'], 'MockERC20')
  const router = await deploy('router', 'Mocks.sol', [], 'VulnerableRouter')
  const nft = await deploy('nft', 'Mocks.sol', [], 'MockNFT')
  const lending = await deploy('lending', 'Mocks.sol', [], 'MockDelegations')
  const executor = await deploy('executor', 'Mocks.sol', [], 'BatchExecutor')
  const account = await deploy('account', 'ZeroAllowAccount.sol', [me, ops, seal, PERMIT2])
  const swapper = await deploy('swapper', 'ZeroAllowSwapper.sol', [])
  const policy = await deploy('policy', 'ZeroAllowPolicy.sol', [ops, seal, PERMIT2])
  const policyAccount = await deploy('policyAccount', 'Mocks.sol', [me, ops, policy], 'PolicyAccount')
  const factory = await deploy('v2Factory', 'Mocks.sol', [], 'MockV2Factory')
  const router2 = await deploy('v2Router', 'Mocks.sol', [factory], 'MockV2Router')
  const factory3 = await deploy('v3Factory', 'Mocks.sol', [], 'MockV3Factory')
  const router3 = await deploy('v3Router', 'Mocks.sol', [factory3, factory], 'MockV3Router')
  const poolManager = await deploy('poolManager', 'Mocks.sol', [], 'MockPoolManager')
  const ur = await deploy('universalRouter', 'Mocks.sol', [PERMIT2, factory, factory3, poolManager], 'MockUniversalRouter')
  const greedy = await deploy('greedyRouter', 'Mocks.sol', [], 'GreedyRouter')
  const dispatch = await deploy('dispatch7579', 'Mocks.sol', [me, ops, policy], 'Dispatch7579Account')
  const coinbase = await deploy('coinbaseLike', 'Mocks.sol', [me, ops, policy], 'CoinbaseLikeAccount')
  const lightaccount = await deploy('lightLike', 'Mocks.sol', [me, ops, policy], 'LightLikeAccount')
  const hook = await deploy('hook', 'ZeroAllowHook.sol', [seal, PERMIT2])
  const kernel = await deploy('kernelLike', 'Mocks.sol', [me, me, hook, false], 'MockKernelLike')

  const erc = artifact('Mocks.sol', 'MockERC20').abi
  const w = wallet(keys.deployer)
  const mint = async (token: Address, to: Address, amount: bigint) => {
    const bal = (await pub.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [to] })) as bigint
    if (bal >= amount) return
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.writeContract({ address: token, abi: erc, functionName: 'mint', args: [to, amount - bal] }) })
  }
  const factoryAbi = parseAbi(['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)'])
  let pair = (await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [usdc, weth] })) as Address
  if (pair === zeroAddress) {
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.writeContract({ address: factory, abi: factoryAbi, functionName: 'createPair', args: [usdc, weth] }) })
    pair = (await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [usdc, weth] })) as Address
  }
  const [r0] = (await pub.readContract({ address: pair, abi: parseAbi(['function getReserves() view returns (uint112,uint112,uint32)']), functionName: 'getReserves' })) as readonly [bigint, bigint, number]
  if (r0 === 0n) {
    await mint(usdc, pair, parseEther('2000000'))
    await mint(weth, pair, parseEther('1000'))
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.sendTransaction({ to: pair, data: encodeFunctionData({ abi: parseAbi(['function sync()']), functionName: 'sync' }) }) })
  }
  const f3 = parseAbi(['function createPool(address,address,uint24) returns (address)', 'function getPool(address,address,uint24) view returns (address)'])
  let pool3 = (await pub.readContract({ address: factory3, abi: f3, functionName: 'getPool', args: [usdc, weth, 3000] })) as Address
  if (pool3 === zeroAddress) {
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.writeContract({ address: factory3, abi: f3, functionName: 'createPool', args: [usdc, weth, 3000] }) })
    pool3 = (await pub.readContract({ address: factory3, abi: f3, functionName: 'getPool', args: [usdc, weth, 3000] })) as Address
  }
  await mint(usdc, pool3, parseEther('2000000'))
  await mint(weth, pool3, parseEther('1000'))
  const [c0, c1] = BigInt(usdc) < BigInt(weth) ? [usdc, weth] : [weth, usdc]
  const poolKey = { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: zeroAddress } as const
  const pmAbi = parseAbi([
    'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'function initialize(PoolKey key, uint256 r0, uint256 r1)',
    'function reserves(bytes32 id, uint256 i) view returns (uint256)',
  ])
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters('(address, address, uint24, int24, address)'), [[c0, c1, 3000, 60, zeroAddress]]))
  if ((await pub.readContract({ address: poolManager, abi: pmAbi, functionName: 'reserves', args: [poolId, 0n] })) === 0n) {
    await mint(usdc, poolManager, parseEther('2000000'))
    await mint(weth, poolManager, parseEther('1000'))
    const [r0, r1] = c0 === usdc ? [parseEther('2000000'), parseEther('1000')] : [parseEther('1000'), parseEther('2000000')]
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.writeContract({ address: poolManager, abi: pmAbi, functionName: 'initialize', args: [poolKey, r0, r1] }) })
  }
  await mint(usdc, greedy, parseEther('1000000'))
  await mint(weth, greedy, parseEther('1000'))
  const nativeKey = { currency0: zeroAddress, currency1: usdc, fee: 3000, tickSpacing: 60, hooks: zeroAddress } as const
  const nativeId = keccak256(encodeAbiParameters(parseAbiParameters('(address, address, uint24, int24, address)'), [[zeroAddress, usdc, 3000, 60, zeroAddress]]))
  if ((await pub.readContract({ address: poolManager, abi: pmAbi, functionName: 'reserves', args: [nativeId, 0n] })) === 0n) {
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.sendTransaction({ to: poolManager, value: parseEther('0.05') }) })
    await mint(usdc, poolManager, (await pub.readContract({ address: usdc, abi: erc, functionName: 'balanceOf', args: [poolManager] }) as bigint) + parseEther('100'))
    await pub.waitForTransactionReceipt({ timeout: 600_000, hash: await w.writeContract({ address: poolManager, abi: pmAbi, functionName: 'initialize', args: [nativeKey, parseEther('0.05'), parseEther('100')] }) })
  }
  const victims = {
    spec: addr(keys.spec),
    zero: addr(keys.zero),
    account,
    hoarder: addr(keys.hoarder),
    today: addr(keys.today),
    asked: addr(keys.asked),
    direct: addr(keys.direct),
    policyAccount,
    dispatch,
    coinbase,
    lightaccount,
    kernel,
    greedySpec: addr(keys.greedySpec),
    greedyBracket: addr(keys.greedyBracket),
    greedyTight: addr(keys.greedyTight),
  }
  await mint(usdc, router, parseEther('1000000'))
  await mint(weth, router, parseEther('1000000'))
  for (const v of Object.values(victims)) await mint(usdc, v, parseEther('1000'))
  for (const a of [...Object.values(victims), addr(keys.attacker)]) await fund(a)
  const topUp = (token: Address, to: Address, amount = parseEther('1000')) => mint(token, to, amount)
  return {
    ops,
    seal,
    usdc,
    weth,
    router,
    nft,
    lending,
    executor,
    account,
    swapper,
    policy,
    policyAccount,
    dispatch,
    coinbase,
    lightaccount,
    hook,
    kernel,
    nativeKey,
    factory,
    router2,
    pair,
    factory3,
    router3,
    pool3,
    ur,
    poolManager,
    poolKey,
    greedy,
    victims,
    erc,
    topUp,
  }
}

if (import.meta.main) {
  const d = await setup()
  console.log(d)
}
