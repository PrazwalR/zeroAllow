// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

struct F {
    uint8 mode;
    uint8 flags;
    address target;
    uint256 value;
    bytes data;
}

library Blob {
    function encode(F[] memory fs) internal pure returns (bytes memory b) {
        b = new bytes(32 + fs.length * 0x180);
        assembly {
            mstore(add(b, 0x20), mload(fs))
        }
        for (uint256 i; i < fs.length; ++i) {
            uint256 base = 0x40 + i * 0x180;
            F memory f = fs[i];
            bytes memory d = f.data;
            uint256 n = d.length < 0xe0 ? d.length : 0xe0;
            assembly {
                let p := add(b, base)
                mstore(p, mload(add(f, 0x40)))
                mstore(add(p, 0x20), mload(f))
                mstore(add(p, 0x40), mload(add(f, 0x20)))
                mstore(add(p, 0x60), mload(add(f, 0x60)))
                mstore(add(p, 0x80), mload(d))
                for { let k := 0 } lt(k, n) { k := add(k, 1) } {
                    mstore8(add(add(p, 0xa0), k), byte(0, mload(add(add(d, 0x20), k))))
                }
            }
        }
    }
}

contract FrameStore {
    F[] internal frames;
    address public sender;
    uint256 public cur;
    address public signer;
    uint256 public scheme = 1;
    bytes32 public sigMsg;
    uint256 public sigs = 1;

    function load(address s, F[] calldata fs) external {
        delete frames;
        for (uint256 i; i < fs.length; ++i) frames.push(fs[i]);
        sender = s;
        cur = 0;
    }

    function setCur(uint256 c) external {
        cur = c;
    }

    function setSig(address s, uint256 sc, bytes32 m, uint256 n) external {
        signer = s;
        scheme = sc;
        sigMsg = m;
        sigs = n;
    }

    function blob() external view returns (bytes memory) {
        return Blob.encode(frames);
    }

    function info() external view returns (address, uint256, uint256, uint256) {
        return (sender, frames.length, cur, sigs);
    }

    function full(uint256 i) external view returns (address, uint256, bytes memory) {
        return (frames[i].target, frames[i].mode, frames[i].data);
    }

    function sig(uint256) external view returns (address, uint256, bytes32) {
        return (scheme == 0 ? address(0) : signer, scheme, sigMsg);
    }
}

contract MockFrameOps {
    FrameStore internal immutable store;

    event Approved(uint256 scope);

    constructor(FrameStore s) {
        store = s;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        (uint256 op, uint256 a) = abi.decode(data, (uint256, uint256));
        bytes memory r;
        if (op == 1) {
            (address s, uint256 n, uint256 c, uint256 k) = store.info();
            r = abi.encode(s, n, c, k);
        } else if (op == 2) {
            r = store.blob();
        } else if (op == 3) {
            (address s, uint256 sc, bytes32 m) = store.sig(a);
            r = abi.encode(s, sc, m);
        } else if (op == 4) {
            emit Approved(a);
        } else if (op == 5) {
            (address t, uint256 m, bytes memory d) = store.full(a);
            r = abi.encode(t, m, d);
        } else {
            revert();
        }
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
