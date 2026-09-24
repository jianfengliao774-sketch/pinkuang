// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {PoolTimelock} from "../../src/PoolTimelock.sol";
import {PoolVault} from "../../src/PoolVault.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IPoolVault} from "../../src/interfaces/IPoolVault.sol";
import {Addresses} from "../../script/Addresses.sol";

interface IFundingVault is IPoolVault, IERC20 {
    function decimals() external view returns (uint8);
    function state() external view returns (IPoolVault.State);
    function params() external view returns (IPoolVault.PoolParams memory);
    function factory() external view returns (address);
    function treasury() external view returns (address);
    function unitPriceWei() external view returns (uint256);
    function totalRaised() external view returns (uint256);
    function contributedWei(address user) external view returns (uint256);
    function bnbOwed(address user) external view returns (uint256);
    function refundsRecorded() external view returns (bool);
    function depositPaused() external view returns (bool);
    function activeMembers() external view returns (address[] memory);
    function memberCount() external view returns (uint256);
    function shareOf(address user) external view returns (uint256);
    function totalBnbOwed() external view returns (uint256);
    function asset() external view returns (address);
    function assetDecimals() external view returns (uint8);
    function assetOwed(address asset_, address user) external view returns (uint256);
    function getPastShares(address user, uint48 timepoint) external view returns (uint256);
    function getPastMemberCount(uint48 timepoint) external view returns (uint256);
    function clock() external view returns (uint48);
}

abstract contract FundingTestBase is Test {
    address internal constant OWNER = address(0x0111);
    address internal constant OPERATOR = address(0x0222);
    address internal constant TREASURY = address(0x0333);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA201);
    uint256 internal constant UNIT_PRICE = 0.065 ether;

    PoolFactory internal poolFactory;
    PoolVault internal vaultImplementation;
    UpgradeableBeacon internal beacon;
    TimelockController internal timelock;
    IFundingVault internal pool;
    IPoolVault.PoolParams internal defaultParams;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        timelock = new PoolTimelock(OWNER);
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        vaultImplementation = new PoolVault(predictedFactory);
        beacon = new PoolBeacon(address(vaultImplementation), address(timelock));
        PoolFactory implementation = new PoolFactory();
        poolFactory = PoolFactory(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        PoolFactory.initialize, (OWNER, OPERATOR, TREASURY, address(timelock), address(beacon))
                    )
                )
            )
        );
        defaultParams = IPoolVault.PoolParams({
            circuits: Addresses.TAPEOUT_CIRCUITS,
            circuitId: 16210,
            targetRaise: 100 * UNIT_PRICE,
            priceCap: 6 ether,
            directSeller: address(0),
            directPrice: 0,
            fundingDeadline: uint64(block.timestamp + 7 days),
            purchaseDeadline: uint64(block.timestamp + 10 days)
        });
        pool = _createPool(defaultParams);
    }

    function _createPool(IPoolVault.PoolParams memory p) internal returns (IFundingVault result) {
        vm.prank(OPERATOR);
        result = IFundingVault(poolFactory.createPool(p));
    }

    function _deposit(IFundingVault vault, address user, uint8 shares) internal {
        uint256 amount = uint256(shares) * vault.unitPriceWei();
        vm.deal(user, user.balance + amount);
        vm.prank(user);
        vault.deposit{value: amount}(shares);
    }

    function _fundPool() internal {
        _deposit(pool, ALICE, 49);
        _deposit(pool, BOB, 49);
        _deposit(pool, CAROL, 2);
    }

    function _stateIs(IPoolVault.State expected) internal view {
        assertEq(uint256(pool.state()), uint256(expected));
    }
}
