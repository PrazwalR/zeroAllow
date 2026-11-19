import { encodeFunctionData, formatEther, maxUint256, parseAbi, parseEther, type Address } from 'viem'
import { CANONICAL, PERMIT2, compile, erc20Abi, guard, routeDirect, specExample, v2RouterAbi, type Call } from '../packages/core/src/index.js'
import { addr, keys, pub, send, table, wallet } from './lib.js'
import { setup } from './setup.js'

const d = await setup()
const amount = parseEther('100')
const head = await pub.getBlock()
const deadline = head.timestamp + 3600n
const asked = (who: Address): Call[] => [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router2, maxUint256] }) },
  { to: d.router2, data: encodeFunctionData({ abi: v2RouterAbi, functionName: 'swapExactTokensForTokens', args: [amount, 1n, [d.usdc, d.weth], who, deadline] }) },
]
const usdc = (o: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
const weth = (o: Address) => pub.readContract({ address: d.weth, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
const allowance = (o: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [o, d.router2] })
const gas = (r: { receipt?: { frameReceipts: { gasUsed: bigint }[] } }) => r.receipt?.frameReceipts.reduce((a, f) => a + f.gasUsed, 0n) ?? 0n
console.log(`\nV2 router ${d.router2} asks for approve(router, max) + swapExactTokensForTokens(100 USDC -> WETH)`)

const A = d.victims.asked
console.log(`\nA ${A} signs what the dApp asked for (spec Example 2 shape)`)
const fa = specExample({ calls: asked(A) })
const ra = await send({ sender: A, signerKey: keys.asked, frames: fa })
table(fa, ra.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))

const D = d.victims.direct
console.log(`\nD ${D} sends the same request through zeroallow --strategy direct`)
const routed = await routeDirect(pub, { sender: D, seal: d.seal, permit2: PERMIT2, calls: asked(D) }, { swapper: d.swapper })
for (const n of routed.notes) console.log(`   note: ${n}`)
const { frames: fd } = compile(routed)
const rd = await send({ sender: D, signerKey: keys.direct, frames: fd })
table(fd, rd.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
console.log(`   tx ${rd.hash}`)

const C = d.account
console.log(`\nguarded account ${C}: same direct route`)
const rc = await routeDirect(pub, { sender: C, seal: d.seal, permit2: PERMIT2, calls: asked(C), account: 'zeroallow' }, { swapper: d.swapper })
const { frames: fc } = compile(rc)
console.log(`   guard: ${guard(fc, C, d.seal, PERMIT2).reason}`)
const rcs = await send({ sender: C, signerKey: keys.deployer, frames: fc })
table(fc, rcs.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))

console.log(`\nWETH received   A: ${formatEther(await weth(A))}   D: ${formatEther(await weth(D))}`)
console.log(`gas used        A: ${gas(ra)}   D: ${gas(rd)}   (direct ${gas(rd) < gas(ra) ? 'saves' : 'costs'} ${gas(ra) > gas(rd) ? gas(ra) - gas(rd) : gas(rd) - gas(ra)})`)
console.log(`allowance to router   A: ${(await allowance(A)) === maxUint256 ? 'unlimited' : formatEther(await allowance(A))}   D: ${formatEther(await allowance(D))}   guarded: ${formatEther(await allowance(C))}`)

console.log('\nrouter is later exploited: attacker calls multicall(usdc, transferFrom(victim, attacker, balance))')
const attacker = addr(keys.attacker)
const w = wallet(keys.attacker)
const routerAbi = parseAbi(['function multicall(address target, bytes data) returns (bytes)'])
for (const [name, victim] of [['A', A], ['D', D], ['guarded', C]] as const) {
  const bal = await usdc(victim)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [victim, attacker, bal] })
  try {
    await pub.simulateContract({ account: attacker, address: d.router2, abi: routerAbi, functionName: 'multicall', args: [d.usdc, data] })
  } catch {
    console.log(`   ${name}: attack reverts, keeps ${formatEther(bal)} USDC`)
    continue
  }
  const hash = await w.writeContract({ address: d.router2, abi: routerAbi, functionName: 'multicall', args: [d.usdc, data], gas: 200_000n })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`   ${name}: drained ${formatEther(bal)} USDC  tx ${hash}`)
}
console.log(`\ncanonical swapper ${CANONICAL.swapper}${CANONICAL.swapper === d.swapper ? '' : ` (demo deployed ${d.swapper})`}`)
