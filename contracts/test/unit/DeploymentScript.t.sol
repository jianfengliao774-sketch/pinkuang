// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {AtomicDeployment} from "../../src/AtomicDeployment.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {PoolBeacon} from "../../src/PoolBeacon.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {DeploymentMultisigFixture} from "./AtomicDeployment.t.sol";

/// @notice Execute the actual script against the local VM using public address configuration only.
contract DeploymentScriptTest is Test {
    function test_scriptSimulatesAtomicDeploymentWithoutPrivateKey() public {
        vm.chainId(56);
        address[] memory owners = new address[](3);
        owners[0] = address(0x111);
        owners[1] = address(0x222);
        owners[2] = address(0x333);
        address multisig = address(new DeploymentMultisigFixture(2, owners));
        address deployer = address(0xD310);
        address operator = address(0x0123);
        vm.setEnv("DEPLOYER", vm.toString(deployer));
        vm.setEnv("OWNER_MULTISIG", vm.toString(multisig));
        vm.setEnv("OPERATOR", vm.toString(operator));
        vm.setEnv("TREASURY", vm.toString(multisig));
        vm.deal(deployer, 100 ether);
        Deploy script = new Deploy();
        AtomicDeployment.Deployment memory result = script.run();
        PoolFactory factory = PoolFactory(result.factory);
        assertEq(factory.owner(), multisig);
        assertEq(factory.operator(), operator);
        assertEq(factory.treasury(), multisig);
        assertEq(factory.beacon(), result.beacon);
        assertEq(factory.timelock(), result.timelock);
        assertEq(factory.shareMarket(), result.shareMarket);
        assertEq(PoolBeacon(result.beacon).OFFICIAL_FACTORY(), result.factory);
        assertEq(ShareMarket(result.shareMarket).factory(), result.factory);
    }

    function test_scriptRejectsWrongChainBeforeDeployment() public {
        vm.chainId(1);
        Deploy script = new Deploy();
        vm.expectRevert("BSC mainnet configuration required");
        script.run();
    }
}
