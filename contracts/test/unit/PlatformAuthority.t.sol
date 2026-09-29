// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {PlatformAuthority} from "../../src/PlatformAuthority.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

contract AuthorityFactoryMock {
    address public timelock;
    address public shareMarket;
    mapping(address => bool) public isPool;
    address public operator;
    address public lastSubscriber;

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

    function createPoolWithExpiry(IPoolVault.PoolParams calldata, bool) external view returns (address) {
        require(msg.sender == operator, "operator");
        return address(0x1234);
    }

    function createFlexiblePool(IPoolVault.PoolParams calldata, IPoolVault.FlexiblePurchaseConfig calldata)
        external
        view
        returns (address)
    {
        require(msg.sender == operator, "operator");
        return address(0x1234);
    }

    function createFlexiblePoolChecked(
        IPoolVault.PoolParams calldata,
        IPoolVault.FlexiblePurchaseConfig calldata,
        uint32,
        uint128
    ) external view returns (address) {
        require(msg.sender == operator, "operator");
        return address(0x1234);
    }

    function createBudgetChildPool(IPoolVault.PoolParams calldata, address subscriber) external returns (address) {
        require(msg.sender == operator, "operator");
        lastSubscriber = subscriber;
        return address(0x5678);
    }

    function createPortfolio(uint256, uint256, uint256, uint64, uint64) external view returns (address) {
        require(msg.sender == operator, "operator");
        return address(0x9ABC);
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
    uint256 public spentWei;
    uint256 public nextCost;
    address public purchasedChild;
    uint256 public purchasedListing;
    bytes32 public purchasedOrderHash;
    bool public depositPaused;

    constructor(address treasury_) {
        treasury = treasury_;
    }

    function setOperator(address next) external {
        operator = next;
    }

    function setDepositPaused(bool paused) external {
        require(msg.sender == operator, "operator");
        depositPaused = paused;
    }

    function reviewChildSale(uint256 proposalId, bool approved) external {
        require(msg.sender == operator, "operator");
        reviewedProposal = proposalId;
        reviewedApproval = approved;
    }

    function setNextCost(uint256 cost) external {
        nextCost = cost;
    }

    function buyOfficial(address child, uint256 listingId) external {
        require(msg.sender == operator, "operator");
        spentWei += nextCost;
        purchasedChild = child;
        purchasedListing = listingId;
    }

    function buyFirsto(address child, bytes calldata encodedOrder) external {
        require(msg.sender == operator, "operator");
        spentWei += nextCost;
        purchasedChild = child;
        purchasedOrderHash = keccak256(encodedOrder);
    }

    function mine(bytes calldata data) external view returns (bytes memory) {
        require(msg.sender == operator, "operator");
        return data;
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
    using stdStorage for StdStorage;

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
        budget.setOperator(address(authority));
        market.setOperator(address(authority));
        pool.setOperator(address(authority));
        AuthorityBemMock token = new AuthorityBemMock();
        vm.etch(authority.BEM(), address(token).code);
        vm.deal(address(this), 10 ether);
    }

    function _sign(uint256 key, bytes32 structHash) private view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BEMine Platform Authority")),
                keccak256(bytes("1")),
                block.chainid,
                address(authority)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _saleSig(
        uint256 key,
        address market_,
        address pool_,
        uint256 id,
        uint128 price,
        bool approved,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        return _sign(
            key,
            keccak256(
                abi.encode(authority.REVIEW_SALE_TYPEHASH(), market_, pool_, id, price, approved, nonce, deadline)
            )
        );
    }

    function _childSig(uint256 key, address portfolio, uint256 id, bool approved, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _sign(
            key, keccak256(abi.encode(authority.REVIEW_CHILD_SALE_TYPEHASH(), portfolio, id, approved, nonce, deadline))
        );
    }

    function _referenceSig(
        uint256 key,
        address market_,
        address pool_,
        uint128 price,
        uint64 observedAt,
        bytes32 digest,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        return _sign(
            key,
            keccak256(
                abi.encode(
                    authority.SALE_REFERENCE_TYPEHASH(), market_, pool_, price, observedAt, digest, nonce, deadline
                )
            )
        );
    }

    function _feeSig(
        uint256 key,
        address[] memory markets,
        address[] memory pools,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        return _sign(
            key,
            keccak256(
                abi.encode(
                    authority.CLAIM_FEES_TYPEHASH(),
                    keccak256(abi.encodePacked(markets)),
                    keccak256(abi.encodePacked(pools)),
                    recipient,
                    nonce,
                    deadline
                )
            )
        );
    }

    function _officialSig(
        uint256 key,
        address portfolio,
        address child,
        uint256 listingId,
        uint256 maxCost,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        return _sign(
            key,
            keccak256(
                abi.encode(
                    authority.BUY_BUDGET_OFFICIAL_TYPEHASH(), portfolio, child, listingId, maxCost, nonce, deadline
                )
            )
        );
    }

    function _firstoSig(
        uint256 key,
        address portfolio,
        address child,
        bytes32 orderHash,
        uint256 maxCost,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        return _sign(
            key,
            keccak256(
                abi.encode(
                    authority.BUY_BUDGET_FIRSTO_TYPEHASH(), portfolio, child, orderHash, maxCost, nonce, deadline
                )
            )
        );
    }

    function _paramsHash(IPoolVault.PoolParams memory p) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                authority.POOL_PARAMS_TYPEHASH(),
                p.circuits,
                p.circuitId,
                p.targetRaise,
                p.priceCap,
                p.directSeller,
                p.directPrice,
                p.fundingDeadline,
                p.purchaseDeadline
            )
        );
    }

    function _configHash(IPoolVault.FlexiblePurchaseConfig memory c) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                authority.FLEXIBLE_CONFIG_TYPEHASH(),
                c.minVerifiedWeight,
                c.referencePriceWei,
                c.targetDailyYieldAtomic,
                c.extraBps,
                c.referenceObservedAt,
                c.referenceBlock,
                c.referenceDigest
            )
        );
    }

    function _zeroConfigHash() private view returns (bytes32) {
        IPoolVault.FlexiblePurchaseConfig memory c;
        return _configHash(c);
    }

    function _poolSig(uint256 key, address factory, bytes memory data, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes4 selector;
        assembly { selector := mload(add(data, 32)) }
        IPoolVault.PoolParams memory p;
        IPoolVault.FlexiblePurchaseConfig memory c;
        bytes32 operationHash;
        bool expiry = true;
        address subscriber;
        uint32 expectedTaskId;
        uint128 expectedReferenceWeight;
        if (
            selector == bytes4(keccak256("createPool((address,uint256,uint256,uint256,address,uint256,uint64,uint64))"))
        ) {
            p = abi.decode(_tail(data), (IPoolVault.PoolParams));
            operationHash = keccak256("createPool");
        } else if (
            selector
                == bytes4(
                    keccak256(
                        "createBudgetChildPool((address,uint256,uint256,uint256,address,uint256,uint64,uint64),address)"
                    )
                )
        ) {
            (p, subscriber) = abi.decode(_tail(data), (IPoolVault.PoolParams, address));
            operationHash = keccak256("createBudgetChildPool");
        } else if (
            selector
                == bytes4(
                    keccak256(
                        "createPoolWithExpiry((address,uint256,uint256,uint256,address,uint256,uint64,uint64),bool)"
                    )
                )
        ) {
            (p, expiry) = abi.decode(_tail(data), (IPoolVault.PoolParams, bool));
            operationHash = keccak256("createPoolWithExpiry");
        } else if (
            selector
                == bytes4(
                    keccak256(
                        "createFlexiblePool((address,uint256,uint256,uint256,address,uint256,uint64,uint64),(uint128,uint256,uint256,uint16,uint64,uint64,bytes32))"
                    )
                )
        ) {
            (p, c) = abi.decode(_tail(data), (IPoolVault.PoolParams, IPoolVault.FlexiblePurchaseConfig));
            operationHash = keccak256("createFlexiblePool");
        } else if (
            selector
                == bytes4(
                    keccak256(
                        "createFlexiblePoolChecked((address,uint256,uint256,uint256,address,uint256,uint64,uint64),(uint128,uint256,uint256,uint16,uint64,uint64,bytes32),uint32,uint128)"
                    )
                )
        ) {
            (p, c, expectedTaskId, expectedReferenceWeight) = abi.decode(
                _tail(data), (IPoolVault.PoolParams, IPoolVault.FlexiblePurchaseConfig, uint32, uint128)
            );
            operationHash = keccak256("createFlexiblePoolChecked");
        } else {
            revert("unsupported test pool operation");
        }
        bytes32[11] memory words;
        words[0] = authority.CREATE_POOL_TYPEHASH();
        words[1] = bytes32(uint256(uint160(factory)));
        words[2] = operationHash;
        words[3] = _paramsHash(p);
        words[4] = bytes32(uint256(expiry ? 1 : 0));
        words[5] = bytes32(uint256(uint160(subscriber)));
        words[6] = _configHash(c);
        words[7] = bytes32(uint256(expectedTaskId));
        words[8] = bytes32(uint256(expectedReferenceWeight));
        words[9] = bytes32(nonce);
        words[10] = bytes32(deadline);
        return _sign(key, keccak256(abi.encodePacked(words)));
    }

    function _portfolioSig(uint256 key, address factory, bytes memory data, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        (uint256 budgetWei, uint256 absoluteCapWei, uint256 unitCapWei, uint64 fundingEnd, uint64 purchaseEnd) =
            abi.decode(_tail(data), (uint256, uint256, uint256, uint64, uint64));
        bytes32[9] memory words;
        words[0] = authority.CREATE_PORTFOLIO_TYPEHASH();
        words[1] = bytes32(uint256(uint160(factory)));
        words[2] = bytes32(budgetWei);
        words[3] = bytes32(absoluteCapWei);
        words[4] = bytes32(unitCapWei);
        words[5] = bytes32(uint256(fundingEnd));
        words[6] = bytes32(uint256(purchaseEnd));
        words[7] = bytes32(nonce);
        words[8] = bytes32(deadline);
        return _sign(key, keccak256(abi.encodePacked(words)));
    }

    function _reclaimSig(uint256 key, address pool_, bytes32 workId, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _sign(key, keccak256(abi.encode(authority.RECLAIM_TYPEHASH(), pool_, workId, nonce, deadline)));
    }

    function _pauseSig(uint256 key, address pool_, bool paused, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _sign(key, keccak256(abi.encode(authority.DEPOSIT_PAUSE_TYPEHASH(), pool_, paused, nonce, deadline)));
    }

    function _tail(bytes memory data) private pure returns (bytes memory result) {
        result = new bytes(data.length - 4);
        for (uint256 i; i < result.length; ++i) {
            result[i] = data[i + 4];
        }
    }

    function testTypedStructHashesMatchIndependentEthersVectors() public view {
        address[] memory markets = new address[](1);
        address[] memory pools = new address[](1);
        markets[0] = address(0x22);
        pools[0] = address(0x33);
        assertEq(
            keccak256(
                abi.encode(
                    authority.CLAIM_FEES_TYPEHASH(),
                    keccak256(abi.encodePacked(markets)),
                    keccak256(abi.encodePacked(pools)),
                    address(0x44),
                    uint256(2),
                    uint256(9999999999)
                )
            ),
            0xf6b1f0f4c9e89d05ce83d643bd454eeb3e684a26060d124a9273376cb44ddbd9
        );

        IPoolVault.PoolParams memory p = IPoolVault.PoolParams({
            circuits: address(0x33),
            circuitId: 123,
            targetRaise: 100000,
            priceCap: 90000,
            directSeller: address(0x44),
            directPrice: 80000,
            fundingDeadline: 1800001000,
            purchaseDeadline: 1800002000
        });
        bytes32[11] memory words;
        words[0] = authority.CREATE_POOL_TYPEHASH();
        words[1] = bytes32(uint256(uint160(address(0x22))));
        words[2] = keccak256("createPool");
        words[3] = _paramsHash(p);
        words[4] = bytes32(uint256(1));
        words[5] = bytes32(0);
        words[6] = _zeroConfigHash();
        words[7] = bytes32(0);
        words[8] = bytes32(0);
        words[9] = bytes32(uint256(2));
        words[10] = bytes32(uint256(9999999999));
        assertEq(keccak256(abi.encodePacked(words)), 0x2e479e5e053f4ac9b3cc8b317638eed409caa78d2403572a419e26e22516ab4c);
    }

    function testEitherAdminCanReviewButRelayerCannotForgeOrReplay() public {
        bytes memory signature =
            _saleSig(FIRST_KEY, address(market), address(pool), 7, 9 ether, true, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, block.timestamp + 1 hours, signature);
        assertEq(market.reviewedProposal(), 7);
        assertTrue(market.reviewedApproval());
        assertEq(authority.nonces(first), 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, block.timestamp + 1 hours, signature);
        bytes memory secondOpinion =
            _saleSig(SECOND_KEY, address(market), address(pool), 7, 9 ether, false, 0, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.reviewSale(
            address(market), address(pool), 7, 9 ether, false, 0, block.timestamp + 1 hours, secondOpinion
        );
        assertFalse(market.reviewedApproval(), "second administrator can reject an earlier approval");
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.reviewSale(
            address(market), address(pool), 7, 9 ether, false, 0, block.timestamp + 1 hours, secondOpinion
        );
        vm.prank(RELAYER);
        vm.expectRevert();
        authority.reviewSale(address(market), address(pool), 7, 8 ether, true, 0, block.timestamp + 1 hours, signature);
        bytes memory nextProposal =
            _saleSig(FIRST_KEY, address(market), address(pool), 8, 9 ether, true, 1, block.timestamp + 1 hours);
        // A signing administrator may submit directly if the Gas wallet withholds the action.
        vm.prank(first);
        authority.reviewSale(
            address(market), address(pool), 8, 9 ether, true, 1, block.timestamp + 1 hours, nextProposal
        );
        assertEq(market.reviewedProposal(), 8);

        bytes memory secondSig = _childSig(SECOND_KEY, address(pool), 4, false, 1, block.timestamp + 1 hours);
        vm.prank(RELAYER);
        authority.reviewChildSale(address(pool), 4, false, 1, block.timestamp + 1 hours, secondSig);
        assertEq(pool.reviewedProposal(), 4);
        assertFalse(pool.reviewedApproval());
    }

    function testOldOpaqueActionSignatureCannotAuthorizeReview() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 obsoleteType =
            keccak256("Action(bytes32 kind,address target,bytes32 paramsHash,uint256 nonce,uint256 deadline)");
        bytes32 paramsHash = keccak256(abi.encode(address(pool), uint256(7), uint128(9 ether), true));
        bytes memory obsolete = _sign(
            FIRST_KEY,
            keccak256(
                abi.encode(obsoleteType, authority.REVIEW_SALE(), address(market), paramsHash, uint256(0), deadline)
            )
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, deadline, obsolete);
    }

    function testIncorrectSaleApprovalPriceCanBeCorrectedBeforeExecution() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory wrong = _saleSig(FIRST_KEY, address(market), address(pool), 12, 8 ether, true, 0, deadline);
        vm.prank(RELAYER);
        authority.reviewSale(address(market), address(pool), 12, 8 ether, true, 0, deadline, wrong);
        assertEq(market.reviewedPrice(), 8 ether);
        bytes memory corrected = _saleSig(SECOND_KEY, address(market), address(pool), 12, 9 ether, true, 0, deadline);
        vm.prank(RELAYER);
        authority.reviewSale(address(market), address(pool), 12, 9 ether, true, 0, deadline, corrected);
        assertEq(market.reviewedPrice(), 9 ether);
        assertTrue(market.reviewedApproval());
        bytes memory childApprove = _childSig(FIRST_KEY, address(pool), 13, true, 1, deadline);
        vm.prank(RELAYER);
        authority.reviewChildSale(address(pool), 13, true, 1, deadline, childApprove);
        bytes memory childReject = _childSig(SECOND_KEY, address(pool), 13, false, 1, deadline);
        vm.prank(RELAYER);
        authority.reviewChildSale(address(pool), 13, false, 1, deadline, childReject);
        assertFalse(pool.reviewedApproval());
    }

    function testReferenceNeedsAdminSignatureAndCannotBeChanged() public {
        bytes32 digest = keccak256("quote");
        bytes memory signature = _referenceSig(
            FIRST_KEY,
            address(market),
            address(pool),
            10 ether,
            uint64(block.timestamp),
            digest,
            0,
            block.timestamp + 1 hours
        );
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
        bytes memory signature = _saleSig(FIRST_KEY, address(market), address(pool), 7, 9 ether, true, 0, deadline);
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

    function testRemovedAdministratorCannotReturnWithOutstandingSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldSignature = _saleSig(SECOND_KEY, address(market), address(pool), 7, 9 ether, true, 0, deadline);
        assertFalse(authority.retiredAdministrators(first));
        assertFalse(authority.retiredAdministrators(second));

        address replacement = address(0x7890);
        vm.prank(TIMELOCK);
        authority.setAdministrators(first, replacement);
        assertTrue(authority.retiredAdministrators(second));
        assertFalse(authority.retiredAdministrators(first));
        assertFalse(authority.retiredAdministrators(replacement));

        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, deadline, oldSignature);
        vm.prank(TIMELOCK);
        vm.expectRevert(PlatformAuthority.InvalidAddress.selector);
        authority.setAdministrators(first, second);

        // Reordering the two active administrators does not retire either one.
        vm.prank(TIMELOCK);
        authority.setAdministrators(replacement, first);
        assertFalse(authority.retiredAdministrators(first));
        assertFalse(authority.retiredAdministrators(replacement));
        bytes memory currentSignature =
            _saleSig(FIRST_KEY, address(market), address(pool), 7, 9 ether, true, 0, deadline);
        vm.prank(RELAYER);
        authority.reviewSale(address(market), address(pool), 7, 9 ether, true, 0, deadline, currentSignature);
        assertEq(market.reviewedPool(), address(pool));
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
        bytes memory signature = _feeSig(FIRST_KEY, markets, pools, first, 0, deadline);
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
        bytes memory secondClaim = _feeSig(SECOND_KEY, markets, pools, second, 0, deadline);
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
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(address(core), callData);
        bytes memory childData =
            abi.encodeWithSelector(AuthorityFactoryMock.createBudgetChildPool.selector, params, address(pool));
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(address(core), childData);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _poolSig(FIRST_KEY, address(core), callData, 0, deadline);
        vm.prank(RELAYER);
        bytes memory result = authority.executeApprovedOperation(address(core), callData, 0, deadline, signature);
        assertEq(abi.decode(result, (address)), address(0x1234));
        bytes memory childSig = _poolSig(SECOND_KEY, address(core), childData, 0, deadline);
        vm.prank(RELAYER);
        assertEq(
            abi.decode(authority.executeApprovedOperation(address(core), childData, 0, deadline, childSig), (address)),
            address(0x5678)
        );
        assertEq(core.lastSubscriber(), address(pool));
        bytes memory portfolioData = abi.encodeWithSelector(
            AuthorityFactoryMock.createPortfolio.selector,
            100 ether,
            10 ether,
            1 ether,
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 2 days)
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(address(budget), portfolioData);
        bytes memory portfolioSig = _portfolioSig(FIRST_KEY, address(budget), portfolioData, 1, deadline);
        vm.prank(RELAYER);
        assertEq(
            abi.decode(
                authority.executeApprovedOperation(address(budget), portfolioData, 1, deadline, portfolioSig), (address)
            ),
            address(0x9ABC)
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.executeApprovedOperation(address(core), callData, 0, deadline, signature);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeApprovedOperation(
            address(core),
            abi.encodeWithSelector(AuthorityFactoryMock.setOperator.selector, RELAYER),
            0,
            deadline,
            signature
        );
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.Unauthorized.selector);
        authority.executeOperation(address(core), callData);
        bytes memory mineData = abi.encodeWithSelector(
            AuthorityPoolMock.mine.selector,
            abi.encodeWithSignature("arm(address,uint256)", address(0xCAFE), uint256(7))
        );
        vm.prank(RELAYER);
        assertEq(
            abi.decode(authority.executeOperation(address(pool), mineData), (bytes)),
            abi.encodeWithSignature("arm(address,uint256)", address(0xCAFE), uint256(7))
        );
    }

    function testAllCreateVariantsAndPauseUseVisibleTypedFields() public {
        IPoolVault.PoolParams memory p = IPoolVault.PoolParams({
            circuits: address(0x33),
            circuitId: 123,
            targetRaise: 100000,
            priceCap: 90000,
            directSeller: address(0x44),
            directPrice: 80000,
            fundingDeadline: 1800001000,
            purchaseDeadline: 1800002000
        });
        IPoolVault.FlexiblePurchaseConfig memory c = IPoolVault.FlexiblePurchaseConfig({
            minVerifiedWeight: 12,
            referencePriceWei: 70000,
            targetDailyYieldAtomic: 456,
            extraBps: 800,
            referenceObservedAt: 1800000000,
            referenceBlock: 123456,
            referenceDigest: keccak256("reference")
        });
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeWithSelector(AuthorityFactoryMock.createPoolWithExpiry.selector, p, false);
        calls[1] = abi.encodeWithSelector(AuthorityFactoryMock.createFlexiblePool.selector, p, c);
        calls[2] = abi.encodeWithSelector(
            AuthorityFactoryMock.createFlexiblePoolChecked.selector, p, c, uint32(42), uint128(12)
        );
        uint256 deadline = block.timestamp + 1 hours;
        for (uint256 i; i < calls.length; ++i) {
            bytes memory signature = _poolSig(FIRST_KEY, address(core), calls[i], i, deadline);
            vm.prank(RELAYER);
            assertEq(
                abi.decode(
                    authority.executeApprovedOperation(address(core), calls[i], i, deadline, signature), (address)
                ),
                address(0x1234)
            );
        }
        bytes memory pause = abi.encodeWithSelector(AuthorityPoolMock.setDepositPaused.selector, true);
        bytes memory pauseSig = _pauseSig(FIRST_KEY, address(pool), true, 3, deadline);
        vm.prank(RELAYER);
        authority.executeApprovedOperation(address(pool), pause, 3, deadline, pauseSig);
        assertTrue(pool.depositPaused());
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.executeApprovedOperation(
            address(pool),
            abi.encodeWithSelector(AuthorityPoolMock.setDepositPaused.selector, false),
            3,
            deadline,
            pauseSig
        );
    }

    function testReclaimRequiresAdministratorSignature() public {
        bytes memory reclaim = abi.encodeWithSelector(
            AuthorityPoolMock.mine.selector, abi.encodeWithSignature("reclaim(bytes32)", bytes32(uint256(7)))
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(address(pool), reclaim);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _reclaimSig(FIRST_KEY, address(pool), bytes32(uint256(7)), 0, deadline);
        vm.prank(RELAYER);
        assertEq(
            abi.decode(authority.executeApprovedOperation(address(pool), reclaim, 0, deadline, signature), (bytes)),
            abi.encodeWithSignature("reclaim(bytes32)", bytes32(uint256(7)))
        );
        bytes memory arm = abi.encodeWithSelector(
            AuthorityPoolMock.mine.selector,
            abi.encodeWithSignature("arm(address,uint256)", address(0xCAFE), uint256(7))
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeApprovedOperation(address(pool), arm, 1, deadline, signature);
    }

    function testBudgetPurchasesRequireExactSingleAdminSignatureAndCostCeiling() public {
        address child = address(0xCAFE);
        uint256 deadline = block.timestamp + 1 hours;
        pool.setNextCost(3 ether);
        bytes memory officialSig = _officialSig(FIRST_KEY, address(pool), child, 17, 3 ether, 0, deadline);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.executeOperation(
            address(pool), abi.encodeWithSelector(AuthorityPoolMock.buyOfficial.selector, child, uint256(17))
        );
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.buyBudgetOfficial(address(pool), child, 18, 3 ether, 0, deadline, officialSig);
        pool.setNextCost(4 ether);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.OverMaxCost.selector);
        authority.buyBudgetOfficial(address(pool), child, 17, 3 ether, 0, deadline, officialSig);
        assertEq(pool.spentWei(), 0, "over-ceiling official purchase must roll back");
        pool.setNextCost(3 ether);
        vm.prank(RELAYER);
        assertEq(authority.buyBudgetOfficial(address(pool), child, 17, 3 ether, 0, deadline, officialSig), 3 ether);
        assertEq(pool.purchasedChild(), child);
        assertEq(pool.purchasedListing(), 17);
        assertEq(authority.nonces(first), 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.buyBudgetOfficial(address(pool), child, 17, 3 ether, 0, deadline, officialSig);

        bytes memory order = hex"1234abcd";
        bytes memory expensiveSig = _firstoSig(SECOND_KEY, address(pool), child, keccak256(order), 2 ether, 0, deadline);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.buyBudgetFirsto(address(pool), child, hex"1234abce", 2 ether, 0, deadline, expensiveSig);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.OverMaxCost.selector);
        authority.buyBudgetFirsto(address(pool), child, order, 2 ether, 0, deadline, expensiveSig);
        assertEq(authority.nonces(second), 0, "failed cost ceiling must not consume signature");
        assertEq(pool.spentWei(), 3 ether, "failed purchase must roll back project spending");
        pool.setNextCost(2 ether);
        vm.prank(RELAYER);
        assertEq(authority.buyBudgetFirsto(address(pool), child, order, 2 ether, 0, deadline, expensiveSig), 2 ether);
        assertEq(pool.purchasedOrderHash(), keccak256(order));
    }

    function testAdministratorCanInvalidateOwnNonceAndSubmitWithoutRelayer() public {
        uint256 deadline = block.timestamp + 1 hours;
        IPoolVault.PoolParams memory params;
        bytes memory data = abi.encodeWithSelector(AuthorityFactoryMock.createPool.selector, params);
        bytes memory expiredByNonce = _poolSig(FIRST_KEY, address(core), data, 0, deadline);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.Unauthorized.selector);
        authority.invalidateNonce(1);
        vm.prank(first);
        authority.invalidateNonce(1);
        assertEq(authority.nonces(first), 1);
        vm.prank(RELAYER);
        vm.expectRevert(PlatformAuthority.InvalidSignature.selector);
        authority.executeApprovedOperation(address(core), data, 0, deadline, expiredByNonce);
        bytes memory current = _poolSig(FIRST_KEY, address(core), data, 1, deadline);
        vm.prank(first);
        assertEq(
            abi.decode(authority.executeApprovedOperation(address(core), data, 1, deadline, current), (address)),
            address(0x1234)
        );
        assertEq(authority.nonces(first), 2);
    }

    function testAdministratorCannotJumpNonceToMaximumAndBrickSigner() public {
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.invalidateNonce(type(uint256).max);
        assertEq(authority.nonces(first), 0);
        vm.prank(first);
        authority.invalidateNonce(type(uint64).max);
        assertEq(authority.nonces(first), type(uint64).max);
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.invalidateNonce(type(uint256).max);
    }

    function testAdministratorCannotInvalidateFromNearMaximumToOverflowingNonce() public {
        // Reproduce the boundary directly; reaching it one permitted jump at a
        // time is impractical, but the final jump must still be rejected.
        bytes32 nonceSlot = bytes32(stdstore.target(address(authority)).sig("nonces(address)").with_key(first).find());
        vm.store(address(authority), nonceSlot, bytes32(type(uint256).max - 1));
        assertEq(authority.nonces(first), type(uint256).max - 1);
        vm.prank(first);
        vm.expectRevert(PlatformAuthority.InvalidAction.selector);
        authority.invalidateNonce(type(uint256).max);
        assertEq(authority.nonces(first), type(uint256).max - 1);
    }
}
