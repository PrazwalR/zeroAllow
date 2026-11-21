# zeroallow

Every DeFi interaction leaves zero residual token allowance, enforced on-chain with EIP-8141 frame transactions. Swaps through Uniswap V2, V3 and V4 (through the Universal Router) can skip approvals altogether, and the approvals that remain shrink to the amount the action actually needs. It works for zeroallow's own account, for any 8141 account through one STATICCALL, for accounts that route every call through their own `execute` (ERC-7579, Coinbase Smart Wallet, LightAccount and SimpleAccount formats), for Kernel and other ERC-7579 accounts on today's chains through a hook module, and for ERC-5792 wallets. A scanner cleans up what is already exposed.

## Problem

An ERC-20 approval lasts forever but is needed for one transaction. The allowance lives in the token contract, keyed by spender, with no expiry, and disconnecting a dApp does nothing. When any spender is later broken (router bug, upgrade, stolen admin key) the attacker inherits every approval anyone ever gave it, with no new signature. In 2026 this drained SwapNet (~$13.4M), Ekubo (~$1.42M, the main victim's approval was 158 days old), router clones and a BNB Chain router.

The same shape exists beyond ERC-20: NFT operators, Permit2 sub-allowances, ERC-6909 operators, and lending delegations that let a third party borrow against or move deposited collateral (Aave credit delegation, Compound III managers, Morpho authorizations, Balancer relayers).

EIP-8141's own **Example 2** (atomic approve + swap) only protects you when the swap fails. When it succeeds the allowance stays.

## Fix

Allowances last one transaction: bounded to what the action needs, revoked before the transaction ends, and proven by reading state. Where the venue allows it, no allowance is created at all.

| Layer | What it does |
|---|---|
| Compiler | Rewrites a dApp's calls into `approve(exact) → action → revoke → seal`, one atomic batch |
| Direct route | V2 pairs, V3 pools and the Universal Router (V2, V3 and V4 swaps) are paid by `transfer` inside one atomic batch. No approval exists at any point, and the router leaves the trust path |
| `--tighten` | Shrinks each remaining approval to the smallest amount the dApp itself stated that still simulates, so a spender that turns greedy inside the transaction gets the trade amount, not the balance |
| `ZeroAllowSeal` | Closes the batch. It reads its own batch with the frame opcodes, finds every grant touched, reads each from state, and reverts the whole batch if any is still open. Catches revokes that silently fail. Also works inside an ERC-7579 `execute` batch |
| `ZeroAllowAccount` | During VERIFY it reads every frame and refuses to `APPROVE` a transaction where a grant is not inside an atomic batch closed by the Seal. Holds even when the frontend is compromised |
| `ZeroAllowPolicy` | The guard as a stateless canonical contract. One STATICCALL during VERIFY enforces zeroallow for any 8141 account, including accounts that route every call through their own `execute`. It returns a verdict, never an approval: the account still checks its own signature |
| `ZeroAllowHook` | An ERC-7579 hook module (Kernel v3.3 `IHook`, plus the Kernel v4 scoped-hook signature). After every batch it reads each touched grant from state and reverts if one is open. Needs no frame opcodes, so it protects ERC-4337 accounts on chains running today |
| Today-mode | Same bracket as an ERC-5792 `wallet_sendCalls` batch with `atomicRequired`, closed by `seal.check(keys)` |
| `scan` / `revoke` | Finds standing grants from events, reads live exposure and age, and closes all of them in one sealed batch |

## Results on the Hegotá testnet (chain 8141)

| Check | Result |
|---|---|
| Spec Example 2 vs zeroallow, then the router is exploited | spec account: unlimited allowance, **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0xb5ac17dd7c73374e53c9d7e5d82851aae2f3736bd219dc372a402349fb9aa56f)). zeroallow account: allowance 0, attack reverts, keeps 900 |
| Spec Example 2 from the guarded account | `valid=false` at simulate, never broadcast |
| Same calls compiled by zeroallow from the guarded account | accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x10f18ad63285ada127f2d9f0fa1fb91b7efb24b96d56a7da5250209e26e2f8f9)) |
| Seal fails in the closing frame | whole batch rolled back, allowance stays 0 |
| A router that takes whatever it is allowed during a 100 USDC swap | dApp's request: **paid 1,000 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x6dec85798cfc77c0f53771976f09e5f83052054a8e25977974547d53d33b588e)). Bracket alone, approval capped to balance: **paid 1,000 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x7d1cd8af25e0f3056d3ac686dc4d246a00f4e42554bc660d252f2425edaa4da9)). Bracket with `--tighten`: approval shrunk from 1,000 to 100 by the frame simulator, paid 100 ([tx](https://dora.privacy.ethrex.xyz/tx/0xac3825c2aa42d5baeba34db67ba336beb6cb6a4ff1868d2629e08613c45324ec)) |
| V2 router asks for `approve(router, max)` + swap. A signs it, D uses `--strategy direct`, router exploited | A **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x0830cd45f257e4811ee6cc277caaa18a46305bc312037b712b6713a6568d0ed1)). D never approves or calls the router ([tx](https://dora.privacy.ethrex.xyz/tx/0x158ebf86a7e441cbfb4437e1a7ea66b4f4de592f6e29d049663932150606ab9f)), keeps 900 |
| SwapRouter02-style V3 router, `multicall(deadline, [exactInputSingle])`, same comparison | A **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x8b078712aaa6dbe43b944e6f5d14c657231ef6b4ef66428da9823ebd95f51d4a)). D's swapper pays the pool in its callback ([tx](https://dora.privacy.ethrex.xyz/tx/0xef889820c64630a04838ec35a40a5b98983bf9d556b2c0d8b4c08ef3b1f2ac01)), keeps 900 |
| Universal Router V3 swap with Permit2 (`approve(Permit2)` + `Permit2.approve(router)` + `execute`), same comparison | A **drained 900 USDC** through Permit2 ([tx](https://dora.privacy.ethrex.xyz/tx/0xf21b9ed6f230eb419dd9cc0ac28a2dca4404515cbcfa5397351db69a464bd6de)). D sends the same `execute` with `payerIsUser=false` and no Permit2 grant ([tx](https://dora.privacy.ethrex.xyz/tx/0xd7749da03f1ff4f70b19ddc8e32e49ca96f7ca07ea6888710508ae564b3c3930)), keeps 900 |
| Universal Router `V4_SWAP` (`SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`) with Permit2, same comparison | A **drained 900 USDC** through Permit2 ([tx](https://dora.privacy.ethrex.xyz/tx/0x0cf3ca481d6b3f97ebb676729045f2a34780128c457690b828606347b8cdeb7c)). D's plan settles from the router's balance (`SETTLE(OPEN_DELTA, payerIsUser=false)`) after a plain transfer ([tx](https://dora.privacy.ethrex.xyz/tx/0x5b50d37464252fe0dee036845c311de85a18698283e1cbc30d577ef06719a806)), keeps 900 |
| The guarded account on all four direct routes | accepted, nothing left behind, every exploit reverts |
| SwapRouter02's V2 swap, `multicall(deadline, [swapExactTokensForTokens])`, same comparison | A **drained 900 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x47056445f82492279dd918f907c1765a82e84933ef0896555581d2b2d25f4132)). D pays the pair directly through the swapper ([tx](https://dora.privacy.ethrex.xyz/tx/0x2a15488423862e3c43b5f17ffe48df72904440ae93ed8a10de9cf672ab1258a0)), keeps 900 |
| V2 router exact output, `swapTokensForExactTokens(0.01 WETH, max 100 USDC)` | A **drained 979.87 USDC** ([tx](https://dora.privacy.ethrex.xyz/tx/0x26ba265ba49cbd598163b0293c98c7e9db1c5bfc4c7ab4c3b5c8acff9004018f)). D sends the maximum to the swapper, which pays the pair exactly what the reserves require and refunds the rest, 0.01 WETH out ([tx](https://dora.privacy.ethrex.xyz/tx/0xc0b91568ebd97f44294eb882c04197ceb96d2712ef71af440d19cbe38c9968dd)) |
| Universal Router `PERMIT2_TRANSFER_FROM` then a `payerIsUser=false` swap | A **drained 900 USDC** through Permit2 ([tx](https://dora.privacy.ethrex.xyz/tx/0x3d449aa5a8a571fee5c54637b10dce6f7062367592b5772f803ffff5fe7ae082)). D's pull becomes a plain transfer, no Permit2 grant ([tx](https://dora.privacy.ethrex.xyz/tx/0x5bd8e653db280c05dc1d0c0169995d38622a29c4604081f50fb60dfd88ff7af5)) |
| Universal Router `V4_SWAP` paying out native ETH | A **drained 999 USDC** through Permit2 ([tx](https://dora.privacy.ethrex.xyz/tx/0x65303dfc76a3bfe73339d840e3d3e221f77fd5d4d3380e87c9edabc72b9e4efb)). D pre-funds the router, receives ETH, leftovers swept back ([tx](https://dora.privacy.ethrex.xyz/tx/0xc79bda74e01112838e2a6f8d57274ccb5b9450b52ed21de2fb8f8a089e084d70)) |
| ERC-7579 account that routes every call through `execute` | Example 2 shape inside one `execute`: invalid. Same calls plus one frame that bypasses `execute`: invalid. Delegatecall mode: invalid. Compiled batch: accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xc74214479c07f2ab3c5d3966762e95d7d7f7c6110e9328ce9928d7152f3aa8a9)) |
| Coinbase-style `executeBatch(Call[])` and LightAccount-style `executeBatch(address[],uint256[],bytes[])` accounts | Example 2 shape: invalid. Compiled batches: accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x8cc27b7c1fa1ff2aa485ab39e77d5650b62ed1b0381f2f2f548d68d12adfee79), [tx](https://dora.privacy.ethrex.xyz/tx/0x417fb4fc4b58d68cb800a5348eceeb07e97322e4420366591e309c2b906e6155)) |
| Kernel-style account with `ZeroAllowHook`, as an ERC-4337 user operation (no frame opcodes) | dApp batch reverts with `Open(1, USDC, router, max)` ([tx](https://dora.privacy.ethrex.xyz/tx/0x061a7675082f4a0ffd2127fc5b2207b9dd4d42e0911143ee2d8ee2507630794e)). Compiled batch succeeds, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0x8a2ca58391fbae985848eed2285638af19b7c719a844ce25701581035e75cf69)); the exploit reverts |
| Third-party style account calling `ZeroAllowPolicy.enforce()` in VERIFY | spec Example 2 invalid. Compiled bracket accepted, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xc7b5d7d1d134b671c5222ef819072e449af75e86ee189592e48be3461f2dfb8a)) |
| `scan` an EOA with 10 standing grants across every family, `revoke` | all 10 closed in one sealed frame transaction, rescan empty ([tx](https://dora.privacy.ethrex.xyz/tx/0xa8d5798b7c413f2857d97ef480b3bad1d7d35ac4e0d84036d07e9787b83dee85)) |
| Today-mode, 7702 EOA, dApp calls as sent + `seal.check` | preview reverts `Open(1, USDC, router, 0)`, on-chain the whole batch reverts ([tx](https://dora.privacy.ethrex.xyz/tx/0x0f6c4b3b47b37bea4703e64bc6511a02b711baa4c972fd005808c8fed19f926b)) |
| Today-mode, same calls compiled | succeeds, allowance 0 ([tx](https://dora.privacy.ethrex.xyz/tx/0xb9e373700c080bb75f26cc357a5f0debd24b67e3d45425ee4e09780454e3e867)) |

| Gas | Measured |
|---|---|
| Bracket overhead per interaction (revoke + seal) | +23k against a first-time approve, +34k against re-approving an allowance that is already set |
| VERIFY, `ZeroAllowAccount`, 5 frames | 10.8k |
| VERIFY at `MAX_FRAMES` (64): 62 revokes / slowest selector path (Permit2) | 67.6k / 78.0k |
| VERIFY, policy account | 21.1k |
| VERIFY, ERC-7579 account: 4 / 33 / 49 executions | 24.9k / 62.4k / 83.9k (≈1.3k per execution; 65 does not fit) |
| VERIFY, Coinbase-style / LightAccount-style account, 4 executions | 24.3k / 25.1k |

The VERIFY budget is `MAX_VERIFY_GAS` (100k) minus the 2,800 secp256k1 signature cost, which the public mempool counts against the same cap: 97.2k.

| Direct route gas | dApp's request, first approval | dApp's request, approval already set | zeroallow direct |
|---|---|---|---|
| V2 router | 112.1k | 102.5k | 91.3k |
| V3 router (multicall) | 98.0k | 88.1k | 102.1k |
| Universal Router V3 swap + Permit2 | 118.9k | 99.0k | 101.3k |
| Universal Router V4 swap + Permit2 | — | 135.6k | 138.0k |

Canonical CREATE2 addresses (salt 0, deterministic deployer `0x4e59…956c`, canonical Permit2), identical on any chain where the deployer exists: FrameOps `0x726c4A879937d11F89c6cF533Ab16a9cc90CA484`, ZeroAllowSeal `0x5b42D503C481EeB8376F0d68B001309a07965057`, ZeroAllowSwapper `0x1E7158a100aDA7ad231859553aEd61Cea01fe5e7`, ZeroAllowPolicy `0xf94792bfd02A490d705b9169D197AD144737D5D5`, ZeroAllowHook `0x91c85028A449D2601F83dDA82491f519b7318e12`. Testnet demo: ZeroAllowAccount `0x83C38b170240329154278eDC10F5B3E0B3Ef004A`, ERC-7579 account `0x40d0Df2f3e2c4243807614a5c5624f6C035d701e`, Coinbase-style `0x1427f881d4677AD917d6AA5b9362ed76D10c0ABD`, LightAccount-style `0x94890B2073d6414e70205C90E37aF0A479768312`, Kernel-style `0x1652D2A7223EBBde9a8d30179ABe6aA114f4701e`, policy account `0x6d51dfA953b4a8A961604f7cA8a38beBf95FDcd2`, VulnerableRouter `0x9C621764F4989bDCE26d1EcbDbddF36194FF5F39`, V2 router `0x6a1140284b517e82e622e378c4a7705dF870D069`, V3 router `0xB7FcC560409F6497b979CfE4AE2ccC10e0E12d1A`, Universal Router `0x9f02369DFB3009792220D8982924cbf9847e75Be`, V4 PoolManager `0x7F8837747718Ae3d6f14D6CC38B0B0A79c5c7F09`, BatchExecutor `0x642A7eEA0219293c1018aF3929e60319F6BA9256`. The routers are mocks with an injected arbitrary-call bug, so the exploits are real transactions against them.

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
| UniswapV2Router02 `swapExactTokensForTokens` (and the fee-on-transfer variant), SwapRouter02's V2 `swapExactTokensForTokens` (resolved through `factoryV2`) | `transfer(tokenIn, pair0, amountIn)` → `ZeroAllowSwapper.swapV2(pairs, …)` |
| UniswapV2Router02 and SwapRouter02 `swapTokensForExactTokens` | `transfer(tokenIn, swapper, amountInMax)` → `ZeroAllowSwapper.swapV2ExactOut(…)`, which pays the pair exactly what the reserves require and refunds the rest |
| SwapRouter / SwapRouter02 `exactInputSingle`, `exactInput`, also wrapped in `multicall(deadline, […])` | `transfer(tokenIn, swapper, amountIn)` → `ZeroAllowSwapper.swapV3(path, factory, …)`, which pays each pool in its swap callback |
| Universal Router `execute` with V2/V3 swaps where `payerIsUser = true`, plus `PERMIT2_PERMIT` | `transfer(tokenIn, router, amount)` → the same `execute` with `payerIsUser` set to false, the permit commands dropped, and `SWEEP(tokenIn, msg.sender)` appended |
| Universal Router `V4_SWAP` whose `SETTLE_ALL(currency, maxAmount)` (or `SETTLE` with `payerIsUser`) pays from the user | `transfer(currency, router, maxAmount)` → the same plan with `SETTLE(currency, OPEN_DELTA, false)`, so the router settles the exact debt from its own balance, then `SWEEP` returns the rest |
| Universal Router `PERMIT2_TRANSFER_FROM` (and the batch form) before any other command | a plain `transfer` to the same recipient before the call; the Permit2 pull disappears |
| Universal Router calls that carry ETH (native V4 settles, `WRAP_ETH`) | the value stays on the call, native settles are paid from `msg.value` as the router does anyway, and unused ETH is swept back |

- Pools and pairs are resolved through the router's own factory on-chain. If one is missing, or a V2/V3 router call sends ETH, sets a price limit, keeps the output in the router, uses the router's balance as the amount, pulls through `PERMIT2_TRANSFER_FROM` after another command has run (moving it earlier could change what that command sees), contains any other Universal Router command, settles an open delta from the user in V4, or uses a V4 action outside swaps, settles and takes, that call keeps the bracket. So does a plan where one of its own commands could move a token the rewrite pre-funded (a swap input, which an exact-output swap or a partial fill leaves partly unspent, or a V4 `SETTLE_ALL` maximum): a `SWEEP`, `PAY_PORTION` or `UNWRAP_WETH` to anyone but the user, a router-paid swap, or a router-paid V4 settle.
- Approvals to a rewritten router are dropped, and so is the Permit2 layer when nothing kept could still need it. Anything kept is revoked by the bracket.
- A Universal Router call that keeps the bracket has the Permit2 allowances its `PERMIT2_PERMIT` commands grant revoked as well (`permit2.approve(token, router, 0, 0)` inside the sealed batch).
- The swapper holds the input only between the two frames of one atomic batch. The V3 callback pays only the pool currently being called, at most that hop's amount, behind a reentrancy lock. Leftovers go back to the caller, and the output is checked as the recipient's balance change against `minOut`.
- The Universal Router keeps `payerIsUser` at word `0x80` both in the deployed 5-field swap inputs and in the current 6-field layout (`minHopPriceX36`), so the rewrite patches that one word and leaves the rest byte-identical.

## Exact amounts (`--tighten`)

The bracket bounds exposure to one transaction, but inside that transaction the spender can still pull up to the approved amount; an unlimited approval is first capped to the balance. `--tighten` shrinks each `approve` and Permit2 `approve` further, using only amounts the dApp itself stated:

1. Every ABI word in the dApp's non-grant calls is a candidate (amounts, but also deadlines and fees, which simply fail).
2. Success is monotone in the approved amount, so for each grant a binary search over the sorted candidates finds the smallest one at which the whole compiled transaction still simulates: about log₂(candidates) simulations.
3. The tightened amounts are simulated together once more; if anything fails, the original amounts stay and the CLI says so.

Simulation goes through `ethrex_simulateFrameTransaction` for frame transactions signed with the key (works on the Hegotá testnet), or `eth_simulateV1` for ERC-5792 batches. The candidates come from the calldata rather than from observed transfers on purpose: a router that takes whatever it is allowed shows up in simulation as pulling the full allowance, but it still works with exactly `amountIn`, so that is what it gets.

## Accounts that route through their own `execute`

An ERC-8286 account with `executionRoute() == 1` sends every SENDER frame to its own batch function. The grants then sit inside a self-call, which the frame-level guard refuses. `ZeroAllowPolicy` decodes them instead, for these formats:

| Format | Used by | Batch semantics |
|---|---|---|
| `execute(bytes32 mode, bytes executionCalldata)`, also `executeFromExecutor` | ERC-7579 (Kernel, Safe7579, Nexus) | single, batch, try mode from the first two mode bytes; the other 30 must be zero |
| `executeBatch((address,uint256,bytes)[])` | Coinbase Smart Wallet | revert-all batch |
| `executeBatch(address[],uint256[],bytes[])`, `executeBatch(address[],bytes[])` | LightAccount, SimpleAccount | revert-all batch; an empty value array means zero values; mismatched lengths are refused |
| `execute(address,uint256,bytes)` | all of the above | single call |

1. For each SENDER frame that targets the sender with one of these selectors, it reads the frame's full calldata (FrameOps op 5, `FRAMEDATACOPY`) and parses the executions with a strict parser that never reverts; malformed input is refused.
2. The executions become a virtual frame list. A revert-all batch maps to atomic frames closed by its last execution; single and try modes map to unflagged frames. The same guard runs on that list, so a grant must be followed by `seal.checkFrames` as the batch's last execution, and a single call or a try-mode batch cannot carry a grant.
3. Delegatecall and staticcall modes, any non-zero mode selector or payload (ERC-7821 shares this selector, and its `0x78210002` batch-of-batches mode would otherwise decode differently), and executions that target the account itself, are refused.
4. The Seal, called from inside `execute`, sees that the current frame targets the sender, decodes the same batch and checks every grant executed before its own call. A transient counter keyed by frame index tells it which seal call it is.

The reference accounts (`Dispatch7579Account`, `CoinbaseLikeAccount`, `LightLikeAccount`) follow ERC-8286: each checks the owner's signature and that it is running in a VERIFY frame, requires `ZeroAllowPolicy.check()` to pass, clears execution approval if any SENDER frame bypasses `execute`, then APPROVEs. Every format's parser is fuzzed against `abi.decode` (well-formed batches, 20k runs) and against single-word corruptions of valid encodings, and the ERC-7579 one also against random bytes. VERIFY costs ≈1.3k gas per execution, so `revoke` splits these accounts' batches at 40 grants.

## Kernel and other ERC-7579 accounts on today's chains (`ZeroAllowHook`)

The VERIFY-time policy needs EIP-8141. `ZeroAllowHook` gives the same guarantee to any ERC-7579 account that supports hooks, on any chain, at execution time:

- `preCheck(msgSender, msgValue, msgData)` parses `msgData` with the same strict parser (all formats above), classifies every execution with the same table, and returns the touched grants as `hookData`. Delegatecall mode and calls back into the account are refused (a delegatecall could grant anything invisibly); static calls and non-execute calls pass.
- `postCheck(hookData)` asks the canonical Seal `isClosed(key, account)` for each grant and reverts with `Open(kind, token, spender, id)` if one is still open, which reverts the whole user operation.
- Kernel v3.3 calls hooks around `executeUserOp` (with the inner `execute(...)` calldata) and `executeFromExecutor`; Kernel v4 calls `preCheck(id, caller, value, data)` / `postCheck(id, hookData)`, which the hook also implements (module types 4 and 11). Direct `execute` from the EntryPoint or the account itself runs no hook in Kernel, so on EIP-8141 the VERIFY-time policy is what protects such frames.

A dApp's leaky batch reverts; the same calls compiled by zeroallow (`compileCalls`, revokes included) pass. About 29.5k gas around a three-call batch.

## Guard rules

Calldata only, at VERIFY time. Only SENDER frames can grant (DEFAULT runs as `ENTRY_POINT`, VERIFY is static). The account first checks that it really is running in a VERIFY frame (`FRAMEPARAM` mode), since a DEFAULT frame also has caller `ENTRY_POINT` and may carry approval-scope flags (ERC-8286 makes this a MUST).

1. A SENDER frame targeting the sender is refused, unless it is one of the account batch formats that the policy decodes as above. This closes the self-call path that would hide nested grants.
2. Every grant must carry the atomic flag.
3. Its batch must close with a SENDER frame to the pinned Seal calling `checkFrames`.
4. A grant selector with calldata too short to parse, or a Permit2 batch permit, is refused.

The Seal, not the guard, decides from state whether each grant is closed, so the guard never trusts the check's arguments, and the ERC-20/ERC-721 `approve` selector collision fails closed. The guard's hot path is one assembly block: a one-word first-byte filter rejects non-grant selectors, `approve` has a fast path, and a two-level split on the selector bounds every other grant to two range checks and at most six comparisons. A differential fuzz test (50k runs) holds it equal to the readable `classify` the Seal uses, and 41 golden vectors hold the Solidity and TypeScript guards equal.

## Tracked grants

The 1-wei tolerance exists only for ERC-20 allowances, because some tokens reject `approve(0)`; every other kind must read exactly zero.

| Grant | Seal reads | Revoke |
|---|---|---|
| ERC-20 `approve`, `increaseAllowance`, `increaseApproval`, ERC-1363 `approveAndCall`, EIP-2612/DAI `permit` (owner = sender) | `allowance ≤ 1` | `approve(spender, 0)` |
| ERC-721 `approve` | `getApproved(id) ≠ spender` | `approve(0, id)` |
| ERC-721/1155 `setApprovalForAll` | `isApprovedForAll == false` | `setApprovalForAll(op, false)` |
| Permit2 `approve`, `permit` | `allowance(owner, token, spender).amount == 0` | `approve(token, spender, 0, 0)` |
| ERC-6909 `approve`, `setOperator` | `allowance == 0`, `isOperator == false` | `approve(…, 0)`, `setOperator(…, false)` |
| Aave `approveDelegation` | `borrowAllowance == 0` | `approveDelegation(d, 0)` |
| Compound III `allow` | `isAllowed == false` | `allow(m, false)` |
| Morpho `setAuthorization` | `isAuthorized == false` | `setAuthorization(a, false)` |
| Balancer `setRelayerApproval` (sender = owner) | `hasApprovedRelayer == false` | `setRelayerApproval(owner, r, false)` |
| ERC-777 `authorizeOperator` | `isOperatorFor == false` | `revokeOperator(op)` |

## Threat model

Stops: future compromise of any spender you used, frontends that build leaky transactions, revokes that silently fail, old allowances on any token/spender a transaction touches. For a `ZeroAllowAccount`, off-chain permit signatures cannot create allowances at all: the account has no private key (CREATE2-deployed) and no ERC-1271 `isValidSignature`, so EIP-2612, DAI, USDC-style 1271 permits and Permit2 signatures all fail for it.

The direct route removes the router from the trust path: only the pool code and the swapper are touched, and the swapper keeps no custody between transactions and holds no approvals. With the Universal Router rewrite the router is still called, but it is paid in advance from the same batch instead of being trusted with a standing Permit2 grant.

An ERC-7579 account is protected only if its VERIFY checks its own signature, asks the policy and refuses frames that bypass `execute` (ERC-8286 step 5); the policy cannot overrule an account whose own code ignores it. The policy is deliberately not an ERC-8286 frame validator: ERC-8286 applies a validator's result as the whole authorization, so a guard that approves would let anyone send any grant-free transaction, such as `transfer(attacker, balance)`.

Does not stop: theft inside the same transaction up to the approved amount (unlimited approvals are capped to balance, `--tighten` lowers that to the smallest amount the dApp stated that still works, `--min-out` bounds output), key compromise of an EOA, malicious tokens, ERC-777 default operators, grants through functions outside the table, tokens someone sends to the swapper outside a batch (anyone can take those). A 7702-delegated EOA still holds its key and can send a plain `approve`; account enforcement is only real for code accounts with no key bypass. Today-mode gives the zero-residual result but not the account-enforced guarantee.

## Audit

An internal review of every contract and of the TypeScript route rewrites, walking the EVM audit checklists (assembly, precision math, ERC-20, ERC-721, general, DeFi AMM, flash loans, DoS, ERC-4337, access control, signatures) against the EIP-8141 and ERC-8286 drafts, Solady's ERC-7821 and the Universal Router sources. Each finding was reproduced by a test that failed before its fix.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | High | ERC-7821 accounts use the same `execute(bytes32,bytes)` as ERC-7579. The parser read only the call and exec type bytes, so the batch-of-batches mode `0x01…78210002` was decoded as a plain batch: crafted calldata showed the guard one harmless call while a Solady-style account ran a hidden `approve(attacker, max)` | the other 30 mode bytes must be zero, in Solidity and TypeScript; the hook inherits it | `test_erc7821_batch_of_batches_cannot_hide_a_grant`, `test_erc7579_mode_must_be_default_beyond_call_and_exec_type` |
| 2 | High | `ZeroAllowPolicy` declared itself an ERC-8286 frame validator (module type 11) and returned execution and payment approval whenever the guard passed. ERC-8286 applies that mode as the whole authorization, so an account that installed it would approve a grant-free transaction from anyone | the policy returns a verdict only (`check`, `enforce`); accounts combine it with their own signature check, as the reference accounts do | `test_policy_is_not_a_frame_validator` |
| 3 | Medium | The Universal Router rewrite pre-funds the router with each swap's input (an exact-output swap's `amountInMax`, or an exact-input amount a partial fill leaves unspent) or a V4 `SETTLE_ALL` `maxAmount`, and the plan's own commands were kept. A `SWEEP`, `PAY_PORTION` or `UNWRAP_WETH` to a third party, a router-paid swap, or a router-paid settle followed by a `TAKE` could send the unspent part away, while the original plan pulled only what it used. Needs `--strategy direct` and a hostile plan; bounded by the stated maximum | such plans keep the bracket | `keeps the bracket when the plan could move the pre-funded surplus to someone else` |
| 4 | Medium | The Seal tolerated a residual of 1 for Permit2, ERC-6909 and Aave delegation, whose revokes always write 0. A lone `approve(spender, id, 1)` on an ERC-6909 id passed with no revoke; for an id with supply 1 that unit is the whole asset | exactly 0 for those kinds | `test_seal_no_residual_for_6909_permit2_and_delegation` |
| 5 | Low | A pool could call `uniswapV3SwapCallback` more than once per swap (only reachable through a malicious factory the user signed) | the callback clears the expected pool before paying | V3 route tests |

Checked and found clean: every assembly block's bounds (all reads stay below the parsed region's end, all writes inside fresh allocations), the selector table and first-byte filter against keccak, the assembly classifier against the readable one, batch boundaries against the spec's atomic-batch definition, FrameOps operand order against the opcode tables, APPROVE only taking effect under the frame target's own delegatecall, the account's signature check (scheme, signer, empty `msg` binding the transaction's sig hash, no ERC-1271), Seal reads failing closed (no code, short or reverting returns), the swapper's math (`getAmountIn + 1` per hop, minimums measured at the recipient, refunds, reentrancy lock, callback window), the other route rewrites (recipients, minimums, deadlines, price limits, ETH), and the planner's limits. Not covered: grants made by signature outside the table (ERC-4494 position `permit`, Comet `allowBySig`, Aave `delegationWithSig`, Morpho `setAuthorizationWithSig`), which need an ERC-1271 signer and so cannot exist for a `ZeroAllowAccount`. This review is no substitute for an external audit.

## Use

```
bun install
cd contracts && forge build && forge test   # 76 tests: guard, seal per kind, drain, permits, 7702, V2/V3/V4/Universal Router routes, exact output, greedy router, ERC-7579/Coinbase/LightAccount accounts, Kernel-style hook, parser fuzzing, gas budgets, vectors
cd packages/core && bunx vitest run          # 93 tests, incl. scan, revoke-all, today-mode, tighten, every direct route and the Kernel-style hook executed on anvil (prague)
bun run vectors                              # regenerate vectors/guard.json
```

CLI, with `ZEROALLOW_KEY` and `ZEROALLOW_RPC` in `.env` (`--seal`, `--permit2` and `--swapper` default to the canonical addresses):

```
zeroallow compile --sender <addr> --calls calls.json [--account eoa|zeroallow|dispatched|coinbase|lightaccount] [--strategy direct] [--tighten] [--min-out token:amount] [--mode 5792] [--verify-data 0x…]
zeroallow send    --sender <addr> --calls calls.json [--account …] [--strategy direct] [--tighten] [--dry-run]
zeroallow check   --sender <addr> --frames frames.json
zeroallow scan    --owner <addr> [--from-block n] [--json]
zeroallow revoke  --owner <addr> [--account …] [--mode 5792] [--send | --dry-run]
```

`calls.json` is the ERC-5792 shape: `[{ "to": "0x…", "data": "0x…", "value": "0" }]`. `--account dispatched|coinbase|lightaccount` compiles into one batch call in that account's format; `--verify-data` sets a third-party account's VERIFY calldata. `--mode 5792` prints a `wallet_sendCalls` payload with `atomicRequired: true`. From code, `sendAtomic` refuses any wallet that does not report `atomic: supported | ready`, and `previewCalls` runs the batch plus `seal.isClosed` reads through `eth_simulateV1`.

Gas limits are planned, not guessed: frames are fitted under the EIP-7825 cap, re-planned when a frame fails, then tightened to simulated usage before signing. A frame can fail with execution gas to spare: under EIP-8037 every new storage slot costs about 98k of state gas from the frame's separate `limits.state` budget, so a failing frame gets more execution and up to 4M of state gas before the planner gives up, and a raised state limit is never tightened back.

Demos (fund the `.env` key from `faucet.privacy.ethrex.xyz`): `bun demo/m0.ts` probes, `bun demo/m1.ts` drain comparison and in-transaction theft with and without `--tighten`, `bun demo/m2.ts` guard, VERIFY gas at 64 frames, the policy account and the ERC-7579 account, `bun demo/m3.ts` scan, revoke-all and today-mode, `bun demo/m4.ts` the four direct routes (V2, V3, Universal Router V3 and V4) against the dApp's request.

## Layout

```
contracts/src/FrameOps.yul          frame opcodes via verbatim (stock solc)
contracts/src/ZeroAllowLib.sol      readable classifier (seal), assembly guard, ERC-7579 execute parser
contracts/src/ZeroAllowSeal.sol     checkFrames closer (frame batches and execute batches), check(keys), snapshot/min-out
contracts/src/ZeroAllowAccount.sol
contracts/src/ZeroAllowSwapper.sol  stateless V2/V3 hop executor for the direct route
contracts/src/ZeroAllowPolicy.sol   the guard for any 8141 account, called during VERIFY
contracts/src/ZeroAllowHook.sol     ERC-7579 hook (Kernel v3.3 and v4 signatures) enforcing the same rule at execution time
contracts/src/mocks/                quirky tokens, NFT, delegations, 1271 permit token, Permit2, V2/V3 pools and routers, V4 PoolManager, Universal Router subset (V2, V3, V4, Permit2 pulls, native ETH), greedy router, ERC-7579/Coinbase/LightAccount style accounts, Kernel-style hooked account, 7702 executor
contracts/test/                     ZeroAllow, Routes (V2/V3/V4, Universal Router, Permit2), Dispatch (account formats, parser fuzzing), Hook (Kernel-style), Vectors
packages/core/src/                  compiler, direct routes, Universal Router and V4 codec, tighten, TS guard mirror, scan, today-mode, frametx-kit adapter
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
| Universal Router | `COMMAND_TYPE_MASK` `0x7f`, allow-revert flag `0x80`, `MSG_SENDER` = address(1); `payerIsUser` at input word `0x80` in both swap-input layouts; `V4_SWAP` `0x10` input is `abi.encode(bytes actions, bytes[] params)`, passed to `PoolManager.unlock` |
| V4 actions | `SWAP_EXACT_IN_SINGLE` `0x06` … `SWAP_EXACT_OUT` `0x09`, `SETTLE` `0x0b` `(currency, amount, payerIsUser)`, `SETTLE_ALL` `0x0c` `(currency, maxAmount)`, `TAKE` `0x0e`, `TAKE_ALL` `0x0f`, `TAKE_PORTION` `0x10`; `OPEN_DELTA` = 0 |
| ERC-7579 | `execute(bytes32,bytes)` `0xe9ae5c53`, `executeFromExecutor` `0xd691c964`; mode byte 0 callType (`0x00` single, `0x01` batch), byte 1 execType (`0x00` revert, `0x01` try); batch = `abi.encode(Execution[])` |
| Other wallets | Coinbase `executeBatch((address,uint256,bytes)[])` `0x34fcd5be`; LightAccount/SimpleAccount `executeBatch(address[],uint256[],bytes[])` `0x47e1da2a`, `executeBatch(address[],bytes[])` `0x18dfb3c7`; `execute(address,uint256,bytes)` `0xb61d27f6` |
| Kernel hooks | v3.3 `IHook.preCheck(address,uint256,bytes)` / `postCheck(bytes)` (module type 4), called around `executeUserOp` and `executeFromExecutor`; v4 beta `IScopedExecutionHook.preCheck(bytes32,address,uint256,bytes)` / `postCheck(bytes32,bytes)` (module type 11) |
| Compiler | solc 0.8.30, via-IR, no metadata (deterministic CREATE2 addresses) |

## Next

- Safe's own `execTransaction` and `multiSend` through the same parser
- run the hook against deployed Kernel v3.3 bytecode on a mainnet fork, not only the Kernel-shaped test account
- per-account exemptions, counterfactual account deploy in the first frame
- an external audit before any mainnet deployment
