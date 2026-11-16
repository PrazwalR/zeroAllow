# zeroallow

Every DeFi interaction leaves zero residual token allowance, enforced on-chain with EIP-8141 frame transactions.

## Problem

An ERC-20 approval lasts forever but is needed for one transaction. The allowance lives in the token contract, keyed by spender, with no expiry, and disconnecting a dApp does nothing. When any spender is later broken (router bug, upgrade, stolen admin key) the attacker inherits every approval anyone ever gave it, with no new signature. In 2026 this drained SwapNet (~$13.4M), Ekubo (~$1.42M, the main victim's approval was 158 days old), router clones and a BNB Chain router.

EIP-8141's own flagship example, `approve(DEX, amount)` + swap in one atomic batch, only protects you when the swap fails. When it succeeds the allowance stays.

## Fix

Allowances last one transaction: bounded to what the action needs, revoked before the transaction ends, and proven by reading state.

| Layer | What it does |
|---|---|
| Compiler | Rewrites a dApp's calls into `approve(exact) → action → revoke → seal`, one atomic batch |
| `ZeroAllowSeal` | The unflagged frame that closes the batch. It walks its own batch with the frame opcodes, finds every allowance touched, reads each from token state, and reverts the whole batch if any is above 1 wei. Catches tokens whose `approve(0)` silently returns `false` |
| `ZeroAllowAccount` | During VERIFY it reads every frame and refuses to `APPROVE` any transaction where an allowance-touching call is not inside an atomic batch closed by the Seal. Holds even when the frontend is compromised |

## Results on the Hegotá testnet (chain 8141)

| Check | Result |
|---|---|
| Custom-code sender, `verbatim` opcodes, APPROVE through DELEGATECALL | accepted (`SelfVerify`), VERIFY 8.6k gas |
| Seal fails in the closing frame | whole batch rolled back, allowance stays 0 |
| Spec example 1 vs zeroallow, then the router is exploited | spec account: unlimited allowance, **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0xe1dc32856ab5264b81556443d4f3ddd4313a75031acc66c96baf2df69405d873)). zeroallow account: allowance 0, attack reverts, keeps 900 |
| Spec example 1 from the guarded account | `valid=false` at simulate, never broadcast |
| Same calls compiled by zeroallow from the guarded account | accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x85ec226a1567c98301ee79dcedd69e08200e7a7ea6f5b8a2adcb9e167933bdac)) |
| Overhead per interaction | +23k to +33k gas (revoke + seal), VERIFY 14k for 5 frames |
| Guard worst case, 64 frames / 31 grants | 83k gas, under the 100k `MAX_VERIFY_GAS` |

Deployed: FrameOps `0x7657611fb4501b7be494c588dfc8e49727bc9c42`, ZeroAllowSeal `0x298b613f77389da0be8e064cc8a320ee129022a0`, ZeroAllowAccount `0x338f60f12633683a82bcf3edccdb0ffe01139fb1`, VulnerableRouter `0x4c1a7b67c3cea7837a4cf3202a4eeeaa544b4cd4`.

## Frame layout

```
0  VERIFY  sender  scope 3   validate(0) → guard → APPROVE
1  SENDER  token   atomic    approve(router, 0)       only when the token is race-protected or an allowance already exists
2  SENDER  seal    atomic    snapshot([tokenOut])     only with --min-out
3  SENDER  token   atomic    approve(router, exact)
4  SENDER  router  atomic    the dApp's call, unchanged
5  SENDER  token   atomic    approve(router, 0)       1 wei for tokens that revert on zero
6  SENDER  seal              checkFrames(outs)        closes the batch; a revert rolls back 1-6
```

## Guard rules

Calldata only, at VERIFY time. Only SENDER frames can grant (DEFAULT runs as `ENTRY_POINT`, VERIFY is static).

1. A SENDER frame targeting the sender is refused. This closes the `execute()` self-call path that would hide nested approvals.
2. Every allowance-touching call must carry the atomic flag.
3. Its batch must close with a SENDER frame to the pinned Seal calling `checkFrames`.
4. A grant selector with calldata too short to parse, or a Permit2 batch permit, is refused.

