import { parseEther, zeroAddress, type Address } from 'viem'
import { addr, artifact, deploy, fund, keys, pub, wallet } from './lib.js'

export async function setup() {
  const me = addr(keys.deployer)
  const ops = await deploy('frameOps', 'FrameOps.yul', [], 'FrameOps')
  const seal = await deploy('seal', 'ZeroAllowSeal.sol', [ops, zeroAddress])
  const usdc = await deploy('usdc', 'Mocks.sol', ['USD Coin', 'USDC'], 'MockERC20')
  const weth = await deploy('weth', 'Mocks.sol', ['Wrapped Ether', 'WETH'], 'MockERC20')
  const router = await deploy('router', 'Mocks.sol', [], 'VulnerableRouter')
  const account = await deploy('account', 'ZeroAllowAccount.sol', [me, ops, seal, zeroAddress])

  const erc = artifact('Mocks.sol', 'MockERC20').abi
  const w = wallet(keys.deployer)
  const mint = async (token: Address, to: Address, amount: bigint) => {
    const bal = (await pub.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [to] })) as bigint
    if (bal >= amount) return
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: token, abi: erc, functionName: 'mint', args: [to, amount - bal] }) })
  }
  const victims = { spec: addr(keys.spec), zero: addr(keys.zero), account }
  await mint(usdc, router, parseEther('1000000'))
  await mint(weth, router, parseEther('1000000'))
  for (const v of Object.values(victims)) await mint(usdc, v, parseEther('1000'))
  for (const a of [account, victims.spec, victims.zero, addr(keys.attacker)]) await fund(a)
  return { ops, seal, usdc, weth, router, account, victims, erc }
}

if (import.meta.main) {
  const d = await setup()
  console.log(d)
}
