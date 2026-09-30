// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Receives a real refund callback without spoofing the vault's original caller.
contract AtomicRefundRecipient {
    address public immutable vault;
    bool public rejectPayment;
    bool public callbackSeen;
    bool public reentrySucceeded;
    bytes public reentryCall;

    constructor(address vault_) {
        vault = vault_;
    }

    function configure(bool reject_, bytes calldata reentry_) external {
        rejectPayment = reject_;
        reentryCall = reentry_;
    }

    function execute(bytes calldata payload) external {
        (bool ok, bytes memory result) = vault.call(payload);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {
        require(!rejectPayment, "reject BNB");
        callbackSeen = true;
        if (reentryCall.length != 0) (reentrySucceeded,) = vault.call(reentryCall);
    }
}
