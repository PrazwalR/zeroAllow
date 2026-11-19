import { BaseError, decodeErrorResult, encodeFunctionData, formatEther, maxUint256, parseAbi, parseEther, type Address, type Hex } from 'viem'
import {
  KIND,
  PERMIT2,
  compile,
  compileCalls,
  delegationAbi,
  erc20Abi,
  nftAbi,
  permit2Abi,
  revokeCalls,
  revokeKeys,
  scan,
  sealAbi,
  type Call,
  type Finding,
} from '../packages/core/src/index.js'
import { hegota, keys, pub, send, table, wallet } from './lib.js'
import { setup } from './setup.js'

const routerAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])
const execAbi = parseAbi(['struct Call { address to; uint256 value; bytes data; }', 'function execute(Call[] calls) payable returns (bytes[])'])
const mintAbi = parseAbi(['function mint(address,uint256)'])
const d = await setup()
const H = d.victims.hoarder
const hw = wallet(keys.hoarder)

const tx = async (w: ReturnType<typeof wallet>, to: Address, data: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to, data }) })
  if (r.status !== 'success') throw new Error(`tx to ${to} failed`)
}
const show = (found: Finding[]) => {
  if (!found.length) console.log('   (none)')
  for (const f of found) {
    const amt = f.unlimited ? 'unlimited' : f.decimals !== null ? formatEther(f.amount) : String(f.amount)
    const exp = f.exposure === null ? '-' : f.decimals !== null ? formatEther(f.exposure) : String(f.exposure)
    console.log(`   ${f.label.padEnd(21)} ${(f.symbol ?? f.key.token.slice(0, 10)).padEnd(10)} amount ${amt.padEnd(10)} exposure ${exp.padEnd(8)} age ${f.ageDays}d  block ${f.lastBlock}`)
  }
}

console.log(`\nA. hoarder ${H} leaves standing grants the old way (plain transactions)`)
const r = d.router
const nftId = BigInt(H) & 0xffffffn
if ((await pub.readContract({ address: d.nft, abi: nftAbi, functionName: 'ownerOf', args: [nftId] })) !== H) {
  await tx(wallet(keys.deployer), d.nft, encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [H, nftId] }))
}
const grants: [Address, Hex, string][] = [
  [d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [r, maxUint256] }), 'usdc.approve(router, max)'],
  [d.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }), 'usdc.approve(permit2, max)'],
  [PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [d.usdc, r, (1n << 160n) - 1n, 2 ** 48 - 1] }), 'permit2.approve(usdc, router)'],
  [d.nft, encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [r, nftId] }), 'nft.approve(router, id)'],
  [d.nft, encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [r, true] }), 'nft.setApprovalForAll(router)'],
  [d.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'approveDelegation', args: [r, parseEther('50')] }), 'aave approveDelegation'],
  [d.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'allow', args: [r, true] }), 'comet allow'],
  [d.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [r, true] }), 'morpho setAuthorization'],
  [d.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setRelayerApproval', args: [H, r, true] }), 'balancer setRelayerApproval'],
  [d.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'authorizeOperator', args: [r] }), 'erc777 authorizeOperator'],
]
for (const [to, data, label] of grants) {
  await tx(hw, to, data)
  console.log(`   ${label}`)
}

console.log('\n   zeroallow scan:')
const found = await scan(pub, { owner: H })
show(found)

const { frames } = compile({ sender: H, seal: d.seal, permit2: PERMIT2, calls: revokeCalls(found, H), keys: revokeKeys(found) })
console.log(`\n   revoke-all: ${found.length} grants closed in one frame transaction, sealed`)
const rv = await send({ sender: H, signerKey: keys.hoarder, frames })
table(frames, rv.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
console.log(`   tx ${rv.hash ?? `not sent: ${rv.sim.violation ?? rv.sim.executionError}`}`)
console.log('\n   rescan:')
show(await scan(pub, { owner: H }))

console.log('\nB. today-mode on the same chain: ERC-5792 calls executed atomically by a 7702-delegated EOA')
const T = d.victims.today
const tw = wallet(keys.today)
const delegated = `0xef0100${d.executor.slice(2).toLowerCase()}`
if ((await pub.getCode({ address: T }))?.toLowerCase() !== delegated) {
  const authorization = await tw.signAuthorization({ contractAddress: d.executor, executor: 'self' })
  await pub.waitForTransactionReceipt({ hash: await tw.sendTransaction({ to: T, authorizationList: [authorization], chain: hegota }) })
}
console.log(`   ${T} code = ${await pub.getCode({ address: T })} (7702 delegation to BatchExecutor)`)
const run = async (calls: Call[], label: string) => {
  const data = encodeFunctionData({ abi: execAbi, functionName: 'execute', args: [calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data }))] })
  try {
    await pub.call({ account: T, to: T, data })
    console.log(`   ${label}: preview (eth_call through the delegation) passes`)
  } catch (e) {
    const raw = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data : undefined
    let why = 'reverted'
    try {
      const err = decodeErrorResult({ abi: sealAbi, data: raw! })
      why = `${err.errorName}(${err.args?.map(String).join(', ')})`
    } catch {}
    console.log(`   ${label}: preview (eth_call through the delegation) reverts ${why}`)
  }
  const hash = await tw.sendTransaction({ to: T, data, gas: 1_500_000n, chain: hegota })
  const rc = await pub.waitForTransactionReceipt({ hash })
  console.log(`   ${label}: ${rc.status}  tx ${hash}`)
}
const allowance = () => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [T, d.router] })
const balance = () => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [T] })
const dapp: Call[] = [
  { to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.router, maxUint256] }) },
  { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, parseEther('10'), 0n, T] }) },
]
const leakyCheck = compileCalls({ sender: T, seal: d.seal, calls: [] , keys: [{ kind: KIND.APPROVE, token: d.usdc, spender: d.router, id: 0n }] }).calls
const b0 = await balance()
await run([...dapp, ...leakyCheck], 'dApp calls as sent, closed by seal.check')
console.log(`   allowance ${(await allowance()) === maxUint256 ? 'unlimited' : formatEther(await allowance())}, usdc ${formatEther(b0)} -> ${formatEther(await balance())} (whole batch reverted)`)
const { calls } = compileCalls({ sender: T, seal: d.seal, calls: dapp })
await run(calls, 'same calls compiled by zeroallow')
console.log(`   allowance ${formatEther(await allowance())}, usdc ${formatEther(await balance())}`)
