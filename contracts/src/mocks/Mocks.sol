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
