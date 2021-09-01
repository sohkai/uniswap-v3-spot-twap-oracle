// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol';

contract MockPoolAddress {
    function computeAddress(
        address factory,
        address tokenA,
        address tokenB,
        uint24 fee
    ) external pure returns (address) {
        return PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee));
    }
}
