import { encodeFunctionData, parseAbi, parseEther, zeroAddress, type Address } from 'viem'
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

  const erc = artifact('Mocks.sol', 'MockERC20').abi
  const w = wallet(keys.deployer)
  const mint = async (token: Address, to: Address, amount: bigint) => {
    const bal = (await pub.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [to] })) as bigint
    if (bal >= amount) return
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: token, abi: erc, functionName: 'mint', args: [to, amount - bal] }) })
  }
  const factoryAbi = parseAbi(['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)'])
  let pair = (await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [usdc, weth] })) as Address
  if (pair === zeroAddress) {
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: factory, abi: factoryAbi, functionName: 'createPair', args: [usdc, weth] }) })
    pair = (await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [usdc, weth] })) as Address
  }
  const [r0] = (await pub.readContract({ address: pair, abi: parseAbi(['function getReserves() view returns (uint112,uint112,uint32)']), functionName: 'getReserves' })) as readonly [bigint, bigint, number]
  if (r0 === 0n) {
    await mint(usdc, pair, parseEther('2000000'))
    await mint(weth, pair, parseEther('1000'))
    await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: pair, data: encodeFunctionData({ abi: parseAbi(['function sync()']), functionName: 'sync' }) }) })
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
  }
  await mint(usdc, router, parseEther('1000000'))
  await mint(weth, router, parseEther('1000000'))
  for (const v of Object.values(victims)) await mint(usdc, v, parseEther('1000'))
  for (const a of [...Object.values(victims), addr(keys.attacker)]) await fund(a)
  return { ops, seal, usdc, weth, router, nft, lending, executor, account, swapper, policy, policyAccount, factory, router2, pair, victims, erc }
}

if (import.meta.main) {
  const d = await setup()
  console.log(d)
}
