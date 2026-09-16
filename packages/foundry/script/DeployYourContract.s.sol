// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DeployHelpers.s.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/**
 * @notice Deploys the InstantWallet implementation + Factory at the SAME address on every chain.
 * @dev Both go through the deterministic CREATE2 deployer (0x4e59b4…, present on Base, Ethereum and anvil)
 *      with a fixed salt, so a key's wallet address is identical on Base and on Ethereum. The deployer is
 *      the default recovery address (the facilitator acting as guardian) with a 1-day delay; keep the same
 *      deployer key on every chain or the factory address changes. On chain id 31337 a MockUSDC is also
 *      deployed for the local playground.
 */
contract DeployYourContract is ScaffoldETHDeploy {
    bytes32 constant SALT = keccak256("instant-wallet.v2");
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external ScaffoldEthDeployerRunner {
        if (block.chainid == 31337) {
            MockUSDC usdc = new MockUSDC();
            deployments.push(Deployment({ name: "MockUSDC", addr: address(usdc) }));
            console.log("MockUSDC deployed at:", address(usdc));
        }

        uint64 delay = uint64(vm.envOr("RECOVERY_DELAY_SECONDS", uint256(1 days)));
        InstantWallet impl;
        Factory factory;
        if (CREATE2_DEPLOYER.code.length > 0) {
            impl = new InstantWallet{ salt: SALT }();
            factory = new Factory{ salt: SALT }(address(impl), deployer, delay);
            console.log("deterministic (CREATE2) deployment");
        } else {
            impl = new InstantWallet();
            factory = new Factory(address(impl), deployer, delay);
            console.log("plain deployment (no CREATE2 deployer on this chain)");
        }
        deployments.push(Deployment({ name: "InstantWallet", addr: address(impl) }));
        deployments.push(Deployment({ name: "Factory", addr: address(factory) }));
        console.log("InstantWallet implementation:", address(impl));
        console.log("Factory:", address(factory), "default recovery:", deployer);
    }
}
