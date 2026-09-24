// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICircuitMarket {
    function listingView(uint256 id)
        external
        view
        returns (address seller, address circuits, uint256 tokenId, uint96 price, uint16 feeBps, bool valid);
    function buy(uint256 id, uint96 expectedPrice) external payable;
}
