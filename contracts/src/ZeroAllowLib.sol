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
    uint8 internal constant DELEGATION = 7;
    uint8 internal constant COMET = 8;
    uint8 internal constant MORPHO = 9;
    uint8 internal constant RELAYER = 10;
    uint8 internal constant ERC777 = 11;
    uint8 internal constant MALFORMED = 255;

    uint256 internal constant OK = 0;
    uint256 internal constant SELF_CALL = 1;
    uint256 internal constant UNPARSEABLE = 2;
    uint256 internal constant OUTSIDE_BATCH = 3;
    uint256 internal constant UNSEALED = 4;

    bytes4 internal constant CHECK_FRAMES = 0x1135b925;
    uint256 internal constant FIRST_BYTES = 0x400400000a004010000000400208080000000000020000402020c0000020200;

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
        address a0 = address(uint160(arg(blob, i, 0)));
        uint256 need;
        if (s == 0x095ea7b3) {
            need = 2;
            spender = a0;
            id = arg(blob, i, 1);
            if (spender != address(0)) kind = APPROVE;
        } else if (s == 0x39509351 || s == 0xd73dd623 || s == 0x3177029f || s == 0xcae9ca51) {
            need = 2;
            kind = ERC20;
            spender = a0;
        } else if (s == 0xd505accf || s == 0x8fcbaf0c) {
            need = 2;
            if (a0 == owner) {
                kind = ERC20;
                spender = address(uint160(arg(blob, i, 1)));
            }
        } else if (s == 0xa22cb465) {
            need = 2;
            kind = OPERATOR;
            spender = a0;
        } else if (s == 0x426a8493) {
            need = 3;
            kind = E6909;
            spender = a0;
            id = arg(blob, i, 1);
        } else if (s == 0x558a7297) {
            need = 2;
            kind = E6909_OPERATOR;
            spender = a0;
        } else if (s == 0xc04a8a10) {
            need = 2;
            kind = DELEGATION;
            spender = a0;
        } else if (s == 0x110496e5) {
            need = 2;
            kind = COMET;
            spender = a0;
        } else if (s == 0xeecea000) {
            need = 2;
            kind = MORPHO;
            spender = a0;
        } else if (s == 0xfa6e671d) {
            need = 3;
            if (a0 == owner) {
                kind = RELAYER;
                spender = address(uint160(arg(blob, i, 1)));
            }
        } else if (s == 0x959b8c3f) {
            need = 1;
            kind = ERC777;
            spender = a0;
        } else if (permit2 != address(0) && token == permit2) {
            if (s == 0x87517c45) {
                need = 4;
                kind = PERMIT2;
                token = a0;
                spender = address(uint160(arg(blob, i, 1)));
            } else if (s == 0x2b67b570) {
                need = 8;
                if (a0 == owner) {
                    kind = PERMIT2;
                    token = address(uint160(arg(blob, i, 1)));
                    spender = address(uint160(arg(blob, i, 5)));
                }
            } else if (s == 0x2a2d80d1) {
                need = 3;
                if (a0 == owner) kind = MALFORMED;
            }
        }
        if (need != 0 && len < 4 + 32 * need) kind = MALFORMED;
    }

    function kindOf(bytes memory blob, uint256 i, address owner, address permit2) internal pure returns (uint8) {
        (uint256 k,) = _run(blob, owner, address(0), permit2, i);
        return uint8(k);
    }

    function guard(bytes memory blob, address sender, address seal, address permit2)
        internal
        pure
        returns (uint256 code, uint256 at)
    {
        return _run(blob, sender, seal, permit2, type(uint256).max);
    }

    function _run(bytes memory blob, address sender, address seal, address permit2, uint256 probe)
        private
        pure
        returns (uint256 code, uint256 at)
    {
        assembly {
            let base := add(blob, 0x40)
            switch lt(probe, mload(add(blob, 0x20)))
            case 1 { code := _kind(add(base, mul(probe, 0x180)), sender, permit2) }
            default { code, at := _guard(base, mload(add(blob, 0x20)), sender, seal, permit2) }

            function _guard(b, n, sender_, seal_, permit2_) -> c, a {
                let end := 0
                let ok := 0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let p := add(b, mul(i, 0x180))
                    if eq(mload(add(p, 0x20)), MODE_SENDER) {
                        if eq(mload(p), sender_) {
                            c := SELF_CALL
                            a := i
                            leave
                        }
                        let k := _kind(p, sender_, permit2_)
                        if k {
                            if eq(k, MALFORMED) {
                                c := UNPARSEABLE
                                a := i
                                leave
                            }
                            if iszero(and(mload(add(p, 0x40)), ATOMIC)) {
                                c := OUTSIDE_BATCH
                                a := i
                                leave
                            }
                            if iszero(lt(i, end)) {
                                let j := add(i, 1)
                                for {} lt(j, n) { j := add(j, 1) } {
                                    if iszero(and(mload(add(add(b, mul(j, 0x180)), 0x40)), ATOMIC)) { break }
                                }
                                end := add(j, 1)
                                ok := 0
                                if lt(j, n) {
                                    let q := add(b, mul(j, 0x180))
                                    ok := and(
                                        and(eq(mload(add(q, 0x20)), MODE_SENDER), eq(mload(q), seal_)),
                                        eq(shr(224, mload(add(q, 0xa0))), 0x1135b925)
                                    )
                                }
                            }
                            if iszero(ok) {
                                c := UNSEALED
                                a := i
                                leave
                            }
                        }
                    }
                }
            }

            function _kind(p, owner_, permit2_) -> r {
                let len := mload(add(p, 0x80))
                if lt(len, 4) { leave }
                let w := mload(add(p, 0xa0))
                if iszero(and(shr(byte(0, w), FIRST_BYTES), 1)) { leave }
                let s := shr(224, w)
                let a0 := and(mload(add(p, 0xa4)), 0xffffffffffffffffffffffffffffffffffffffff)
                let need := 2
                if eq(s, 0x095ea7b3) {
                    if lt(len, 68) { r := MALFORMED leave }
                    if a0 { r := APPROVE }
                    leave
                }
                let isOwner := eq(a0, owner_)
                let onP2 := and(iszero(iszero(permit2_)), eq(mload(p), permit2_))
                switch lt(s, 0x87517c45)
                case 1 {
                    switch lt(s, 0x3177029f)
                    case 1 {
                        switch s
                        case 0x110496e5 { r := COMET }
                        case 0x2a2d80d1 {
                            need := mul(onP2, 3)
                            if and(onP2, isOwner) { r := MALFORMED }
                        }
                        case 0x2b67b570 {
                            need := mul(onP2, 8)
                            if and(onP2, isOwner) { r := PERMIT2 }
                        }
                        default { need := 0 }
                    }
                    default {
                        switch s
                        case 0x3177029f { r := ERC20 }
                        case 0x39509351 { r := ERC20 }
                        case 0x426a8493 {
                            need := 3
                            r := E6909
                        }
                        case 0x558a7297 { r := E6909_OPERATOR }
                        default { need := 0 }
                    }
                }
                default {
                    switch lt(s, 0xc04a8a10)
                    case 1 {
                        switch s
                        case 0x87517c45 {
                            need := mul(onP2, 4)
                            if onP2 { r := PERMIT2 }
                        }
                        case 0x8fcbaf0c { if isOwner { r := ERC20 } }
                        case 0x959b8c3f {
                            need := 1
                            r := ERC777
                        }
                        case 0xa22cb465 { r := OPERATOR }
                        default { need := 0 }
                    }
                    default {
                        switch s
                        case 0xc04a8a10 { r := DELEGATION }
                        case 0xcae9ca51 { r := ERC20 }
                        case 0xd505accf { if isOwner { r := ERC20 } }
                        case 0xd73dd623 { r := ERC20 }
                        case 0xeecea000 { r := MORPHO }
                        case 0xfa6e671d {
                            need := 3
                            if isOwner { r := RELAYER }
                        }
                        default { need := 0 }
                    }
                }
                if and(iszero(iszero(need)), lt(len, add(4, shl(5, need)))) { r := MALFORMED }
            }
        }
    }

    function batchStart(bytes memory blob, uint256 cur) internal pure returns (uint256 s) {
        s = cur;
        while (s > 0 && word(blob, s - 1, 2) & ATOMIC != 0) --s;
    }
}
