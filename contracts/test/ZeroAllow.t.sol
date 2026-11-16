// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {F, Blob, FrameStore, MockFrameOps} from "./utils/FrameKit.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowAccount} from "../src/ZeroAllowAccount.sol";
import {
    MockERC20, UsdtLike, FalseOnZeroApprove, ZeroApproveReverts, MockNFT, VulnerableRouter
} from "../src/mocks/Mocks.sol";

contract ZeroAllowTest is Test {
    address constant ENTRY_POINT = address(0xaa);
    uint8 constant VERIFY = 1;
    uint8 constant SENDER = 2;
    uint8 constant DEFAULT = 0;

    FrameStore store;
    MockFrameOps ops;
    ZeroAllowSeal seal;
    ZeroAllowAccount acct;
    VulnerableRouter router;
    MockERC20 usdc;
    MockERC20 weth;
    address owner;
    uint256 ownerKey;
    address attacker = address(0xbad);

    event Approved(uint256 scope);

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        store = new FrameStore();
        ops = new MockFrameOps(store);
        seal = new ZeroAllowSeal(address(ops), address(0));
        acct = new ZeroAllowAccount(owner, address(ops), address(seal), address(0));
        router = new VulnerableRouter();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped Ether", "WETH");
        usdc.mint(address(router), 1_000_000e18);
        weth.mint(address(router), 1_000_000e18);
        usdc.mint(address(acct), 1_000e18);
        store.setSig(owner, 1, bytes32(0), 1);
    }

    function _v(address a) internal pure returns (F memory) {
        return F(VERIFY, 3, a, 0, abi.encodeWithSelector(0xce4d01a3, uint256(0)));
    }

    function _s(address t, bytes memory d, bool atomic) internal pure returns (F memory) {
        return F(SENDER, atomic ? 4 : 0, t, 0, d);
    }

    function _approve(address token, address spender, uint256 v, bool atomic) internal pure returns (F memory) {
        return _s(token, abi.encodeWithSelector(0x095ea7b3, spender, v), atomic);
    }

    function _swap(address to, uint256 amt, bool atomic) internal view returns (F memory) {
        return _s(
            address(router),
            abi.encodeCall(VulnerableRouter.swapExactIn, (address(usdc), address(weth), amt, 0, to)),
            atomic
        );
    }

    function _sealF(ZeroAllowSeal.Out[] memory outs) internal view returns (F memory) {
        return _s(address(seal), abi.encodeCall(ZeroAllowSeal.checkFrames, (outs)), false);
    }

    function _noOuts() internal pure returns (ZeroAllowSeal.Out[] memory) {
        return new ZeroAllowSeal.Out[](0);
    }

    function _bracket(address sender, address token, uint256 amt) internal view returns (F[] memory fs) {
        fs = new F[](5);
        fs[0] = _v(sender);
        fs[1] = _approve(token, address(router), amt, true);
        fs[2] = _swap(sender, amt, true);
        fs[3] = _approve(token, address(router), 0, true);
        fs[4] = _sealF(_noOuts());
    }

    function _specExample(address sender, uint256 amt) internal view returns (F[] memory fs) {
        fs = new F[](3);
        fs[0] = _v(sender);
        fs[1] = _approve(address(usdc), address(router), amt, true);
        fs[2] = _swap(sender, amt, false);
    }

    function _validate(F[] memory fs) internal {
        store.load(address(acct), fs);
        vm.prank(ENTRY_POINT);
        acct.validate(0);
    }

    function _expectRejected(F[] memory fs, uint256 code, uint256 at) internal {
        store.load(address(acct), fs);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowAccount.Rejected.selector, code, at));
        acct.validate(0);
    }

    function runBatch(address sender, F[] memory fs) external {
        store.load(sender, fs);
        for (uint256 i; i < fs.length; ++i) {
            if (fs[i].mode != SENDER) continue;
            store.setCur(i);
            vm.prank(sender);
            (bool ok, bytes memory r) = fs[i].target.call{value: fs[i].value}(fs[i].data);
            if (!ok) {
                assembly {
                    revert(add(r, 0x20), mload(r))
                }
            }
        }
    }

    function test_guard_accepts_bracket() public {
        store.load(address(acct), _bracket(address(acct), address(usdc), 100e18));
        vm.expectEmit(address(acct));
        emit Approved(3);
        vm.prank(ENTRY_POINT);
        acct.validate(0);
    }

    function test_guard_refuses_spec_example() public {
        _expectRejected(_specExample(address(acct), 100e18), ZeroAllowLib.UNSEALED, 1);
    }

    function test_guard_refuses_grant_outside_batch() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 100e18);
        fs[1].flags = 0;
        _expectRejected(fs, ZeroAllowLib.OUTSIDE_BATCH, 1);
    }

    function test_guard_refuses_self_call() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 100e18);
        fs[2] = _s(address(acct), abi.encodeWithSignature("execute(address,uint256,bytes)"), true);
        _expectRejected(fs, ZeroAllowLib.SELF_CALL, 2);
    }

    function test_guard_refuses_wrong_closer() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 100e18);
        fs[4] = _s(address(0xdead), abi.encodeCall(ZeroAllowSeal.checkFrames, (_noOuts())), false);
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
        fs[4] = _s(address(seal), abi.encodeWithSelector(ZeroAllowSeal.snapshot.selector, new address[](0)), false);
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
    }

    function test_guard_refuses_grant_sealed_in_other_batch() public {
        F[] memory fs = new F[](6);
        fs[0] = _v(address(acct));
        fs[1] = _approve(address(usdc), address(router), 1e18, true);
        fs[2] = _swap(address(acct), 1e18, false);
        fs[3] = _approve(address(usdc), address(router), 0, true);
        fs[4] = _approve(address(usdc), address(router), 0, true);
        fs[5] = _sealF(_noOuts());
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
    }

    function test_guard_refuses_short_calldata() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 100e18);
        fs[1].data = abi.encodePacked(bytes4(0x095ea7b3), bytes32(uint256(uint160(address(router)))));
        _expectRejected(fs, ZeroAllowLib.UNPARSEABLE, 1);
    }

    function test_guard_refuses_operator_and_increase_unsealed() public {
        F[] memory fs = _specExample(address(acct), 1e18);
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0xa22cb465, address(router), true), true);
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0x39509351, address(router), 1), true);
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
    }

    function test_guard_permit_for_owner_only() public {
        F[] memory fs = _specExample(address(acct), 1e18);
        bytes memory other = abi.encodeWithSelector(
            0xd505accf, address(0x1234), address(router), 1, 1, uint8(27), bytes32(0), bytes32(0)
        );
        fs[1] = _s(address(usdc), other, true);
        _validate(fs);
        fs[1].data = abi.encodeWithSelector(
            0xd505accf, address(acct), address(router), 1, 1, uint8(27), bytes32(0), bytes32(0)
        );
        _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);
    }

    function test_guard_ignores_default_mode_and_zero_spender() public {
        F[] memory fs = new F[](3);
        fs[0] = _v(address(acct));
        fs[1] = F(DEFAULT, 0, address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 1));
        fs[2] = _approve(address(usdc), address(0), 5, false);
        _validate(fs);
    }

    function test_guard_rejects_bad_signature() public {
        store.load(address(acct), _bracket(address(acct), address(usdc), 1e18));
        store.setSig(address(0xbeef), 1, bytes32(0), 1);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(ZeroAllowAccount.BadSignature.selector);
        acct.validate(0);
        store.setSig(owner, 1, bytes32(uint256(1)), 1);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(ZeroAllowAccount.BadSignature.selector);
        acct.validate(0);
        vm.expectRevert(ZeroAllowAccount.NotEntryPoint.selector);
        acct.validate(0);
    }

    function test_guard_permit2() public {
        address p2 = address(0x2222);
        ZeroAllowAccount a2 = new ZeroAllowAccount(owner, address(ops), address(seal), p2);
        F[] memory fs = new F[](3);
        fs[0] = _v(address(a2));
        fs[1] = _s(p2, abi.encodeWithSelector(0x87517c45, address(usdc), address(router), uint160(1), uint48(0)), true);
        fs[2] = _swap(address(a2), 1, false);
        store.load(address(a2), fs);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowAccount.Rejected.selector, ZeroAllowLib.UNSEALED, 1));
        a2.validate(0);
        fs[1] = _s(p2, abi.encodeWithSelector(0x2a2d80d1, address(a2), uint256(0x60), uint256(0)), true);
        store.load(address(a2), fs);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowAccount.Rejected.selector, ZeroAllowLib.UNPARSEABLE, 1));
        a2.validate(0);
    }

    function test_seal_bracket_leaves_zero() public {
        this.runBatch(address(acct), _bracket(address(acct), address(usdc), 100e18));
        assertEq(usdc.allowance(address(acct), address(router)), 0);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertGt(weth.balanceOf(address(acct)), 0);
    }

    function test_seal_reverts_batch_without_revoke() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 100e18);
        fs[1] = _approve(address(usdc), address(router), type(uint256).max, true);
        fs[3] = _s(address(usdc), abi.encodeWithSelector(0x70a08231, address(acct)), true);
        vm.expectRevert(
            abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(usdc), address(router), type(uint256).max)
        );
        this.runBatch(address(acct), fs);
        assertEq(usdc.balanceOf(address(acct)), 1_000e18);
    }

    function test_seal_catches_false_returning_revoke() public {
        FalseOnZeroApprove t = new FalseOnZeroApprove();
        t.mint(address(acct), 10e18);
        F[] memory fs = new F[](4);
        fs[0] = _v(address(acct));
        fs[1] = _approve(address(t), address(router), 5e18, true);
        fs[2] = _approve(address(t), address(router), 0, true);
        fs[3] = _sealF(_noOuts());
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(t), address(router), 5e18));
        this.runBatch(address(acct), fs);
    }

    function test_seal_usdt_zero_first() public {
        UsdtLike t = new UsdtLike();
        t.mint(address(acct), 10e18);
        vm.prank(address(acct));
        (bool ok,) = address(t).call(abi.encodeWithSelector(0x095ea7b3, address(router), 7));
        assertTrue(ok);
        F[] memory fs = new F[](5);
        fs[0] = _v(address(acct));
        fs[1] = _approve(address(t), address(router), 0, true);
        fs[2] = _approve(address(t), address(router), 5e18, true);
        fs[3] = _approve(address(t), address(router), 0, true);
        fs[4] = _sealF(_noOuts());
        this.runBatch(address(acct), fs);
        assertEq(t.allowance(address(acct), address(router)), 0);
    }

    function test_seal_bnb_residual_one() public {
        ZeroApproveReverts t = new ZeroApproveReverts();
        t.mint(address(acct), 10e18);
        F[] memory fs = new F[](4);
        fs[0] = _v(address(acct));
        fs[1] = _approve(address(t), address(router), 5e18, true);
        fs[2] = _approve(address(t), address(router), 1, true);
        fs[3] = _sealF(_noOuts());
        this.runBatch(address(acct), fs);
        assertEq(t.allowance(address(acct), address(router)), 1);
        fs[2] = _approve(address(t), address(router), 2, true);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(t), address(router), 5e18));
        this.runBatch(address(acct), fs);
    }

    function test_seal_nft_single_and_operator() public {
        MockNFT nft = new MockNFT();
        nft.mint(address(acct), 7);
        F[] memory fs = new F[](4);
        fs[0] = _v(address(acct));
        fs[1] = _approve(address(nft), address(router), 7, true);
        fs[2] = _approve(address(nft), address(0), 7, true);
        fs[3] = _sealF(_noOuts());
        this.runBatch(address(acct), fs);
        assertEq(nft.getApproved(7), address(0));
        fs[2] = _s(address(nft), abi.encodeWithSignature("ownerOf(uint256)", 7), true);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(nft), address(router), 7));
        this.runBatch(address(acct), fs);
        fs[1] = _s(address(nft), abi.encodeWithSelector(0xa22cb465, address(router), true), true);
        fs[2] = _s(address(nft), abi.encodeWithSelector(0xa22cb465, address(router), false), true);
        this.runBatch(address(acct), fs);
        assertFalse(nft.isApprovedForAll(address(acct), address(router)));
    }

    function test_seal_min_out() public {
        uint256 amt = 100e18;
        uint256 expect = router.quote(address(usdc), address(weth), amt);
        ZeroAllowSeal.Out[] memory outs = new ZeroAllowSeal.Out[](1);
        outs[0] = ZeroAllowSeal.Out(address(weth), expect);
        address[] memory toks = new address[](1);
        toks[0] = address(weth);
        F[] memory fs = new F[](6);
        fs[0] = _v(address(acct));
        fs[1] = _s(address(seal), abi.encodeCall(ZeroAllowSeal.snapshot, (toks)), true);
        fs[2] = _approve(address(usdc), address(router), amt, true);
        fs[3] = _swap(address(acct), amt, true);
        fs[4] = _approve(address(usdc), address(router), 0, true);
        fs[5] = _sealF(outs);
        this.runBatch(address(acct), fs);
        outs[0].amount = expect * 2;
        fs[5] = _sealF(outs);
        vm.expectRevert();
        this.runBatch(address(acct), fs);
    }

    function test_seal_explicit_mode() public {
        ZeroAllowLib.Key[] memory keys = new ZeroAllowLib.Key[](1);
        keys[0] = ZeroAllowLib.Key(ZeroAllowLib.ERC20, address(usdc), address(router), 0);
        vm.startPrank(address(acct));
        usdc.approve(address(router), 5);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 2, address(usdc), address(router), 0));
        seal.check(keys, _noOuts());
        usdc.approve(address(router), 0);
        seal.check(keys, _noOuts());
        vm.stopPrank();
    }

    function test_drain_spec_example_vs_zeroallow() public {
        address a = makeAddr("victimSpec");
        address b = makeAddr("victimZero");
        usdc.mint(a, 1_000e18);
        usdc.mint(b, 1_000e18);

        vm.startPrank(a);
        usdc.approve(address(router), type(uint256).max);
        router.swapExactIn(address(usdc), address(weth), 100e18, 0, a);
        vm.stopPrank();

        this.runBatch(b, _bracket(b, address(usdc), 100e18));

        vm.startPrank(attacker);
        router.multicall(
            address(usdc), abi.encodeWithSelector(0x23b872dd, a, attacker, usdc.balanceOf(a))
        );
        vm.expectRevert(bytes("call"));
        router.multicall(address(usdc), abi.encodeWithSelector(0x23b872dd, b, attacker, 1));
        vm.stopPrank();

        assertEq(usdc.balanceOf(a), 0);
        assertEq(usdc.balanceOf(b), 900e18);
        assertEq(usdc.balanceOf(attacker), 900e18);
    }

    function testFuzz_seal_passes_iff_residual_at_most_one(uint96 approved, uint96 pulled, bool revoke) public {
        vm.assume(approved > 0);
        pulled = uint96(bound(pulled, 0, approved));
        address a = address(acct);
        F[] memory fs = new F[](revoke ? 5 : 4);
        uint256 k;
        fs[k++] = _v(a);
        fs[k++] = _approve(address(usdc), address(this), approved, true);
        fs[k++] = _s(address(usdc), abi.encodeWithSelector(0x70a08231, a), true);
        if (revoke) fs[k++] = _approve(address(usdc), address(this), 0, true);
        fs[k] = _sealF(_noOuts());
        store.load(a, fs);
        vm.startPrank(a);
        usdc.approve(address(this), approved);
        vm.stopPrank();
        if (pulled > 0) {
            usdc.mint(a, pulled);
            usdc.transferFrom(a, address(0xdead), pulled);
        }
        uint256 residual = approved - pulled;
        if (revoke) {
            vm.prank(a);
            usdc.approve(address(this), 0);
            residual = 0;
        }
        store.setCur(k);
        vm.prank(a);
        if (residual > 1) vm.expectRevert();
        seal.checkFrames(_noOuts());
    }

    function test_gas_guard_64_frames() public {
        F[] memory fs = new F[](64);
        fs[0] = _v(address(acct));
        for (uint256 i = 1; i < 63; i += 2) {
            fs[i] = _approve(address(usdc), address(router), 1e18, true);
            fs[i + 1] = _approve(address(usdc), address(router), 0, true);
        }
        fs[63] = _sealF(_noOuts());
        bytes memory blob = Blob.encode(fs);
        uint256 g = gasleft();
        (uint256 code,) = ZeroAllowLib.guard(blob, address(acct), address(seal), address(0));
        g -= gasleft();
        assertEq(code, 0);
        emit log_named_uint("guard gas, 64 frames", g);
        assertLt(g, 100_000);
    }
}
