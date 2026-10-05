// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RelayTip
 * @notice Pays whoever submitted the transaction. A wallet appends two calls to a signed batch:
 *         `token.transfer(RelayTip, tip)` then `RelayTip.pay(token)`, so the tip goes to `tx.origin`, the EOA that
 *         paid the gas. Nobody knows the relayer at signing time, and nobody has to: whoever lands the batch
 *         before its deadline gets the tip; after the deadline the wallet's own check reverts and nobody gets
 *         anything. Holds nothing between transactions (the transfer and the sweep are in the same batch).
 */
contract RelayTip {
    using SafeERC20 for IERC20;

    event Tipped(address indexed relayer, address indexed token, uint256 amount, address indexed from);

    function pay(IERC20 token) external {
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(tx.origin, amount);
        emit Tipped(tx.origin, address(token), amount, msg.sender);
    }
}
