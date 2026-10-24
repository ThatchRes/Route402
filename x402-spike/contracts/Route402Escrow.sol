// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Minimal ERC-20 surface the escrow needs.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Route402 release-on-delivery escrow (testnet demo).
/// The company locks USDC for one supplier payment. Before the deadline only a release can move it, and only to the
/// supplier: the company cannot pull it back early, so the supplier can see the money is committed. Release needs the
/// payer or the named releaser (the account Route402 signs with after receiving confirms delivery under the company's
/// controls). After the deadline, if it was never released, the payer can take it back.
/// `conditionHash` is the SHA-256 of the portable ConditionSpec record, tying the on-chain lock to the condition text.
contract Route402Escrow {
    enum State { None, Locked, Released, Refunded }

    struct Lock {
        address payer;
        address payee;
        address releaser;
        uint128 amount;
        uint64 deadline;
        State state;
        bytes32 conditionHash;
    }

    IERC20 public immutable token;
    mapping(bytes32 => Lock) public locks;

    event Locked(bytes32 indexed id, address indexed payer, address indexed payee, uint256 amount, uint64 deadline, address releaser, bytes32 conditionHash);
    event Released(bytes32 indexed id, address indexed by, bytes32 evidenceHash);
    event Refunded(bytes32 indexed id, address indexed by);

    constructor(address token_) {
        require(token_ != address(0), "token");
        token = IERC20(token_);
    }

    function lock(bytes32 id, address payee, address releaser, uint128 amount, uint64 deadline, bytes32 conditionHash) external {
        require(locks[id].state == State.None, "id used");
        require(payee != address(0) && releaser != address(0), "address");
        require(amount > 0, "amount");
        require(deadline > block.timestamp, "deadline");
        locks[id] = Lock(msg.sender, payee, releaser, amount, deadline, State.Locked, conditionHash);
        require(token.transferFrom(msg.sender, address(this), amount), "transferFrom");
        emit Locked(id, msg.sender, payee, amount, deadline, releaser, conditionHash);
    }

    function release(bytes32 id, bytes32 evidenceHash) external {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "not locked");
        require(msg.sender == l.payer || msg.sender == l.releaser, "not allowed");
        l.state = State.Released;
        require(token.transfer(l.payee, l.amount), "transfer");
        emit Released(id, msg.sender, evidenceHash);
    }

    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "not locked");
        require(block.timestamp >= l.deadline, "before deadline");
        require(msg.sender == l.payer || msg.sender == l.releaser, "not allowed");
        l.state = State.Refunded;
        require(token.transfer(l.payer, l.amount), "transfer");
        emit Refunded(id, msg.sender);
    }
}
