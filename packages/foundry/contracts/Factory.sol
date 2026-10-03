// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { InstantWallet } from "./InstantWallet.sol";
import { ERC1967Clones } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Clones.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Factory (v3)
 * @notice Deploys InstantWallet behind ERC-1967 minimal proxies at CREATE2 addresses derived from the first key
 *         (qx, qy, kind, credentialIdHash), so the address is known before any deposit and nobody can deploy a
 *         key's wallet with a different kind or credential. Deployed at the same address on every chain (CREATE2
 *         through the deterministic deployer), so one key means one address everywhere.
 *         The first key becomes the owner; the default guardians (dao.buidlguidl.eth) and delay are baked in,
 *         both changeable later by an owner.
 * @author BuidlGuidl
 */
contract Factory {
    address public immutable implementation;
    uint64 public immutable defaultRecoveryDelay;
    address[] private _defaultGuardians;

    event WalletCreated(address indexed wallet, address indexed signerId, uint8 kind);

    constructor(address _implementation, address[] memory defaultGuardians_, uint64 _defaultRecoveryDelay) {
        implementation = _implementation;
        _defaultGuardians = defaultGuardians_;
        defaultRecoveryDelay = _defaultRecoveryDelay;
    }

    function defaultGuardians() external view returns (address[] memory) {
        return _defaultGuardians;
    }

    /// @notice Deploy the wallet for this key if it does not exist yet; returns the address either way.
    function createWallet(bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash)
        public
        returns (address wallet)
    {
        bytes32 salt = _salt(qx, qy, kind, credentialIdHash);
        wallet = ERC1967Clones.predictDeterministicAddress(implementation, salt);
        if (wallet.code.length != 0) return wallet;
        ERC1967Clones.cloneDeterministic(implementation, salt);
        InstantWallet(payable(wallet))
            .initialize(qx, qy, kind, credentialIdHash, _defaultGuardians, defaultRecoveryDelay);
        emit WalletCreated(wallet, InstantWallet(payable(wallet)).signerIdOf(qx, qy), kind);
    }

    /**
     * @notice Deploy if needed, then forward `data` (a signed meta call) to the wallet, in one tx. Simulate first:
     *         a bad signature reverts the whole thing, so nothing is paid for a wallet that can't act.
     */
    function createAndCall(bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash, bytes calldata data)
        external
        returns (address wallet, bytes memory result)
    {
        wallet = createWallet(qx, qy, kind, credentialIdHash);
        result = Address.functionCall(wallet, data);
    }

    function getAddress(bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash) external view returns (address) {
        return ERC1967Clones.predictDeterministicAddress(implementation, _salt(qx, qy, kind, credentialIdHash));
    }

    function _salt(bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy, kind, credentialIdHash));
    }
}
