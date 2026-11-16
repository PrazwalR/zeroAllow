#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CODE,
  broadcast,
  compile,
  guard,
  prepare,
  prepareTx,
  signAndEncode,
  simulate,
  waitReceipt,
  type AccountKind,
  type Call,
  type CompileInput,
  type FrameSpec,
} from 'zeroallow'

const usage = `zeroallow <command> [options]

commands
  compile   wrap calls into a zero-residual frame transaction and print it
  check     run the guard pre-flight on a frame list (JSON from compile --json)
  send      compile, sign with ZEROALLOW_KEY, simulate and broadcast (--dry-run to stop after simulate)

options
  --sender <addr>       account sending the transaction
  --seal <addr>         ZeroAllowSeal address
  --calls <file>        JSON array of { to, data, value? }
  --frames <file>       JSON frame list (check only)
  --account <kind>      eoa | zeroallow (default eoa)
  --permit2 <addr>      Permit2 address, enables Permit2 grants
  --min-out <tok:amt>   require output delta, repeatable
  --rpc <url>           read allowances and cap unlimited approvals (default ZEROALLOW_RPC)
  --json                print frames as JSON
  --dry-run             send: simulate only`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sender: { type: 'string' },
    seal: { type: 'string' },
    calls: { type: 'string' },
    frames: { type: 'string' },
    account: { type: 'string', default: 'eoa' },
    permit2: { type: 'string' },
    'min-out': { type: 'string', multiple: true },
    rpc: { type: 'string' },
    json: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const cmd = positionals[0]
if (!cmd || values.help) {
  console.log(usage)
  process.exit(cmd ? 0 : 1)
}

const need = (k: keyof typeof values): string => {
  const v = values[k]
  if (typeof v !== 'string') throw new Error(`--${String(k)} is required`)
  return v
}
const rpcUrl = values.rpc ?? process.env.ZEROALLOW_RPC
const client = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : undefined
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2)
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

function printFrames(frames: FrameSpec[], sender: Address, seal: Address, permit2?: Address) {
  const mode = ['DEFAULT', 'VERIFY', 'SENDER']
  frames.forEach((f, i) =>
    console.log(`${String(i).padStart(3)}  ${mode[f.mode].padEnd(7)} ${f.flags & 4 ? 'atomic' : '      '}  ${(f.target ?? 'sender').padEnd(42)}  ${f.label}`),
  )
  const v = guard(frames, sender, seal, permit2)
  console.log(`\nguard: ${v.code === CODE.OK ? 'accept' : `refuse at frame ${v.at}: ${v.reason}`}`)
}

async function build() {
  const input: CompileInput = {
    sender: getAddress(need('sender')),
    seal: getAddress(need('seal')),
    calls: (readJson(need('calls')) as Call[]).map((c) => ({ to: getAddress(c.to), data: c.data as Hex, value: c.value ? BigInt(c.value) : 0n })),
    account: values.account as AccountKind,
    permit2: values.permit2 ? getAddress(values.permit2) : undefined,
    minOut: (values['min-out'] ?? []).map((s: string) => {
      const [token, amount] = s.split(':')
      return { token: getAddress(token), amount: BigInt(amount) }
    }),
  }
  const prepared = client ? await prepare(client, input) : { ...input, notes: [] as string[] }
  const out = compile(prepared)
  return { input, out, notes: [...prepared.notes, ...out.notes] }
}

if (cmd === 'compile') {
  const { input, out, notes } = await build()
  if (values.json) console.log(json(out.frames))
  else {
    printFrames(out.frames, input.sender, input.seal, input.permit2)
    for (const n of notes) console.log(`note: ${n}`)
  }
} else if (cmd === 'check') {
  const frames = (readJson(need('frames')) as FrameSpec[]).map((f) => ({ ...f, value: BigInt(f.value) }))
  const sender = getAddress(need('sender'))
  const seal = getAddress(need('seal'))
  const permit2 = values.permit2 ? getAddress(values.permit2) : undefined
  printFrames(frames, sender, seal, permit2)
  process.exit(guard(frames, sender, seal, permit2).code === CODE.OK ? 0 : 2)
} else if (cmd === 'send') {
  const key = process.env.ZEROALLOW_KEY as Hex | undefined
  if (!key || !client) throw new Error('send needs ZEROALLOW_KEY and --rpc or ZEROALLOW_RPC')
  const { input, out } = await build()
  printFrames(out.frames, input.sender, input.seal, input.permit2)
  const chainId = BigInt(await client.getChainId())
  const tx = await prepareTx(client, { chainId, sender: input.sender, signer: privateKeyToAccount(key).address, frames: out.frames })
  const { raw } = await signAndEncode(tx, key)
  const sim = await simulate(client, raw)
  console.log(`\nsimulate: valid=${sim.valid} execution=${sim.executionStatus} ${sim.violation ?? sim.executionError ?? ''}`)
  sim.frames?.forEach((f, i) => console.log(`${String(i).padStart(3)}  ${f.succeeded ? 'ok  ' : 'FAIL'}  gas=${f.gasUsed}`))
  if (!sim.valid || sim.executionStatus !== 'success' || values['dry-run']) process.exit(sim.valid ? 0 : 2)
  const hash = await broadcast(client, raw)
  const receipt = await waitReceipt(client, hash)
  console.log(`\nsent ${hash}`)
  receipt.frameReceipts.forEach((f, i) => console.log(`${String(i).padStart(3)}  ${f.status.padEnd(7)}  gas=${f.gasUsed}`))
} else {
  console.log(usage)
  process.exit(1)
}
