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
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        require(ownerOf[id] == msg.sender, "owner");
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "from");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "auth");
        getApproved[id] = address(0);
        ownerOf[id] = to;
    }
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
