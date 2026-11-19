#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, formatUnits, getAddress, http, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CANONICAL,
  CODE,
  PERMIT2,
  broadcast,
  compile,
  compileCalls,
  guard,
  planTx,
  prepare,
  revokeCalls,
  revokeKeys,
  routeDirect,
  scan,
  waitReceipt,
  type AccountKind,
  type Call,
  type CompileInput,
  type Finding,
  type FrameSpec,
} from 'zeroallow'

const usage = `zeroallow <command> [options]

commands
  compile   wrap calls into a zero-residual frame transaction (or ERC-5792 batch with --mode 5792) and print it
  check     run the guard pre-flight on a frame list (JSON from compile --json)
  send      compile, sign with ZEROALLOW_KEY, simulate and broadcast a frame transaction (--dry-run stops after simulate)
  scan      list standing approvals, operators and delegations for --owner with exposure and age
  revoke    scan --owner and compile one batch that closes everything found (--send to broadcast in frame mode)

options
  --sender <addr>       account sending the transaction
  --owner <addr>        account to scan (scan, revoke; defaults to --sender)
  --seal <addr>         ZeroAllowSeal address (default ${CANONICAL.seal})
  --calls <file>        JSON array of { to, data, value? }
  --frames <file>       JSON frame list (check only)
  --account <kind>      eoa | zeroallow (default eoa)
  --mode <mode>         frame | 5792 (default frame)
  --strategy <s>        bracket | direct (default bracket); direct sends V2 router swaps straight to the pairs, no approval
  --swapper <addr>      ZeroAllowSwapper address (default ${CANONICAL.swapper})
  --permit2 <addr>      Permit2 address (default canonical ${PERMIT2})
  --min-out <tok:amt>   require output delta, repeatable
  --from-block <n>      scan start block (default 0)
  --rpc <url>           RPC (default ZEROALLOW_RPC)
  --json                machine-readable output
  --send                revoke: sign with ZEROALLOW_KEY and broadcast
  --dry-run             send/revoke: simulate only`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sender: { type: 'string' },
    owner: { type: 'string' },
    seal: { type: 'string' },
    calls: { type: 'string' },
    frames: { type: 'string' },
    account: { type: 'string', default: 'eoa' },
    mode: { type: 'string', default: 'frame' },
    strategy: { type: 'string', default: 'bracket' },
    swapper: { type: 'string' },
    permit2: { type: 'string' },
    'min-out': { type: 'string', multiple: true },
    'from-block': { type: 'string' },
    rpc: { type: 'string' },
    json: { type: 'boolean' },
    send: { type: 'boolean' },
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
const client = rpcUrl ? (createPublicClient({ transport: http(rpcUrl) }) as PublicClient) : undefined
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2)
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const seal = getAddress(values.seal ?? CANONICAL.seal)
const permit2 = getAddress(values.permit2 ?? PERMIT2)
const account = values.account as AccountKind
const needClient = () => {
  if (!client) throw new Error(`${cmd} needs --rpc or ZEROALLOW_RPC`)
  return client
}

function printFrames(frames: FrameSpec[], sender: Address) {
  const mode = ['DEFAULT', 'VERIFY', 'SENDER']
  frames.forEach((f, i) =>
    console.log(`${String(i).padStart(3)}  ${mode[f.mode].padEnd(7)} ${f.flags & 4 ? 'atomic' : '      '}  ${(f.target ?? 'sender').padEnd(42)}  ${f.label}`),
  )
  const v = guard(frames, sender, seal, permit2)
  console.log(`\nguard: ${v.code === CODE.OK ? 'accept' : `refuse at frame ${v.at}: ${v.reason}`}`)
}

const payload5792 = (from: Address, calls: Call[], chainId: number) => ({
  method: 'wallet_sendCalls',
  params: [{ version: '2.0.0', chainId: `0x${chainId.toString(16)}`, from, atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: `0x${(c.value ?? 0n).toString(16)}` })) }],
})

async function build() {
  const input: CompileInput = {
    sender: getAddress(need('sender')),
    seal,
    calls: (readJson(need('calls')) as Call[]).map((c) => ({ to: getAddress(c.to), data: c.data as Hex, value: c.value ? BigInt(c.value) : 0n })),
    account,
    permit2,
    minOut: (values['min-out'] ?? []).map((s: string) => {
      const [token, amount] = s.split(':')
      return { token: getAddress(token), amount: BigInt(amount) }
    }),
  }
  const notes: string[] = []
  let routed: CompileInput = input
  if (values.strategy === 'direct') {
    const r = await routeDirect(needClient(), input, { swapper: getAddress(values.swapper ?? CANONICAL.swapper) })
    notes.push(...r.notes)
    routed = r
  }
  const prepared = client ? await prepare(client, routed) : { ...routed, notes: [] as string[] }
  prepared.notes.unshift(...notes)
  return { input, prepared }
}

