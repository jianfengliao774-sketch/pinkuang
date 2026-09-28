// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IFirstoSignedAskExchange} from "./interfaces/IFirstoExchange.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

/// @notice One-use constructor forwarder: Firsto rejects a maker that also calls fillSignedAsk.
/// @dev Created only inside the pool's guarded sale. No administrator, callable runtime,
/// retained funds, reusable signature or NFT approval exists on this executor.
contract FirstoSaleExecutor {
    constructor(IFirstoSignedAskExchange.SignedAsk memory ask, address recipient) payable {
        // CREATE addresses are predictable and may already hold forced BNB.
        uint256 initialBalance = address(this).balance - msg.value;
        if (ask.maker != msg.sender || ask.payoutRecipient != msg.sender || recipient == address(0)) {
            revert IPoolVault.InvalidFirstoOrder();
        }
        if (msg.value != uint256(ask.price) + uint256(ask.price) * ask.feeBps / 10_000) {
            revert IPoolVault.PaymentMismatch();
        }
        IFirstoSignedAskExchange(0x33423244F9a5bF81b12B1a018aF6F4e079B97f29).fillSignedAsk{value: msg.value}(
            ask, new bytes(65), recipient
        );
        if (address(this).balance != initialBalance) revert IPoolVault.PaymentMismatch();
    }
}
