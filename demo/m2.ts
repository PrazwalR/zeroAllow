import { decodeErrorResult, encodeFunctionData, formatEther, maxUint256, parseAbi, parseEther } from 'viem'
import { CODE_NAME, accountAbi, compile, erc20Abi, guard, specExample, type Call } from '../packages/core/src/index.js'
import { keys, pub, send, table } from './lib.js'
import { setup } from './setup.js'

const routerAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])
const d = await setup()
const C = d.account
const amount = parseEther('10')
const calls: Call[] = [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, maxUint256] }) },
  { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, amount, 0n, C] }) },
]

console.log(`\nguarded account ${C}`)
console.log('\n1. spec example 1 from the guarded account (what a careless or compromised frontend would send)')
const bad = specExample({ account: 'zeroallow', calls })
const local = guard(bad, C, d.seal)
console.log(`   local pre-flight: ${local.reason} at frame ${local.at}`)
const r1 = await send({ sender: C, signerKey: keys.deployer, frames: bad })
const err = r1.sim.violation ?? r1.sim.executionError ?? ''
const m = err.match(/0x[0-9a-fA-F]{8,}/)
let decoded = ''
if (m) {
  try {
    const e = decodeErrorResult({ abi: accountAbi, data: m[0] as `0x${string}` })
    decoded = `${e.errorName}(${e.args?.map(String).join(', ')}) = ${CODE_NAME[Number(e.args?.[0])]}`
  } catch {}
}
console.log(`   chain simulate: valid=${r1.sim.valid}  ${decoded || err}`)
console.log(`   broadcast: ${r1.hash ? r1.hash : 'never sent, the account refuses to APPROVE it'}`)

console.log('\n2. the same calls compiled by zeroallow')
const { frames } = compile({ sender: C, seal: d.seal, account: 'zeroallow', calls })
const r2 = await send({ sender: C, signerKey: keys.deployer, frames })
console.log(`   chain simulate: valid=${r2.sim.valid}`)
table(frames, r2.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
const left = await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [C, d.router] })
console.log(`   allowance left to router: ${formatEther(left)}   tx ${r2.hash}`)
