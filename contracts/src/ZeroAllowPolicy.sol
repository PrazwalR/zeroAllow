// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ZeroAllowLib} from "./ZeroAllowLib.sol";

contract ZeroAllowPolicy {
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
        (address sender,,,) = abi.decode(info, (address, uint256, uint256, uint256));
        if (sender != msg.sender) revert NotSender();
        bytes memory blob;
        (ok, blob) = ops.staticcall(abi.encode(uint256(2), uint256(0)));
        if (!ok) revert FramesUnavailable();
        return ZeroAllowLib.guard(blob, sender, seal, permit2);
    }

    function enforce() external view {
        (uint256 code, uint256 at) = check();
        if (code != ZeroAllowLib.OK) revert Rejected(code, at);
    }
}
