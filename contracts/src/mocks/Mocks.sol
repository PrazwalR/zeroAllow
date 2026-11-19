// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address spender, uint256 v) public virtual returns (bool) {
        _approve(msg.sender, spender, v);
        return true;
    }

    function transfer(address to, uint256 v) public virtual returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[from][msg.sender] = a - v;
        }
        _move(from, to, v);
        return true;
    }

    function _approve(address owner, address spender, uint256 v) internal {
        allowance[owner][spender] = v;
        emit Approval(owner, spender, v);
    }

    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
        emit Transfer(from, to, v);
    }
}

contract UsdtLike is MockERC20 {
    constructor() MockERC20("Tether-like", "USDTL") {}

    function approve(address spender, uint256 v) public override returns (bool) {
        require(v == 0 || allowance[msg.sender][spender] == 0, "usdt race");
        _approve(msg.sender, spender, v);
        assembly {
            return(0, 0)
        }
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        _move(msg.sender, to, v);
        assembly {
            return(0, 0)
        }
    }

    function transferFrom(address from, address to, uint256 v) public override returns (bool) {
        super.transferFrom(from, to, v);
        assembly {
            return(0, 0)
        }
    }
}

contract FalseOnZeroApprove is MockERC20 {
    constructor() MockERC20("Silent", "SLNT") {}

    function approve(address spender, uint256 v) public override returns (bool) {
        if (v == 0) return false;
        return super.approve(spender, v);
    }
}

contract ZeroApproveReverts is MockERC20 {
    constructor() MockERC20("BNB-like", "BNBL") {}

    function approve(address spender, uint256 v) public override returns (bool) {
        require(v > 0, "zero approve");
        return super.approve(spender, v);
    }
}

contract MockNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, id);
    }

    function approve(address to, uint256 id) external {
        require(ownerOf[id] == msg.sender, "owner");
        getApproved[id] = to;
        emit Approval(msg.sender, to, id);
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
        emit ApprovalForAll(msg.sender, op, ok);
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "from");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "auth");
        getApproved[id] = address(0);
        ownerOf[id] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            (bool ok, bytes memory r) =
                to.call(abi.encodeWithSelector(0x150b7a02, msg.sender, from, id, bytes("")));
            require(ok && r.length == 32 && bytes4(abi.decode(r, (bytes32))) == 0x150b7a02, "receiver");
        }
    }
}