async function sendFrames(sender: Address, frames: FrameSpec[]) {
  const key = process.env.ZEROALLOW_KEY as Hex | undefined
  const c = needClient()
  if (!key) throw new Error('sending needs ZEROALLOW_KEY')
  const chainId = BigInt(await c.getChainId())
  const { raw, sim } = await planTx(c, { chainId, sender, signer: privateKeyToAccount(key).address, frames }, key)
  console.log(`\nsimulate: valid=${sim.valid} execution=${sim.executionStatus} ${sim.violation ?? sim.executionError ?? ''}`)
  sim.frames?.forEach((f, i) => console.log(`${String(i).padStart(3)}  ${f.succeeded ? 'ok  ' : 'FAIL'}  gas=${f.gasUsed}`))
  if (!sim.valid || sim.executionStatus !== 'success' || values['dry-run']) return sim.valid && sim.executionStatus === 'success'
  const hash = await broadcast(c, raw)
  const receipt = await waitReceipt(c, hash)
  console.log(`\nsent ${hash}`)
  receipt.frameReceipts.forEach((f, i) => console.log(`${String(i).padStart(3)}  ${f.status.padEnd(7)}  gas=${f.gasUsed}`))
  return receipt.frameReceipts.every((f) => f.status === 'success')
}

function printFindings(found: Finding[]) {
  if (!found.length) return console.log('no standing grants')
  for (const f of found) {
    const amt = f.unlimited ? 'unlimited' : f.decimals !== null ? formatUnits(f.amount, f.decimals) : String(f.amount)
    const exp = f.exposure === null ? '-' : f.decimals !== null ? formatUnits(f.exposure, f.decimals) : String(f.exposure)
    const what = `${f.symbol ?? f.key.token}${f.nft && f.key.id ? ` #${f.key.id}` : ''}`
    console.log(`${f.label.padEnd(21)} ${what.padEnd(44)} -> ${f.key.spender}  amount ${amt.padEnd(12)} exposure ${exp.padEnd(12)} ${f.ageDays}d old (block ${f.lastBlock})`)
  }
}

if (cmd === 'compile') {
  const { input, prepared } = await build()
  if (values.mode === '5792') {
    const out = compileCalls(prepared)
    const chainId = client ? await client.getChainId() : 1
    console.log(json(payload5792(input.sender, out.calls, chainId)))
    for (const n of [...prepared.notes, ...out.notes]) console.error(`note: ${n}`)
  } else {
    const out = compile(prepared)
    if (values.json) console.log(json(out.frames))
    else {
      printFrames(out.frames, input.sender)
      for (const n of [...prepared.notes, ...out.notes]) console.log(`note: ${n}`)
    }
  }
} else if (cmd === 'check') {
  const frames = (readJson(need('frames')) as FrameSpec[]).map((f) => ({ ...f, value: BigInt(f.value) }))
  const sender = getAddress(need('sender'))
  printFrames(frames, sender)
  process.exit(guard(frames, sender, seal, permit2).code === CODE.OK ? 0 : 2)
} else if (cmd === 'send') {
  const { input, prepared } = await build()
  const out = compile(prepared)
  printFrames(out.frames, input.sender)
  process.exit((await sendFrames(input.sender, out.frames)) ? 0 : 2)
} else if (cmd === 'scan' || cmd === 'revoke') {
  const c = needClient()
  const owner = getAddress(values.owner ?? need('sender'))
  const found = await scan(c, { owner, permit2, fromBlock: values['from-block'] ? BigInt(values['from-block']) : undefined })
  if (cmd === 'scan') {
    if (values.json) console.log(json(found))
    else printFindings(found)
    process.exit(0)
  }
  printFindings(found)
  if (!found.length) process.exit(0)
  if (values.mode === '5792') {
    const out = compileCalls({ sender: owner, seal, permit2, calls: revokeCalls(found, owner, permit2), keys: revokeKeys(found) })
    console.log(json(payload5792(owner, out.calls, await c.getChainId())))
    process.exit(0)
  }
  let ok = true
  for (let i = 0; i < found.length; i += 61) {
    const part = found.slice(i, i + 61)
    const { frames } = compile({ sender: owner, seal, permit2, account, calls: revokeCalls(part, owner, permit2), keys: revokeKeys(part) })
    console.log(`\nrevoke batch ${i / 61 + 1}: ${part.length} grants`)
    printFrames(frames, owner)
    if (values.send || values['dry-run']) ok = (await sendFrames(owner, frames)) && ok
  }
  process.exit(ok ? 0 : 2)
} else {
  console.log(usage)
  process.exit(1)
}
