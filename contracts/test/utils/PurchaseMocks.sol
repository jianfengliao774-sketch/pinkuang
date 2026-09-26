// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Addresses} from "../../script/Addresses.sol";

/// @dev Fault injection fixtures for unit tests only. None are protocol/fork evidence.
contract PurchaseMockBem is ERC20 {
    constructor() ERC20("Mock BEM", "mBEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PurchaseCallbackRelay {
    function relay(address recipient, address operator, address from, uint256 id, bytes calldata data) external {
        IERC721Receiver(recipient).onERC721Received(operator, from, id, data);
    }
}

contract PurchaseMockNft is ERC721 {
    uint8 public callbackFault;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC721("Mock Circuits", "mC") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function forceTransfer(address to, uint256 id) external {
        _update(to, id, address(0));
    }

    function setCallbackFault(uint8 fault) external {
        callbackFault = fault;
    }

    function setReentryData(bytes calldata data) external {
        reentryData = data;
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public override {
        if (callbackFault == 0) {
            super.safeTransferFrom(from, to, id, data);
        } else {
            transferFrom(from, to, id);
            if (callbackFault == 6) {
                new PurchaseCallbackRelay().relay(to, msg.sender, from, id, data);
            } else if (callbackFault != 5 && to.code.length > 0) {
                IERC721Receiver(to)
                    .onERC721Received(
                        callbackFault == 1 ? address(0xBAD) : msg.sender,
                        callbackFault == 2 ? address(0xBAD) : from,
                        callbackFault == 3 ? id + 1 : id,
                        data
                    );
                if (callbackFault == 4) IERC721Receiver(to).onERC721Received(msg.sender, from, id, data);
            }
        }
        if (reentryData.length > 0) {
            reentryAttempted = true;
            (reentrySucceeded,) = to.call(reentryData);
        }
    }
}

contract PurchaseMockMining {
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    mapping(bytes32 => Miner) private miners;
    mapping(bytes32 => uint256) public pending;
    mapping(bytes32 => uint256) public unreported;
    uint256 public claimCalls;
    uint8 public claimFault;
    address public reentryTarget;
    bytes public reentryData;
    bytes public reentryResult;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function minerKey(address circuits, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(circuits, id));
    }

    function configure(address circuits, uint256 id, uint256 storedPending, uint256 liveExtra) external {
        bytes32 key = minerKey(circuits, id);
        Miner storage miner = miners[key];
        miner.circuits = circuits;
        miner.circuitId = uint64(id);
        miner.taskId = 1;
        miner.gateCount = 2;
        miner.depth = 2;
        miner.area = 2;
        miner.mult = 1;
        miner.status = 1;
        miner.verifWeight = 2;
        pending[key] = storedPending;
        unreported[key] = liveExtra;
    }

    function getMiner(bytes32 key) external view returns (Miner memory) {
        return miners[key];
    }

    function setStatus(bytes32 key, uint8 status) external {
        miners[key].status = status;
    }

    function setTaskId(bytes32 key, uint32 taskId) external {
        miners[key].taskId = taskId;
    }

    function setClaimFault(uint8 fault) external {
        claimFault = fault;
    }

    function setClaimReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function setIdentity(bytes32 key, address circuits, uint64 id) external {
        miners[key].circuits = circuits;
        miners[key].circuitId = id;
    }

    function claim(bytes32 key) external {
        // Actual fixed-block Mining rejects all non-mining states with this selector.
        // Keep this independent of injected failures so ordinary tests exercise real eligibility.
        if (miners[key].status != 1) {
            assembly {
                mstore(0, 0x5f9bb3be)
                revert(28, 4)
            }
        }
        require(claimFault != 1, "injected claim revert");
        ++claimCalls;
        if (reentryData.length > 0) {
            reentryAttempted = true;
            (reentrySucceeded, reentryResult) = reentryTarget.call(reentryData);
        }
        Miner memory miner = miners[key];
        address owner = PurchaseMockNft(miner.circuits).ownerOf(miner.circuitId);
        uint256 amount = pending[key] + unreported[key];
        pending[key] = claimFault == 2 ? 1 : 0;
        unreported[key] = 0;
        if (amount > 0) PurchaseMockBem(Addresses.BEM).mint(claimFault == 3 ? address(0xBAD) : owner, amount);
        if (claimFault == 4) PurchaseMockNft(miner.circuits).forceTransfer(address(0xBAD), miner.circuitId);
        if (claimFault == 5) miners[key].status = 3;
        if (claimFault == 6) miners[key].status = 255;
    }

    receive() external payable {}
}

contract PurchaseMockMarket {
    struct Listing {
        address seller;
        address circuits;
        uint256 tokenId;
        uint96 price;
        bool valid;
    }
    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) private currentListing;
    uint256 public nextId;
    uint256 public buyCalls;
    uint256 public fees;
    uint8 public buyFault;

    function createListing(address seller, address circuits, uint256 tokenId, uint96 price)
        external
        returns (uint256 id)
    {
        id = ++nextId;
        listings[id] = Listing(seller, circuits, tokenId, price, true);
        currentListing[circuits][tokenId] = id;
    }

    function setValid(uint256 id, bool valid) external {
        listings[id].valid = valid;
    }

    function setBuyFault(uint8 fault) external {
        buyFault = fault;
    }

    function feeBps() external pure returns (uint16) {
        return 100;
    }

    function listingView(uint256 id) external view returns (address, address, uint256, uint96, uint16, bool) {
        Listing memory listing = listings[id];
        return (listing.seller, listing.circuits, listing.tokenId, listing.price, 100, listing.valid);
    }

    function listingFor(address circuits, uint256 tokenId) external view returns (uint256, address, uint96, bool) {
        uint256 id = currentListing[circuits][tokenId];
        Listing memory listing = listings[id];
        return (id, listing.seller, listing.price, listing.valid);
    }

    function buy(uint256 id, uint96 expectedPrice) external payable {
        Listing memory listing = listings[id];
        require(listing.valid && expectedPrice == listing.price && msg.value == listing.price, "bad listing payment");
        listings[id].valid = false;
        ++buyCalls;
        if (buyFault != 1) {
            PurchaseMockNft(listing.circuits).safeTransferFrom(listing.seller, msg.sender, listing.tokenId);
        }
        if (buyFault == 2) PurchaseMockNft(listing.circuits).forceTransfer(listing.seller, listing.tokenId);
        if (buyFault == 3) {
            PurchaseMockMining mining = PurchaseMockMining(payable(Addresses.MINING));
            mining.setStatus(mining.minerKey(listing.circuits, listing.tokenId), 3);
        }
        if (buyFault == 4) revert("injected market failure");
        if (buyFault == 5) {
            PurchaseMockMining mining = PurchaseMockMining(payable(Addresses.MINING));
            mining.setTaskId(mining.minerKey(listing.circuits, listing.tokenId), 8);
        }
        uint256 fee = uint256(listing.price) / 100;
        fees += fee;
        (bool ok,) = listing.seller.call{value: uint256(listing.price) - fee}("");
        require(ok, "seller rejected payment");
    }
}

contract PurchaseRejectingSeller {
    function approveVault(address nft, address vault, uint256 id) external {
        PurchaseMockNft(nft).approve(vault, id);
    }

    function sell(address vault) external {
        (bool ok, bytes memory reason) = vault.call(abi.encodeWithSignature("sellToPool()"));
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
    }

    receive() external payable {
        revert("seller only accepts pull credit");
    }
}
