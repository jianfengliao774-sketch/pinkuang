// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ShareTransferTestBase} from "./ShareTransferTestBase.sol";
import {IRewardsVault} from "./RewardsTestBase.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";

interface ISaleVault {
    function executeSale(uint256 proposalId) external;
    function relist(uint256 proposalId) external;
    function cancelExpired() external;
    function completeSale() external payable;
    function settleSale() external;
    function state() external view returns (IPoolVault.State);
    function listedProposalId() external view returns (uint256);
    function listedAt() external view returns (uint64);
    function expiresAt() external view returns (uint64);
    function salePrice() external view returns (uint256);
    function saleBuyer() external view returns (address);
    function completedAt() external view returns (uint64);
    function saleProceeds() external view returns (uint256);
    function salePerShareWei() external view returns (uint256);
    function saleRemainder() external view returns (uint256);
    function saleOutstandingWei() external view returns (uint256);
    function saleSettled(address member) external view returns (bool);
    function pendingSaleProceeds(address member) external view returns (uint256);
    function saleTradeId() external view returns (bytes32);
    function burnBudget() external view returns (uint256);
    function bnbOwed(address member) external view returns (uint256);
    function totalBnbOwed() external view returns (uint256);
    function withdrawBnb() external;
}

/// @dev Buyer fault injection only; does not replace the NFT's normal safe-transfer logic.
contract SaleCallbackBuyer is IERC721Receiver {
    error BuyerRejected();

    uint8 public fault;
    address public vault;
    bytes public reentryData;
    bool public bubbleReentryFailure;
    bool public attempted;
    bool public succeeded;
    bytes public result;
    IPoolVault.State public observedState;
    address public observedOwner;
    uint256 public observedOwed;
    bool public rejectBnb;

    function configure(uint8 fault_, bytes calldata data_, bool bubble_) external {
        fault = fault_;
        reentryData = data_;
        bubbleReentryFailure = bubble_;
    }

    function buy(address vault_) external payable {
        vault = vault_;
        ISaleVault(vault_).completeSale{value: msg.value}();
    }

    function setRejectBnb(bool rejected) external {
        rejectBnb = rejected;
    }

    function withdraw() external {
        ISaleVault(vault).withdrawBnb();
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        observedState = ISaleVault(vault).state();
        observedOwner = IERC721(msg.sender).ownerOf(id);
        observedOwed = ISaleVault(vault).bnbOwed(address(this));
        if (fault == 1) revert BuyerRejected();
        if (fault == 2) return bytes4(0);
        if (fault == 3) IERC721(msg.sender).transferFrom(address(this), address(0xBAD), id);
        if (reentryData.length != 0) {
            attempted = true;
            (succeeded, result) = vault.call(reentryData);
            if (bubbleReentryFailure && !succeeded) revert BuyerRejected();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (rejectBnb) revert BuyerRejected();
    }
}

abstract contract SaleTestBase is ShareTransferTestBase {
    address internal constant NFT_BUYER = address(0xB07E2);
    uint256 internal constant SALE_PRICE = 10 ether;
    PoolVault internal saleVault;
    ISaleVault internal sale;

    function setUp() public virtual override {
        super.setUp();
        _useSalePool();
    }

    function _useSalePool() internal {
        saleVault = PoolVault(payable(address(pool)));
        sale = ISaleVault(address(pool));
        rewards = IRewardsVault(address(pool));
    }

    function _readyForSale() internal {
        uint256 firstAllowed = uint256(saleVault.activatedAt()) + 7 days;
        if (block.timestamp < firstAllowed) vm.warp(firstAllowed);
    }

    function _passSaleProposal(uint256 price) internal returns (uint256 id) {
        _readyForSale();
        address proposer = pool.balanceOf(ALICE) != 0 ? ALICE : BOB;
        vm.prank(proposer);
        id = saleVault.propose(price, 0, 0);
        address[8] memory voters = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK, TREASURY, REWARD_SELLER];
        uint48 snapshot = saleVault.getProposal(id).snapshotTs;
        for (uint256 i; i < voters.length; ++i) {
            uint256 weight =
                snapshot == saleVault.clock() ? pool.balanceOf(voters[i]) : pool.getPastShares(voters[i], snapshot);
            if (weight == 0) continue;
            vm.prank(voters[i]);
            saleVault.vote(id, true);
        }
        assertTrue(saleVault.proposalPassed(id));
    }

    function _listSale(uint256 price) internal returns (uint256 id) {
        id = _passSaleProposal(price);
        sale.executeSale(id);
        _stateIs(IPoolVault.State.Listed);
    }

    function _complete(address buyer, uint256 price) internal {
        vm.deal(buyer, buyer.balance + price);
        vm.prank(buyer);
        sale.completeSale{value: price}();
    }

    function _withdraw(address member) internal returns (uint256 received) {
        uint256 beforeBalance = member.balance;
        vm.prank(member);
        pool.withdrawBnb();
        received = member.balance - beforeBalance;
    }

    /// @dev Real funding refund, direct NFT purchase and sale all accumulate in the same pool.
    function _directPoolWithRefund(uint256 directPrice) internal {
        defaultParams.circuitId = ++rewardId;
        defaultParams.directSeller = ALICE;
        defaultParams.directPrice = directPrice;
        defaultParams.fundingDeadline = uint64(block.timestamp + 7 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 10 days);
        pool = _createPool(defaultParams);
        _useSalePool();
        nft.mint(ALICE, rewardId);
        mining.configure(address(nft), rewardId, 0, 0);
        key = mining.minerKey(address(nft), rewardId);
        _deposit(pool, ALICE, 2);
        vm.prank(ALICE);
        pool.withdrawDeposit();
        _fundPool();
        vm.prank(ALICE);
        nft.approve(address(pool), rewardId);
        vm.prank(ALICE);
        pool.sellToPool();
        firstEpoch = _epoch();
        _stateIs(IPoolVault.State.Active);
    }
}
