// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IPoolVault} from "../src/interfaces/IPoolVault.sol";
import {PoolVaultState} from "../src/PoolVaultState.sol";
import {PoolSaleState} from "../src/PoolSaleState.sol";
import {ShareCheckpoints} from "../src/libraries/ShareCheckpoints.sol";
import {SaleSettlement} from "../src/libraries/SaleSettlement.sol";
import {SandboxSaleGovernance} from "./SandboxSaleGovernance.sol";
import {SandboxMockMiner} from "./SandboxMockMiner.sol";

/// @notice Mainnet transaction rehearsal with simulated shares/NFT, never a real miner or Firsto sale.
/// @dev Governance is generated from the production library with only timing/name/import/visibility changes.
contract SandboxSalePool is ERC20, ReentrancyGuard, PoolVaultState, PoolSaleState {
    using Checkpoints for Checkpoints.Trace208;

    address public immutable owner;
    address public immutable simulatedNft;
    uint256 public constant tokenId = 1;
    uint256 public constant TOTAL_SHARES = 100;
    uint256 public constant MAX_SIMULATED_SALE_PRICE = 0.001 ether;
    uint256 public constant proposalCooldown = 60;
    uint256 public constant voteDuration = 300;
    uint256 public constant listingDuration = 900;
    uint16 public constant saleFeeBps = 100;
    bool public constant simulationOnly = true;

    uint128 private referencePrice;
    uint64 private referenceAt;
    bytes32 private referenceDigest;
    struct Review { uint128 price; uint8 status; }
    mapping(uint256 => Review) private reviews;

    error Unauthorized();
    error InvalidSetup();
    error WrongState();
    error InvalidReference();
    error InvalidReview();
    error PaymentMismatch();
    error TransferFailed();
    error UnexpectedPayment();
    error NothingToWithdraw();

    event SaleProposed(uint256 indexed proposalId, address indexed proposer, uint256 price, uint256 refPrice, uint64 refAt, uint64 endsAt);
    event SaleSnapshotRecorded(uint256 indexed proposalId, uint48 snapshotTs, uint256 snapshotMemberCount, uint256 snapshotTotalShares);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event SaleListed(uint256 indexed proposalId, uint256 listingId, uint256 price, uint64 expiresAt);
    event SaleExpired(uint256 indexed proposalId);
    event SaleReferenceUpdated(address indexed pool, uint256 marketPriceWei, uint64 observedAt, bytes32 sourceDigest);
    event SaleReviewed(address indexed pool, uint256 indexed proposalId, uint128 priceWei, bool approved, address indexed operator);
    event SaleCompleted(uint256 gross, uint256 toPlatform, uint256 burnedBem, uint256 toMembers);
    event SaleProceedsSettled(address indexed user, uint256 shares, uint256 amount);
    event BnbWithdrawn(address indexed user, uint256 amount);

    constructor(address testOwner, address[] memory initialMembers, uint8[] memory initialShares, uint128 simulatedPurchaseCost)
        ERC20("BEMine Sale Rehearsal Shares", "TEST-SHARE")
    {
        if (block.chainid != 56 || testOwner == address(0) || testOwner == address(this)
            || initialMembers.length == 0 || initialMembers.length > TOTAL_SHARES
            || initialMembers.length != initialShares.length || simulatedPurchaseCost == 0
            || simulatedPurchaseCost > MAX_SIMULATED_SALE_PRICE) revert InvalidSetup();
        owner = testOwner;
        simulatedNft = address(new SandboxMockMiner());
        VaultStorage storage v = _vaultStorage();
        v.factory = address(this);
        v.treasury = testOwner;
        v.params.circuits = simulatedNft;
        v.params.circuitId = tokenId;
        v.purchaseCost = simulatedPurchaseCost;
        v.state = IPoolVault.State.Funding;
        for (uint256 i; i < initialMembers.length; ++i) {
            if (initialMembers[i] == address(0) || initialMembers[i] == address(this) || initialShares[i] == 0
                || balanceOf(initialMembers[i]) != 0) revert InvalidSetup();
            _mint(initialMembers[i], initialShares[i]);
        }
        if (totalSupply() != TOTAL_SHARES) revert InvalidSetup();
        v.activatedAt = SafeCast.toUint64(block.timestamp);
        v.state = IPoolVault.State.Active;
        referencePrice = simulatedPurchaseCost;
        referenceAt = SafeCast.toUint64(block.timestamp);
        referenceDigest = keccak256(abi.encode("SIMULATED_INITIAL_REFERENCE", address(this), simulatedPurchaseCost));
    }

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    function decimals() public pure override returns (uint8) { return 0; }
    function factory() external view returns (address) { return address(this); }
    function shareMarket() external view returns (address) { return address(this); }
    function operator() external view returns (address) { return owner; }
    function treasury() external view returns (address) { return owner; }
    function state() external view returns (IPoolVault.State) { return _vaultStorage().state; }
    function activatedAt() external view returns (uint64) { return _vaultStorage().activatedAt; }
    function firstProposalAt() external view returns (uint256) { return uint256(_vaultStorage().activatedAt) + proposalCooldown; }
    function purchaseCost() external view returns (uint256) { return _vaultStorage().purchaseCost; }
    function memberCount() external view returns (uint256) { return _vaultStorage().activeMembers.length; }
    function clock() public view returns (uint48) { return SafeCast.toUint48(block.timestamp); }

    function setSaleReference(address pool, uint128 price, uint64 observedAt, bytes32 digest) external onlyOwner {
        if (pool != address(this) || price == 0 || price > MAX_SIMULATED_SALE_PRICE
            || digest == bytes32(0) || observedAt > block.timestamp
            || block.timestamp - observedAt > 5 minutes) revert InvalidReference();
        referencePrice = price; referenceAt = observedAt; referenceDigest = digest;
        emit SaleReferenceUpdated(pool, price, observedAt, digest);
    }
    function saleReference(address pool) external view returns (uint128, uint64, bytes32) {
        if (pool != address(this)) revert InvalidReference();
        return (referencePrice, referenceAt, referenceDigest);
    }
    function reviewSale(address pool, uint256 id, uint128 price, bool approved) external onlyOwner {
        SaleStorage storage s = _saleStorage();
        Proposal storage p = s.proposals[id];
        Proposal storage opener = s.proposals[s.activeProposalId];
        if (pool != address(this) || _vaultStorage().state != IPoolVault.State.Active || id == 0
            || id < s.activeProposalId || id >= nextProposalId() || s.activeProposalId == 0 || price == 0
            || p.price != price || p.executed || opener.executed || block.timestamp >= p.endsAt
            || p.snapshotTs != opener.snapshotTs || p.endsAt != opener.endsAt || reviews[id].status == 2) revert InvalidReview();
        reviews[id] = Review(price, approved ? 1 : 2);
        emit SaleReviewed(pool, id, price, approved, msg.sender);
    }
    function saleReview(address pool, uint256 id) external view returns (uint8, uint128) {
        if (pool != address(this)) revert InvalidReview();
        return (reviews[id].status, reviews[id].price);
    }
    function propose(uint256 price, uint256 refPrice, uint64 refAt) external nonReentrant returns (uint256) {
        VaultStorage storage v = _vaultStorage();
        if (v.state != IPoolVault.State.Active) revert WrongState();
        if (price > MAX_SIMULATED_SALE_PRICE) revert IPoolVault.InvalidSalePrice();
        return SandboxSaleGovernance.propose(_saleStorage(), v.memberHistory,
            SandboxSaleGovernance.ProposalInput(v.activatedAt, balanceOf(msg.sender), price, refPrice, refAt));
    }
    function vote(uint256 id, bool support) external nonReentrant {
        if (_vaultStorage().state != IPoolVault.State.Active) revert WrongState();
        SandboxSaleGovernance.vote(_saleStorage(), _vaultStorage().shareHistory, id, support);
    }
    function executeSale(uint256 id) external nonReentrant {
        VaultStorage storage v = _vaultStorage();
        if (v.state != IPoolVault.State.Active) revert WrongState();
        SandboxSaleGovernance.execute(_saleStorage(), id, v.purchaseCost, address(this));
        v.state = IPoolVault.State.Listed;
    }
    function cancelExpired() external nonReentrant {
        if (_vaultStorage().state != IPoolVault.State.Listed) revert WrongState();
        SandboxSaleGovernance.cancel(_saleStorage());
        _vaultStorage().state = IPoolVault.State.Active;
    }

    /// @notice Direct simulated NFT/BNB settlement, not a Firsto order or a real mining claim.
    function completeSimulatedSale(uint256 expectedProposalId, uint256 expectedPrice) external payable nonReentrant {
        VaultStorage storage v = _vaultStorage();
        SaleStorage storage s = _saleStorage();
        if (v.state != IPoolVault.State.Listed) revert WrongState();
        if (expectedProposalId != s.listedProposalId) revert IPoolVault.InvalidProposal();
        if (expectedPrice != s.salePrice || msg.value != expectedPrice) revert PaymentMismatch();
        SaleSettlement.prepareFirsto(v, s, msg.sender, expectedPrice, 0);
        IERC721(simulatedNft).safeTransferFrom(address(this), msg.sender, tokenId);
        if (IERC721(simulatedNft).ownerOf(tokenId) != msg.sender) revert TransferFailed();
        emit SaleCompleted(expectedPrice, expectedPrice / 100, 0, expectedPrice - expectedPrice / 100);
    }
    function withdrawBnb() external nonReentrant {
        VaultStorage storage v = _vaultStorage();
        SaleSettlement.materialize(_saleStorage(), v, msg.sender, balanceOf(msg.sender));
        uint256 amount = v.bnbOwed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        v.bnbOwed[msg.sender] = 0; v.totalBnbOwed -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit BnbWithdrawn(msg.sender, amount);
    }

    function transfer(address to, uint256 quantity) public override nonReentrant returns (bool) { return super.transfer(to, quantity); }
    function transferFrom(address from, address to, uint256 quantity) public override nonReentrant returns (bool) { return super.transferFrom(from, to, quantity); }
    function _update(address from, address to, uint256 quantity) internal override {
        VaultStorage storage v = _vaultStorage();
        if (from != address(0)) {
            if (v.state != IPoolVault.State.Active) revert WrongState();
            if (SandboxSaleGovernance.tradingFrozen(_saleStorage())) revert IPoolVault.ProposalActive();
            if (to == address(this) || quantity == 0 || quantity > TOTAL_SHARES) revert InvalidSetup();
        }
        super._update(from, to, quantity);
        if (balanceOf(to) > TOTAL_SHARES) revert InvalidSetup();
        ShareCheckpoints.sync(v.activeMembers, v.memberIndexPlusOne, v.shareHistory, v.memberHistory,
            from, to, balanceOf(from), balanceOf(to), clock());
    }
    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (_saleStorage().proposals[id].proposer == address(0)) revert IPoolVault.InvalidProposal();
        return _saleStorage().proposals[id];
    }
    function hasVoted(uint256 id, address member) external view returns (bool) { return _saleStorage().hasVoted[id][member]; }
    function activeProposalId() external view returns (uint256) { return _saleStorage().activeProposalId; }
    function nextProposalId() public view returns (uint256) { uint256 id = _saleStorage().nextProposalId; return id == 0 ? 1 : id; }
    function lastProposed(address member) external view returns (uint64) { return _saleStorage().lastProposed[member]; }
    function proposalPassed(uint256 id) external view returns (bool) { return SandboxSaleGovernance.passed(_saleStorage(), id, _vaultStorage().purchaseCost); }
    function listedProposalId() external view returns (uint256) { return _saleStorage().listedProposalId; }
    function listedAt() external view returns (uint64) { return _saleStorage().listedAt; }
    function expiresAt() external view returns (uint64) { return _saleStorage().expiresAt; }
    function salePrice() external view returns (uint256) { return _saleStorage().salePrice; }
    function saleBuyer() external view returns (address) { return _saleStorage().saleBuyer; }
    function completedAt() external view returns (uint64) { return _saleStorage().completedAt; }
    function saleProceeds() external view returns (uint256) { return _saleStorage().saleProceeds; }
    function bnbOwed(address member) external view returns (uint256) { return _vaultStorage().bnbOwed[member]; }
    function totalBnbOwed() external view returns (uint256) { return _vaultStorage().totalBnbOwed; }
    function pendingSaleProceeds(address member) external view returns (uint256) { return SaleSettlement.pending(_saleStorage(), _vaultStorage(), member, balanceOf(member)); }
    receive() external payable { revert UnexpectedPayment(); }
}
