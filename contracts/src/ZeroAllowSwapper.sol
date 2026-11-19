// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract ZeroAllowSwapper {
    error Expired();
    error BadPath(uint256 hop);
    error NothingIn(uint256 hop);
    error Slippage(uint256 got, uint256 want);

    function swapV2(address[] calldata pairs, address tokenIn, uint256 minOut, address to, uint256 deadline, uint256 feeBps)
        external
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        if (pairs.length == 0 || feeBps >= 10_000) revert BadPath(0);
        address input = tokenIn;
        uint256 before;
        for (uint256 i; i < pairs.length; ++i) {
            IV2Pair pair = IV2Pair(pairs[i]);
            address t0 = pair.token0();
            address t1 = pair.token1();
            if (input != t0 && input != t1) revert BadPath(i);
            (uint256 r0, uint256 r1,) = pair.getReserves();
            (uint256 rIn, uint256 rOut) = input == t0 ? (r0, r1) : (r1, r0);
            uint256 amountIn = _balance(input, address(pair)) - rIn;
            if (amountIn == 0) revert NothingIn(i);
            uint256 withFee = amountIn * (10_000 - feeBps);
            uint256 amountOut = (withFee * rOut) / (rIn * 10_000 + withFee);
            address output = input == t0 ? t1 : t0;
            address recipient = i + 1 < pairs.length ? pairs[i + 1] : to;
            if (i + 1 == pairs.length) before = _balance(output, to);
            (uint256 o0, uint256 o1) = input == t0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            pair.swap(o0, o1, recipient, "");
            input = output;
        }
        out = _balance(input, to) - before;
        if (out < minOut) revert Slippage(out, minOut);
    }

    function _balance(address token, address who) internal view returns (uint256 b) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        require(ok && r.length >= 32);
        b = abi.decode(r, (uint256));
    }
}
