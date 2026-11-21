// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ZeroAllowLib} from "./ZeroAllowLib.sol";

interface ISealView {
    function isClosed(ZeroAllowLib.Key calldata k, address owner) external view returns (bool);
}

contract ZeroAllowHook {
    uint256 public constant MODULE_TYPE_HOOK = 4;
    uint256 public constant MODULE_TYPE_SCOPED_EXECUTION_HOOK = 11;

    address public immutable seal;
    address public immutable permit2;

    error Open(uint8 kind, address token, address spender, uint256 id);
    error Unparseable();
    error SelfCall();
    error DelegateCall();

    constructor(address seal_, address permit2_) {
        seal = seal_;
        permit2 = permit2_;
    }

    function preCheck(address, uint256, bytes calldata msgData) external view returns (bytes memory) {
        return _pre(msgData);
    }

    function postCheck(bytes calldata hookData) external view {
        _post(hookData);
    }

    function preCheck(bytes32, address, uint256, bytes calldata msgData) external view returns (bytes memory) {
        return _pre(msgData);
    }

    function postCheck(bytes32, bytes calldata hookData) external view {
        _post(hookData);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK || moduleTypeId == MODULE_TYPE_SCOPED_EXECUTION_HOOK;
    }

    function isInitialized(address) external pure returns (bool) {
        return true;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    function _pre(bytes calldata msgData) internal view returns (bytes memory) {
        if (msgData.length < 4) return "";
        bytes4 s = bytes4(msgData[:4]);
        bool erc7579 = s == ZeroAllowLib.EXECUTE || s == ZeroAllowLib.EXECUTE_FROM_EXECUTOR;
        if (!erc7579 && !ZeroAllowLib.isExecute(s)) return "";
        if (erc7579 && msgData.length >= 5) {
            bytes1 callType = msgData[4];
            if (callType == 0xfe) return "";
            if (callType == 0xff) revert DelegateCall();
        }
        (uint256 code, bytes memory vb) = ZeroAllowLib.virtualBlob(msgData);
        if (code != ZeroAllowLib.OK) revert Unparseable();
        uint256 n = ZeroAllowLib.count(vb);
        ZeroAllowLib.Key[] memory keys = new ZeroAllowLib.Key[](n);
        uint256 m;
        for (uint256 k; k < n; ++k) {
            if (ZeroAllowLib.word(vb, k, 0) == uint160(msg.sender)) revert SelfCall();
            (uint8 kind, address token, address spender, uint256 id) =
                ZeroAllowLib.classify(vb, k, msg.sender, permit2);
            if (kind == ZeroAllowLib.MALFORMED) revert Unparseable();
            if (kind != ZeroAllowLib.NONE) keys[m++] = ZeroAllowLib.Key(kind, token, spender, id);
        }
        if (m == 0) return "";
        assembly {
            mstore(keys, m)
        }
        return abi.encode(keys);
    }

    function _post(bytes calldata hookData) internal view {
        if (hookData.length == 0) return;
        ZeroAllowLib.Key[] memory keys = abi.decode(hookData, (ZeroAllowLib.Key[]));
        for (uint256 i; i < keys.length; ++i) {
            ZeroAllowLib.Key memory k = keys[i];
            if (!ISealView(seal).isClosed(k, msg.sender)) revert Open(k.kind, k.token, k.spender, k.id);
        }
    }
}