contract MockDelegations {
    mapping(address => mapping(address => uint256)) public borrowAllowance;
    mapping(address => mapping(address => bool)) public isAllowed;
    mapping(address => mapping(address => bool)) public isAuthorized;
    mapping(address => mapping(address => bool)) public hasApprovedRelayer;
    mapping(address => mapping(address => bool)) internal operators;

    event BorrowAllowanceDelegated(
        address indexed fromUser, address indexed toUser, address indexed asset, uint256 amount
    );
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event SetAuthorization(
        address indexed caller, address indexed authorizer, address indexed authorized, bool newIsAuthorized
    );
    event RelayerApprovalChanged(address indexed relayer, address indexed sender, bool approved);
    event AuthorizedOperator(address indexed operator, address indexed tokenHolder);
    event RevokedOperator(address indexed operator, address indexed tokenHolder);

    function approveDelegation(address delegatee, uint256 amount) external {
        borrowAllowance[msg.sender][delegatee] = amount;
        emit BorrowAllowanceDelegated(msg.sender, delegatee, address(this), amount);
    }

    function allow(address manager, bool ok) external {
        isAllowed[msg.sender][manager] = ok;
        emit Approval(msg.sender, manager, ok ? type(uint256).max : 0);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return isAllowed[owner][spender] ? type(uint256).max : 0;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(amount == 0 || amount == type(uint256).max, "comet amount");
        isAllowed[msg.sender][spender] = amount != 0;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function setAuthorization(address authorized, bool ok) external {
        isAuthorized[msg.sender][authorized] = ok;
        emit SetAuthorization(msg.sender, msg.sender, authorized, ok);
    }

    function setRelayerApproval(address sender, address relayer, bool ok) external {
        require(sender == msg.sender, "sender");
        hasApprovedRelayer[sender][relayer] = ok;
        emit RelayerApprovalChanged(relayer, sender, ok);
    }

    function authorizeOperator(address operator) external {
        operators[msg.sender][operator] = true;
        emit AuthorizedOperator(operator, msg.sender);
    }

    function revokeOperator(address operator) external {
        operators[msg.sender][operator] = false;
        emit RevokedOperator(operator, msg.sender);
    }

    function isOperatorFor(address operator, address holder) external view returns (bool) {
        return operator == holder || operators[holder][operator];
    }
}

contract Permit1271Token is MockERC20 {
    mapping(address => uint256) public nonces;

    constructor() MockERC20("Permit USD", "PUSD") {}

    function digest(address owner, address spender, uint256 value, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), owner, spender, value, deadline, nonces[owner]));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata sig) external {
        bytes32 d = digest(owner, spender, value, deadline);
        nonces[owner]++;
        if (owner.code.length > 0) {
            (bool ok, bytes memory r) = owner.staticcall(abi.encodeWithSelector(0x1626ba7e, d, sig));
            require(ok && r.length == 32 && bytes4(abi.decode(r, (bytes32))) == 0x1626ba7e, "1271");
        } else {
            require(sig.length == 65, "len");
            (bytes32 r, bytes32 s, uint8 v) = abi.decode(abi.encodePacked(sig[0:64], uint256(uint8(sig[64]))), (bytes32, bytes32, uint8));
            address got = ecrecover(d, v, r, s);
            require(got != address(0) && got == owner, "sig");
        }
        _approve(owner, spender, value);
    }
}

contract BatchExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    function execute(Call[] calldata calls) external payable returns (bytes[] memory results) {
        require(msg.sender == address(this), "self");
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(r, 0x20), mload(r))
                }
            }
            results[i] = r;
        }
    }

    receive() external payable {}
}

contract VulnerableRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        out = quote(tokenIn, tokenOut, amountIn);
        require(out >= minOut, "slippage");
        _call(tokenIn, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountIn));
        _call(tokenOut, abi.encodeWithSelector(0xa9059cbb, to, out));
    }

    function swapExactOut(address tokenIn, address tokenOut, uint256 amountOut, uint256 maxIn, address to)
        external
        returns (uint256 amountIn)
    {
        uint256 rIn = _bal(tokenIn);
        uint256 rOut = _bal(tokenOut);
        amountIn = (rIn * amountOut) / (rOut - amountOut) + 1;
        require(amountIn <= maxIn, "slippage");
        _call(tokenIn, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountIn));
        _call(tokenOut, abi.encodeWithSelector(0xa9059cbb, to, amountOut));
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 rIn = _bal(tokenIn);
        uint256 rOut = _bal(tokenOut);
        return (rOut * amountIn) / (rIn + amountIn);
    }

    function multicall(address target, bytes calldata data) external returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        require(ok, "call");
    }

    function _bal(address t) internal view returns (uint256) {
        return MockERC20(t).balanceOf(address(this));
    }

    function _call(address t, bytes memory data) internal {
        (bool ok, bytes memory r) = t.call(data);
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "token");
    }
}

contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 internal reserve0;
    uint112 internal reserve1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function sync() public {
        reserve0 = uint112(MockERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(MockERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "out");
        uint256 r0 = reserve0;
        uint256 r1 = reserve1;
        require(amount0Out < r0 && amount1Out < r1, "liquidity");
        if (amount0Out > 0) MockERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockERC20(token1).transfer(to, amount1Out);
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "in");
        require((b0 * 1000 - in0 * 3) * (b1 * 1000 - in1 * 3) >= r0 * r1 * 1_000_000, "K");
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        require(getPair[a][b] == address(0), "exists");
        pair = address(new MockV2Pair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract MockV2Router {
    address public immutable factory;

    constructor(address f) {
        factory = f;
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "expired");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i + 1 < path.length; ++i) {
            MockV2Pair pair = MockV2Pair(MockV2Factory(factory).getPair(path[i], path[i + 1]));
            (uint256 r0, uint256 r1,) = pair.getReserves();
            (uint256 rIn, uint256 rOut) = path[i] == pair.token0() ? (r0, r1) : (r1, r0);
            amounts[i + 1] = (amounts[i] * 997 * rOut) / (rIn * 1000 + amounts[i] * 997);
        }
        require(amounts[path.length - 1] >= amountOutMin, "slippage");
        MockERC20(path[0]).transferFrom(msg.sender, MockV2Factory(factory).getPair(path[0], path[1]), amountIn);
        for (uint256 i; i + 1 < path.length; ++i) {
            MockV2Pair pair = MockV2Pair(MockV2Factory(factory).getPair(path[i], path[i + 1]));
            address next = i + 2 < path.length ? MockV2Factory(factory).getPair(path[i + 1], path[i + 2]) : to;
            (uint256 o0, uint256 o1) = path[i] == pair.token0() ? (uint256(0), amounts[i + 1]) : (amounts[i + 1], uint256(0));
            pair.swap(o0, o1, next, "");
        }
    }

    function multicall(address target, bytes calldata data) external returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        require(ok, "call");
    }
}

interface IZeroAllowPolicy {
    function enforce() external view;
}

contract PolicyAccount {
    address public immutable owner;
    address public immutable ops;
    address public immutable policy;

    constructor(address owner_, address ops_, address policy_) {
        owner = owner_;
        ops = ops_;
        policy = policy_;
    }

    function validate() external {
        require(msg.sender == address(0xaa), "entry point");
        (address sender,, uint256 cur,) = abi.decode(_op(1, 0), (address, uint256, uint256, uint256));
        (address signer, uint256 scheme, bytes32 m) = abi.decode(_op(3, 0), (address, uint256, bytes32));
        require(sender == address(this) && scheme == 1 && signer == owner && m == bytes32(0), "sig");
        bytes memory blob = _op(2, 0);
        uint256 base = 0x40 + cur * 0x180;
        uint256 mode;
        uint256 flags;
        assembly {
            mode := mload(add(blob, add(base, 0x20)))
            flags := mload(add(blob, add(base, 0x40)))
        }
        require(mode == 1, "verify");
        IZeroAllowPolicy(policy).enforce();
        _op(4, flags & 3);
    }

    function _op(uint256 op, uint256 a) internal returns (bytes memory r) {
        bool ok;
        (ok, r) = ops.delegatecall(abi.encode(op, a));
        require(ok, "op");
    }

    receive() external payable {}
}

interface IV3CallbackLike {
    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external;
}

interface IFrameValidatorLike {
    function validateFrame(bytes calldata data) external view returns (uint8);
}

contract MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Allowance))) internal allowances;

    event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Allowance storage a = allowances[msg.sender][token][spender];
        a.amount = amount;
        a.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
        emit Approval(msg.sender, token, spender, amount, a.expiration);
    }

    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48) {
        Allowance memory a = allowances[owner][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage a = allowances[from][token][msg.sender];
        require(block.timestamp <= a.expiration, "expired");
        if (a.amount != type(uint160).max) {
            require(a.amount >= amount, "insufficient");
            a.amount -= amount;
        }
        MockERC20(token).transferFrom(from, to, amount);
    }
}

contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address a, address b, uint24 f) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = f;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified != 0, "AS");
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 rIn = MockERC20(tIn).balanceOf(address(this));
        uint256 rOut = MockERC20(tOut).balanceOf(address(this));
        uint256 amtIn;
        uint256 amtOut;
        if (amountSpecified > 0) {
            amtIn = uint256(amountSpecified);
            uint256 net = (amtIn * (1e6 - fee)) / 1e6;
            amtOut = (net * rOut) / (rIn + net);
        } else {
            amtOut = uint256(-amountSpecified);
            require(amtOut < rOut, "liquidity");
            amtIn = (rIn * amtOut * 1e6) / ((rOut - amtOut) * (1e6 - fee)) + 1;
        }
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(amtOut)) : (-int256(amtOut), int256(amtIn));
        MockERC20(tOut).transfer(recipient, amtOut);
        IV3CallbackLike(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(MockERC20(tIn).balanceOf(address(this)) >= rIn + amtIn, "IIA");
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        require(getPool[a][b][fee] == address(0), "exists");
        pool = address(new MockV3Pool(a, b, fee));
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

abstract contract V3Payer {
    address transient payer_;
    address transient pool_;

    function _v3Hop(address factory, address a, address b, uint24 fee, uint256 amountIn, address recipient, address payer)
        internal
        returns (uint256)
    {
        address pool = MockV3Factory(factory).getPool(a, b, fee);
        require(pool != address(0), "pool");
        payer_ = payer;
        pool_ = pool;
        bool z = a < b;
        (int256 d0, int256 d1) = MockV3Pool(pool).swap(
            recipient, z, int256(amountIn), z ? 4295128740 : 1461446703485210103287273052203988822378723970341, abi.encode(a)
        );
        pool_ = address(0);
        return uint256(-(z ? d1 : d0));
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        require(msg.sender == pool_ && msg.sender != address(0), "pool");
        _pay(abi.decode(data, (address)), payer_, msg.sender, d0 > 0 ? uint256(d0) : uint256(d1));
    }

    function _pay(address token, address payer, address to, uint256 amount) internal virtual;

    function multicall(address target, bytes calldata data) external returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        require(ok, "call");
    }
}

contract MockV3Router is V3Payer {
    address public immutable factory;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    constructor(address f) {
        factory = f;
    }

    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results) {
        require(block.timestamp <= deadline, "Transaction too old");
        results = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            (bool ok, bytes memory r) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(r, 0x20), mload(r))
                }
            }
            results[i] = r;
        }
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        out = _v3Hop(factory, p.tokenIn, p.tokenOut, p.fee, p.amountIn, _to(p.recipient), msg.sender);
        require(out >= p.amountOutMinimum, "Too little received");
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        bytes calldata path = p.path;
        uint256 hops = (path.length - 20) / 23;
        out = p.amountIn;
        address payer = msg.sender;
        for (uint256 i; i < hops; ++i) {
            uint256 o = i * 23;
            out = _v3Hop(
                factory,
                address(bytes20(path[o:o + 20])),
                address(bytes20(path[o + 23:o + 43])),
                uint24(bytes3(path[o + 20:o + 23])),
                out,
                i + 1 == hops ? _to(p.recipient) : address(this),
                payer
            );
            payer = address(this);
        }
        require(out >= p.amountOutMinimum, "Too little received");
    }

    function _to(address r) internal view returns (address) {
        return r == address(1) ? msg.sender : r == address(2) ? address(this) : r;
    }

    function _pay(address token, address payer, address to, uint256 amount) internal override {
        if (payer == address(this)) MockERC20(token).transfer(to, amount);
        else MockERC20(token).transferFrom(payer, to, amount);
    }
}

