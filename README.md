# zeroallow

Every DeFi interaction leaves zero residual token allowance, enforced on-chain with EIP-8141 frame transactions, plus a today-mode for ERC-5792 wallets and a scanner that cleans up what is already exposed.

## Problem

An ERC-20 approval lasts forever but is needed for one transaction. The allowance lives in the token contract, keyed by spender, with no expiry, and disconnecting a dApp does nothing. When any spender is later broken (router bug, upgrade, stolen admin key) the attacker inherits every approval anyone ever gave it, with no new signature. In 2026 this drained SwapNet (~$13.4M), Ekubo (~$1.42M, the main victim's approval was 158 days old), router clones and a BNB Chain router.

The same shape exists beyond ERC-20: NFT operators, Permit2 sub-allowances, ERC-6909 operators, and lending delegations that let a third party borrow against or move deposited collateral (Aave credit delegation, Compound III managers, Morpho authorizations, Balancer relayers).

EIP-8141's own **Example 2** (atomic approve + swap) only protects you when the swap fails. When it succeeds the allowance stays.

## Fix

Allowances last one transaction: bounded to what the action needs, revoked before the transaction ends, and proven by reading state.

| Layer | What it does |
|---|---|
| Compiler | Rewrites a dApp's calls into `approve(exact) → action → revoke → seal`, one atomic batch |
| `ZeroAllowSeal` | Closes the batch. It walks its own batch with the frame opcodes, finds every grant touched, reads each from state, and reverts the whole batch if any is still open. Catches revokes that silently fail |
| `ZeroAllowAccount` | During VERIFY it reads every frame and refuses to `APPROVE` a transaction where a grant is not inside an atomic batch closed by the Seal. Holds even when the frontend is compromised |
| Direct route | For V2-style swaps, skips the router entirely: transfer the exact input to the pair, then `ZeroAllowSwapper` (stateless, never approved, holds nothing) computes each hop from reserves and swaps. No approval exists at any point |
| `ZeroAllowPolicy` | The guard as a stateless canonical contract. Any 8141 account whose SENDER frames call targets directly enforces zeroallow with one STATICCALL during VERIFY |
| Today-mode | Same bracket as an ERC-5792 `wallet_sendCalls` batch with `atomicRequired`, closed by `seal.check(keys)` |
| `scan` / `revoke` | Finds standing grants from events, reads live exposure and age, and closes all of them in one sealed batch |

## Results on the Hegotá testnet (chain 8141)

| Check | Result |
|---|---|
| Spec Example 2 vs zeroallow, then the router is exploited | spec account: unlimited allowance, **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x18a328d46aa9648323a3a9c735c4652fc5b62018d1929d45c34faaa5ea0386e8)). zeroallow account: allowance 0, attack reverts, keeps 900 |
| Spec Example 2 from the guarded account | `valid=false` at simulate, never broadcast |
| Same calls compiled by zeroallow from the guarded account | accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xb0f499bb92301badec7bfd7653444ee0b3b76ac1f4b7640c5f7f7e2daf970355)) |
| V2 router asks for `approve(router, max)` + swap; A signs it, D uses `--strategy direct`; router exploited | A: unlimited allowance, **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x902032c236a7b550f651b92713eb26411c764fa52ca54807c53108ba21c54d75)). D: router never approved or called ([tx](https://dora.privacy.ethrex.xyz/tx/0x0acb98b45877eddb147cae43fdfa7771cbf1a78ca2f196c280763d8eb0f3d9ea)), 0.0498 WETH out like A, 21.6k gas cheaper than A, keeps 900. The guarded account accepts the direct route too |
| Third-party style account calling `ZeroAllowPolicy.enforce()` in VERIFY | spec Example 2 invalid; compiled bracket accepted, VERIFY 17.5k, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x95129f449e5b02f04c6d0ad9dfb6cedc075c3e0e94cbcf2028d9095a028e4b11)) |
| Seal fails in the closing frame | whole batch rolled back, allowance stays 0 |
| `scan` an EOA with 10 standing grants across every family, `revoke` | all 10 closed in one sealed frame transaction, rescan empty ([tx](https://dora.privacy.ethrex.xyz/tx/0x2ab129322c6eeb51f8f70350f0e2ef32419d3b17f6af33f25faa84d827f35445)) |
| Today-mode, 7702 EOA, dApp calls as sent + `seal.check` | preview reverts `Open(1, USDC, router, 0)`, on-chain the whole batch reverts ([tx](https://dora.privacy.ethrex.xyz/tx/0xa4f50097ccc882dabed706e5f1b57b64dbc3beebb7e7ed725a5a8a598bdc4903)) |
| Today-mode, same calls compiled | succeeds, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xa0f50fe9ae3c449d083b01fc37b136cbb54cb4b8e44120935b3382d0867270dd)) |
| Overhead per interaction | +23k gas (revoke + seal) |
| VERIFY gas, 5 frames | 10.8k |
| VERIFY gas at `MAX_FRAMES` (64), 62 revokes | 67.6k |
| VERIFY gas at 64 frames, slowest selector path (Permit2) | 78.0k, under the 97.2k budget |

The VERIFY budget is `MAX_VERIFY_GAS` (100k) minus the 2,800 secp256k1 signature cost, which the public mempool counts against the same cap.

Canonical CREATE2 addresses (salt 0, deterministic deployer `0x4e59…956c`, canonical Permit2), identical on any chain where the deployer exists: FrameOps `0x22679371820E523224cfBA585535EDA1d26fE6C1`, ZeroAllowSeal `0xfC483f5Bade6Da527BF04CAC05195BA04CAf5560`, ZeroAllowSwapper `0x19265c4a23d0F4c1A5eB1aC7fE9B935cF18FfAe9`, ZeroAllowPolicy `0xbcF16943adAf0007854d245073775144E2e17dA7`. Testnet demo: ZeroAllowAccount `0x5CcC752511A534Dde08ca38DB3Fb15268667044f`, VulnerableRouter `0x9C621764F4989bDCE26d1EcbDbddF36194FF5F39`, V2 router `0xde0E3c14E4FE9d13394D36B11Fc962DBF68e6CA4`, BatchExecutor `0x642A7eEA0219293c1018aF3929e60319F6BA9256`.

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

Calldata only, at VERIFY time. Only SENDER frames can grant (DEFAULT runs as `ENTRY_POINT`, VERIFY is static). The account first checks that it really is running in a VERIFY frame (`FRAMEPARAM` mode), since a DEFAULT frame also has caller `ENTRY_POINT` and may carry approval-scope flags (ERC-8286 makes this a MUST).

1. A SENDER frame targeting the sender is refused. This closes the `execute()` self-call path that would hide nested grants.
2. Every grant must carry the atomic flag.
3. Its batch must close with a SENDER frame to the pinned Seal calling `checkFrames`.
4. A grant selector with calldata too short to parse, or a Permit2 batch permit, is refused.

The Seal, not the guard, decides from state whether each grant is closed, so the guard never trusts the check's arguments, and the ERC-20/ERC-721 `approve` selector collision fails closed. The guard's hot path is one assembly block: a one-word first-byte filter rejects non-grant selectors, `approve` has a fast path, and a two-level split on the selector bounds every other grant to two range checks and at most six comparisons. A differential fuzz test (50k runs) holds it equal to the readable `classify` the Seal uses.

## Tracked grants

| Grant | Seal reads | Revoke |
|---|---|---|
| ERC-20 `approve`, `increaseAllowance`, `increaseApproval`, ERC-1363 `approveAndCall`, EIP-2612/DAI `permit` (owner = sender) | `allowance ≤ 1` | `approve(spender, 0)` |
| ERC-721 `approve` | `getApproved(id) ≠ spender` | `approve(0, id)` |
| ERC-721/1155 `setApprovalForAll` | `isApprovedForAll == false` | `setApprovalForAll(op, false)` |
| Permit2 `approve`, `permit` | `allowance(owner, token, spender).amount ≤ 1` | `approve(token, spender, 0, 0)` |
| ERC-6909 `approve`, `setOperator` | `allowance ≤ 1`, `isOperator == false` | `approve(…, 0)`, `setOperator(…, false)` |
| Aave `approveDelegation` | `borrowAllowance ≤ 1` | `approveDelegation(d, 0)` |
| Compound III `allow` | `isAllowed == false` | `allow(m, false)` |
| Morpho `setAuthorization` | `isAuthorized == false` | `setAuthorization(a, false)` |
| Balancer `setRelayerApproval` (sender = owner) | `hasApprovedRelayer == false` | `setRelayerApproval(owner, r, false)` |
| ERC-777 `authorizeOperator` | `isOperatorFor == false` | `revokeOperator(op)` |

## Direct route

```
0  VERIFY  sender   scope 3   validate(0) → guard → APPROVE
1  SENDER  tokenIn  atomic    transfer(pair0, amountIn)
2  SENDER  swapper            swapV2(pairs, tokenIn, minOut, to, deadline, feeBps)   closes the batch
```

`routeDirect` recognises UniswapV2Router02 `swapExactTokensForTokens` (and the fee-on-transfer variant), resolves the pairs through the router's factory on-chain, rewrites the swap, and drops the now-unneeded approvals to that router. Anything it cannot resolve falls back to the bracket. The transfer and the swap must be in one atomic batch, otherwise a failed swap would leave the input sitting in the pair for anyone to skim, so the compiler always batches multi-call bodies, sealed or not. The swapper derives each hop's input from the pair's balance over its reserve, so fee-on-transfer inputs work; a fee set lower than the pair's fails the pair's K check, never overpays.

## Threat model

Stops: future compromise of any spender you used, frontends that build leaky transactions, revokes that silently fail, old allowances on any token/spender a transaction touches. For a `ZeroAllowAccount`, off-chain permit signatures cannot create allowances at all: the account has no private key (CREATE2-deployed) and no ERC-1271 `isValidSignature`, so EIP-2612, DAI, USDC-style 1271 permits and Permit2 signatures all fail for it.

The direct route removes the router from the trust path altogether: only the pair code and a stateless swapper with no custody and no approvals are touched.

Does not stop: theft inside the same transaction up to the approved amount (unlimited approvals are capped to balance, `--min-out` bounds output), key compromise of an EOA, malicious tokens, ERC-777 default operators, grants through functions outside the table. A 7702-delegated EOA still holds its key and can send a plain `approve`; account enforcement is only real for code accounts with no key bypass. Today-mode gives the zero-residual result but not the account-enforced guarantee.

## Use

```
bun install
cd contracts && forge build && forge test   # 35 tests: guard, seal per kind, drain, permits, 7702 bracket, direct route, policy, differential fuzz, gas budgets, vectors
cd packages/core && bunx vitest run          # 53 tests, incl. scan + revoke-all + today-mode + direct route on anvil (prague)
bun run vectors                              # regenerate vectors/guard.json
```

CLI, with `ZEROALLOW_KEY` and `ZEROALLOW_RPC` in `.env` (`--seal` defaults to the canonical Seal):

```
zeroallow compile --sender <addr> --calls calls.json [--account zeroallow] [--min-out token:amount] [--mode 5792] [--strategy direct]
zeroallow send    --sender <addr> --calls calls.json --account zeroallow [--dry-run]
zeroallow check   --sender <addr> --frames frames.json
zeroallow scan    --owner <addr> [--from-block n] [--json]
zeroallow revoke  --owner <addr> [--mode 5792] [--send | --dry-run]
```

`calls.json` is the ERC-5792 shape: `[{ "to": "0x…", "data": "0x…", "value": "0" }]`. `--mode 5792` prints a `wallet_sendCalls` payload with `atomicRequired: true`. From code, `sendAtomic` refuses any wallet that does not report `atomic: supported | ready`, and `previewCalls` runs the batch plus `seal.isClosed` reads through `eth_simulateV1`.

Gas limits are planned, not guessed: frames are fitted under the EIP-7825 cap, re-planned when a frame runs out, then tightened to simulated usage before signing.

Demos (fund the `.env` key from `faucet.privacy.ethrex.xyz`): `bun demo/m0.ts` probes, `bun demo/m1.ts` drain comparison, `bun demo/m2.ts` guard, VERIFY gas at 64 frames and the policy account, `bun demo/m3.ts` scan, revoke-all and today-mode, `bun demo/m4.ts` direct route vs the dApp's request.

## Layout

```
contracts/src/FrameOps.yul        frame opcodes via verbatim (stock solc), delegatecalled by the account
contracts/src/ZeroAllowLib.sol    readable classifier (seal), assembly guard (account)
contracts/src/ZeroAllowSeal.sol   checkFrames closer, check(keys) for ERC-5792 batches, snapshot/min-out
contracts/src/ZeroAllowAccount.sol
contracts/src/ZeroAllowSwapper.sol stateless V2 hop executor for the direct route
contracts/src/ZeroAllowPolicy.sol the guard for any 8141 account, one STATICCALL
contracts/src/mocks/              quirky tokens, NFT, delegations, 1271 permit token, 7702 executor, V2 pair/factory/router, SwapNet-style routers, policy account
packages/core/                    compiler, direct route, TS guard mirror, scan, today-mode, frametx-kit adapter
packages/cli/                     zeroallow CLI
vectors/guard.json                golden vectors checked by both vitest and forge
demo/                             testnet scripts
```

## Pinned

| | |
|---|---|
| Spec | EIP-8141 draft at ethereum/EIPs `dc5d5fa688` (2026-11-01). Approve + swap is Example 2. ERC-8286 draft (2026-09-13) |
| Chain | ethrex Hegotá testnet, chain ID 8141, `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`. No `eth_simulateV1`; supports type-4 transactions |
| Encoding | `@jaw.id/frametx-kit` 0.5.0, keyed nonces (EIP-8250), limits `{execution, state}` |
| Opcodes | APPROVE `0xaa` `[offset,length,scope]`, TXPARAM `0xb0`, FRAMEDATALOAD `0xb1`, FRAMEDATACOPY `0xb2` `[mem,off,len,frame]`, FRAMEPARAM `0xb3` `[frame,param]`, SIGPARAM `0xb4` `[sig,param]` (first operand on top) |
| Behaviour relied on | transient storage cleared between frames, unbatched frame reverts do not undo earlier frames, batch rollback when the closer fails, VERIFY static + sender-only SLOAD, VERIFY limit + signature cost ≤ 100k, Σ execution limits ≤ 16,777,216, no SSTORE refunds in frame txs |
| Compiler | solc 0.8.30, via-IR, no metadata (deterministic CREATE2 addresses) |

## Next

- direct routes for V3 pools (callback-paid), Universal Router `payerIsUser=false`, V4 settle
- exact-amount tightening from simulated pulls (ethrex simulate returns no revert data or logs, so this needs `eth_simulateV1` or a search)
- contract-dispatched ERC-8286 accounts (every SENDER frame is `execute` on self): decode ERC-7579 executions in the guard. A per-account ERC-7579 validator module is not mempool-safe as specified, because VERIFY may only read the sender's storage; `ZeroAllowPolicy` is stateless for that reason
- per-account exemptions, counterfactual account deploy in the first frame, Kernel integration, audit
