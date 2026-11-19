import { decodeErrorResult, encodeFunctionData, formatEther, maxUint256, parseAbi, parseEther, type Hex } from 'viem'
import {
  ATOMIC,
  CODE_NAME,
  MODE,
  PERMIT2,
  VERIFY_LIMITS,
  accountAbi,
  compile,
  erc20Abi,
  guard,
  permit2Abi,
  sealAbi,
  specExample,
  verifyFrame,
  type Call,
  type FrameSpec,
} from '../packages/core/src/index.js'
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
console.log('\n1. spec Example 2 (atomic approve + swap) from the guarded account, as a careless or compromised frontend would send it')
const bad = specExample({ account: 'zeroallow', calls })
const local = guard(bad, C, d.seal, PERMIT2)
console.log(`   local pre-flight: ${local.reason} at frame ${local.at}`)
const r1 = await send({ sender: C, signerKey: keys.deployer, frames: bad })
const err = r1.sim.violation ?? r1.sim.executionError ?? ''
const m = err.match(/0x[0-9a-fA-F]{8,}/)
let decoded = ''
if (m) {
  try {
    const e = decodeErrorResult({ abi: accountAbi, data: m[0] as Hex })
    decoded = `${e.errorName}(${e.args?.map(String).join(', ')}) = ${CODE_NAME[Number(e.args?.[0])]}`
  } catch {}
}
console.log(`   chain simulate: valid=${r1.sim.valid}  ${decoded || err}`)
console.log(`   broadcast: ${r1.hash ? r1.hash : 'never sent, the account refuses to APPROVE it'}`)

console.log('\n2. the same calls compiled by zeroallow')
const { frames } = compile({ sender: C, seal: d.seal, permit2: PERMIT2, account: 'zeroallow', calls })
const r2 = await send({ sender: C, signerKey: keys.deployer, frames })
console.log(`   chain simulate: valid=${r2.sim.valid}`)
table(frames, r2.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
const left = await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [C, d.router] })
console.log(`   allowance left to router: ${formatEther(left)}   tx ${r2.hash}`)

console.log(`\n3. VERIFY gas at MAX_FRAMES (frame limit ${VERIFY_LIMITS.execution} = 100k MAX_VERIFY_GAS - 2800 signature)`)
const s = (to: `0x${string}`, data: Hex): FrameSpec => ({ mode: MODE.SENDER, flags: ATOMIC, target: to, value: 0n, data, label: '' })
const seal: FrameSpec = { mode: MODE.SENDER, flags: 0, target: d.seal, value: 0n, data: encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [[]] }), label: '' }
const shapes: [string, FrameSpec][] = [
  ['62 erc20 revokes', s(d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, 0n] }))],
  ['62 permit2 approves (slowest path)', s(PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [d.usdc, d.router, 0n, 0] }))],
]
for (const [name, f] of shapes) {
  const fs = [verifyFrame('zeroallow'), ...Array.from({ length: 62 }, () => f), seal]
  const r = await send({ sender: C, signerKey: keys.deployer, frames: fs, dryRun: true })
  console.log(`   ${name.padEnd(36)} valid=${r.sim.valid}  VERIFY gas=${r.sim.frames?.[0]?.gasUsed}  execution=${r.sim.executionStatus}  ${r.sim.violation ?? ''}`)
}

console.log(`\n4. any 8141 account: one STATICCALL to ZeroAllowPolicy ${d.policy} during VERIFY`)
const P = d.policyAccount
const pverify: FrameSpec = { ...verifyFrame(), data: encodeFunctionData({ abi: parseAbi(['function validate()']), functionName: 'validate' }) }
const pcalls: Call[] = [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, maxUint256] }) },
  { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, amount, 0n, P] }) },
]
const pbad = [pverify, ...specExample({ calls: pcalls }).slice(1)]
const rp1 = await send({ sender: P, signerKey: keys.deployer, frames: pbad })
console.log(`   spec Example 2 from PolicyAccount ${P}: valid=${rp1.sim.valid} ${rp1.sim.violation ?? ''}`)
const pgood = compile({ sender: P, seal: d.seal, permit2: PERMIT2, calls: pcalls }).frames
pgood[0] = pverify
const rp2 = await send({ sender: P, signerKey: keys.deployer, frames: pgood })
console.log(`   compiled bracket: valid=${rp2.sim.valid}, VERIFY gas ${rp2.receipt?.frameReceipts[0].gasUsed}, allowance left ${formatEther(await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [P, d.router] }))}   tx ${rp2.hash}`)
