// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZeroAllowLib} from "../src/ZeroAllowLib.sol";

contract VectorsTest is Test {
    function test_solidity_guard_matches_ts_vectors() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../vectors/guard.json"));
        uint256 n = vm.parseJsonUint(json, ".count");
        assertGt(n, 40);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".vectors[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(k, ".name"));
            (uint256 code, uint256 at) = ZeroAllowLib.guard(
                vm.parseJsonBytes(json, string.concat(k, ".blob")),
                vm.parseJsonBytesArray(json, string.concat(k, ".full")),
                vm.parseJsonAddress(json, string.concat(k, ".sender")),
                vm.parseJsonAddress(json, string.concat(k, ".seal")),
                vm.parseJsonAddress(json, string.concat(k, ".permit2"))
            );
            assertEq(code, vm.parseJsonUint(json, string.concat(k, ".code")), name);
            assertEq(at, vm.parseJsonUint(json, string.concat(k, ".at")), name);
        }
    }
}
