// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { InstantWallet } from "./InstantWallet.sol";
import { Clones } from "./Clones.sol";

/**
 * @title Factory
 * @notice Deploys InstantWallet clones (EIP-1167) at CREATE2 addresses derived from the first key, so the
 *         address is known before any deposit and the wallet can stay counterfactual until its first
 *         outbound action (`createWallet` is idempotent: the relayer calls it right before the first meta
 *         call). Deployed at the same address on every chain (CREATE2 through the deterministic deployer,
 *         see script/Deploy.s.sol), so one key means one address everywhere.
 *         The first key becomes the owner; the factory's default recovery address (the facilitator acting
 *         as guardian) and delay are baked in, both changeable later by an owner-signed `metaSetRecovery`.
 * @author BuidlGuidl
 */
contract Factory {
    address public immutable implementation;
    address public defaultRecovery;
    uint64 public defaultRecoveryDelay;

    event WalletCreated(address indexed signerId, address indexed wallet, bytes32 salt);
    event DefaultRecoveryChanged(address indexed recovery, uint64 delay);

    error OnlyDefaultRecovery();

    constructor(address _implementation, address _defaultRecovery, uint64 _defaultRecoveryDelay) {
        implementation = _implementation;
        defaultRecovery = _defaultRecovery;
        defaultRecoveryDelay = _defaultRecoveryDelay;
    }

    /// @notice Deploy the wallet for `(qx, qy)` if it does not exist yet; returns the address either way.
    function createWallet(bytes32 salt, bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash)
        external
        returns (address wallet)
    {
        bytes32 finalSalt = _salt(qx, qy, salt);
        wallet = Clones.predictDeterministicAddress(implementation, finalSalt, address(this));
        if (wallet.code.length != 0) return wallet;
        Clones.cloneDeterministic(implementation, finalSalt);
        InstantWallet(payable(wallet)).initialize(qx, qy, kind, credentialIdHash, defaultRecovery, defaultRecoveryDelay);
        emit WalletCreated(InstantWallet(payable(wallet)).signerIdOf(qx, qy), wallet, salt);
    }

    function getWalletAddress(bytes32 qx, bytes32 qy, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(qx, qy, salt), address(this));
    }

    function isDeployed(bytes32 qx, bytes32 qy, bytes32 salt) external view returns (bool) {
        return Clones.predictDeterministicAddress(implementation, _salt(qx, qy, salt), address(this)).code.length != 0;
    }

    function setDefaultRecovery(address _recovery, uint64 _delay) external {
        if (msg.sender != defaultRecovery) revert OnlyDefaultRecovery();
        defaultRecovery = _recovery;
        defaultRecoveryDelay = _delay;
        emit DefaultRecoveryChanged(_recovery, _delay);
    }

    function _salt(bytes32 qx, bytes32 qy, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(InstantWallet(payable(implementation)).signerIdOf(qx, qy), salt));
    }
}
