import { encodeFunctionData, formatEther, maxUint256, parseAbi, parseEther, type Address } from 'viem'
import { compile, erc20Abi, frameOracle, prepare, specExample, tighten, type Call } from '../packages/core/src/index.js'
import { addr, hegota, keys, pub, send, table, wallet } from './lib.js'
import { setup } from './setup.js'

const routerAbi = parseAbi([
  'function swapExactIn(address,address,uint256,uint256,address) returns (uint256)',
  'function multicall(address target, bytes data) returns (bytes)',
])

const d = await setup()
const amount = parseEther('100')
const calls = (who: Address): Call[] => [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, maxUint256] }) },
  { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, amount, 0n, who] }) },
]
const allowance = (owner: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [owner, d.router] })
const usdc = (owner: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const gas = (r: { receipt?: { frameReceipts: { gasUsed: bigint }[] } }) => r.receipt?.frameReceipts.reduce((a, f) => a + f.gasUsed, 0n) ?? 0n

const A = d.victims.spec
const B = d.victims.zero

console.log(`\nA ${A}  sends EIP-8141 spec Example 2: atomic approve(router, max) + swap`)
const fa = specExample({ calls: calls(A) })
const ra = await send({ sender: A, signerKey: keys.spec, frames: fa })
table(fa, ra.receipt?.frameReceipts.map((f) => f.status))

console.log(`\nB ${B}  sends the same calls compiled by zeroallow`)
const prepared = await prepare(pub, { sender: B, seal: d.seal, calls: calls(B) })
const { frames: fb, notes } = compile(prepared)
for (const n of [...prepared.notes, ...notes]) console.log(`   note: ${n}`)
const rb = await send({ sender: B, signerKey: keys.zero, frames: fb })
table(fb, rb.receipt?.frameReceipts.map((f) => f.status))

const [aa, ab] = [await allowance(A), await allowance(B)]
console.log(`\nallowance left to router   A: ${aa === maxUint256 ? 'unlimited' : formatEther(aa)}   B: ${formatEther(ab)}`)
console.log(`gas used                   A: ${gas(ra)}   B: ${gas(rb)}   overhead: ${gas(rb) - gas(ra)}`)

console.log('\nrouter is later exploited: attacker calls multicall(usdc, transferFrom(victim, attacker, balance))')
const attacker = addr(keys.attacker)
const w = wallet(keys.attacker)
for (const [name, victim] of [['A', A], ['B', B]] as const) {
  const bal = await usdc(victim)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [victim, attacker, bal] })
  try {
    await pub.simulateContract({ account: attacker, address: d.router, abi: routerAbi, functionName: 'multicall', args: [d.usdc, data] })
  } catch (e) {
    const reason = (e as { cause?: { reason?: string } }).cause?.reason ?? 'reverted'
    console.log(`   ${name}: attack reverts ("${reason}"), balance stays ${formatEther(bal)} USDC`)
    continue
  }
  const hash = await w.writeContract({ address: d.router, abi: routerAbi, functionName: 'multicall', args: [d.usdc, data], gas: 200_000n })
  const r = await pub.waitForTransactionReceipt({ timeout: 600_000, hash })
  console.log(`   ${name}: drained ${formatEther(bal)} USDC  (${r.status})  tx ${hash}`)
}
console.log(`\nfinal USDC   A: ${formatEther(await usdc(A))}   B: ${formatEther(await usdc(B))}   attacker: ${formatEther(await usdc(attacker))}`)

console.log('\nin-transaction theft: a router that takes whatever it is allowed while doing the swap (GreedyRouter)')
const greedyAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])
const greedyCalls = (who: Address): Call[] => [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.greedy, maxUint256] }) },
  { to: d.greedy, data: encodeFunctionData({ abi: greedyAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, amount, 0n, who] }) },
]
const runs: [string, Address, `0x${string}`, 'spec' | 'bracket' | 'tight'][] = [
  ['A signs the request', d.victims.greedySpec, keys.greedySpec, 'spec'],
  ['B zeroallow bracket', d.victims.greedyBracket, keys.greedyBracket, 'bracket'],
  ['C bracket + --tighten', d.victims.greedyTight, keys.greedyTight, 'tight'],
]
for (const [label, who, key, how] of runs) {
  const before = await usdc(who)
  let frames
  if (how === 'spec') frames = specExample({ calls: greedyCalls(who) })
  else {
    const p = await prepare(pub, { sender: who, seal: d.seal, calls: greedyCalls(who) })
    const input = how === 'tight' ? await tighten(p, frameOracle(pub, { chainId: BigInt(hegota.id), signer: addr(key), key })) : p
    for (const n of [...p.notes, ...((input as { notes?: string[] }).notes ?? []).filter((x) => !p.notes.includes(x))]) console.log(`   ${label}: ${n}`)
    frames = compile(input).frames
  }
  const r = await send({ sender: who, signerKey: key, frames })
  console.log(`   ${label.padEnd(24)} paid ${formatEther(before - (await usdc(who))).padEnd(6)} USDC for a ${formatEther(amount)} USDC swap   tx ${r.hash}`)
}
