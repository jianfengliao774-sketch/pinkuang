// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformAuthority} from "../../src/PlatformAuthority.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract AuthorityFactoryMock {
    address public timelock;
    address public shareMarket;
    mapping(address => bool) public isPool;
    address public operator;

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function setMarket(address market) external {
        shareMarket = market;
    }

    function setPool(address pool) external {
        isPool[pool] = true;
    }

    function setOperator(address next) external {
        operator = next;
    }

    function createPool(IPoolVault.PoolParams calldata) external view returns (address) {
        require(msg.sender == operator, "operator");
        return address(0x1234);
    }
}

contract AuthorityMarketMock {
    address public operator;
    address public reviewedPool;
    uint256 public reviewedProposal;
    uint128 public reviewedPrice;
    bool public reviewedApproval;
    uint128 public referencePrice;
    mapping(address => uint256) public bnbOwed;

    function setOperator(address next) external {
        operator = next;
    }

    function reviewSale(address pool, uint256 proposalId, uint128 priceWei, bool approved) external {
        require(msg.sender == operator, "operator");
        reviewedPool = pool;
        reviewedProposal = proposalId;
        reviewedPrice = priceWei;
        reviewedApproval = approved;
    }

    function setSaleReference(address, uint128 priceWei, uint64, bytes32) external {
        require(msg.sender == operator, "operator");
        referencePrice = priceWei;
    }

    function fundFee(address beneficiary) external payable {
        bnbOwed[beneficiary] += msg.value;
    }

    function withdrawBnb() external {
        uint256 amount = bnbOwed[msg.sender];
        bnbOwed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
    }
}

contract AuthorityPoolMock {
    address public operator;
    address public treasury;
    uint256 public reviewedProposal;
    bool public reviewedApproval;
    mapping(address => uint256) public bnbOwed;

    constructor(address treasury_) {
        treasury = treasury_;
    }

    function setOperator(address next) external {
        operator = next;
    }

    function reviewChildSale(uint256 proposalId, bool approved) external {
        require(msg.sender == operator, "operator");
        reviewedProposal = proposalId;
        reviewedApproval = approved;
    }

    function fundFee(address beneficiary) external payable {
        bnbOwed[beneficiary] += msg.value;
    }

    function withdrawBnb() external {
        uint256 amount = bnbOwed[msg.sender];
        bnbOwed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
    }
}

