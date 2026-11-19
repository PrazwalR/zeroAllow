// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ZeroAllowLib} from "./ZeroAllowLib.sol";

contract ZeroAllowPolicy {
    uint256 public constant MODULE_TYPE_FRAME_VALIDATOR = 11;
    uint8 internal constant APPROVE_EXECUTION_AND_PAYMENT = 3;

    address public immutable ops;
    address public immutable seal;
    address public immutable permit2;

    error Rejected(uint256 code, uint256 frame);
    error NotSender();
    error FramesUnavailable();

    constructor(address ops_, address seal_, address permit2_) {
        ops = ops_;
        seal = seal_;
        permit2 = permit2_;
    }

    function check() public view returns (uint256 code, uint256 at) {
        (bool ok, bytes memory info) = ops.staticcall(abi.encode(uint256(1), uint256(0)));
        if (!ok) revert FramesUnavailable();
        (address sender, uint256 n,,) = abi.decode(info, (address, uint256, uint256, uint256));
        if (sender != msg.sender) revert NotSender();
        bytes memory blob;
        (ok, blob) = ops.staticcall(abi.encode(uint256(2), uint256(0)));
        if (!ok) revert FramesUnavailable();
        bytes[] memory full = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            if (!ZeroAllowLib.dispatched(blob, i, sender)) continue;
            bytes memory frame;
            (ok, frame) = ops.staticcall(abi.encode(uint256(5), i));
            if (!ok || frame.length < 0x80) revert FramesUnavailable();
            bytes memory data;
            assembly {
                data := add(frame, 0x80)
            }
            if (data.length > frame.length - 0x80) revert FramesUnavailable();
            full[i] = data;
        }
        return ZeroAllowLib.guard(blob, full, sender, seal, permit2);
    }

    function enforce() external view {
        (uint256 code, uint256 at) = check();
        if (code != ZeroAllowLib.OK) revert Rejected(code, at);
    }

    function validateFrame(bytes calldata) external view returns (uint8) {
        (uint256 code,) = check();
        return code == ZeroAllowLib.OK ? APPROVE_EXECUTION_AND_PAYMENT : 0;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_FRAME_VALIDATOR;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}
}
