// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {F, FrameStore, MockFrameOps} from "./utils/FrameKit.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowAccount} from "../src/ZeroAllowAccount.sol";
import {ZeroAllowSwapper} from "../src/ZeroAllowSwapper.sol";
import {
    MockERC20,
    MockPermit2,
    MockV2Factory,
    MockV2Pair,
    MockV3Factory,
    MockV3Router,
    MockUniversalRouter,
    MockPoolManager,
    MockV2Router,
    GreedyRouter,
    IV3CallbackLike
} from "../src/mocks/Mocks.sol";

contract GreedyPool {
    function swap(address, bool, int256 amountSpecified, uint160, bytes calldata) external returns (int256, int256) {
        IV3CallbackLike(msg.sender).uniswapV3SwapCallback(amountSpecified * 2, -1, "");
        return (amountSpecified * 2, -1);
    }
}

contract GreedyFactory {
    address public immutable pool = address(new GreedyPool());

    function getPool(address, address, uint24) external view returns (address) {
        return pool;
    }
}

contract RoutesTest is Test {
    address constant ENTRY_POINT = address(0xaa);
    address constant MSG_SENDER = address(1);

    FrameStore store;
    MockFrameOps ops;
    MockPermit2 p2;
    ZeroAllowSeal seal;
    ZeroAllowAccount acct;
    ZeroAllowSwapper sw;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 dai;
    MockV3Factory f3;
    MockV3Router r3;
    MockV2Factory f2;
    MockUniversalRouter ur;
    MockPoolManager pm;
    MockPoolManager.PoolKey key;
    address owner;
    address attacker = address(0xbad);
    address alice = makeAddr("alice");

    function setUp() public {
        owner = makeAddr("owner");
        store = new FrameStore();
        ops = new MockFrameOps(store);
        p2 = new MockPermit2();
        seal = new ZeroAllowSeal(address(ops), address(p2));
        acct = new ZeroAllowAccount(owner, address(ops), address(seal), address(p2));
        sw = new ZeroAllowSwapper();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");
        dai = new MockERC20("Dai", "DAI");
        f3 = new MockV3Factory();
        f2 = new MockV2Factory();
        r3 = new MockV3Router(address(f3), address(f2));
        pm = new MockPoolManager();
        ur = new MockUniversalRouter(address(p2), address(f2), address(f3), address(pm));
        (address c0, address c1) = address(usdc) < address(weth) ? (address(usdc), address(weth)) : (address(weth), address(usdc));
        key = MockPoolManager.PoolKey(c0, c1, 3000, 60, address(0));
        usdc.mint(address(pm), 2_000_000e18);
        weth.mint(address(pm), 1_000e18);
        (uint256 r0, uint256 r1) = c0 == address(usdc) ? (uint256(2_000_000e18), uint256(1_000e18)) : (uint256(1_000e18), uint256(2_000_000e18));
        pm.initialize(key, r0, r1);
        _seed(f3.createPool(address(usdc), address(weth), 3000), usdc, 2_000_000e18, weth, 1_000e18);
        _seed(f3.createPool(address(weth), address(dai), 500), weth, 1_000e18, dai, 2_000_000e18);
        address pair = f2.createPair(address(usdc), address(weth));
        _seed(pair, usdc, 2_000_000e18, weth, 1_000e18);
        MockV2Pair(pair).sync();
        usdc.mint(address(acct), 1_000e18);
        usdc.mint(alice, 1_000e18);
        store.setSig(owner, 1, bytes32(0), 1);
    }

    function _seed(address at, MockERC20 a, uint256 x, MockERC20 b, uint256 y) internal {
        a.mint(at, x);
        b.mint(at, y);
    }

    function _s(address t, bytes memory d, bool atomic) internal pure returns (F memory) {
        return F(2, atomic ? 4 : 0, t, 0, d);
    }

    function _tx(F memory a, F memory b) internal view returns (F[] memory fs) {
        fs = new F[](3);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeWithSelector(0xce4d01a3, uint256(0)));
        (fs[1], fs[2]) = (a, b);
    }

    function _validate(F[] memory fs) internal {
        store.load(address(acct), fs);
        vm.prank(ENTRY_POINT);
        acct.validate(0);
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

    function _path1() internal view returns (bytes memory) {
        return abi.encodePacked(address(usdc), uint24(3000), address(weth));
    }

    function _direct(bytes memory path, uint256 amt, uint256 minOut) internal view returns (F[] memory) {
        return _tx(
            _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(sw), amt), true),
            _s(address(sw), abi.encodeCall(sw.swapV3, (path, address(f3), amt, minOut, address(acct), block.timestamp)), false)
        );
    }

    function test_v3_direct_matches_router_without_any_approval() public {
        uint256 snap = vm.snapshotState();
        vm.startPrank(alice);
        usdc.approve(address(r3), 100e18);
        uint256 viaRouter = r3.exactInputSingle(
            MockV3Router.ExactInputSingleParams(address(usdc), address(weth), 3000, alice, 100e18, 0, 0)
        );
        vm.stopPrank();
        vm.revertToState(snap);

        F[] memory fs = _direct(_path1(), 100e18, viaRouter);
        _validate(fs);
        this.runBatch(fs);
        assertEq(weth.balanceOf(address(acct)), viaRouter);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertEq(usdc.balanceOf(address(sw)), 0);
        assertEq(usdc.allowance(address(acct), address(r3)), 0);
        assertEq(usdc.allowance(address(acct), address(sw)), 0);
    }

    function test_v3_direct_multi_hop_leaves_nothing_in_swapper() public {
        bytes memory path = abi.encodePacked(address(usdc), uint24(3000), address(weth), uint24(500), address(dai));
        this.runBatch(_direct(path, 100e18, 1));
        assertGt(dai.balanceOf(address(acct)), 98e18);
        assertEq(weth.balanceOf(address(sw)) + usdc.balanceOf(address(sw)) + dai.balanceOf(address(sw)), 0);
    }

    function test_v3_callback_only_from_the_pool_being_called() public {
        vm.expectRevert(ZeroAllowSwapper.NotPool.selector);
        sw.uniswapV3SwapCallback(1, 0, "");
        usdc.mint(address(sw), 5e18);
        GreedyFactory g = new GreedyFactory();
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSwapper.Overpay.selector, 10e18, 5e18));
        sw.swapV3(_path1(), address(g), 5e18, 0, address(this), block.timestamp);
    }

    function test_v3_slippage_unwinds_the_transfer() public {
        vm.expectRevert();
        this.runBatch(_direct(_path1(), 100e18, 1e18));
        assertEq(usdc.balanceOf(address(acct)), 1_000e18);
        assertEq(usdc.balanceOf(address(sw)), 0);
    }

    function test_v3_router_exploit_drains_approver_not_direct_user() public {
        vm.startPrank(alice);
        usdc.approve(address(r3), type(uint256).max);
        r3.exactInputSingle(MockV3Router.ExactInputSingleParams(address(usdc), address(weth), 3000, alice, 100e18, 0, 0));
        vm.stopPrank();
        this.runBatch(_direct(_path1(), 100e18, 1));

        vm.startPrank(attacker);
        r3.multicall(address(usdc), abi.encodeWithSelector(0x23b872dd, alice, attacker, 900e18));
        vm.expectRevert(bytes("call"));
        r3.multicall(address(usdc), abi.encodeWithSelector(0x23b872dd, address(acct), attacker, 1));
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
    }

    function _urSwap(bool payerIsUser) internal view returns (bytes memory) {
        return abi.encode(MSG_SENDER, uint256(100e18), uint256(1), _path1(), payerIsUser);
    }

    function test_ur_payer_is_user_false_needs_no_permit2() public {
        vm.startPrank(alice);
        usdc.approve(address(p2), type(uint256).max);
        p2.approve(address(usdc), address(ur), type(uint160).max, type(uint48).max);
        bytes[] memory one = new bytes[](1);
        one[0] = _urSwap(true);
        ur.execute(hex"00", one, block.timestamp);
        vm.stopPrank();
        assertGt(weth.balanceOf(alice), 0);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _urSwap(false);
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        F[] memory fs = _tx(
            _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 100e18), true),
            _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"0004", inputs, block.timestamp), false)
        );
        _validate(fs);
        this.runBatch(fs);
        assertGt(weth.balanceOf(address(acct)), 0);
        assertEq(usdc.balanceOf(address(ur)) + weth.balanceOf(address(ur)), 0);
        (uint160 left,,) = p2.allowance(address(acct), address(usdc), address(ur));
        assertEq(left, 0);
        assertEq(usdc.allowance(address(acct), address(p2)), 0);

        vm.startPrank(attacker);
        ur.multicall(address(p2), abi.encodeCall(p2.transferFrom, (alice, attacker, 900e18, address(usdc))));
        vm.expectRevert(bytes("call"));
        ur.multicall(address(p2), abi.encodeCall(p2.transferFrom, (address(acct), attacker, 1, address(usdc))));
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
    }

    function test_ur_v2_exact_out_sweeps_the_leftover() public {
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(usdc), address(weth));
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(MSG_SENDER, uint256(1e16), uint256(50e18), path, false);
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        this.runBatch(
            _tx(
                _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 50e18), true),
                _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"0904", inputs, block.timestamp), false)
            )
        );
        assertEq(weth.balanceOf(address(acct)), 1e16);
        assertGt(usdc.balanceOf(address(acct)), 975e18);
        assertEq(usdc.balanceOf(address(ur)), 0);
    }

    function test_seal_closes_both_permit2_layers() public {
        bytes[] memory one = new bytes[](1);
        one[0] = _urSwap(true);
        F[] memory fs = new F[](7);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeWithSelector(0xce4d01a3, uint256(0)));
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(p2), type(uint256).max), true);
        fs[2] = _s(address(p2), abi.encodeCall(p2.approve, (address(usdc), address(ur), type(uint160).max, type(uint48).max)), true);
        fs[3] = _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"00", one, block.timestamp), true);
        fs[4] = _s(address(p2), abi.encodeCall(p2.approve, (address(usdc), address(ur), 0, 0)), true);
        fs[5] = _s(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(p2), 0), true);
        fs[6] = _s(address(seal), abi.encodeCall(ZeroAllowSeal.checkFrames, (new ZeroAllowSeal.Out[](0))), false);
        _validate(fs);
        this.runBatch(fs);
        (uint160 left,,) = p2.allowance(address(acct), address(usdc), address(ur));
        assertEq(left, 0);
        assertEq(usdc.allowance(address(acct), address(p2)), 0);

        fs[4] = _s(address(usdc), abi.encodeWithSelector(0x70a08231, address(acct)), true);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 4, address(usdc), address(ur), 0));
        this.runBatch(fs);
    }

    function _v4(uint8 settle, bytes memory settleParams, uint256 amountIn) internal view returns (bytes memory) {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            MockUniversalRouter.ExactInputSingleParams(key, address(usdc) == key.currency0, uint128(amountIn), 1, "")
        );
        params[1] = settleParams;
        params[2] = abi.encode(address(weth), uint256(1));
        return abi.encode(abi.encodePacked(uint8(0x06), settle, uint8(0x0f)), params);
    }

    function test_ur_v4_settle_from_router_balance_needs_no_permit2() public {
        vm.startPrank(alice);
        usdc.approve(address(p2), type(uint256).max);
        p2.approve(address(usdc), address(ur), type(uint160).max, type(uint48).max);
        bytes[] memory one = new bytes[](1);
        one[0] = _v4(0x0c, abi.encode(address(usdc), uint256(100e18)), 100e18);
        ur.execute(hex"10", one, block.timestamp);
        vm.stopPrank();
        assertGt(weth.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 900e18);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _v4(0x0b, abi.encode(address(usdc), uint256(0), false), 100e18);
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        F[] memory fs = _tx(
            _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 100e18), true),
            _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"1004", inputs, block.timestamp), false)
        );
        _validate(fs);
        this.runBatch(fs);
        assertGt(weth.balanceOf(address(acct)), 0);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertEq(usdc.balanceOf(address(ur)) + weth.balanceOf(address(ur)), 0);

        vm.startPrank(attacker);
        ur.multicall(address(p2), abi.encodeCall(p2.transferFrom, (alice, attacker, 900e18, address(usdc))));
        vm.expectRevert(bytes("call"));
        ur.multicall(address(p2), abi.encodeCall(p2.transferFrom, (address(acct), attacker, 1, address(usdc))));
        vm.stopPrank();
    }

    function test_ur_v4_overfunded_settle_returns_the_rest() public {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _v4(0x0b, abi.encode(address(usdc), uint256(0), false), 60e18);
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        this.runBatch(
            _tx(
                _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 100e18), true),
                _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"1004", inputs, block.timestamp), false)
            )
        );
        assertEq(usdc.balanceOf(address(acct)), 940e18);
        assertEq(usdc.balanceOf(address(ur)), 0);
    }

    function test_greedy_router_takes_whatever_the_bracket_allows() public {
        GreedyRouter g = new GreedyRouter();
        weth.mint(address(g), 1_000e18);
        usdc.mint(address(g), 1_000_000e18);
        bytes memory swap = abi.encodeCall(GreedyRouter.swapExactIn, (address(usdc), address(weth), 100e18, 0, address(acct)));
        F[] memory fs = new F[](5);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeWithSelector(0xce4d01a3, uint256(0)));
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(g), 1_000e18), true);
        fs[2] = _s(address(g), swap, true);
        fs[3] = _s(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(g), 0), true);
        fs[4] = _s(address(seal), abi.encodeCall(ZeroAllowSeal.checkFrames, (new ZeroAllowSeal.Out[](0))), false);
        uint256 snap = vm.snapshotState();
        this.runBatch(fs);
        assertEq(usdc.balanceOf(address(acct)), 0);
        vm.revertToState(snap);
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(g), 100e18), true);
        this.runBatch(fs);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertEq(usdc.allowance(address(acct), address(g)), 0);
    }

    function test_ur_permit2_transfer_from_becomes_a_plain_transfer() public {
        bytes memory swapAll = abi.encode(MSG_SENDER, uint256(1) << 255, uint256(1), _path1(), false);
        vm.startPrank(alice);
        usdc.approve(address(p2), type(uint256).max);
        p2.approve(address(usdc), address(ur), type(uint160).max, type(uint48).max);
        bytes[] memory asked = new bytes[](2);
        asked[0] = abi.encode(address(usdc), address(2), uint160(100e18));
        asked[1] = swapAll;
        ur.execute(hex"0200", asked, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 900e18);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = swapAll;
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        F[] memory fs = _tx(
            _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 100e18), true),
            _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"0004", inputs, block.timestamp), false)
        );
        _validate(fs);
        this.runBatch(fs);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertGt(weth.balanceOf(address(acct)), 0);
        assertEq(usdc.balanceOf(address(ur)), 0);
    }

    function test_v2_exact_out_matches_router_and_refunds() public {
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(usdc), address(weth));
        address[] memory pairs = new address[](1);
        pairs[0] = f2.getPair(address(usdc), address(weth));
        MockV2Router r2 = new MockV2Router(address(f2));
        uint256 snap = vm.snapshotState();
        vm.startPrank(alice);
        usdc.approve(address(r2), type(uint256).max);
        uint256 viaRouter = r2.swapTokensForExactTokens(1e16, 50e18, path, alice, block.timestamp)[0];
        vm.stopPrank();
        vm.revertToState(snap);

        F[] memory fs = _tx(
            _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(sw), 50e18), true),
            _s(address(sw), abi.encodeCall(sw.swapV2ExactOut, (pairs, address(usdc), 1e16, 50e18, address(acct), block.timestamp, 30)), false)
        );
        _validate(fs);
        this.runBatch(fs);
        assertEq(weth.balanceOf(address(acct)), 1e16);
        assertEq(usdc.balanceOf(address(acct)), 1_000e18 - viaRouter);
        assertEq(usdc.balanceOf(address(sw)), 0);
        vm.expectRevert();
        this.runBatch(
            _tx(
                _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(sw), 1e18), true),
                _s(address(sw), abi.encodeCall(sw.swapV2ExactOut, (pairs, address(usdc), 1e16, 1e18, address(acct), block.timestamp, 30)), false)
            )
        );
    }

    function test_swaprouter02_v2_functions() public {
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(usdc), address(weth));
        vm.startPrank(alice);
        usdc.approve(address(r3), type(uint256).max);
        uint256 out = r3.swapExactTokensForTokens(10e18, 1, path, MSG_SENDER);
        uint256 spent = r3.swapTokensForExactTokens(1e15, 10e18, path, alice);
        vm.stopPrank();
        assertEq(weth.balanceOf(alice), out + 1e15);
        assertEq(usdc.balanceOf(alice), 1_000e18 - 10e18 - spent);
    }

    function _nativePool() internal returns (MockPoolManager.PoolKey memory k) {
        k = MockPoolManager.PoolKey(address(0), address(usdc), 3000, 60, address(0));
        vm.deal(address(pm), 1_000 ether);
        usdc.mint(address(pm), 2_000_000e18);
        pm.initialize(k, 1_000 ether, 2_000_000e18);
    }

    function _plan(MockPoolManager.PoolKey memory k, bool ethIn, uint256 amountIn, bytes memory settle, address takeCurrency)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(MockUniversalRouter.ExactInputSingleParams(k, ethIn, uint128(amountIn), 1, ""));
        params[1] = settle;
        params[2] = abi.encode(takeCurrency, uint256(1));
        return abi.encode(abi.encodePacked(uint8(0x06), ethIn ? uint8(0x0c) : uint8(0x0b), uint8(0x0f)), params);
    }

    function test_v4_native_eth_in_and_out() public {
        MockPoolManager.PoolKey memory k = _nativePool();
        vm.deal(address(acct), 10 ether);
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = _plan(k, true, 1 ether, abi.encode(address(0), uint256(1 ether)), address(usdc));
        inputs[1] = abi.encode(address(0), MSG_SENDER, uint256(0));
        F[] memory fs = new F[](2);
        fs[0] = F(1, 3, address(acct), 0, abi.encodeWithSelector(0xce4d01a3, uint256(0)));
        fs[1] = F(2, 0, address(ur), 1 ether, abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"1004", inputs, block.timestamp));
        _validate(fs);
        this.runBatch(fs);
        assertEq(address(acct).balance, 9 ether);
        assertGt(usdc.balanceOf(address(acct)), 1_000e18);
        assertEq(address(ur).balance, 0);

        uint256 ethBefore = address(acct).balance;
        inputs[0] = _plan(k, false, 100e18, abi.encode(address(usdc), uint256(0), false), address(0));
        inputs[1] = abi.encode(address(usdc), MSG_SENDER, uint256(0));
        this.runBatch(
            _tx(
                _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, address(ur), 100e18), true),
                _s(address(ur), abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"1004", inputs, block.timestamp), false)
            )
        );
        assertGt(address(acct).balance, ethBefore);
        assertEq(usdc.balanceOf(address(ur)), 0);
    }
}
