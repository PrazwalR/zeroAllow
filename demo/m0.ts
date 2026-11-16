import { encodeFunctionData } from 'viem'
import { ATOMIC, MODE, erc20Abi, sealAbi, verifyFrame, type FrameSpec } from '../packages/core/src/index.js'
import { keys, pub, send, table } from './lib.js'
import { setup } from './setup.js'

const d = await setup()
const s = (target: `0x${string}`, data: `0x${string}`, atomic: boolean, label: string): FrameSpec => ({
  mode: MODE.SENDER,
  flags: atomic ? ATOMIC : 0,
  target,
  value: 0n,
  data,
  label,
})

console.log('\nprobe 1: custom-code sender, verbatim opcodes, APPROVE through DELEGATECALL')
const p1: FrameSpec[] = [
  verifyFrame('zeroallow'),
  s(d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [d.account] }), false, 'usdc.balanceOf'),
]
const r1 = await send({ sender: d.account, signerKey: keys.deployer, frames: p1 })
console.log(`   simulate valid=${r1.sim.valid} shape=${r1.sim.prefixShape} violation=${r1.sim.violation} gas=${r1.sim.frames?.map((f) => f.gasUsed)}`)
if (r1.receipt) table(p1, r1.receipt.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))

console.log('\nprobe 2: closing seal fails, whole batch must roll back')
const p2: FrameSpec[] = [
  verifyFrame('zeroallow'),
  s(d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, 5n] }), true, 'approve(router,5)'),
  s(d.seal, encodeFunctionData({ abi: sealAbi, functionName: 'checkFrames', args: [[]] }), false, 'seal.checkFrames'),
]
const r2 = await send({ sender: d.account, signerKey: keys.deployer, frames: p2 })
console.log(`   simulate valid=${r2.sim.valid} execution=${r2.sim.executionStatus} frames=${r2.sim.frames?.map((f) => f.succeeded)}`)
if (r2.receipt) table(p2, r2.receipt.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
const left = await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [d.account, d.router] })
console.log(`   allowance(account, router) after = ${left}  ${left === 0n ? '(rolled back)' : '(NOT rolled back)'}`)
