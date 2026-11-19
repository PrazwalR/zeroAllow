import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  AtomicityUnavailable,
  CMD,
  KIND,
  MSG_SENDER,
  PERMIT2,
  compileCalls,
  delegationAbi,
  encodeUr,
  erc20Abi,
  nftAbi,
  permit2Abi,
  previewCalls,
  revokeCalls,
  revokeKeys,
  routeDirect,
  scan,
  v2RouterAbi,
  v3Path,
  sendAtomic,
  type Call,
} from '../src/index.js'

const out = new URL('../../../contracts/out/', import.meta.url)
const art = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, out), 'utf8'))
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex }
}
const hasAnvil = spawnSync('anvil', ['--version']).status === 0
const execAbi = parseAbi(['struct Call { address to; uint256 value; bytes data; }', 'function execute(Call[] calls) payable returns (bytes[])'])
const routerAbi = parseAbi(['function swapExactIn(address,address,uint256,uint256,address) returns (uint256)'])

describe('sendAtomic gate', () => {
  const fakeWallet = (status: string, seen: string[]) =>
    createWalletClient({
      account: '0x1111111111111111111111111111111111111111',
      transport: custom({
        async request({ method }: { method: string }) {
          seen.push(method)
          if (method === 'wallet_getCapabilities') return { '0x1': { atomic: { status } } }
          if (method === 'eth_chainId') return '0x1'
          throw new Error(`unexpected ${method}`)
        },
      }),
    })

  test('refuses wallets that cannot guarantee atomicity, before sending anything', async () => {
    for (const status of ['unsupported', 'bogus']) {
      const seen: string[] = []
      await expect(sendAtomic(fakeWallet(status, seen), { chainId: 1, calls: [] })).rejects.toBeInstanceOf(AtomicityUnavailable)
      expect(seen).toEqual(['wallet_getCapabilities'])
    }
  })
})

