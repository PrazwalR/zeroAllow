// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {F, Blob, FrameStore, MockFrameOps} from "./utils/FrameKit.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";
import {ZeroAllowSeal} from "../src/ZeroAllowSeal.sol";
import {ZeroAllowAccount} from "../src/ZeroAllowAccount.sol";
import {
    MockERC20,
    UsdtLike,
    FalseOnZeroApprove,
    ZeroApproveReverts,
    MockNFT,
    VulnerableRouter,
    MockDelegations,
    Permit1271Token,
    BatchExecutor,
    MockV2Pair,
    MockV2Factory,
    MockV2Router,
    MockERC6909,
    MockPermit2
} from "../src/mocks/Mocks.sol";
import {ZeroAllowSwapper} from "../src/ZeroAllowSwapper.sol";
import {ZeroAllowPolicy} from "../src/ZeroAllowPolicy.sol";

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

    function test_seal_no_residual_for_6909_permit2_and_delegation() public {
        MockERC6909 t = new MockERC6909();
        MockDelegations d = new MockDelegations();
        MockPermit2 p2 = new MockPermit2();
        ZeroAllowSeal s2 = new ZeroAllowSeal(address(ops), address(p2));
        t.mint(address(acct), 7, 1);
        ZeroAllowLib.Key[] memory keys = new ZeroAllowLib.Key[](1);
        vm.startPrank(address(acct));
        t.approve(attacker, 7, 1);
        d.approveDelegation(attacker, 1);
        p2.approve(address(usdc), attacker, 1, type(uint48).max);
        ZeroAllowLib.Key[3] memory open = [
            ZeroAllowLib.Key(ZeroAllowLib.E6909, address(t), attacker, 7),
            ZeroAllowLib.Key(ZeroAllowLib.DELEGATION, address(d), attacker, 0),
            ZeroAllowLib.Key(ZeroAllowLib.PERMIT2, address(usdc), attacker, 0)
        ];
        for (uint256 i; i < 3; ++i) {
            keys[0] = open[i];
            vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, open[i].kind, open[i].token, attacker, open[i].id));
            s2.check(keys, _noOuts());
        }
        t.approve(attacker, 7, 0);
        d.approveDelegation(attacker, 0);
        p2.approve(address(usdc), attacker, 0, 0);
        for (uint256 i; i < 3; ++i) {
            keys[0] = open[i];
            s2.check(keys, _noOuts());
        }
        vm.stopPrank();
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

    function _grant(MockDelegations d, uint8 kind, bool on) internal view returns (bytes memory) {
        address r = address(router);
        if (kind == ZeroAllowLib.DELEGATION) return abi.encodeCall(d.approveDelegation, (r, on ? 5e18 : 0));
        if (kind == ZeroAllowLib.COMET) return abi.encodeCall(d.allow, (r, on));
        if (kind == ZeroAllowLib.MORPHO) return abi.encodeCall(d.setAuthorization, (r, on));
        if (kind == ZeroAllowLib.RELAYER) return abi.encodeCall(d.setRelayerApproval, (address(acct), r, on));
        return on ? abi.encodeCall(d.authorizeOperator, (r)) : abi.encodeCall(d.revokeOperator, (r));
    }

    function test_delegation_kinds_guarded_and_sealed() public {
        MockDelegations d = new MockDelegations();
        for (uint8 kind = ZeroAllowLib.DELEGATION; kind <= ZeroAllowLib.ERC777; ++kind) {
            F[] memory fs = _specExample(address(acct), 1e18);
            fs[1] = _s(address(d), _grant(d, kind, true), true);
            _expectRejected(fs, ZeroAllowLib.UNSEALED, 1);

            F[] memory ok = new F[](4);
            ok[0] = _v(address(acct));
            ok[1] = _s(address(d), _grant(d, kind, true), true);
            ok[2] = _s(address(d), _grant(d, kind, false), true);
            ok[3] = _sealF(_noOuts());
            _validate(ok);
            this.runBatch(address(acct), ok);

            ok[2] = _s(address(d), abi.encodeCall(d.isAuthorized, (address(acct), address(router))), true);
            vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, kind, address(d), address(router), 0));
            this.runBatch(address(acct), ok);
        }
    }

    function test_validate_refuses_default_frame_caller() public {
        F[] memory fs = _bracket(address(acct), address(usdc), 1e18);
        fs[0].mode = DEFAULT;
        store.load(address(acct), fs);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(ZeroAllowAccount.NotVerify.selector);
        acct.validate(0);
    }

    function test_guard_relayer_for_other_sender_is_neutral() public {
        MockDelegations d = new MockDelegations();
        F[] memory fs = _specExample(address(acct), 1e18);
        fs[1] = _s(address(d), abi.encodeCall(d.setRelayerApproval, (address(0x1234), address(router), true)), true);
        _validate(fs);
    }

    function test_account_cannot_sign_permits() public {
        Permit1271Token t = new Permit1271Token();
        bytes32 dg = t.digest(address(acct), attacker, 1e18, 1);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(ownerKey, dg);
        vm.expectRevert(bytes("1271"));
        t.permit(address(acct), attacker, 1e18, 1, abi.encodePacked(r, sg, v));
        (bool ok,) = address(acct).staticcall(abi.encodeWithSelector(0x1626ba7e, dg, abi.encodePacked(r, sg, v)));
        assertFalse(ok);
        assertEq(t.allowance(address(acct), attacker), 0);

        dg = t.digest(owner, attacker, 1e18, 1);
        (v, r, sg) = vm.sign(ownerKey, dg);
        t.permit(owner, attacker, 1e18, 1, abi.encodePacked(r, sg, v));
        assertEq(t.allowance(owner, attacker), 1e18);
    }

    function test_account_receives_nft() public {
        MockNFT nft = new MockNFT();
        nft.mint(address(this), 9);
        nft.safeTransferFrom(address(this), address(acct), 9);
        assertEq(nft.ownerOf(9), address(acct));
    }

    function testFuzz_kindOf_matches_classify(uint8 pick, bytes32 a0, bytes32 a1, uint16 cut, uint8 flags) public view {
        bytes4[22] memory sels = [
            bytes4(0x095ea7b3), 0x39509351, 0xd73dd623, 0x3177029f, 0xcae9ca51, 0xd505accf, 0x8fcbaf0c,
            0xa22cb465, 0x426a8493, 0x558a7297, 0x87517c45, 0x2b67b570, 0x2a2d80d1, 0xc04a8a10,
            0x110496e5, 0xeecea000, 0xfa6e671d, 0x959b8c3f, 0xa9059cbb, 0x23b872dd, 0x09000000, 0xfa000000
        ];
        bytes4 sel = pick < 200 ? sels[pick % 22] : bytes4(keccak256(abi.encode(pick, a1)));
        address p2 = flags & 4 != 0 ? address(0) : address(0x2222);
        if (flags & 1 != 0) a0 = bytes32(uint256(uint160(address(acct)))) | (a0 & bytes32(uint256(0xff) << 248));
        bytes memory full = abi.encodePacked(sel, a0, a1, a0, a1, a0, a1, a0, a1);
        bytes memory data = new bytes(bound(cut, 0, full.length));
        for (uint256 i; i < data.length; ++i) data[i] = full[i];
        F[] memory fs = new F[](1);
        fs[0] = _s(flags & 2 != 0 ? address(0x2222) : address(usdc), data, true);
        bytes memory blob = Blob.encode(fs);
        (uint8 k,,,) = ZeroAllowLib.classify(blob, 0, address(acct), p2);
        assertEq(ZeroAllowLib.kindOf(blob, 0, address(acct), p2), k);
    }

    function test_today_mode_7702_bracket() public {
        (address eoa, uint256 key) = makeAddrAndKey("today");
        BatchExecutor exec = new BatchExecutor();
        vm.signAndAttachDelegation(address(exec), key);
        usdc.mint(eoa, 1_000e18);

        ZeroAllowLib.Key[] memory keys = new ZeroAllowLib.Key[](1);
        keys[0] = ZeroAllowLib.Key(ZeroAllowLib.APPROVE, address(usdc), address(router), type(uint256).max);
        BatchExecutor.Call[] memory leaky = new BatchExecutor.Call[](3);
        leaky[0] = BatchExecutor.Call(address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), type(uint256).max));
        leaky[1] = BatchExecutor.Call(address(router), 0, abi.encodeCall(VulnerableRouter.swapExactIn, (address(usdc), address(weth), 100e18, 0, eoa)));
        leaky[2] = BatchExecutor.Call(address(seal), 0, abi.encodeCall(ZeroAllowSeal.check, (keys, _noOuts())));
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowSeal.Open.selector, 1, address(usdc), address(router), type(uint256).max));
        BatchExecutor(payable(eoa)).execute(leaky);
        assertEq(usdc.balanceOf(eoa), 1_000e18);

        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](4);
        calls[0] = BatchExecutor.Call(address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 100e18));
        calls[1] = leaky[1];
        calls[2] = BatchExecutor.Call(address(usdc), 0, abi.encodeWithSelector(0x095ea7b3, address(router), 0));
        keys[0].id = 100e18;
        calls[3] = BatchExecutor.Call(address(seal), 0, abi.encodeCall(ZeroAllowSeal.check, (keys, _noOuts())));
        vm.prank(eoa);
        BatchExecutor(payable(eoa)).execute(calls);
        assertEq(usdc.allowance(eoa, address(router)), 0);
        assertEq(usdc.balanceOf(eoa), 900e18);
    }

    function _shape(F memory f) internal view returns (uint256 g) {
        F[] memory fs = new F[](64);
        fs[0] = _v(address(acct));
        for (uint256 i = 1; i < 63; ++i) fs[i] = f;
        fs[63] = _sealF(_noOuts());
        bytes memory blob = Blob.encode(fs);
        g = gasleft();
        (uint256 code,) = ZeroAllowLib.guard(blob, address(acct), address(seal), address(0x2222));
        g -= gasleft();
        assertEq(code, 0);
    }

    function test_gas_guard_64_frame_shapes() public {
        address t = address(usdc);
        address r = address(router);
        uint256 revokes = _shape(_approve(t, r, 0, true));
        uint256 neutral = _shape(_s(t, abi.encodeWithSelector(0xa9059cbb, r, 1), true));
        uint256 operators = _shape(_s(t, abi.encodeWithSelector(0xa22cb465, r, false), true));
        uint256 last = _shape(_s(t, abi.encodeWithSelector(0x959b8c3f, r), true));
        uint256 permit2 = _shape(_s(address(0x2222), abi.encodeWithSelector(0x87517c45, t, r, 0, 0), true));
        emit log_named_uint("guard gas, 62 revokes", revokes);
        emit log_named_uint("guard gas, 62 neutral", neutral);
        emit log_named_uint("guard gas, 62 operator revokes", operators);
        emit log_named_uint("guard gas, 62 last-case grants", last);
        emit log_named_uint("guard gas, 62 permit2 approves", permit2);
        assertLt(revokes, 45_000);
        assertLt(neutral, 25_000);
        assertLt(operators, 55_000);
        assertLt(last, 55_000);
        assertLt(permit2, 55_000);
    }

    function _v2() internal returns (MockV2Router r2, MockERC20 dai, address p1, address p2, ZeroAllowSwapper sw) {
        MockV2Factory f = new MockV2Factory();
        r2 = new MockV2Router(address(f));
        dai = new MockERC20("Dai", "DAI");
        p1 = f.createPair(address(usdc), address(weth));
        p2 = f.createPair(address(weth), address(dai));
        usdc.mint(p1, 2_000_000e18);
        weth.mint(p1, 1_000e18);
        weth.mint(p2, 1_000e18);
        dai.mint(p2, 2_000_000e18);
        MockV2Pair(p1).sync();
        MockV2Pair(p2).sync();
        sw = new ZeroAllowSwapper();
    }

    function _direct(ZeroAllowSwapper sw, address[] memory pairs, uint256 amt, uint256 minOut, uint256 fee)
        internal
        view
        returns (F[] memory fs)
    {
        fs = new F[](3);
        fs[0] = _v(address(acct));
        fs[1] = _s(address(usdc), abi.encodeWithSelector(0xa9059cbb, pairs[0], amt), true);
        fs[2] = _s(address(sw), abi.encodeCall(sw.swapV2, (pairs, address(usdc), minOut, address(acct), block.timestamp, fee)), false);
    }

    function test_direct_route_matches_router_without_any_approval() public {
        (MockV2Router r2,, address p1,, ZeroAllowSwapper sw) = _v2();
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(usdc), address(weth));
        address[] memory pairs = new address[](1);
        pairs[0] = p1;
        uint256 snap = vm.snapshotState();
        address other = makeAddr("routerUser");
        usdc.mint(other, 100e18);
        vm.startPrank(other);
        usdc.approve(address(r2), 100e18);
        uint256 viaRouter = r2.swapExactTokensForTokens(100e18, 0, path, other, block.timestamp)[1];
        vm.stopPrank();
        vm.revertToState(snap);

        F[] memory fs = _direct(sw, pairs, 100e18, viaRouter, 30);
        _validate(fs);
        this.runBatch(address(acct), fs);
        assertEq(weth.balanceOf(address(acct)), viaRouter);
        assertEq(usdc.balanceOf(address(acct)), 900e18);
        assertEq(usdc.allowance(address(acct), address(r2)), 0);
        assertEq(usdc.allowance(address(acct), address(sw)), 0);

        vm.prank(attacker);
        vm.expectRevert(bytes("call"));
        r2.multicall(address(usdc), abi.encodeWithSelector(0x23b872dd, address(acct), attacker, 1));
    }

    function test_direct_route_multi_hop() public {
        (, MockERC20 dai, address p1, address p2, ZeroAllowSwapper sw) = _v2();
        address[] memory pairs = new address[](2);
        (pairs[0], pairs[1]) = (p1, p2);
        this.runBatch(address(acct), _direct(sw, pairs, 100e18, 1, 30));
        assertGt(dai.balanceOf(address(acct)), 98e18);
        assertEq(weth.balanceOf(address(acct)), 0);
    }

    function test_direct_route_slippage_unwinds_transfer() public {
        (,, address p1,, ZeroAllowSwapper sw) = _v2();
        address[] memory pairs = new address[](1);
        pairs[0] = p1;
        vm.expectRevert();
        this.runBatch(address(acct), _direct(sw, pairs, 100e18, 1e18, 30));
        assertEq(usdc.balanceOf(address(acct)), 1_000e18);
        vm.expectRevert(bytes("K"));
        this.runBatch(address(acct), _direct(sw, pairs, 100e18, 0, 0));
    }

    function test_policy_enforces_for_any_account() public {
        ZeroAllowPolicy policy = new ZeroAllowPolicy(address(ops), address(seal), address(0));
        address other = makeAddr("kernelLikeAccount");
        store.load(other, _bracket(other, address(usdc), 1e18));
        vm.prank(other);
        policy.enforce();

        store.load(other, _specExample(other, 1e18));
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowPolicy.Rejected.selector, ZeroAllowLib.UNSEALED, 1));
        policy.enforce();

        MockDelegations d = new MockDelegations();
        F[] memory fs = _specExample(other, 1e18);
        fs[1] = _s(address(d), abi.encodeCall(d.approveDelegation, (address(router), 1)), true);
        store.load(other, fs);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ZeroAllowPolicy.Rejected.selector, ZeroAllowLib.UNSEALED, 1));
        policy.enforce();

        vm.prank(attacker);
        vm.expectRevert(ZeroAllowPolicy.NotSender.selector);
        policy.enforce();
    }
}
