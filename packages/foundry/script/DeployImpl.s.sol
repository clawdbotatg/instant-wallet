// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";

/// @notice Deploys an InstantWallet implementation through the CREATE2 deployer (same address on every chain).
///         Wallets move to it with an owner-signed `upgradeToAndCall`; the Factory keeps its own.
contract DeployImpl is Script {
    function run() external {
        vm.startBroadcast();
        InstantWallet impl = new InstantWallet{ salt: keccak256("instant-wallet.v3.2.1") }();
        vm.stopBroadcast();
        console.log("InstantWallet", impl.version(), address(impl));
    }
}
