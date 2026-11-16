// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ZeroAllowLib} from "./ZeroAllowLib.sol";

contract ZeroAllowSeal {
    struct Out {
        address token;
        uint256 amount;
    }

    uint256 public constant MAX_RESIDUAL = 1;

    address public immutable ops;
    address public immutable permit2;

    mapping(address owner => mapping(address token => uint256)) internal snap;

    error Open(uint8 kind, address token, address spender, uint256 id);
    error Unparseable(uint256 frame);
    error NotSender();
    error NoSnapshot(address token);
    error Short(address token, uint256 got, uint256 want);
    error FramesUnavailable();

    constructor(address ops_, address permit2_) {
        ops = ops_;
        permit2 = permit2_;
    }

    function snapshot(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            snap[msg.sender][tokens[i]] = _balance(tokens[i], msg.sender) + 1;
        }
    }

    function checkFrames(Out[] calldata outs) external {
        (bool ok, bytes memory info) = ops.staticcall(abi.encode(uint256(1), uint256(0)));
        if (!ok) revert FramesUnavailable();
        (address sender,, uint256 cur,) = abi.decode(info, (address, uint256, uint256, uint256));
        if (sender != msg.sender) revert NotSender();
        bytes memory blob;
        (ok, blob) = ops.staticcall(abi.encode(uint256(2), uint256(0)));
        if (!ok) revert FramesUnavailable();
        for (uint256 i = ZeroAllowLib.batchStart(blob, cur); i < cur; ++i) {
            if (ZeroAllowLib.word(blob, i, 1) != ZeroAllowLib.MODE_SENDER) continue;
            (uint8 kind, address token, address spender, uint256 id) =
                ZeroAllowLib.classify(blob, i, msg.sender, permit2);
            if (kind == ZeroAllowLib.MALFORMED) revert Unparseable(i);
            if (kind != ZeroAllowLib.NONE) _closed(ZeroAllowLib.Key(kind, token, spender, id), msg.sender);
        }
        _outs(outs);
    }

    function check(ZeroAllowLib.Key[] calldata keys, Out[] calldata outs) external {
        for (uint256 i; i < keys.length; ++i) {
            _closed(keys[i], msg.sender);
        }
        _outs(outs);
    }

    function isClosed(ZeroAllowLib.Key calldata k, address owner) external view returns (bool) {
        return _isClosed(k, owner);
    }

    function _closed(ZeroAllowLib.Key memory k, address owner) internal view {
        if (!_isClosed(k, owner)) revert Open(k.kind, k.token, k.spender, k.id);
    }

    function _isClosed(ZeroAllowLib.Key memory k, address owner) internal view returns (bool) {
        uint8 kind = k.kind;
        if (kind == ZeroAllowLib.APPROVE) {
            (bool okA, uint256 a) = _read(k.token, abi.encodeWithSelector(0xdd62ed3e, owner, k.spender));
            (bool okB, uint256 b) = _read(k.token, abi.encodeWithSelector(0x081812fc, k.id));
            if (!okA && !okB) return false;
            if (okA && a > MAX_RESIDUAL) return false;
            if (okB && address(uint160(b)) == k.spender) return false;
            return true;
        }
        if (kind == ZeroAllowLib.ERC20) {
            return _atMost(k.token, abi.encodeWithSelector(0xdd62ed3e, owner, k.spender), MAX_RESIDUAL);
        }
        if (kind == ZeroAllowLib.OPERATOR) {
            return _atMost(k.token, abi.encodeWithSelector(0xe985e9c5, owner, k.spender), 0);
        }
        if (kind == ZeroAllowLib.PERMIT2) {
            if (permit2 == address(0)) return false;
            return _atMost(permit2, abi.encodeWithSelector(0x927da105, owner, k.token, k.spender), MAX_RESIDUAL);
        }
        if (kind == ZeroAllowLib.E6909) {
            return _atMost(k.token, abi.encodeWithSelector(0x598af9e7, owner, k.spender, k.id), MAX_RESIDUAL);
        }
        if (kind == ZeroAllowLib.E6909_OPERATOR) {
            return _atMost(k.token, abi.encodeWithSelector(0xb6363cf2, owner, k.spender), 0);
        }
        return kind == ZeroAllowLib.NONE;
    }

    function _outs(Out[] calldata outs) internal {
        for (uint256 i; i < outs.length; ++i) {
            address token = outs[i].token;
            uint256 before = snap[msg.sender][token];
            if (before == 0) revert NoSnapshot(token);
            delete snap[msg.sender][token];
            uint256 got = _balance(token, msg.sender) - (before - 1);
            if (got < outs[i].amount) revert Short(token, got, outs[i].amount);
        }
    }

    function _atMost(address target, bytes memory data, uint256 max) internal view returns (bool) {
        (bool ok, uint256 v) = _read(target, data);
        return ok && v <= max;
    }

    function _read(address target, bytes memory data) internal view returns (bool ok, uint256 v) {
        if (target.code.length == 0) return (false, 0);
        bytes memory r;
        (ok, r) = target.staticcall(data);
        if (!ok || r.length < 32) return (false, 0);
        v = abi.decode(r, (uint256));
    }

    function _balance(address token, address owner) internal view returns (uint256) {
        (bool ok, uint256 v) = _read(token, abi.encodeWithSelector(0x70a08231, owner));
        if (!ok) revert NoSnapshot(token);
        return v;
    }
}
