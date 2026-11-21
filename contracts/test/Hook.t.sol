// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowHook} from "../src/ZeroAllowHook.sol";
import {MockERC20, FalseOnZeroApprove, VulnerableRouter, MockKernelLike} from "../src/mocks/Mocks.sol";

contract HookTest is Test {
    bytes32 constant BATCH = bytes32(uint256(1) << 248);
    bytes32 constant BATCH_TRY = bytes32((uint256(1) << 248) | (uint256(1) << 240));
    bytes32 constant DELEGATE = bytes32(uint256(0xff) << 248);

    ZeroAllowSeal seal;
    ZeroAllowHook hook;
    VulnerableRouter router;
    MockERC20 usdc;
    MockERC20 weth;
    address entryPoint = makeAddr("entryPoint");
    address executor = makeAddr("executor");
    address attacker = address(0xbad);

    function setUp() public {
        seal = new ZeroAllowSeal(address(0), address(0));
        hook = new ZeroAllowHook(address(seal), address(0));
        router = new VulnerableRouter();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");
        usdc.mint(address(router), 1_000_000e18);
        weth.mint(address(router), 1_000_000e18);
    }

    function _kernel(bool scoped) internal returns (MockKernelLike k) {
        k = new MockKernelLike(entryPoint, executor, address(hook), scoped);
        usdc.mint(address(k), 1_000e18);
    }

    function _x(address t, bytes memory d) internal pure returns (MockKernelLike.Execution memory) {
        return MockKernelLike.Execution(t, 0, d);
    }

    function _swap(address to, uint256 amt) internal view returns (MockKernelLike.Execution memory) {
        return _x(address(router), abi.encodeCall(VulnerableRouter.swapExactIn, (address(usdc), address(weth), amt, 0, to)));
    }

    function _leaky(address k) internal view returns (MockKernelLike.Execution[] memory xs) {
        xs = new MockKernelLike.Execution[](2);
        xs[0] = _x(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(router), type(uint256).max));
        xs[1] = _swap(k, 100e18);
    }

    function _bracket(address k) internal view returns (MockKernelLike.Execution[] memory xs) {
        xs = new MockKernelLike.Execution[](3);
        xs[0] = _x(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(router), 100e18));
        xs[1] = _swap(k, 100e18);
        xs[2] = _x(address(usdc), abi.encodeWithSelector(0x095ea7b3, address(router), 0));
    }

    function _userOp(MockKernelLike k, bytes32 mode, MockKernelLike.Execution[] memory xs) internal {
        vm.prank(entryPoint);
        k.executeUserOp(abi.encodeCall(MockKernelLike.execute, (mode, abi.encode(xs))));
    }

    function test_user_op_path_v3_and_v4_signatures() public {
        for (uint256 i; i < 2; ++i) {
            MockKernelLike k = _kernel(i == 1);
            vm.expectRevert(abi.encodeWithSelector(ZeroAllowHook.Open.selector, 1, address(usdc), address(router), type(uint256).max));
            _userOp(k, BATCH, _leaky(address(k)));
            assertEq(usdc.allowance(address(k), address(router)), 0);

            _userOp(k, BATCH, _bracket(address(k)));
            assertEq(usdc.allowance(address(k), address(router)), 0);
            assertEq(usdc.balanceOf(address(k)), 900e18);

            vm.prank(attacker);
            vm.expectRevert(bytes("call"));
            router.multicall(address(usdc), abi.encodeWithSelector(0x23b872dd, address(k), attacker, 1));
        }
    }

    function test_executor_path() public {
        MockKernelLike k = _kernel(false);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowHook.Open.selector, 1, address(usdc), address(router), type(uint256).max));
        k.executeFromExecutor(BATCH, abi.encode(_leaky(address(k))));
        vm.prank(executor);
        k.executeFromExecutor(BATCH, abi.encode(_bracket(address(k))));
        assertEq(usdc.allowance(address(k), address(router)), 0);
    }

    function test_refuses_delegatecall_and_self_calls_passes_other_calls() public {
        MockKernelLike k = _kernel(false);
        vm.prank(entryPoint);
        vm.expectRevert(ZeroAllowHook.DelegateCall.selector);
        k.executeUserOp(abi.encodeCall(MockKernelLike.execute, (DELEGATE, abi.encodePacked(address(usdc), bytes("")))));

        MockKernelLike.Execution[] memory xs = _bracket(address(k));
        xs[1] = _x(address(k), abi.encodeCall(MockKernelLike.ping, ()));
        vm.expectRevert(ZeroAllowHook.SelfCall.selector);
        _userOp(k, BATCH, xs);

        vm.prank(entryPoint);
        k.executeUserOp(abi.encodeCall(MockKernelLike.ping, ()));
    }

    function test_try_mode_silent_revoke_is_caught() public {
        MockKernelLike k = _kernel(false);
        FalseOnZeroApprove t = new FalseOnZeroApprove();
        MockKernelLike.Execution[] memory xs = new MockKernelLike.Execution[](2);
        xs[0] = _x(address(t), abi.encodeWithSelector(0x095ea7b3, address(router), 5e18));
        xs[1] = _x(address(t), abi.encodeWithSelector(0x095ea7b3, address(router), 0));
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowHook.Open.selector, 1, address(t), address(router), 5e18));
        _userOp(k, BATCH_TRY, xs);
    }

    function test_module_types_and_gas() public {
        assertTrue(hook.isModuleType(4));
        assertTrue(hook.isModuleType(11));
        assertFalse(hook.isModuleType(1));
        MockKernelLike k = _kernel(false);
        bytes memory inner = abi.encodeCall(MockKernelLike.execute, (BATCH, abi.encode(_bracket(address(k)))));
        vm.prank(address(k));
        uint256 g = gasleft();
        bytes memory ctx = hook.preCheck(entryPoint, 0, inner);
        vm.prank(address(k));
        hook.postCheck(ctx);
        g -= gasleft();
        emit log_named_uint("hook pre+post gas, 3-call bracket", g);
        assertLt(g, 60_000);
    }
}
