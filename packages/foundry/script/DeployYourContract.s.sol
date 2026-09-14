// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DeployHelpers.s.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/**
 * @notice Deploys the InstantWallet implementation + Factory.
 * @dev On chain id 31337 a MockUSDC is deployed and used as the token. Anywhere else `USDC_ADDRESS` from
 *      packages/foundry/.env is used (Base USDC by default). The deployer is the default recovery
 *      address (the facilitator acting as guardian) with a 1-day delay.
 */
contract DeployYourContract is ScaffoldETHDeploy {
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Circle testnet USDC

    function run() external ScaffoldEthDeployerRunner {
        address token;
        if (block.chainid == 31337) {
            MockUSDC usdc = new MockUSDC();
            token = address(usdc);
            deployments.push(Deployment({ name: "MockUSDC", addr: token }));
            console.log("MockUSDC deployed at:", token);
        } else {
            token = vm.envOr("USDC_ADDRESS", block.chainid == 84532 ? BASE_SEPOLIA_USDC : BASE_USDC);
            console.log("Using token at:", token);
        }

        InstantWallet impl = new InstantWallet();
        deployments.push(Deployment({ name: "InstantWallet", addr: address(impl) }));
        console.log("InstantWallet implementation:", address(impl));

        uint64 delay = uint64(vm.envOr("RECOVERY_DELAY_SECONDS", uint256(1 days)));
        Factory factory = new Factory(address(impl), token, deployer, delay);
        deployments.push(Deployment({ name: "Factory", addr: address(factory) }));
        console.log("Factory:", address(factory), "default recovery:", deployer);
    }
}
