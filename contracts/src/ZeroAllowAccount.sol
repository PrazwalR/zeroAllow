// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ZeroAllowLib} from "./ZeroAllowLib.sol";

contract ZeroAllowAccount {
    address internal constant ENTRY_POINT = address(0xaa);
    uint256 internal constant SECP256K1 = 1;

    address public immutable owner;
    address public immutable ops;
    address public immutable seal;
    address public immutable permit2;

    error NotEntryPoint();
    error NotVerify();
    error BadSignature();
    error Rejected(uint256 code, uint256 frame);
    error OpFailed(uint256 op);

    constructor(address owner_, address ops_, address seal_, address permit2_) {
        owner = owner_;
        ops = ops_;
        seal = seal_;
        permit2 = permit2_;
    }

    function validate(uint256 sigIndex) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        (address sender,, uint256 cur, uint256 sigs) =
            abi.decode(_op(1, 0), (address, uint256, uint256, uint256));
        if (sender != address(this) || sigIndex >= sigs) revert BadSignature();
        (address signer, uint256 scheme, bytes32 m) = abi.decode(_op(3, sigIndex), (address, uint256, bytes32));
        if (scheme != SECP256K1 || signer != owner || m != bytes32(0)) revert BadSignature();
        bytes memory blob = _op(2, 0);
        if (ZeroAllowLib.word(blob, cur, 1) != 1) revert NotVerify();
        (uint256 code, uint256 at) = ZeroAllowLib.guard(blob, address(this), seal, permit2);
        if (code != ZeroAllowLib.OK) revert Rejected(code, at);
        _op(4, ZeroAllowLib.word(blob, cur, 2) & 3);
    }

    function _op(uint256 op, uint256 a) internal returns (bytes memory r) {
        bool ok;
        (ok, r) = ops.delegatecall(abi.encode(op, a));
        if (!ok) revert OpFailed(op);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    receive() external payable {}
}