describe.skipIf(!hasAnvil)('m3 on anvil (prague, 7702, eth_simulateV1)', () => {
  const port = 18000 + Math.floor(Math.random() * 1000)
  const url = `http://127.0.0.1:${port}`
  const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
  const userKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
  const deployer = privateKeyToAccount(deployerKey)
  const user = privateKeyToAccount(userKey)
  const pub = createPublicClient({ transport: http(url) })
  const dw = createWalletClient({ account: deployer, transport: http(url) })
  const uw = createWalletClient({ account: user, transport: http(url) })
  let anvil: ChildProcess
  const a: Record<string, Address> = {}

  const deploy = async (file: string, name: string, args: unknown[] = []) => {
    const { abi, bytecode } = art(file, name)
    const hash = await dw.deployContract({ abi, bytecode, args, chain: null })
    return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress!)
  }
  const write = async (w: typeof dw, to: Address, data: Hex) => {
    const hash = await w.sendTransaction({ to, data, chain: null })
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error('tx failed')
  }
  const execute7702 = async (calls: Call[]) => {
    const auth = await uw.signAuthorization({ contractAddress: a.executor, executor: 'self', chainId: 31337 })
    const data = encodeFunctionData({ abi: execAbi, functionName: 'execute', args: [calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data }))] })
    const hash = await uw.sendTransaction({ to: user.address, data, authorizationList: [auth], chain: null, gas: 3_000_000n })
    return pub.waitForTransactionReceipt({ hash })
  }

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(port), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    a.seal = await deploy('ZeroAllowSeal.sol', 'ZeroAllowSeal', [deployer.address, PERMIT2])
    a.usdc = await deploy('Mocks.sol', 'MockERC20', ['USD Coin', 'USDC'])
    a.weth = await deploy('Mocks.sol', 'MockERC20', ['Wrapped Ether', 'WETH'])
    a.router = await deploy('Mocks.sol', 'VulnerableRouter')
    a.nft = await deploy('Mocks.sol', 'MockNFT')
    a.lending = await deploy('Mocks.sol', 'MockDelegations')
    a.executor = await deploy('Mocks.sol', 'BatchExecutor')
    a.factory = await deploy('Mocks.sol', 'MockV2Factory')
    a.router2 = await deploy('Mocks.sol', 'MockV2Router', [a.factory])
    a.swapper = await deploy('ZeroAllowSwapper.sol', 'ZeroAllowSwapper')
    const factoryAbi = parseAbi(['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)'])
    await write(dw, a.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createPair', args: [a.usdc, a.weth] }))
    a.pair = getAddress(await pub.readContract({ address: a.factory, abi: factoryAbi, functionName: 'getPair', args: [a.usdc, a.weth] }))
    const mint = parseAbi(['function mint(address,uint256)'])
    await write(dw, a.usdc, encodeFunctionData({ abi: mint, functionName: 'mint', args: [user.address, parseEther('1000')] }))
    await write(dw, a.usdc, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.router, parseEther('100000')] }))
    await write(dw, a.weth, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.router, parseEther('100000')] }))
    await write(dw, a.nft, encodeFunctionData({ abi: mint, functionName: 'mint', args: [user.address, 7n] }))
    await write(dw, a.usdc, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.pair, parseEther('2000000')] }))
    await write(dw, a.weth, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.pair, parseEther('1000')] }))
    await write(dw, a.pair, encodeFunctionData({ abi: parseAbi(['function sync()']), functionName: 'sync' }))
    a.factory3 = await deploy('Mocks.sol', 'MockV3Factory')
    a.router3 = await deploy('Mocks.sol', 'MockV3Router', [a.factory3])
    a.ur = await deploy('Mocks.sol', 'MockUniversalRouter', [PERMIT2, a.factory, a.factory3])
    const f3 = parseAbi(['function createPool(address,address,uint24) returns (address)', 'function getPool(address,address,uint24) view returns (address)'])
    await write(dw, a.factory3, encodeFunctionData({ abi: f3, functionName: 'createPool', args: [a.usdc, a.weth, 3000] }))
    a.pool = getAddress(await pub.readContract({ address: a.factory3, abi: f3, functionName: 'getPool', args: [a.usdc, a.weth, 3000] }))
    await write(dw, a.usdc, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.pool, parseEther('2000000')] }))
    await write(dw, a.weth, encodeFunctionData({ abi: mint, functionName: 'mint', args: [a.pool, parseEther('1000')] }))
  }, 60_000)

  afterAll(() => anvil?.kill())

  test('scan finds standing grants of every family, revoke-all closes them atomically', async () => {
    const r = a.router
    const grants: Hex[][] = [
      [a.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [r, maxUint256] })],
      [a.nft, encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [r, true] })],
      [a.nft, encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [r, 7n] })],
      [a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'approveDelegation', args: [r, parseEther('50')] })],
      [a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'allow', args: [r, true] })],
      [a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [r, true] })],
      [a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setRelayerApproval', args: [user.address, r, true] })],
      [a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'authorizeOperator', args: [r] })],
    ]
    for (const [to, data] of grants) await write(uw, to as Address, data)
    await write(uw, a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [a.weth, true] }))
    await write(uw, a.lending, encodeFunctionData({ abi: delegationAbi, functionName: 'setAuthorization', args: [a.weth, false] }))

    const found = await scan(pub, { owner: user.address })
    expect(found.map((f) => f.label).sort()).toEqual(
      ['approve', 'approve', 'balancer relayer', 'credit delegation', 'erc777 operator', 'morpho authorization', 'nft approve', 'operator'],
    )
    const usdc = found.find((f) => f.key.token === a.usdc)!
    expect(usdc).toMatchObject({ unlimited: true, exposure: parseEther('1000'), symbol: 'USDC', decimals: 18 })
    expect(found.every((f) => f.ageDays === 0)).toBe(true)

    const { calls, keys } = compileCalls({ sender: user.address, seal: a.seal, calls: revokeCalls(found, user.address), keys: revokeKeys(found) })
    expect(keys.length).toBe(found.length)
    const preview = await previewCalls(pub, { account: user.address, calls, keys, seal: a.seal })
    expect(preview).toMatchObject({ ok: true, failedAt: null })
    expect(preview.closed.every((c) => c.closed)).toBe(true)

    const receipt = await execute7702(calls)
    expect(receipt.status).toBe('success')
    expect(await scan(pub, { owner: user.address })).toEqual([])
  }, 60_000)

  test('today-mode bracket leaves zero; a leaky batch reverts whole, preview says so', async () => {
    const swap = (amt: bigint) => encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [a.usdc, a.weth, amt, 0n, user.address] })
    const dapp: Call[] = [
      { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.router, parseEther('100')] }) },
      { to: a.router, data: swap(parseEther('100')) },
    ]
    const { calls, keys } = compileCalls({ sender: user.address, seal: a.seal, calls: dapp })
    expect((await previewCalls(pub, { account: user.address, calls, keys, seal: a.seal })).ok).toBe(true)
    expect((await execute7702(calls)).status).toBe('success')
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'allowance', args: [user.address, a.router] })).toBe(0n)

    const leaky: Call[] = [{ to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.router, maxUint256] }) }, dapp[1], calls.at(-1)!]
    const before = await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })
    const p = await previewCalls(pub, { account: user.address, calls: leaky, keys: [{ kind: KIND.APPROVE, token: a.usdc, spender: a.router, id: 0n }], seal: a.seal })
    expect(p.ok).toBe(false)
    expect(p.failedAt).toBe(2)
    expect((await execute7702(leaky)).status).toBe('reverted')
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'allowance', args: [user.address, a.router] })).toBe(0n)
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })).toBe(before)
  }, 60_000)

  test('sendAtomic drives a 5792 wallet with atomicRequired', async () => {
    const sent: unknown[] = []
    const wallet = createWalletClient({
      account: user.address,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === 'wallet_getCapabilities') return { [numberToHex(31337)]: { atomic: { status: 'ready' } } }
          if (method === 'eth_chainId') return numberToHex(31337)
          if (method === 'wallet_sendCalls') {
            const req = (params as { calls: { to: Address; data: Hex; value?: Hex }[]; atomicRequired: boolean }[])[0]
            sent.push(req)
            const r = await execute7702(req.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ? BigInt(c.value) : 0n })))
            return { id: r.transactionHash }
          }
          if (method === 'wallet_getCallsStatus') {
            const r = await pub.getTransactionReceipt({ hash: (params as Hex[])[0] })
            return { version: '2.0.0', id: r.transactionHash, chainId: numberToHex(31337), atomic: true, status: r.status === 'success' ? 200 : 500, receipts: [{ logs: [], status: r.status === 'success' ? '0x1' : '0x0', blockHash: r.blockHash, blockNumber: numberToHex(r.blockNumber), gasUsed: numberToHex(r.gasUsed), transactionHash: r.transactionHash }] }
          }
          throw new Error(`unexpected ${method}`)
        },
      }),
    })
    const { calls } = compileCalls({
      sender: user.address,
      seal: a.seal,
      calls: [{ to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.router, 5n] }) }],
    })
    const r = await sendAtomic(wallet, { chainId: 31337, calls })
    expect(r.status).toBe('success')
    expect((sent[0] as { atomicRequired: boolean }).atomicRequired).toBe(true)
  }, 60_000)

  test('direct route: the router is never approved, never called', async () => {
    const deadline = 2n ** 40n
    const dapp: Call[] = [
      { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.router2, maxUint256] }) },
      { to: a.router2, data: encodeFunctionData({ abi: v2RouterAbi, functionName: 'swapExactTokensForTokens', args: [parseEther('50'), 1n, [a.usdc, a.weth], user.address, deadline] }) },
    ]
    const routed = await routeDirect(pub, { sender: user.address, seal: a.seal, calls: dapp }, { swapper: a.swapper })
    expect(routed.calls.map((c) => c.to)).toEqual([a.usdc, a.swapper])
    expect(routed.notes.join('\n')).toMatch(/dropped approval/)
    const { calls, keys } = compileCalls(routed)
    expect(keys).toEqual([])
    expect(calls).toHaveLength(2)
    expect((await previewCalls(pub, { account: user.address, calls, keys, seal: a.seal })).ok).toBe(true)
    const weth = () => pub.readContract({ address: a.weth, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })
    const before = await weth()
    expect((await execute7702(calls)).status).toBe('success')
    expect(await weth()).toBeGreaterThan(before)
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'allowance', args: [user.address, a.router2] })).toBe(0n)

    const tooGreedy = await routeDirect(pub, { sender: user.address, seal: a.seal, calls: [{ ...dapp[1], data: encodeFunctionData({ abi: v2RouterAbi, functionName: 'swapExactTokensForTokens', args: [parseEther('50'), parseEther('1000'), [a.usdc, a.weth], user.address, deadline] }) }] }, { swapper: a.swapper })
    const usdcBefore = await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })
    expect((await execute7702(compileCalls(tooGreedy).calls)).status).toBe('reverted')
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] })).toBe(usdcBefore)
  }, 60_000)

  test('direct route: V3 router multicall and Universal Router execute, nothing is ever approved', async () => {
    const bal = (t: Address, o: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [o] })
    const v3 = parseAbi([
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
    ])
    const single = encodeFunctionData({
      abi: v3,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: a.usdc, tokenOut: a.weth, fee: 3000, recipient: MSG_SENDER, amountIn: parseEther('20'), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
    })
    const v3Request: Call[] = [
      { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.router3, maxUint256] }) },
      { to: a.router3, data: encodeFunctionData({ abi: v3, functionName: 'multicall', args: [2n ** 40n, [single]] }) },
    ]
    const r1 = await routeDirect(pub, { sender: user.address, seal: a.seal, calls: v3Request }, { swapper: a.swapper })
    expect(r1.calls.map((c) => c.to)).toEqual([a.usdc, a.swapper])
    const c1 = compileCalls(r1)
    expect(c1.keys).toEqual([])
    const w0 = await bal(a.weth, user.address)
    expect((await execute7702(c1.calls)).status).toBe('success')
    expect(await bal(a.weth, user.address)).toBeGreaterThan(w0)
    expect(await bal(a.usdc, a.swapper)).toBe(0n)
    expect(await pub.readContract({ address: a.usdc, abi: erc20Abi, functionName: 'allowance', args: [user.address, a.router3] })).toBe(0n)

    const swapIn = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [
      MSG_SENDER,
      parseEther('20'),
      1n,
      v3Path([{ a: a.usdc, fee: 3000, b: a.weth }]),
      true,
    ])
    const permitIn = encodeAbiParameters(parseAbiParameters('((address, uint160, uint48, uint48), address, uint256), bytes'), [[[a.usdc, 5n, 9, 0], a.ur, 9n], '0x12'])
    const urRequest: Call[] = [
      { to: a.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }) },
      { to: PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [a.usdc, a.ur, (1n << 160n) - 1n, 2 ** 48 - 1] }) },
      { to: a.ur, data: encodeUr({ commands: [CMD.PERMIT2_PERMIT, CMD.V3_SWAP_EXACT_IN], inputs: [permitIn, swapIn], deadline: 2n ** 40n }) },
    ]
    const r2 = await routeDirect(pub, { sender: user.address, seal: a.seal, calls: urRequest }, { swapper: a.swapper })
    expect(r2.calls.map((c) => c.to)).toEqual([a.usdc, a.ur])
    const c2 = compileCalls(r2)
    expect(c2.keys).toEqual([])
    const w1 = await bal(a.weth, user.address)
    expect((await execute7702(c2.calls)).status).toBe('success')
    expect(await bal(a.weth, user.address)).toBeGreaterThan(w1)
    expect((await bal(a.usdc, a.ur)) + (await bal(a.weth, a.ur))).toBe(0n)
  }, 60_000)
})