contract MockUniversalRouter is V3Payer {
    uint256 internal constant CONTRACT_BALANCE = 1 << 255;

    address public immutable permit2;
    address public immutable v2Factory;
    address public immutable v3Factory;
    address transient locker_;

    constructor(address p2, address f2, address f3) {
        permit2 = p2;
        v2Factory = f2;
        v3Factory = f3;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "deadline");
        _execute(commands, inputs);
    }

    function execute(bytes calldata commands, bytes[] calldata inputs) external payable {
        _execute(commands, inputs);
    }

    function _execute(bytes calldata commands, bytes[] calldata inputs) internal {
        require(locker_ == address(0), "locked");
        require(commands.length == inputs.length, "length");
        locker_ = msg.sender;
        for (uint256 i; i < commands.length; ++i) {
            _dispatch(uint8(commands[i]) & 0x7f, inputs[i]);
        }
        locker_ = address(0);
    }

    function _dispatch(uint256 cmd, bytes calldata input) internal {
        if (cmd == 0x00) {
            (address recipient, uint256 amountIn, uint256 minOut, bytes memory path, bool payerIsUser) =
                abi.decode(input, (address, uint256, uint256, bytes, bool));
            address payer = payerIsUser ? locker_ : address(this);
            if (amountIn == CONTRACT_BALANCE) amountIn = MockERC20(_addr(path, 0)).balanceOf(address(this));
            uint256 hops = (path.length - 20) / 23;
            for (uint256 i; i < hops; ++i) {
                uint256 o = i * 23;
                amountIn = _v3Hop(
                    v3Factory,
                    _addr(path, o),
                    _addr(path, o + 23),
                    _fee(path, o + 20),
                    amountIn,
                    i + 1 == hops ? _map(recipient) : address(this),
                    payer
                );
                payer = address(this);
            }
            require(amountIn >= minOut, "V3TooLittleReceived");
        } else if (cmd == 0x04) {
            (address token, address recipient, uint256 amountMin) = abi.decode(input, (address, address, uint256));
            uint256 b = MockERC20(token).balanceOf(address(this));
            require(b >= amountMin, "InsufficientToken");
            if (b > 0) MockERC20(token).transfer(_map(recipient), b);
        } else if (cmd == 0x08 || cmd == 0x09) {
            (address recipient, uint256 amount, uint256 limit, address[] memory path, bool payerIsUser) =
                abi.decode(input, (address, uint256, uint256, address[], bool));
            address payer = payerIsUser ? locker_ : address(this);
            address to = _map(recipient);
            address pair0 = MockV2Factory(v2Factory).getPair(path[0], path[1]);
            uint256 before = MockERC20(path[path.length - 1]).balanceOf(to);
            if (cmd == 0x08) {
                if (amount == CONTRACT_BALANCE) amount = MockERC20(path[0]).balanceOf(address(this));
                if (amount != 0) _pay(path[0], payer, pair0, amount);
                _v2(path, to);
                require(MockERC20(path[path.length - 1]).balanceOf(to) - before >= limit, "V2TooLittleReceived");
            } else {
                uint256 amountIn = _amountIn(path, amount);
                require(amountIn <= limit, "V2TooMuchRequested");
                _pay(path[0], payer, pair0, amountIn);
                _v2(path, to);
            }
        } else {
            revert("command");
        }
    }

    function _amountIn(address[] memory path, uint256 amountOut) internal view returns (uint256 a) {
        a = amountOut;
        for (uint256 i = path.length - 1; i > 0; --i) {
            MockV2Pair pair = MockV2Pair(MockV2Factory(v2Factory).getPair(path[i - 1], path[i]));
            (uint256 r0, uint256 r1,) = pair.getReserves();
            (uint256 rIn, uint256 rOut) = path[i - 1] == pair.token0() ? (r0, r1) : (r1, r0);
            a = (rIn * a * 1000) / ((rOut - a) * 997) + 1;
        }
    }

    function _v2(address[] memory path, address to) internal {
        for (uint256 i; i + 1 < path.length; ++i) {
            MockV2Pair pair = MockV2Pair(MockV2Factory(v2Factory).getPair(path[i], path[i + 1]));
            (uint256 r0, uint256 r1,) = pair.getReserves();
            bool zero = path[i] == pair.token0();
            (uint256 rIn, uint256 rOut) = zero ? (r0, r1) : (r1, r0);
            uint256 inAmt = MockERC20(path[i]).balanceOf(address(pair)) - rIn;
            uint256 out = (inAmt * 997 * rOut) / (rIn * 1000 + inAmt * 997);
            address next = i + 2 < path.length ? MockV2Factory(v2Factory).getPair(path[i + 1], path[i + 2]) : to;
            pair.swap(zero ? 0 : out, zero ? out : 0, next, "");
        }
    }

    function _pay(address token, address payer, address to, uint256 amount) internal override {
        if (payer == address(this)) MockERC20(token).transfer(to, amount);
        else MockPermit2(permit2).transferFrom(payer, to, uint160(amount), token);
    }

    function _map(address r) internal view returns (address) {
        return r == address(1) ? locker_ : r == address(2) ? address(this) : r;
    }

    function _addr(bytes memory p, uint256 o) internal pure returns (address a) {
        assembly {
            a := shr(96, mload(add(add(p, 0x20), o)))
        }
    }

    function _fee(bytes memory p, uint256 o) internal pure returns (uint24 f) {
        assembly {
            f := shr(232, mload(add(add(p, 0x20), o)))
        }
    }
}

