// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./ISupportsInterface.sol";

// As in ensdomains/ens-contracts (contracts/resolvers), which OffchainResolver.sol imports.
abstract contract SupportsInterface is ISupportsInterface {
    function supportsInterface(bytes4 interfaceID) public pure virtual override returns (bool) {
        return interfaceID == type(ISupportsInterface).interfaceId;
    }
}