contract AuthorityBemMock {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PlatformAuthorityTest is Test {
    uint256 private constant FIRST_KEY = 0xA11CE;
    uint256 private constant SECOND_KEY = 0xB0B;
    address private first;
    address private second;
    address private constant RELAYER = address(0x123);
    address private constant TIMELOCK = address(0x456);
    AuthorityFactoryMock private core;
    AuthorityFactoryMock private budget;
    AuthorityMarketMock private market;
    AuthorityPoolMock private pool;
    PlatformAuthority private authority;

    function setUp() public {
        vm.chainId(56);
        first = vm.addr(FIRST_KEY);
        second = vm.addr(SECOND_KEY);
        core = new AuthorityFactoryMock(TIMELOCK);
        budget = new AuthorityFactoryMock(TIMELOCK);
        market = new AuthorityMarketMock();
        core.setMarket(address(market));
        authority = new PlatformAuthority(address(core), address(budget), first, second, RELAYER);
        pool = new AuthorityPoolMock(address(authority));
        core.setPool(address(pool));
        budget.setPool(address(pool));
        core.setOperator(address(authority));
        market.setOperator(address(authority));
        pool.setOperator(address(authority));
        AuthorityBemMock token = new AuthorityBemMock();
        vm.etch(authority.BEM(), address(token).code);
        vm.deal(address(this), 10 ether);
    }

    function _sign(uint256 key, bytes32 kind, address target, bytes32 params, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BEMine Platform Authority")),
                keccak256(bytes("1")),
                block.chainid,
                address(authority)
            )
        );
        bytes32 structHash = keccak256(abi.encode(authority.ACTION_TYPEHASH(), kind, target, params, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function testEitherAdminCanReviewButRelayerCannotForgeOrReplay() public {
        bytes32 params = keccak256(abi.encode(address(pool), uint256(7), uint128(9 ether), true));
        bytes memory signature =
            _sign(FIRST_KEY, authority.REVIEW_SALE(), address(market), params, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, block.timestamp + 1 hours, signature);
        assertEq(market.reviewedProposal(), 7);
        assertTrue(market.reviewedApproval());
        assertEq(authority.nonces(first), 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, block.timestamp + 1 hours, signature);
        bytes32 otherOpinion = keccak256(abi.encode(address(pool), uint256(7), uint128(9 ether), false));
        bytes memory secondOpinion =
            _sign(SECOND_KEY, authority.REVIEW_SALE(), address(market), otherOpinion, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.reviewSale(
            address(market), address(pool), 7, 9 ether, false, 0, block.timestamp + 1 hours, secondOpinion
        );
        vm.prank(RELAYER);
        vm.expectRevert();
        authority.reviewSale(address(market), address(pool), 7, 8 ether, true, 0, block.timestamp + 1 hours, signature);
        bytes memory nextProposal = _sign(
            FIRST_KEY,
            authority.REVIEW_SALE(),
            address(market),
            keccak256(abi.encode(address(pool), uint256(8), uint128(9 ether), true)),
            1,
            block.timestamp + 1 hours
        );
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.Unauthorized.selector);
        authority.reviewSale(
            address(market), address(pool), 8, 9 ether, true, 1, block.timestamp + 1 hours, nextProposal
        );

        bytes32 childParams = keccak256(abi.encode(uint256(4), false));
        bytes memory secondSig =
            _sign(SECOND_KEY, authority.REVIEW_CHILD_SALE(), address(pool), childParams, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.reviewChildSale(address(pool), 4, false, 0, block.timestamp + 1 hours, secondSig);
        assertEq(pool.reviewedProposal(), 4);
        assertFalse(pool.reviewedApproval());
    }

    function testReferenceNeedsAdminSignatureAndCannotBeChanged() public {
        bytes32 digest = keccak256("quote");
        bytes32 params = keccak256(abi.encode(address(pool), uint128(10 ether), uint64(block.timestamp), digest));
        bytes memory signature =
            _sign(FIRST_KEY, authority.SALE_REFERENCE(), address(market), params, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.setSaleReference(
            address(market),
            address(pool),
            10 ether,
            uint64(block.timestamp),
            digest,
            0,
            block.timestamp + 1 hours,
            signature
        );
        assertEq(market.referencePrice(), 10 ether);
        vm.prank(RELAYER);
        vm.expectRevert();
        authority.setSaleReference(
            address(market),
            address(pool),
            1 ether,
            uint64(block.timestamp),
            digest,
            1,
            block.timestamp + 1 hours,
            signature
        );
    }

    function testExpiredCrossChainAndWrongContractSignaturesFail() public {
        uint256 deadline = block.timestamp + 5;
        bytes32 params = keccak256(abi.encode(address(pool), uint256(7), uint128(9 ether), true));
        bytes memory signature = _sign(FIRST_KEY, authority.REVIEW_SALE(), address(market), params, 0, deadline);
        vm.warp(deadline + 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, deadline, signature);

        vm.warp(deadline - 1);
        vm.chainId(57);
        vm.prank(RELAYER);
        vm.expectRevert();
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, deadline, signature);
        vm.chainId(56);

        AuthorityMarketMock unrelated = new AuthorityMarketMock();
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidTarget.selector);
        authority.reviewSale(address(unrelated), address(pool), 7, 9 ether, true, 0, deadline, signature);
    }

    function testOnlyTimelockCanRotateAdminsAndGasWallet() public {
        vm.prank(RELAYER);
        vm.expectRevert();
        authority.setGasWallet(address(0x4567));
        vm.prank(TIMELOCK);
        vm.expectRevert(PlatformAuthority.InvalidAddress.selector);
        authority.setGasWallet(first);
        vm.prank(TIMELOCK);
        vm.expectRevert(PlatformAuthority.InvalidAddress.selector);
        authority.setAdministrators(first, RELAYER);
        vm.prank(first);
        vm.expectRevert();
        authority.setAdministrators(first, address(0x4567));
        vm.prank(TIMELOCK);
        authority.setGasWallet(address(0x4567));
        assertEq(authority.gasWallet(), address(0x4567));
        vm.prank(TIMELOCK);
        authority.setAdministrators(first, address(0x7890));
        assertEq(authority.administratorTwo(), address(0x7890));
        vm.prank(TIMELOCK);
        vm.expectRevert(PlatformAuthority.InvalidAddress.selector);
        authority.setAdministrators(address(0x4567), address(0x7890));
    }

    function testFirstAdminCanTakeAllFeesButRelayerCannotRedirect() public {
        market.fundFee{value: 0.1 ether}(address(authority));
        pool.fundFee{value: 0.2 ether}(address(authority));
        AuthorityBemMock(authority.BEM()).mint(address(authority), 300);
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(
            FIRST_KEY,
            authority.CLAIM_FEES(),
            address(authority),
            keccak256(abi.encode(markets, pools, first)),
            0,
            deadline
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.claimFees(markets, pools, second, 0, deadline, signature);
        vm.prank(RELAYER);
        authority.claimFees(markets, pools, first, 0, deadline, signature);
        assertEq(first.balance, 0.3 ether);
        assertEq(AuthorityBemMock(authority.BEM()).balanceOf(first), 300);
        assertEq(second.balance, 0);
        assertEq(authority.nonces(first), 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.claimFees(markets, pools, first, 0, deadline, signature);

        market.fundFee{value: 0.05 ether}(address(authority));
        AuthorityBemMock(authority.BEM()).mint(address(authority), 50);
        bytes memory secondClaim = _sign(
            SECOND_KEY,
            authority.CLAIM_FEES(),
            address(authority),
            keccak256(abi.encode(markets, pools, second)),
            0,
            deadline
        );
        vm.prank(RELAYER);
        authority.claimFees(markets, pools, second, 0, deadline, secondClaim);
        assertEq(first.balance, 0.3 ether);
        assertEq(second.balance, 0.05 ether);
        assertEq(AuthorityBemMock(authority.BEM()).balanceOf(second), 50);
    }

    function testGasWalletMayOnlyRelayWhitelistedOperations() public {
        IPoolVault.PoolParams memory params;
        bytes memory callData = abi.encodeWithSelector(AuthorityFactoryMock.createPool.selector, params);
        vm.prank(RELAYER);
        bytes memory result = authority.executeOperation(address(core), callData);
        assertEq(abi.decode(result, (address)), address(0x1234));
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(
            address(core), abi.encodeWithSelector(AuthorityFactoryMock.setOperator.selector, RELAYER)
        );
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.Unauthorized.selector);
        authority.executeOperation(address(core), callData);
    }
}
