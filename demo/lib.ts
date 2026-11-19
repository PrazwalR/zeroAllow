import { readFileSync } from 'node:fs'
import { frameActions } from '@jaw.id/frametx-kit/viem'
import {
  concatHex,
  createPublicClient,
  defineChain,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CREATE2_DEPLOYER, planTx, prepareTx, signAndEncode, simulate, broadcast, type FrameSpec, type Limits } from '../packages/core/src/index.js'

const root = new URL('..', import.meta.url).pathname
const key = process.env.ZEROALLOW_KEY as Hex | undefined
if (!key) throw new Error('ZEROALLOW_KEY missing; put it in .env')

export const rpcUrl = process.env.ZEROALLOW_RPC ?? 'https://rpc1.privacy.ethrex.xyz'
export const hegota = defineChain({
  id: 8141,
  name: 'Ethrex Hegota Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
})
export const pub = createPublicClient({ chain: hegota, transport: http(rpcUrl) })
export const frames = frameActions(pub)

export const keys = {
  deployer: key,
  spec: keccak256(concatHex([key, toHex('victim-spec')])),
  zero: keccak256(concatHex([key, toHex('victim-zeroallow')])),
  attacker: keccak256(concatHex([key, toHex('attacker')])),
  hoarder: keccak256(concatHex([key, toHex('hoarder')])),
  today: keccak256(concatHex([key, toHex('today-7702')])),
  asked: keccak256(concatHex([key, toHex('direct-asked')])),
  direct: keccak256(concatHex([key, toHex('direct-routed')])),
}
export const addr = (k: Hex) => privateKeyToAccount(k).address
export const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: hegota, transport: http(rpcUrl) })

export function artifact(file: string, name = file.replace(/\.(sol|yul)$/, '')) {
  const j = JSON.parse(readFileSync(`${root}contracts/out/${file}/${name}.json`, 'utf8'))
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex }
}

const SALT = `0x${'00'.repeat(32)}` as const

export function predict(file: string, args: unknown[] = [], name?: string): Address {
  const { abi, bytecode } = artifact(file, name)
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: SALT, bytecode: encodeDeployData({ abi, bytecode, args }) })
}

export async function deploy(label: string, file: string, args: unknown[] = [], name?: string): Promise<Address> {
  const at = predict(file, args, name)
  if (await pub.getCode({ address: at })) return at
  const { abi, bytecode } = artifact(file, name)
  const w = wallet(keys.deployer)
  const hash = await w.sendTransaction({ to: CREATE2_DEPLOYER, data: concatHex([SALT, encodeDeployData({ abi, bytecode, args })]) })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success' || !(await pub.getCode({ address: at }))) throw new Error(`deploy ${label} failed`)
  console.log(`  deployed ${label.padEnd(14)} ${at}`)
  return at
}

export async function fund(to: Address, eth = '0.05') {
  const bal = await pub.getBalance({ address: to })
  if (bal >= parseEther(eth) / 2n) return
  const hash = await wallet(keys.deployer).sendTransaction({ to, value: parseEther(eth) })
  await pub.waitForTransactionReceipt({ hash })
}

export async function send(p: { sender: Address; signerKey: Hex; frames: FrameSpec[]; limits?: (f: FrameSpec, i: number) => Limits; dryRun?: boolean }) {
  const base = { chainId: BigInt(hegota.id), sender: p.sender, signer: addr(p.signerKey), frames: p.frames }
  const { raw, sim } = p.limits
    ? await (async () => {
        const { raw } = await signAndEncode(await prepareTx(pub, { ...base, limits: p.limits }), p.signerKey)
        return { raw, sim: await simulate(pub, raw) }
      })()
    : await planTx(pub, base, p.signerKey)
  if (p.dryRun || !sim.valid) return { sim, raw }
  const hash = await broadcast(pub, raw)
  const receipt = await frames.waitForFrameTransactionReceipt({ hash, timeout: 120_000 })
  return { sim, raw, hash, receipt }
}

export function table(fs: FrameSpec[], statuses?: string[]) {
  const mode = ['DEFAULT', 'VERIFY', 'SENDER']
  fs.forEach((f, i) =>
    console.log(
      `   ${String(i).padStart(2)}  ${mode[f.mode].padEnd(7)} ${f.flags & 4 ? 'atomic' : '      '}  ${f.label.padEnd(18)} ${statuses?.[i] ?? ''}`,
    ),
  )
}
