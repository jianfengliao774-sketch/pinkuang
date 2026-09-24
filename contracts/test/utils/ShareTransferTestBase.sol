// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RewardsTestBase, RewardsVaultHarness} from "./RewardsTestBase.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";

interface IShareTransferVault {
    function lockedShares(address seller) external view returns (uint256);
    function lock(address seller, uint256 amount) external;
    function unlock(address seller, uint256 amount) external;
    function transferLocked(address seller, address buyer, uint256 amount) external;
}

interface IShareRegistry {
    function registerShareMarket(address market) external;
    function shareMarket() external view returns (address);
}

/// @dev Test-only lifecycle fixture for share orders while the whole NFT is Listed.
contract ShareTransferVaultHarness is RewardsVaultHarness {
    constructor(address officialFactory_) RewardsVaultHarness(officialFactory_) {}

    function fixtureSetListed() external {
        require(_vaultStorage().state == State.Active, "fixture requires acquired Active NFT");
        _vaultStorage().state = State.Listed;
    }
}

abstract contract ShareTransferTestBase is RewardsTestBase {
    address internal constant DAVE = address(0xDA7E);
    address internal constant ERIN = address(0xE211);
    address internal constant FRANK = address(0xF2A7);
    ShareMarket internal shareMarket;

    function setUp() public virtual override {
        super.setUp();
        _registerMarket();
        // Buy a fresh NFT after registration so transfers can occur in its exact purchase timestamp.
        defaultParams.circuitId = ++rewardId;
        defaultParams.fundingDeadline = uint64(block.timestamp + 7 days);
        defaultParams.purchaseDeadline = uint64(block.timestamp + 10 days);
        pool = _createPool(defaultParams);
        _activate();
    }

    function _registerMarket() internal {
        ShareMarket implementation = new ShareMarket();
        shareMarket = ShareMarket(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(ShareMarket.initialize, (address(poolFactory), address(timelock)))
                )
            )
        );
        ShareTransferVaultHarness harness = new ShareTransferVaultHarness(address(poolFactory));
        bytes memory registration = abi.encodeCall(IShareRegistry.registerShareMarket, (address(shareMarket)));
        bytes memory upgrade = abi.encodeWithSignature("upgradeTo(address)", address(harness));
        bytes32 registrationSalt = keccak256("share-market-test-registration");
        bytes32 upgradeSalt = keccak256("share-transfer-test-harness");
        vm.startPrank(OWNER);
        timelock.schedule(address(poolFactory), 0, registration, bytes32(0), registrationSalt, 48 hours);
        timelock.schedule(address(beacon), 0, upgrade, bytes32(0), upgradeSalt, 48 hours);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        timelock.execute(address(poolFactory), 0, registration, bytes32(0), registrationSalt);
        timelock.execute(address(beacon), 0, upgrade, bytes32(0), upgradeSalt);
        assertEq(IShareRegistry(address(poolFactory)).shareMarket(), address(shareMarket));
    }

    function _transfer(address seller, address buyer, uint256 amount) internal {
        vm.prank(seller);
        assertTrue(pool.transfer(buyer, amount));
    }

    function _shareVault() internal view returns (IShareTransferVault) {
        return IShareTransferVault(address(pool));
    }
}
