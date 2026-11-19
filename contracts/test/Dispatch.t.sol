// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {F, Blob, FrameStore, MockFrameOps} from "./utils/FrameKit.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowPolicy} from "../src/ZeroAllowPolicy.sol";
import {MockERC20, FalseOnZeroApprove, VulnerableRouter, Dispatch7579Account} from "../src/mocks/Mocks.sol";

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
        fs[0] = F(1, 3, address(acct), 0, abi.encodeCall(Dispatch7579Account.verify, ("")));
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
        fs[0] = F(1, 3, address(acct), 0, abi.encodeCall(Dispatch7579Account.verify, ("")));
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

    function test_policy_is_erc8286_frame_validator() public {
        assertTrue(policy.isModuleType(11));
        assertFalse(policy.isModuleType(1));
        store.load(address(acct), _tx(_exec(BATCH, _bracket(1e18))));
        vm.prank(address(acct));
        assertEq(policy.validateFrame(""), 3);
        store.load(address(acct), _tx(_exec(BATCH, _xs(_approve(address(usdc), address(router), 1), _swap(1)))));
        vm.prank(address(acct));
        assertEq(policy.validateFrame(""), 0);
        vm.expectRevert(ZeroAllowPolicy.NotSender.selector);
        policy.validateFrame("");
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
}
