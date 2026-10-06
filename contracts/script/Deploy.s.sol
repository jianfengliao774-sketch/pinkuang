// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AtomicDeployment} from "../src/AtomicDeployment.sol";
import {PoolVault} from "../src/PoolVault.sol";
import {PoolFactory} from "../src/PoolFactory.sol";
import {ShareMarket} from "../src/ShareMarket.sol";

/// @notice Run forge script without --broadcast for a local simulation against a BSC RPC.
/// @dev Reads public addresses only. A future explicit broadcast must use an external CLI signer.
/// The returned/logged addresses, codehashes, compiled artifacts and Forge transaction data form the deployment record.
contract Deploy is Script {
    function run() external returns (AtomicDeployment.Deployment memory result) {
        require(block.chainid == 56, "BSC mainnet configuration required");
        address deployer = vm.envAddress("DEPLOYER");
        require(deployer != address(0), "DEPLOYER must be nonzero");
        AtomicDeployment.Config memory config;
        config.ownerMultisig = vm.envAddress("OWNER_MULTISIG");
        config.operator = vm.envAddress("OPERATOR");
        config.treasury = vm.envAddress("TREASURY");

        vm.startBroadcast(deployer);
        AtomicDeployment coordinator = new AtomicDeployment();
        config.vaultImplementation = address(new PoolVault(coordinator.predictedFactory()));
        config.factoryImplementation = address(new PoolFactory());
        config.marketImplementation = address(new ShareMarket());
        result = coordinator.deploy(config);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("coordinator", address(coordinator));
        console2.log("deployer", deployer);
        console2.log("ownerMultisig", config.ownerMultisig);
        console2.log("operator", config.operator);
        console2.log("treasury", config.treasury);
        console2.log("timelock", result.timelock);
        console2.log("beacon", result.beacon);
        console2.log("factory", result.factory);
        console2.log("shareMarket", result.shareMarket);
        console2.log("vaultImplementation", config.vaultImplementation);
        console2.logBytes32(config.vaultImplementation.codehash);
        console2.log("factoryImplementation", config.factoryImplementation);
        console2.logBytes32(config.factoryImplementation.codehash);
        console2.log("marketImplementation", config.marketImplementation);
        console2.logBytes32(config.marketImplementation.codehash);
    }
}
