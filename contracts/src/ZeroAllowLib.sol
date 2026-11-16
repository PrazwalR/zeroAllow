// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library ZeroAllowLib {
    uint256 internal constant STRIDE = 0x180;
    uint256 internal constant HEAD = 0xe0;
    uint256 internal constant MODE_SENDER = 2;
    uint256 internal constant ATOMIC = 4;

    uint8 internal constant NONE = 0;
    uint8 internal constant APPROVE = 1;
    uint8 internal constant ERC20 = 2;
    uint8 internal constant OPERATOR = 3;
    uint8 internal constant PERMIT2 = 4;
    uint8 internal constant E6909 = 5;
    uint8 internal constant E6909_OPERATOR = 6;
    uint8 internal constant MALFORMED = 7;

    uint256 internal constant OK = 0;
    uint256 internal constant SELF_CALL = 1;
    uint256 internal constant UNPARSEABLE = 2;
    uint256 internal constant OUTSIDE_BATCH = 3;
    uint256 internal constant UNSEALED = 4;

    bytes4 internal constant CHECK_FRAMES = 0x1135b925;

    struct Key {
        uint8 kind;
        address token;
        address spender;
        uint256 id;
    }

    function count(bytes memory blob) internal pure returns (uint256 n) {
        assembly {
            n := mload(add(blob, 0x20))
        }
    }

    function word(bytes memory blob, uint256 i, uint256 w) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(blob, 0x40), add(mul(i, 0x180), shl(5, w))))
        }
    }

    function selector(bytes memory blob, uint256 i) internal pure returns (bytes4 s) {
        assembly {
            s := mload(add(add(blob, 0xe0), mul(i, 0x180)))
        }
    }

    function arg(bytes memory blob, uint256 i, uint256 k) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(add(blob, 0xe4), mul(i, 0x180)), shl(5, k)))
        }
    }

    function classify(bytes memory blob, uint256 i, address owner, address permit2)
        internal
        pure
        returns (uint8 kind, address token, address spender, uint256 id)
    {
        uint256 len = word(blob, i, 4);
        if (len < 4) return (NONE, address(0), address(0), 0);
        bytes4 s = selector(blob, i);
        token = address(uint160(word(blob, i, 0)));
        uint256 need;
        if (s == 0x095ea7b3) {
            need = 2;
            spender = address(uint160(arg(blob, i, 0)));
            id = arg(blob, i, 1);
            if (spender != address(0)) kind = APPROVE;
        } else if (s == 0x39509351 || s == 0xd73dd623 || s == 0x3177029f || s == 0xcae9ca51) {
            need = 2;
            kind = ERC20;
            spender = address(uint160(arg(blob, i, 0)));
        } else if (s == 0xd505accf || s == 0x8fcbaf0c) {
            need = 2;
            if (address(uint160(arg(blob, i, 0))) == owner) {
                kind = ERC20;
                spender = address(uint160(arg(blob, i, 1)));
            }
        } else if (s == 0xa22cb465) {
            need = 2;
            kind = OPERATOR;
            spender = address(uint160(arg(blob, i, 0)));
        } else if (s == 0x426a8493) {
            need = 3;
            kind = E6909;
            spender = address(uint160(arg(blob, i, 0)));
            id = arg(blob, i, 1);
        } else if (s == 0x558a7297) {
            need = 2;
            kind = E6909_OPERATOR;
            spender = address(uint160(arg(blob, i, 0)));
        } else if (permit2 != address(0) && token == permit2) {
            if (s == 0x87517c45) {
                need = 4;
                kind = PERMIT2;
                token = address(uint160(arg(blob, i, 0)));
                spender = address(uint160(arg(blob, i, 1)));
            } else if (s == 0x2b67b570) {
                need = 8;
                if (address(uint160(arg(blob, i, 0))) == owner) {
                    kind = PERMIT2;
                    token = address(uint160(arg(blob, i, 1)));
                    spender = address(uint160(arg(blob, i, 5)));
                }
            } else if (s == 0x2a2d80d1) {
                need = 3;
                if (address(uint160(arg(blob, i, 0))) == owner) kind = MALFORMED;
            }
        }
        if (need != 0 && len < 4 + 32 * need) kind = MALFORMED;
    }

    function guard(bytes memory blob, address sender, address seal, address permit2)
        internal
        pure
        returns (uint256 code, uint256 at)
    {
        uint256 n = count(blob);
        uint256 end;
        bool sealed_;
        for (uint256 i; i < n; ++i) {
            if (word(blob, i, 1) != MODE_SENDER) continue;
            if (address(uint160(word(blob, i, 0))) == sender) return (SELF_CALL, i);
            (uint8 kind,,,) = classify(blob, i, sender, permit2);
            if (kind == NONE) continue;
            if (kind == MALFORMED) return (UNPARSEABLE, i);
            if (word(blob, i, 2) & ATOMIC == 0) return (OUTSIDE_BATCH, i);
            if (i >= end) {
                uint256 j = i + 1;
                while (j < n && word(blob, j, 2) & ATOMIC != 0) ++j;
                end = j + 1;
                sealed_ = j < n && word(blob, j, 1) == MODE_SENDER && address(uint160(word(blob, j, 0))) == seal
                    && selector(blob, j) == CHECK_FRAMES;
            }
            if (!sealed_) return (UNSEALED, i);
        }
    }

    function batchStart(bytes memory blob, uint256 cur) internal pure returns (uint256 s) {
        s = cur;
        while (s > 0 && word(blob, s - 1, 2) & ATOMIC != 0) --s;
    }
}
