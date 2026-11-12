// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

// As in ensdomains/ens-contracts (contracts/resolvers), which OffchainResolver.sol imports.
interface ISupportsInterface {
    function supportsInterface(bytes4 interfaceID) external pure returns (bool);
}
