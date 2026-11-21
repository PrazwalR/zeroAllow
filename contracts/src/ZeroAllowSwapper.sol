// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
}

contract ZeroAllowSwapper {
    uint160 internal constant MIN_SQRT = 4295128740;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    address transient pool_;
    address transient token_;
    uint256 transient max_;
    bool transient locked_;

    error Expired();
    error Locked();
    error BadPath(uint256 hop);
    error NothingIn(uint256 hop);
    error Slippage(uint256 got, uint256 want);
    error NotPool();
    error Overpay(uint256 owed, uint256 max);

    modifier lock() {
        if (locked_) revert Locked();
        locked_ = true;
        _;
        locked_ = false;
    }

    function swapV2(address[] calldata pairs, address tokenIn, uint256 minOut, address to, uint256 deadline, uint256 feeBps)
        external
        lock
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

    function swapV2ExactOut(
        address[] calldata pairs,
        address tokenIn,
        uint256 amountOut,
        uint256 amountInMax,
        address to,
        uint256 deadline,
        uint256 feeBps
    ) external lock returns (uint256 amountIn) {
        if (block.timestamp > deadline) revert Expired();
        uint256 n = pairs.length;
        if (n == 0 || feeBps >= 10_000 || amountOut == 0) revert BadPath(0);
        address[] memory tokens = new address[](n + 1);
        tokens[0] = tokenIn;
        for (uint256 i; i < n; ++i) {
            address t0 = IV2Pair(pairs[i]).token0();
            address t1 = IV2Pair(pairs[i]).token1();
            if (tokens[i] != t0 && tokens[i] != t1) revert BadPath(i);
            tokens[i + 1] = tokens[i] == t0 ? t1 : t0;
        }
        uint256[] memory amounts = new uint256[](n + 1);
        amounts[n] = amountOut;
        for (uint256 i = n; i > 0; --i) {
            (uint256 r0, uint256 r1,) = IV2Pair(pairs[i - 1]).getReserves();
            (uint256 rIn, uint256 rOut) = tokens[i - 1] == IV2Pair(pairs[i - 1]).token0() ? (r0, r1) : (r1, r0);
            if (amounts[i] >= rOut) revert BadPath(i - 1);
            amounts[i - 1] = (rIn * amounts[i] * 10_000) / ((rOut - amounts[i]) * (10_000 - feeBps)) + 1;
        }
        amountIn = amounts[0];
        if (amountIn > amountInMax) revert Slippage(amountInMax, amountIn);
        uint256 before = _balance(tokens[n], to);
        _transfer(tokenIn, pairs[0], amountIn);
        for (uint256 i; i < n; ++i) {
            bool zero = tokens[i] == IV2Pair(pairs[i]).token0();
            address recipient = i + 1 < n ? pairs[i + 1] : to;
            IV2Pair(pairs[i]).swap(zero ? 0 : amounts[i + 1], zero ? amounts[i + 1] : 0, recipient, "");
        }
        uint256 got = _balance(tokens[n], to) - before;
        if (got < amountOut) revert Slippage(got, amountOut);
        uint256 left = _balance(tokenIn, address(this));
        if (left > 0) _transfer(tokenIn, msg.sender, left);
    }

    function swapV3(bytes calldata path, address factory, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        lock
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        if (path.length < 43 || (path.length - 20) % 23 != 0 || amountIn == 0 || amountIn >= 1 << 255) revert BadPath(0);
        uint256 hops = (path.length - 20) / 23;
        address tokenOut = address(bytes20(path[path.length - 20:]));
        uint256 before = _balance(tokenOut, to);
        uint256 amount = amountIn;
        for (uint256 i; i < hops; ++i) {
            uint256 o = i * 23;
            address a = address(bytes20(path[o:o + 20]));
            address b = address(bytes20(path[o + 23:o + 43]));
            address pool = IV3Factory(factory).getPool(a, b, uint24(bytes3(path[o + 20:o + 23])));
            if (pool == address(0)) revert BadPath(i);
            bool zeroForOne = a < b;
            pool_ = pool;
            token_ = a;
            max_ = amount;
            (int256 d0, int256 d1) = IV3Pool(pool).swap(
                i + 1 == hops ? to : address(this), zeroForOne, int256(amount), zeroForOne ? MIN_SQRT : MAX_SQRT, ""
            );
            pool_ = address(0);
            int256 got = zeroForOne ? d1 : d0;
            if (got >= 0) revert BadPath(i);
            amount = uint256(-got);
        }
        out = _balance(tokenOut, to) - before;
        if (out < minOut) revert Slippage(out, minOut);
        for (uint256 i; i < hops; ++i) {
            address t = address(bytes20(path[i * 23:i * 23 + 20]));
            uint256 left = _balance(t, address(this));
            if (left > 0) _transfer(t, msg.sender, left);
        }
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (msg.sender != pool_ || msg.sender == address(0)) revert NotPool();
        uint256 owed = d0 > 0 ? uint256(d0) : d1 > 0 ? uint256(d1) : 0;
        if (owed > max_) revert Overpay(owed, max_);
        pool_ = address(0);
        _transfer(token_, msg.sender, owed);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))));
    }

    function _balance(address token, address who) internal view returns (uint256 b) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        require(ok && r.length >= 32);
        b = abi.decode(r, (uint256));
    }
}