The Seal, not the guard, decides from state whether each allowance is closed, so the guard never trusts the check's arguments and the ERC-20/ERC-721 `approve` selector collision fails closed.

Tracked grants: ERC-20 `approve`, `increaseAllowance`, `increaseApproval`, ERC-1363 `approveAndCall`, EIP-2612 and DAI `permit` (owner = sender), ERC-721/1155 `setApprovalForAll`, ERC-721 `approve`, ERC-6909 `approve`/`setOperator`, Permit2 `approve`/`permit`.

## Threat model

Stops: future compromise of any spender you used, frontends that build leaky transactions, revokes that silently fail, old allowances on any token/spender a transaction touches.

Does not stop: theft inside the same transaction up to the approved amount (unlimited approvals are capped to balance, `--min-out` bounds output), off-chain permit-signature phishing, key compromise, malicious tokens, grants through functions outside the table. A 7702-delegated EOA still holds its key and can send a plain `approve`; account enforcement is only real for code accounts with no key bypass.

## Use

```
bun install
cd contracts && forge test            # 24 tests: guard, seal quirks, drain, fuzz, TS/Sol vector parity
cd packages/core && bunx vitest run   # 31 tests
bun run vectors                       # regenerate vectors/guard.json
```

CLI, with `ZEROALLOW_KEY` and `ZEROALLOW_RPC` in `.env`:

```
bun packages/cli/src/main.ts compile --sender <addr> --seal <addr> --calls calls.json [--account zeroallow] [--min-out token:amount]
bun packages/cli/src/main.ts send    --sender <addr> --seal <addr> --calls calls.json --account zeroallow [--dry-run]
bun packages/cli/src/main.ts check   --sender <addr> --seal <addr> --frames frames.json
```

`calls.json` is the ERC-5792 shape: `[{ "to": "0x…", "data": "0x…", "value": "0" }]`.

Demos (fund the `.env` key from `faucet.privacy.ethrex.xyz`): `bun demo/m0.ts` probes, `bun demo/m1.ts` drain comparison, `bun demo/m2.ts` guard.

## Layout

```
contracts/src/FrameOps.yul        frame opcodes via verbatim (stock solc), delegatecalled by the account
contracts/src/ZeroAllowLib.sol    grant classifier + guard, shared by account and seal
contracts/src/ZeroAllowSeal.sol   closing check, snapshot/min-out, explicit check() for non-8141 batches
contracts/src/ZeroAllowAccount.sol
contracts/src/mocks/              quirky tokens, NFT, SwapNet-style VulnerableRouter
packages/core/                    compiler, TS guard mirror, prepare (RPC), frametx-kit adapter
packages/cli/                     zeroallow CLI
vectors/guard.json                golden vectors checked by both vitest and forge
demo/                             testnet scripts
```

## Pinned

| | |
|---|---|
| Chain | ethrex Hegotá testnet, chain ID 8141, `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09` |
| Encoding | `@jaw.id/frametx-kit` 0.5.0, keyed nonces (EIP-8250), limits `{execution, state}` |
| Opcodes | APPROVE `0xaa` `[offset,length,scope]`, TXPARAM `0xb0`, FRAMEDATALOAD `0xb1`, FRAMEDATACOPY `0xb2` `[mem,off,len,frame]`, FRAMEPARAM `0xb3` `[frame,param]`, SIGPARAM `0xb4` `[sig,param]` (first operand on top) |
| Behaviour relied on | transient storage cleared between frames, unbatched frame reverts do not undo earlier frames, batch rollback on closer failure, VERIFY static + 100k gas + sender-only SLOAD, no SSTORE refunds in frame txs |
| Compiler | solc 0.8.30, no fork |

## Next

- ERC-5792 today-mode: same bracket via `wallet_sendCalls` with `atomicRequired`, closed by `seal.check(keys, outs)`
- `scan` standing approvals with exposure and age, compiled into one revoke-all batch
- approval-free transfer strategies (Uniswap V2 pair, Universal Router `payerIsUser=false`, V4 settle)
- ERC-8286 validator module decoding ERC-7579 `execute`, per-account exemptions, Kernel integration, audit
