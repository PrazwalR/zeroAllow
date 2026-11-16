// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";

contract VectorsTest is Test {
    struct V {
        uint256 at;
        bytes blob;
        uint256 code;
        string name;
        address permit2;
        address seal;
        address sender;
    }

    function test_solidity_guard_matches_ts_vectors() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../vectors/guard.json"));
        V[] memory vs = abi.decode(vm.parseJson(json, ".vectors"), (V[]));
        assertGt(vs.length, 10);
        for (uint256 i; i < vs.length; ++i) {
            (uint256 code, uint256 at) = ZeroAllowLib.guard(vs[i].blob, vs[i].sender, vs[i].seal, vs[i].permit2);
            assertEq(code, vs[i].code, vs[i].name);
            assertEq(at, vs[i].at, vs[i].name);
        }
    }
}