contract Dispatch7579Account {
    address internal constant ENTRY_POINT = address(0xaa);

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    address public immutable owner;
    address public immutable ops;
    address public immutable policy;

    constructor(address owner_, address ops_, address policy_) {
        owner = owner_;
        ops = ops_;
        policy = policy_;
    }

    function verify(bytes calldata) external returns (uint8 approved) {
        require(msg.sender == ENTRY_POINT, "entry point");
        (address sender, uint256 n, uint256 cur,) = abi.decode(_op(1, 0), (address, uint256, uint256, uint256));
        (address signer, uint256 scheme, bytes32 m) = abi.decode(_op(3, 0), (address, uint256, bytes32));
        require(sender == address(this) && scheme == 1 && signer == owner && m == bytes32(0), "sig");
        bytes memory blob = _op(2, 0);
        require(_word(blob, cur, 1) == 1, "verify");
        approved = IFrameValidatorLike(policy).validateFrame("") & uint8(_word(blob, cur, 2) & 3);
        for (uint256 i; i < n; ++i) {
            if (_word(blob, i, 1) == 2 && _word(blob, i, 0) != uint160(address(this))) approved &= 1;
        }
        require(approved == 3, "rejected");
        _op(4, approved);
    }

    function execute(bytes32 mode, bytes calldata ec) external payable {
        require(msg.sender == address(this), "self");
        bool tryMode = mode[1] == 0x01;
        require(mode[1] == 0x00 || tryMode, "execType");
        if (mode[0] == 0x00) {
            _call(address(bytes20(ec[0:20])), uint256(bytes32(ec[20:52])), ec[52:], tryMode);
        } else if (mode[0] == 0x01) {
            Execution[] memory xs = abi.decode(ec, (Execution[]));
            for (uint256 i; i < xs.length; ++i) {
                _call(xs[i].target, xs[i].value, xs[i].callData, tryMode);
            }
        } else {
            revert("callType");
        }
    }

    function executionRoute() external pure returns (uint8) {
        return 1;
    }

    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        return uint8(mode[0]) <= 1 && uint8(mode[1]) <= 1;
    }

    function supportsApprovalMode(uint8 mode) external pure returns (bool) {
        return mode == 3;
    }

    function _call(address target, uint256 value, bytes memory data, bool tryMode) internal {
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok && !tryMode) {
            assembly {
                revert(add(r, 0x20), mload(r))
            }
        }
    }

    function _word(bytes memory blob, uint256 i, uint256 w) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(blob, 0x40), add(mul(i, 0x180), shl(5, w))))
        }
    }

    function _op(uint256 op, uint256 a) internal returns (bytes memory r) {
        bool ok;
        (ok, r) = ops.delegatecall(abi.encode(op, a));
        require(ok, "op");
    }

    receive() external payable {}
}
