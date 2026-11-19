# zeroallow

Every DeFi interaction leaves zero residual token allowance, enforced on-chain with EIP-8141 frame transactions. Swaps through Uniswap V2, V3 and the Universal Router can skip approvals altogether. It works for zeroallow's own account, for any 8141 account through one STATICCALL, for ERC-7579 accounts that route every call through `execute`, and for today's ERC-5792 wallets. A scanner cleans up what is already exposed.

## Problem

An ERC-20 approval lasts forever but is needed for one transaction. The allowance lives in the token contract, keyed by spender, with no expiry, and disconnecting a dApp does nothing. When any spender is later broken (router bug, upgrade, stolen admin key) the attacker inherits every approval anyone ever gave it, with no new signature. In 2026 this drained SwapNet (~$13.4M), Ekubo (~$1.42M, the main victim's approval was 158 days old), router clones and a BNB Chain router.

The same shape exists beyond ERC-20: NFT operators, Permit2 sub-allowances, ERC-6909 operators, and lending delegations that let a third party borrow against or move deposited collateral (Aave credit delegation, Compound III managers, Morpho authorizations, Balancer relayers).

EIP-8141's own **Example 2** (atomic approve + swap) only protects you when the swap fails. When it succeeds the allowance stays.

## Fix

Allowances last one transaction: bounded to what the action needs, revoked before the transaction ends, and proven by reading state. Where the venue allows it, no allowance is created at all.

| Layer | What it does |
|---|---|
| Compiler | Rewrites a dApp's calls into `approve(exact) → action → revoke → seal`, one atomic batch |
| Direct route | V2 pairs, V3 pools and the Universal Router are paid by `transfer` inside one atomic batch. No approval exists at any point, and the router leaves the trust path |
| `ZeroAllowSeal` | Closes the batch. It reads its own batch with the frame opcodes, finds every grant touched, reads each from state, and reverts the whole batch if any is still open. Catches revokes that silently fail. Also works inside an ERC-7579 `execute` batch |
| `ZeroAllowAccount` | During VERIFY it reads every frame and refuses to `APPROVE` a transaction where a grant is not inside an atomic batch closed by the Seal. Holds even when the frontend is compromised |
| `ZeroAllowPolicy` | The guard as a stateless canonical contract and an ERC-8286 frame validator (module type 11). One STATICCALL during VERIFY enforces zeroallow for any 8141 account, including ERC-7579 accounts that route every call through `execute` |
| Today-mode | Same bracket as an ERC-5792 `wallet_sendCalls` batch with `atomicRequired`, closed by `seal.check(keys)` |
| `scan` / `revoke` | Finds standing grants from events, reads live exposure and age, and closes all of them in one sealed batch |

## Results on the Hegotá testnet (chain 8141)

| Check | Result |
|---|---|
| Spec Example 2 vs zeroallow, then the router is exploited | spec account: unlimited allowance, **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0xba61662e19310478929f0a8eb849fa79e5363cd7d5662d31d5c1ebd99f74919e)). zeroallow account: allowance 0, attack reverts, keeps 900 |
| Spec Example 2 from the guarded account | `valid=false` at simulate, never broadcast |
| Same calls compiled by zeroallow from the guarded account | accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x2d7200dd24a9af64810370eea5b8edecbffbfa6a703554670cf9946ed5998851)) |
| Seal fails in the closing frame | whole batch rolled back, allowance stays 0 |
| V2 router asks for `approve(router, max)` + swap. A signs it, D uses `--strategy direct`, router exploited | A **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x946d495d6e291da51e7cebaa9d0e325d72243d3372928c176f9904d359dc6c91)). D never approves or calls the router ([tx](https://dora.privacy.ethrex.xyz/tx/0xfd3c84c6d880e19fa932e0ee122602989bda16d1423a88fb9da74a9aee49a3d0)), keeps 900 |
| SwapRouter02-style V3 router, `multicall(deadline, [exactInputSingle])`, same comparison | A **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x3bd176e9c7290527a0ba6dca14c55e36f20dc4a08e8cbe485da71e2db2ac98d8)). D's swapper pays the pool in its callback ([tx](https://dora.privacy.ethrex.xyz/tx/0x75de45080f7028f90c262bb37c37435379204ce3d60a6a0d1f2f6a2ecde89c11)), keeps 900 |
| Universal Router with Permit2 (`approve(Permit2)` + `Permit2.approve(router)` + `execute`), same comparison | A **drained 900 USDC** through Permit2 ([tx](https://dora.privacy.ethrex.xyz/tx/0xe1582546b9c04f5b86ce763a6e8677e0a237852522623de8bf173bdec6f36c32)). D sends the same `execute` with `payerIsUser=false` and no Permit2 grant ([tx](https://dora.privacy.ethrex.xyz/tx/0xb378a8144d396772bb0c8fbf4992187ef73392e70dd80ddc1cba8410c79f9d9b)), keeps 900 |
| The guarded account on all three direct routes | accepted, nothing left behind, every exploit reverts |
| ERC-7579 account that routes every call through `execute` | Example 2 shape inside one `execute`: invalid. Same calls plus one frame that bypasses `execute`: invalid. Delegatecall mode: invalid. Compiled batch: accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xbac62baa59f5e100283ac1881d26e4da42cde7a26a211c2f2369c642b716f06f)) |
| Third-party style account calling `ZeroAllowPolicy.enforce()` in VERIFY | spec Example 2 invalid. Compiled bracket accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xe7026edd408a71f90b3f07abfa4433d69b939bcddea72ee1f837c243aa6737d4)) |
| `scan` an EOA with 10 standing grants across every family, `revoke` | all 10 closed in one sealed frame transaction, rescan empty ([tx](https://dora.privacy.ethrex.xyz/tx/0xac7a9939215b403bfca8b4305447cf12543094dc5869fb098584775ea159cf8f)) |
| Today-mode, 7702 EOA, dApp calls as sent + `seal.check` | preview reverts `Open(1, USDC, router, 0)`, on-chain the whole batch reverts ([tx](https://dora.privacy.ethrex.xyz/tx/0x2f487c8f5a78587556dfa438720789c5b7effcfa58ab144054cae380d18cefa8)) |
| Today-mode, same calls compiled | succeeds, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xf268b127305fe1054a0957c5f5cafc093e2a3391a1f87a66838fc5c43048dc71)) |

| Gas | Measured |
|---|---|
| Bracket overhead per interaction (revoke + seal) | +23k against a first-time approve, +34k against re-approving an allowance that is already set |
| VERIFY, `ZeroAllowAccount`, 5 frames | 10.8k |
| VERIFY at `MAX_FRAMES` (64): 62 revokes / slowest selector path (Permit2) | 67.6k / 78.0k |
| VERIFY, policy account | 21.1k |
| VERIFY, ERC-7579 account: 4 / 33 / 49 executions | 24.6k / 62.4k / 83.9k (≈1.3k per execution; 65 does not fit) |

The VERIFY budget is `MAX_VERIFY_GAS` (100k) minus the 2,800 secp256k1 signature cost, which the public mempool counts against the same cap: 97.2k.

| Direct route gas | dApp's request, first approval | dApp's request, approval already set | zeroallow direct |
|---|---|---|---|
| V2 router | 112.1k | 102.1k | 91.1k |
| V3 router (multicall) | 98.0k | 88.0k | 101.8k |
| Universal Router + Permit2 | 118.9k | 98.9k | 101.2k |

Canonical CREATE2 addresses (salt 0, deterministic deployer `0x4e59…956c`, canonical Permit2), identical on any chain where the deployer exists: FrameOps `0x726c4A879937d11F89c6cF533Ab16a9cc90CA484`, ZeroAllowSeal `0xB6E016304f214caeD1f882f2c8C0A2786900D96E`, ZeroAllowSwapper `0x6d08f9De8EB5980fC9a8Eb474ef407480918523f`, ZeroAllowPolicy `0x033320bfE2F97fDfa0B7c693A5e6de66E1F2f576`. Testnet demo: ZeroAllowAccount `0x50E04A18B1F2E039bA6847735cF41C1989b117D4`, ERC-7579 account `0xB2c40a4a32E093fe9528cdBF9ef71dE619Cf7693`, policy account `0xb7A71cf871BE40676831347Dd5B0E68A16Bc260d`, VulnerableRouter `0x9C621764F4989bDCE26d1EcbDbddF36194FF5F39`, V2 router `0xde0E3c14E4FE9d13394D36B11Fc962DBF68e6CA4`, V3 router `0x4d150B3eB083572Dd91bB5b4D3a44959eA6E4110`, Universal Router `0xA07d9Df0019ad08869629D83d949D167649E8c36`, BatchExecutor `0x642A7eEA0219293c1018aF3929e60319F6BA9256`. The routers are mocks with an injected arbitrary-call bug, so the exploits are real transactions against them.

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

## Direct route

`--strategy direct` takes the router out of the trust path. No allowance is created at any point; the input moves by `transfer`, and the transfer and the swap share one atomic batch, so a failed swap returns the input.

| dApp asks for | zeroallow sends |
|---|---|
| UniswapV2Router02 `swapExactTokensForTokens` (and the fee-on-transfer variant) | `transfer(tokenIn, pair0, amountIn)` → `ZeroAllowSwapper.swapV2(pairs, …)` |
| SwapRouter / SwapRouter02 `exactInputSingle`, `exactInput`, also wrapped in `multicall(deadline, […])` | `transfer(tokenIn, swapper, amountIn)` → `ZeroAllowSwapper.swapV3(path, factory, …)`, which pays each pool in its swap callback |
| Universal Router `execute` with V2/V3 swaps where `payerIsUser = true`, plus `PERMIT2_PERMIT` | `transfer(tokenIn, router, amount)` → the same `execute` with `payerIsUser` set to false, the permit commands dropped, and `SWEEP(tokenIn, msg.sender)` appended |

- Pools and pairs are resolved through the router's own factory on-chain. If one is missing, or the call sends ETH, sets a price limit, keeps the output in the router, uses the router's balance as the amount, pulls through `PERMIT2_TRANSFER_FROM`, or contains any other Universal Router command, that call keeps the bracket.
- Approvals to a rewritten router are dropped, and so is the Permit2 layer when nothing kept could still need it. Anything kept is revoked by the bracket.
- A Universal Router call that keeps the bracket has the Permit2 allowances its `PERMIT2_PERMIT` commands grant revoked as well (`permit2.approve(token, router, 0, 0)` inside the sealed batch).
- The swapper holds the input only between the two frames of one atomic batch. The V3 callback pays only the pool currently being called, at most that hop's amount, behind a reentrancy lock. Leftovers go back to the caller, and the output is checked as the recipient's balance change against `minOut`.
- The Universal Router keeps `payerIsUser` at word `0x80` both in the deployed 5-field swap inputs and in the current 6-field layout (`minHopPriceX36`), so the rewrite patches that one word and leaves the rest byte-identical.

## ERC-7579 accounts that route through `execute`

An ERC-8286 account with `executionRoute() == 1` sends every SENDER frame to its own `execute(bytes32 mode, bytes executionCalldata)`. The grants then sit inside a self-call, which the frame-level guard refuses. `ZeroAllowPolicy` decodes them instead:

1. For each SENDER frame that targets the sender with the `execute` selector, it reads the frame's full calldata (FrameOps op 5, `FRAMEDATACOPY`) and parses the executions with a strict parser that never reverts; malformed input is refused.
2. The executions become a virtual frame list. A revert-all batch maps to atomic frames closed by its last execution; single and try modes map to unflagged frames. The same guard runs on that list, so a grant must be followed by `seal.checkFrames` as the batch's last execution, and a single call or a try-mode batch cannot carry a grant.
3. Delegatecall and staticcall modes, and executions that target the account itself, are refused.
4. The Seal, called from inside `execute`, sees that the current frame targets the sender, decodes the same batch and checks every grant executed before its own call. A transient counter keyed by frame index tells it which seal call it is.

The reference `Dispatch7579Account` follows ERC-8286: it checks that it is running in a VERIFY frame, asks `ZeroAllowPolicy.validateFrame`, clears execution approval if any SENDER frame bypasses `execute`, then APPROVEs. The parser is fuzzed against `abi.decode` (well-formed batches, 20k runs), against random bytes, and against single-word corruptions of valid encodings. VERIFY costs ≈1.3k gas per execution, so `revoke` splits these accounts' batches at 40 grants.

## Guard rules

Calldata only, at VERIFY time. Only SENDER frames can grant (DEFAULT runs as `ENTRY_POINT`, VERIFY is static). The account first checks that it really is running in a VERIFY frame (`FRAMEPARAM` mode), since a DEFAULT frame also has caller `ENTRY_POINT` and may carry approval-scope flags (ERC-8286 makes this a MUST).

1. A SENDER frame targeting the sender is refused, unless it is an ERC-7579 `execute` that the policy decodes as above. This closes the self-call path that would hide nested grants.
2. Every grant must carry the atomic flag.
3. Its batch must close with a SENDER frame to the pinned Seal calling `checkFrames`.
4. A grant selector with calldata too short to parse, or a Permit2 batch permit, is refused.

The Seal, not the guard, decides from state whether each grant is closed, so the guard never trusts the check's arguments, and the ERC-20/ERC-721 `approve` selector collision fails closed. The guard's hot path is one assembly block: a one-word first-byte filter rejects non-grant selectors, `approve` has a fast path, and a two-level split on the selector bounds every other grant to two range checks and at most six comparisons. A differential fuzz test (50k runs) holds it equal to the readable `classify` the Seal uses, and 41 golden vectors hold the Solidity and TypeScript guards equal.

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

## Threat model

Stops: future compromise of any spender you used, frontends that build leaky transactions, revokes that silently fail, old allowances on any token/spender a transaction touches. For a `ZeroAllowAccount`, off-chain permit signatures cannot create allowances at all: the account has no private key (CREATE2-deployed) and no ERC-1271 `isValidSignature`, so EIP-2612, DAI, USDC-style 1271 permits and Permit2 signatures all fail for it.

The direct route removes the router from the trust path: only the pool code and the swapper are touched, and the swapper keeps no custody between transactions and holds no approvals. With the Universal Router rewrite the router is still called, but it is paid in advance from the same batch instead of being trusted with a standing Permit2 grant.

An ERC-7579 account is protected only if its VERIFY asks the policy and refuses frames that bypass `execute` (ERC-8286 step 5); the policy cannot overrule an account whose own code ignores it.

Does not stop: theft inside the same transaction up to the approved amount (unlimited approvals are capped to balance, `--min-out` bounds output), key compromise of an EOA, malicious tokens, ERC-777 default operators, grants through functions outside the table, tokens someone sends to the swapper outside a batch (anyone can take those). A 7702-delegated EOA still holds its key and can send a plain `approve`; account enforcement is only real for code accounts with no key bypass. Today-mode gives the zero-residual result but not the account-enforced guarantee.

## Use

```
bun install
cd contracts && forge build && forge test   # 57 tests: guard, seal per kind, drain, permits, 7702, V3 and Universal Router routes, ERC-7579 accounts, parser fuzzing, gas budgets, vectors
cd packages/core && bunx vitest run          # 72 tests, incl. scan, revoke-all, today-mode and all three direct routes executed on anvil (prague)
bun run vectors                              # regenerate vectors/guard.json
```

CLI, with `ZEROALLOW_KEY` and `ZEROALLOW_RPC` in `.env` (`--seal`, `--permit2` and `--swapper` default to the canonical addresses):

```
zeroallow compile --sender <addr> --calls calls.json [--account eoa|zeroallow|dispatched] [--strategy direct] [--min-out token:amount] [--mode 5792] [--verify-data 0x…]
zeroallow send    --sender <addr> --calls calls.json [--account …] [--strategy direct] [--dry-run]
zeroallow check   --sender <addr> --frames frames.json
zeroallow scan    --owner <addr> [--from-block n] [--json]
zeroallow revoke  --owner <addr> [--account …] [--mode 5792] [--send | --dry-run]
```

`calls.json` is the ERC-5792 shape: `[{ "to": "0x…", "data": "0x…", "value": "0" }]`. `--account dispatched` compiles into one ERC-7579 `execute` batch; `--verify-data` sets a third-party account's VERIFY calldata. `--mode 5792` prints a `wallet_sendCalls` payload with `atomicRequired: true`. From code, `sendAtomic` refuses any wallet that does not report `atomic: supported | ready`, and `previewCalls` runs the batch plus `seal.isClosed` reads through `eth_simulateV1`.

Gas limits are planned, not guessed: frames are fitted under the EIP-7825 cap, re-planned when a frame runs out, then tightened to simulated usage before signing.

Demos (fund the `.env` key from `faucet.privacy.ethrex.xyz`): `bun demo/m0.ts` probes, `bun demo/m1.ts` drain comparison, `bun demo/m2.ts` guard, VERIFY gas at 64 frames, the policy account and the ERC-7579 account, `bun demo/m3.ts` scan, revoke-all and today-mode, `bun demo/m4.ts` the three direct routes against the dApp's request.

## Layout

```
contracts/src/FrameOps.yul          frame opcodes via verbatim (stock solc)
contracts/src/ZeroAllowLib.sol      readable classifier (seal), assembly guard, ERC-7579 execute parser
contracts/src/ZeroAllowSeal.sol     checkFrames closer (frame batches and execute batches), check(keys), snapshot/min-out
contracts/src/ZeroAllowAccount.sol
contracts/src/ZeroAllowSwapper.sol  stateless V2/V3 hop executor for the direct route
contracts/src/ZeroAllowPolicy.sol   the guard for any 8141 account, ERC-8286 frame validator
contracts/src/mocks/                quirky tokens, NFT, delegations, 1271 permit token, Permit2, V2/V3 pools and routers, Universal Router subset, ERC-7579 account, 7702 executor
contracts/test/                     ZeroAllow, Routes (V3, Universal Router, Permit2), Dispatch (ERC-7579, parser fuzzing), Vectors
packages/core/src/                  compiler, direct routes, Universal Router codec, TS guard mirror, scan, today-mode, frametx-kit adapter
packages/cli/                       zeroallow CLI
vectors/guard.json                  golden vectors checked by both vitest and forge
demo/                               testnet scripts
```

## Pinned

| | |
|---|---|
| Spec | EIP-8141 draft at ethereum/EIPs `dc5d5fa688` (2026-11-01). Approve + swap is Example 2. ERC-8286 draft (2026-09-13) |
| Chain | ethrex Hegotá testnet, chain ID 8141, `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`. No `eth_simulateV1`; supports type-4 transactions; canonical Permit2 deployed |
| Encoding | `@jaw.id/frametx-kit` 0.5.0, keyed nonces (EIP-8250), limits `{execution, state}` |
| Opcodes | APPROVE `0xaa` `[offset,length,scope]`, TXPARAM `0xb0`, FRAMEDATALOAD `0xb1`, FRAMEDATACOPY `0xb2` `[mem,off,len,frame]`, FRAMEPARAM `0xb3` `[frame,param]`, SIGPARAM `0xb4` `[sig,param]` (first operand on top) |
| Behaviour relied on | transient storage cleared between frames, unbatched frame reverts do not undo earlier frames, batch rollback when the closer fails, VERIFY static + sender-only SLOAD, VERIFY limit + signature cost ≤ 100k, Σ execution limits ≤ 16,777,216, no SSTORE refunds in frame txs |
| Universal Router | `COMMAND_TYPE_MASK` `0x7f`, allow-revert flag `0x80`, `MSG_SENDER` = address(1); `payerIsUser` at input word `0x80` in both swap-input layouts |
| ERC-7579 | `execute(bytes32,bytes)` `0xe9ae5c53`; mode byte 0 callType (`0x00` single, `0x01` batch), byte 1 execType (`0x00` revert, `0x01` try); batch = `abi.encode(Execution[])` |
| Compiler | solc 0.8.30, via-IR, no metadata (deterministic CREATE2 addresses) |

## Next

- direct routes for V4 (Universal Router `V4_SWAP` settled from the router's balance), `PERMIT2_TRANSFER_FROM` turned into a plain transfer, and SwapRouter02's V2 swap (resolved through `factoryV2`)
- exact-amount tightening from simulated pulls (ethrex simulate returns no revert data or logs, so this needs `eth_simulateV1` or a search)
- other `execute` dialects through the same virtual-frame parser (Coinbase Smart Wallet `executeBatch`, LightAccount, Safe)
- per-account exemptions, counterfactual account deploy in the first frame, Kernel integration, audit
