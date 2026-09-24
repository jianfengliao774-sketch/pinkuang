// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IProbeMining {
    function minerKey(address circuits, uint256 tokenId) external view returns (bytes32);
    function pending(bytes32 key) external view returns (uint256);
    function claim(bytes32 key) external;
}

interface IProbeMarket {
    function list(address circuits, uint256 tokenId, uint96 price) external returns (uint256);
    function buy(uint256 id, uint96 expectedPrice) external payable;
    function listingView(uint256 id)
        external
        view
        returns (address seller, address circuits, uint256 tokenId, uint96 price, uint16 feeBps, bool valid);
}

/// @notice Fork-only probe. This is not the production PoolVault or its accounting implementation.
contract ProbeHolder is IERC721Receiver {
    address public immutable controller;
    address public immutable circuits;
    uint256 public immutable tokenId;
    address public immutable mining;
    address public immutable market;
    address public immutable bem;

    constructor(address circuits_, uint256 tokenId_, address mining_, address market_, address bem_) {
        controller = msg.sender;
        circuits = circuits_;
        tokenId = tokenId_;
        mining = mining_;
        market = market_;
        bem = bem_;
    }

    modifier onlyController() {
        require(msg.sender == controller, "probe controller only");
        _;
    }

    function forward(address target, bytes calldata data) external payable onlyController returns (bytes memory) {
        require(data.length >= 4, "missing selector");
        bytes4 selector = bytes4(data[:4]);
        bool allowed = target == mining
            && (selector == bytes4(keccak256("arm(address,uint256)"))
                || selector
                    == bytes4(keccak256("start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32)"))
                || selector == bytes4(keccak256("stop(bytes32)"))
                || selector == IProbeMining.claim.selector);
        allowed = allowed
            || (target == market
                && (selector == IProbeMarket.list.selector
                    || selector == bytes4(keccak256("delist(uint256)"))
                    || selector == bytes4(keccak256("withdraw()"))));
        allowed = allowed || (target == circuits && selector == IERC721.approve.selector);
        require(allowed, "not allowlisted");
        (bool ok, bytes memory result) = target.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }

    function claimAndBuy(uint256 listingId, uint96 expectedPrice) external payable onlyController {
        (address seller, address asset, uint256 id,,, bool valid) = IProbeMarket(market).listingView(listingId);
        require(valid && asset == circuits && id == tokenId, "wrong listing");
        require(IERC721(circuits).ownerOf(tokenId) == seller, "seller changed");
        bytes32 key = IProbeMining(mining).minerKey(circuits, tokenId);
        IProbeMining(mining).claim(key);
        require(IProbeMining(mining).pending(key) == 0, "not settled");
        require(IERC721(circuits).ownerOf(tokenId) == seller, "owner changed during claim");
        IProbeMarket(market).buy{value: msg.value}(listingId, expectedPrice);
        require(IERC721(circuits).ownerOf(tokenId) == address(this), "purchase failed");
    }

    /// @dev Only demonstrates the ordered settlement/transfer primitive; no production fee or share logic.
    function probeCompleteSale(address buyer, uint256 approvedPrice) external payable onlyController {
        require(msg.value == approvedPrice && buyer != address(0), "wrong payment");
        require(IERC721(circuits).ownerOf(tokenId) == address(this), "not owner");
        bytes32 key = IProbeMining(mining).minerKey(circuits, tokenId);
        IProbeMining(mining).claim(key);
        require(IProbeMining(mining).pending(key) == 0, "not settled");
        IERC721(circuits).safeTransferFrom(address(this), buyer, tokenId);
        require(IERC721(circuits).ownerOf(tokenId) == buyer, "handover failed");
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        require(msg.sender == circuits && id == tokenId, "unexpected NFT");
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        require(msg.sender == market, "unexpected BNB");
    }
}
