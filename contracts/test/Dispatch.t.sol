// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {F, Blob, FrameStore, MockFrameOps} from "./utils/FrameKit.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowPolicy} from "../src/ZeroAllowPolicy.sol";
import {MockERC20, FalseOnZeroApprove, VulnerableRouter, Dispatch7579Account, PolicyVerified, CoinbaseLikeAccount, LightLikeAccount, Solady7821LikeAccount} from "../src/mocks/Mocks.sol";

contract Parser {
    function parse(bytes memory d) external pure returns (uint256 code, bytes memory vb) {
        return ZeroAllowLib.virtualBlob(d);
    }
}

contract DispatchTest is Test {
    address constant ENTRY_POINT = address(0xaa);
    bytes32 constant BATCH = bytes32(uint256(1) << 248);
    bytes32 constant BATCH_TRY = bytes32((uint256(1) << 248) | (uint256(1) << 240));
    bytes32 constant SINGLE = bytes32(0);
    bytes32 constant DELEGATE = bytes32(uint256(0xff) << 248);

    FrameStore store;
    MockFrameOps ops;
    ZeroAllowSeal seal;
    ZeroAllowPolicy policy;
    Dispatch7579Account acct;
    VulnerableRouter router;
    MockERC20 usdc;
    MockERC20 weth;
    Parser parser;
    address owner;
    address attacker = address(0xbad);

    event Approved(uint256 scope);

    function setUp() public {
        owner = makeAddr("owner");
        store = new FrameStore();
        ops = new MockFrameOps(store);
        seal = new ZeroAllowSeal(address(ops), address(0));
        policy = new ZeroAllowPolicy(address(ops), address(seal), address(0));
        acct = new Dispatch7579Account(owner, address(ops), address(policy));
        router = new VulnerableRouter();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");
        usdc.mint(address(router), 1_000_000e18);
        weth.mint(address(router), 1_000_000e18);
        usdc.mint(address(acct), 1_000e18);
        store.setSig(owner, 1, bytes32(0), 1);
        parser = new Parser();
    }

    function _x(address t, bytes memory d) internal pure returns (Dispatch7579Account.Execution memory) {
        return Dispatch7579Account.Execution(t, 0, d);
    }

    function _approve(address token, address spender, uint256 v) internal pure returns (Dispatch7579Account.Execution memory) {
        return _x(token, abi.encodeWithSelector(0x095ea7b3, spender, v));
    }

    function _swap(uint256 amt) internal view returns (Dispatch7579Account.Execution memory) {
        return _x(address(router), abi.encodeCall(VulnerableRouter.swapExactIn, (address(usdc), address(weth), amt, 0, address(acct))));
    }

    function _seal() internal view returns (Dispatch7579Account.Execution memory) {
        return _x(address(seal), abi.encodeCall(ZeroAllowSeal.checkFrames, (new ZeroAllowSeal.Out[](0))));
    }

    function _exec(bytes32 mode, Dispatch7579Account.Execution[] memory xs) internal view returns (F memory) {
        return F(2, 0, address(acct), 0, abi.encodeCall(Dispatch7579Account.execute, (mode, abi.encode(xs))));
    }

    function _tx(F memory body) internal view returns (F[] memory fs) {
        fs = new F[](2);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeCall(PolicyVerified.verify, ("")));
        fs[1] = body;
    }

    function _xs(Dispatch7579Account.Execution memory a, Dispatch7579Account.Execution memory b)
        internal
        pure
        returns (Dispatch7579Account.Execution[] memory xs)
    {
        xs = new Dispatch7579Account.Execution[](2);
        (xs[0], xs[1]) = (a, b);
    }

    function _bracket(uint256 amt) internal view returns (Dispatch7579Account.Execution[] memory xs) {
        xs = new Dispatch7579Account.Execution[](4);
        xs[0] = _approve(address(usdc), address(router), amt);
        xs[1] = _swap(amt);
        xs[2] = _approve(address(usdc), address(router), 0);
        xs[3] = _seal();
    }

    function _check(F[] memory fs) internal returns (uint256 code, uint256 at) {
        store.load(address(acct), fs);
        vm.prank(address(acct));
        return policy.check();
    }

    function _verify(F[] memory fs) internal {
        store.load(address(acct), fs);
        vm.prank(ENTRY_POINT);
        acct.verify("");
    }

    function runBatch(F[] memory fs) external {
        store.load(address(acct), fs);
        for (uint256 i; i < fs.length; ++i) {
            if (fs[i].mode != 2) continue;
            store.setCur(i);
            vm.prank(address(acct));
            (bool ok, bytes memory r) = fs[i].target.call{value: fs[i].value}(fs[i].data);
            if (!ok) {
                assembly {
                    revert(add(r, 0x20), mload(r))
                }
            }
        }
    }

    function test_dispatched_bracket_accepted_and_leaves_zero() public {
        F[] memory fs = _tx(_exec(BATCH, _bracket(100e18)));
        store.load(address(acct), fs);
        vm.expectEmit(address(acct));
        emit Approved(3);
        vm.prank(ENTRY_POINT);
        acct.verify("");
        this.runBatch(fs);
        assertEq(usdc.allowance(address(acct), address(router)), 0);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertGt(weth.balanceOf(address(acct)), 0);
    }

    function test_dispatched_spec_example_refused() public {
        F[] memory fs = _tx(_exec(BATCH, _xs(_approve(address(usdc), address(router), type(uint256).max), _swap(1e18))));
        (uint256 code, uint256 at) = _check(fs);
        assertEq(code, ZeroAllowLib.UNSEALED);
        assertEq(at, 1);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(bytes("rejected"));
        acct.verify("");
    }

    function test_dispatched_try_and_single_refused() public {
        (uint256 code,) = _check(_tx(_exec(BATCH_TRY, _bracket(1e18))));
        assertEq(code, ZeroAllowLib.OUTSIDE_BATCH);
        bytes memory single = abi.encodePacked(address(usdc), uint256(0), abi.encodeWithSelector(0x095ea7b3, address(router), 5));
        (code,) = _check(_tx(F(2, 0, address(acct), 0, abi.encodeCall(Dispatch7579Account.execute, (SINGLE, single)))));
        assertEq(code, ZeroAllowLib.OUTSIDE_BATCH);
        single = abi.encodePacked(address(usdc), uint256(0), abi.encodeWithSelector(0xa9059cbb, address(router), 5));
        (code,) = _check(_tx(F(2, 0, address(acct), 0, abi.encodeCall(Dispatch7579Account.execute, (SINGLE, single)))));
        assertEq(code, ZeroAllowLib.OK);
    }

    function test_dispatched_delegatecall_and_nested_self_refused() public {
        (uint256 code, uint256 at) = _check(_tx(_exec(DELEGATE, _bracket(1e18))));
        assertEq(code, ZeroAllowLib.SELF_CALL);
        assertEq(at, 1);
        Dispatch7579Account.Execution[] memory xs = _bracket(1e18);
        xs[1] = _x(address(acct), abi.encodeCall(Dispatch7579Account.execute, (BATCH, abi.encode(_bracket(1)))));
        (code, at) = _check(_tx(_exec(BATCH, xs)));
        assertEq(code, ZeroAllowLib.SELF_CALL);
        assertEq(at, 1);
    }

    function test_dispatched_direct_frame_clears_execution() public {
        F[] memory fs = new F[](3);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeCall(PolicyVerified.verify, ("")));
        fs[1] = _exec(BATCH, _bracket(1e18));
        fs[2] = F(2, 0, address(usdc), 0, abi.encodeWithSelector(0x70a08231, address(acct)));
        (uint256 code,) = _check(fs);
        assertEq(code, ZeroAllowLib.OK);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(bytes("rejected"));
        acct.verify("");
    }

    function test_dispatched_seal_catches_false_revoke() public {
        FalseOnZeroApprove t = new FalseOnZeroApprove();
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](3);
        xs[0] = _approve(address(t), address(router), 5e18);
        xs[1] = _approve(address(t), address(router), 0);
        xs[2] = _seal();
        F[] memory fs = _tx(_exec(BATCH, xs));
        _verify(fs);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(t), address(router), 5e18));
        this.runBatch(fs);
    }

    function test_dispatched_seal_checks_only_executions_before_it() public {
        vm.prank(address(acct));
        usdc.approve(address(router), 9);
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](5);
        xs[0] = _approve(address(usdc), attacker, 7);
        xs[1] = _approve(address(usdc), attacker, 0);
        xs[2] = _seal();
        xs[3] = _approve(address(usdc), address(router), 0);
        xs[4] = _seal();
        F[] memory fs = _tx(_exec(BATCH, xs));
        _verify(fs);
        this.runBatch(fs);
        assertEq(usdc.allowance(address(acct), address(router)), 0);
    }

    function test_dispatched_second_seal_catches_grant_between() public {
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](5);
        xs[0] = _approve(address(usdc), address(router), 5);
        xs[1] = _approve(address(usdc), address(router), 0);
        xs[2] = _seal();
        xs[3] = _approve(address(usdc), attacker, 7);
        xs[4] = _seal();
        F[] memory fs = _tx(_exec(BATCH, xs));
        _verify(fs);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(usdc), attacker, 7));
        this.runBatch(fs);
    }

    function test_dispatched_grant_after_last_seal_refused() public {
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](3);
        xs[0] = _approve(address(usdc), address(router), 5);
        xs[1] = _seal();
        xs[2] = _approve(address(usdc), address(router), 0);
        (uint256 code,) = _check(_tx(_exec(BATCH, xs)));
        assertEq(code, ZeroAllowLib.UNSEALED);
    }

    function test_dispatched_truncated_unparseable() public {
        bytes memory d = abi.encodeCall(Dispatch7579Account.execute, (BATCH, abi.encode(_bracket(1e18))));
        assembly {
            mstore(d, sub(mload(d), 40))
        }
        (uint256 code, uint256 at) = _check(_tx(F(2, 0, address(acct), 0, d)));
        assertEq(code, ZeroAllowLib.UNPARSEABLE);
        assertEq(at, 1);
    }

    function test_policy_is_not_a_frame_validator() public {
        (bool ok,) = address(policy).staticcall(abi.encodeWithSignature("isModuleType(uint256)", 11));
        assertFalse(ok);
        (ok,) = address(policy).staticcall(abi.encodeWithSignature("validateFrame(bytes)", ""));
        assertFalse(ok);
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](1);
        xs[0] = _x(address(usdc), abi.encodeWithSelector(0xa9059cbb, attacker, 1_000e18));
        F[] memory fs = _tx(_exec(BATCH, xs));
        (uint256 code,) = _check(fs);
        assertEq(code, ZeroAllowLib.OK);
        store.setSig(attacker, 1, bytes32(0), 1);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(bytes("sig"));
        acct.verify("");
    }

    function _hidden7821(address token) internal view returns (bytes memory) {
        bytes memory approveData = abi.encodeWithSelector(0x095ea7b3, attacker, type(uint256).max);
        bytes memory batch = abi.encodePacked(
            abi.encode(uint256(0x60), uint256(0x40), uint256(0), uint256(1), uint256(0x20)),
            abi.encode(token, uint256(0), uint256(0x60), approveData.length),
            approveData,
            new bytes(28)
        );
        bytes[] memory batches = new bytes[](1);
        batches[0] = batch;
        return abi.encode(batches);
    }

    function test_erc7821_batch_of_batches_cannot_hide_a_grant() public {
        Solady7821LikeAccount a = new Solady7821LikeAccount(owner, address(ops), address(policy));
        bytes32 batches = bytes32((uint256(1) << 248) | (uint256(0x78210002) << 176));
        bytes memory data = abi.encodeCall(Solady7821LikeAccount.execute, (batches, _hidden7821(address(usdc))));
        store.load(address(a), _tx(F(2, 0, address(a), 0, data)));
        vm.prank(address(a));
        (uint256 code,) = policy.check();
        assertEq(code, ZeroAllowLib.SELF_CALL);
        vm.prank(address(a));
        (bool ok,) = address(a).call(data);
        assertTrue(ok);
        assertEq(usdc.allowance(address(a), attacker), type(uint256).max);
    }

    function test_erc7579_mode_must_be_default_beyond_call_and_exec_type() public view {
        bytes memory ec = abi.encode(_bracket(1e18));
        (uint256 code,) = parser.parse(abi.encodeCall(Dispatch7579Account.execute, (BATCH, ec)));
        assertEq(code, ZeroAllowLib.OK);
        bytes32[3] memory odd = [
            bytes32(uint256(BATCH) | (uint256(0x78210001) << 176)),
            bytes32(uint256(BATCH) | (uint256(1) << 200)),
            bytes32(uint256(BATCH) | 1)
        ];
        for (uint256 i; i < 3; ++i) {
            (code,) = parser.parse(abi.encodeCall(Dispatch7579Account.execute, (odd[i], ec)));
            assertEq(code, ZeroAllowLib.SELF_CALL);
        }
    }

    function testFuzz_virtualBlob_matches_abi_decode(uint256 seed, bool single, bool tryMode) public view {
        uint256 n = single ? 1 : seed % 6;
        Dispatch7579Account.Execution[] memory xs = new Dispatch7579Account.Execution[](n);
        for (uint256 k; k < n; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            bytes memory data = new bytes(r % 300);
            for (uint256 j; j < data.length; ++j) data[j] = bytes1(uint8(uint256(keccak256(abi.encode(r, j)))));
            xs[k] = Dispatch7579Account.Execution(address(uint160(r >> 8)), r % 1e18, data);
        }
        bytes32 mode = bytes32((uint256(single ? 0 : 1) << 248) | (uint256(tryMode ? 1 : 0) << 240));
        bytes memory ec = single ? abi.encodePacked(xs[0].target, xs[0].value, xs[0].callData) : abi.encode(xs);
        (uint256 code, bytes memory vb) = parser.parse(abi.encodeCall(Dispatch7579Account.execute, (mode, ec)));
        assertEq(code, ZeroAllowLib.OK);
        assertEq(ZeroAllowLib.count(vb), n);
        for (uint256 k; k < n; ++k) {
            assertEq(ZeroAllowLib.word(vb, k, 0), uint160(xs[k].target));
            assertEq(ZeroAllowLib.word(vb, k, 1), 2);
            assertEq(ZeroAllowLib.word(vb, k, 2), !single && !tryMode && k + 1 < n ? 4 : 0);
            assertEq(ZeroAllowLib.word(vb, k, 3), xs[k].value);
            assertEq(ZeroAllowLib.word(vb, k, 4), xs[k].callData.length);
            uint256 h = xs[k].callData.length < 0xe0 ? xs[k].callData.length : 0xe0;
            for (uint256 j; j < 0xe0; ++j) {
                bytes1 got;
                assembly {
                    got := mload(add(add(add(vb, 0xe0), mul(k, 0x180)), j))
                }
                assertEq(got, j < h ? xs[k].callData[j] : bytes1(0));
            }
        }
    }

    function testFuzz_virtualBlob_total_on_garbage(bytes memory tail, uint8 callType, uint8 execType) public view {
        bytes memory d = abi.encodePacked(
            bytes4(0xe9ae5c53), bytes32((uint256(callType % 3) << 248) | (uint256(execType % 3) << 240)), tail
        );
        (uint256 code,) = parser.parse(d);
        assertTrue(
            code == ZeroAllowLib.OK || code == ZeroAllowLib.UNPARSEABLE || code == ZeroAllowLib.SELF_CALL
        );
    }

    function testFuzz_virtualBlob_total_on_mutations(uint256 seed, uint256 pos, uint256 val, bool single) public view {
        Dispatch7579Account.Execution[] memory xs = _bracket(1e18 + seed % 1e18);
        bytes memory ec = single ? abi.encodePacked(xs[0].target, xs[0].value, xs[0].callData) : abi.encode(xs);
        bytes memory d = abi.encodeCall(Dispatch7579Account.execute, (single ? SINGLE : BATCH, ec));
        uint256 at = pos % (d.length - 31);
        if (seed % 3 == 0) val = val % (d.length * 2);
        assembly {
            mstore(add(add(d, 0x20), at), val)
        }
        (uint256 code, bytes memory vb) = parser.parse(d);
        assertTrue(code == ZeroAllowLib.OK || code == ZeroAllowLib.UNPARSEABLE || code == ZeroAllowLib.SELF_CALL);
        if (code == ZeroAllowLib.OK) {
            uint256 n = ZeroAllowLib.count(vb);
            for (uint256 k; k < n; ++k) assertLe(ZeroAllowLib.word(vb, k, 4), d.length);
        }
    }

    function _dialectSetup() internal returns (CoinbaseLikeAccount cb, LightLikeAccount la) {
        cb = new CoinbaseLikeAccount(owner, address(ops), address(policy));
        la = new LightLikeAccount(owner, address(ops), address(policy));
        usdc.mint(address(cb), 1_000e18);
        usdc.mint(address(la), 1_000e18);
    }

    function _run(address account, F[] memory fs) external {
        store.load(account, fs);
        for (uint256 i; i < fs.length; ++i) {
            if (fs[i].mode != 2) continue;
            store.setCur(i);
            vm.prank(account);
            (bool ok, bytes memory r) = fs[i].target.call{value: fs[i].value}(fs[i].data);
            if (!ok) {
                assembly {
                    revert(add(r, 0x20), mload(r))
                }
            }
        }
    }

    function _check2(address account, F[] memory fs) internal returns (uint256 code, uint256 at) {
        store.load(account, fs);
        vm.prank(account);
        return policy.check();
    }

    function _txFor(address account, bytes memory data) internal pure returns (F[] memory fs) {
        fs = new F[](2);
        fs[0] = F(1, 3, account, 0, abi.encodeCall(PolicyVerified.verify, ("")));
        fs[1] = F(2, 0, account, 0, data);
    }

    function _bracketFor(address to) internal view returns (CoinbaseLikeAccount.Call[] memory calls) {
        calls = new CoinbaseLikeAccount.Call[](4);
        calls[0] = CoinbaseLikeAccount.Call(address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 100e18));
        calls[1] = CoinbaseLikeAccount.Call(
            address(router), 0, abi.encodeCall(VulnerableRouter.swapExactIn, (address(usdc), address(weth), 100e18, 0, to))
        );
        calls[2] = CoinbaseLikeAccount.Call(address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 0));
        calls[3] = CoinbaseLikeAccount.Call(address(seal), 0, abi.encodeCall(ZeroAllowSeal.checkFrames, (new ZeroAllowSeal.Out[](0))));
    }

    function _arraysOf(CoinbaseLikeAccount.Call[] memory calls)
        internal
        pure
        returns (address[] memory dest, uint256[] memory value, bytes[] memory func)
    {
        dest = new address[](calls.length);
        value = new uint256[](calls.length);
        func = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) (dest[i], value[i], func[i]) = (calls[i].target, calls[i].value, calls[i].data);
    }

    function test_coinbase_style_account() public {
        (CoinbaseLikeAccount cb,) = _dialectSetup();
        F[] memory fs = _txFor(address(cb), abi.encodeCall(CoinbaseLikeAccount.executeBatch, (_bracketFor(address(cb)))));
        (uint256 code,) = _check2(address(cb), fs);
        assertEq(code, ZeroAllowLib.OK);
        store.load(address(cb), fs);
        vm.prank(ENTRY_POINT);
        cb.verify("");
        this._run(address(cb), fs);
        assertEq(usdc.allowance(address(cb), address(router)), 0);
        assertEq(usdc.balanceOf(address(cb)), 900e18);

        CoinbaseLikeAccount.Call[] memory leaky = _bracketFor(address(cb));
        assembly {
            mstore(leaky, 2)
        }
        (code,) = _check2(address(cb), _txFor(address(cb), abi.encodeCall(CoinbaseLikeAccount.executeBatch, (leaky))));
        assertEq(code, ZeroAllowLib.UNSEALED);
        (code,) = _check2(
            address(cb),
            _txFor(address(cb), abi.encodeCall(CoinbaseLikeAccount.execute, (address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 5))))
        );
        assertEq(code, ZeroAllowLib.OUTSIDE_BATCH);
    }

    function test_lightaccount_style_account() public {
        (, LightLikeAccount la) = _dialectSetup();
        (address[] memory dest, uint256[] memory value, bytes[] memory func) = _arraysOf(_bracketFor(address(la)));
        F[] memory fs = _txFor(address(la), abi.encodeWithSelector(0x47e1da2a, dest, value, func));
        (uint256 code,) = _check2(address(la), fs);
        assertEq(code, ZeroAllowLib.OK);
        this._run(address(la), fs);
        assertEq(usdc.allowance(address(la), address(router)), 0);

        (code,) = _check2(address(la), _txFor(address(la), abi.encodeWithSelector(0x18dfb3c7, dest, func)));
        assertEq(code, ZeroAllowLib.OK);
        uint256[] memory none = new uint256[](0);
        (code,) = _check2(address(la), _txFor(address(la), abi.encodeWithSelector(0x47e1da2a, dest, none, func)));
        assertEq(code, ZeroAllowLib.OK);
        uint256[] memory short = new uint256[](2);
        (code,) = _check2(address(la), _txFor(address(la), abi.encodeWithSelector(0x47e1da2a, dest, short, func)));
        assertEq(code, ZeroAllowLib.UNPARSEABLE);
        address[] memory three = new address[](3);
        (code,) = _check2(address(la), _txFor(address(la), abi.encodeWithSelector(0x18dfb3c7, three, func)));
        assertEq(code, ZeroAllowLib.UNPARSEABLE);
    }

    function _randomCalls(uint256 seed, uint256 n) internal pure returns (CoinbaseLikeAccount.Call[] memory calls) {
        calls = new CoinbaseLikeAccount.Call[](n);
        for (uint256 k; k < n; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            bytes memory data = new bytes(r % 300);
            for (uint256 j; j < data.length; ++j) data[j] = bytes1(uint8(uint256(keccak256(abi.encode(r, j)))));
            calls[k] = CoinbaseLikeAccount.Call(address(uint160(r >> 8)), r % 1e18, data);
        }
    }

    function _assertMatches(bytes memory d, CoinbaseLikeAccount.Call[] memory calls, bool values, bool atomic) internal view {
        (uint256 code, bytes memory vb) = parser.parse(d);
        assertEq(code, ZeroAllowLib.OK);
        uint256 n = calls.length;
        assertEq(ZeroAllowLib.count(vb), n);
        for (uint256 k; k < n; ++k) {
            assertEq(ZeroAllowLib.word(vb, k, 0), uint160(calls[k].target));
            assertEq(ZeroAllowLib.word(vb, k, 2), atomic && k + 1 < n ? 4 : 0);
            assertEq(ZeroAllowLib.word(vb, k, 3), values ? calls[k].value : 0);
            assertEq(ZeroAllowLib.word(vb, k, 4), calls[k].data.length);
            uint256 h = calls[k].data.length < 0xe0 ? calls[k].data.length : 0xe0;
            for (uint256 j; j < h; ++j) {
                bytes1 got;
                assembly {
                    got := mload(add(add(add(vb, 0xe0), mul(k, 0x180)), j))
                }
                assertEq(got, calls[k].data[j]);
            }
        }
    }

    function testFuzz_dialects_match_abi_decode(uint256 seed, uint8 which) public view {
        uint256 n = seed % 6;
        CoinbaseLikeAccount.Call[] memory calls = _randomCalls(seed, n);
        (address[] memory dest, uint256[] memory value, bytes[] memory func) = _arraysOf(calls);
        uint256 w = which % 4;
        if (w == 0) _assertMatches(abi.encodeCall(CoinbaseLikeAccount.executeBatch, (calls)), calls, true, true);
        else if (w == 1) _assertMatches(abi.encodeWithSelector(0x47e1da2a, dest, value, func), calls, true, true);
        else if (w == 2) _assertMatches(abi.encodeWithSelector(0x18dfb3c7, dest, func), calls, false, true);
        else if (n > 0) {
            CoinbaseLikeAccount.Call[] memory one = new CoinbaseLikeAccount.Call[](1);
            one[0] = calls[0];
            _assertMatches(abi.encodeCall(CoinbaseLikeAccount.execute, (calls[0].target, calls[0].value, calls[0].data)), one, true, false);
        }
    }

    function testFuzz_dialects_total_on_mutations(uint256 seed, uint256 pos, uint256 val, uint8 which) public view {
        CoinbaseLikeAccount.Call[] memory calls = _bracketFor(address(uint160(seed)));
        (address[] memory dest, uint256[] memory value, bytes[] memory func) = _arraysOf(calls);
        uint256 w = which % 4;
        bytes memory d = w == 0
            ? abi.encodeCall(CoinbaseLikeAccount.executeBatch, (calls))
            : w == 1
                ? abi.encodeWithSelector(0x47e1da2a, dest, value, func)
                : w == 2 ? abi.encodeWithSelector(0x18dfb3c7, dest, func) : abi.encodeCall(CoinbaseLikeAccount.execute, (dest[0], 0, func[0]));
        uint256 at = 4 + pos % (d.length - 35);
        if (seed % 3 == 0) val = val % (d.length * 2);
        assembly {
            mstore(add(add(d, 0x20), at), val)
        }
        (uint256 code, bytes memory vb) = parser.parse(d);
        assertTrue(code == ZeroAllowLib.OK || code == ZeroAllowLib.UNPARSEABLE);
        if (code == ZeroAllowLib.OK) {
            for (uint256 k; k < ZeroAllowLib.count(vb); ++k) assertLe(ZeroAllowLib.word(vb, k, 4), d.length);
        }
    }
}
