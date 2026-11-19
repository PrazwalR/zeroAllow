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
        r3 = new MockV3Router(address(f3));
        f2 = new MockV2Factory();
        ur = new MockUniversalRouter(address(p2), address(f2), address(f3));
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
}
