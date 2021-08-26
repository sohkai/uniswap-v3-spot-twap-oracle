// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0 <0.8.0;

import '@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';
import '@uniswap/v3-core/contracts/libraries/FullMath.sol';
import '@uniswap/v3-core/contracts/libraries/LowGasSafeMath.sol';
import '@uniswap/v3-core/contracts/libraries/TickMath.sol';
import '@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol';

/// @title Spot Oracle library
/// @notice Provides functions to integrate with a V3 pool's "safe" spot price
library SpotOracleLibrary {
    /// @notice Fetches spot tick using Uniswap V3 oracle
    /// @param pool Address of Uniswap V3 pool that we want to observe
    /// @return spotTick The spot tick, which is either the prior trading block's first observed or ending tick
    function consult(address pool) internal view returns (int24 spotTick) {
        (, int24 currentTick, uint16 currentObservationIndex, uint16 observationCardinality, , , ) = IUniswapV3Pool(pool).slot0();
        (uint32 currentObservationTimestamp, , , ) = IUniswapV3Pool(pool).observations(currentObservationIndex);
        // Stored timestamps are truncated, so assume the last observation was made within a uint32 second time window (~136 years)
        if (beforeNow(currentObservationTimestamp)) {
            // The last observation was written prior to this block, so no trades have occurred since then
            // The pool's current tick can be considered its spot tick
            spotTick = currentTick;
        } else {
            // The last observation was written in this block.
            // Both the current tick value and the last observation are now considered unreliable
            // due to potential manipulation from prior transactions in this block.
            // Instead, provide spot as prior trading block's observed tick.
            spotTick = fetchPreviouslyObservedTick(
                pool,
                1, // fetch second-last observation (one before last)
                currentObservationIndex,
                observationCardinality
            );
        }
    }

    /// @notice Fetches a previously observed tick from a Uniswap V3 oracle
    /// @param pool Address of Uniswap V3 pool that we want to observe
    /// @param prevSteps Number of tick observations to go backwards from last
    /// @return observedTick Previously observed tick
    function consultPreviouslyObservedTick(address pool, uint16 prevSteps) internal view returns (int24 observedTick) {
        (, , uint16 currentObservationIndex, uint16 observationCardinality, , , ) = IUniswapV3Pool(pool).slot0();
        return fetchPreviouslyObservedTick(pool, prevSteps, currentObservationIndex, observationCardinality);
    }

    /// @dev Fetch a previously observed tick.
    ///      This tick _may not_ be the same as the ending tick of a block (ie. reading pool.slot0()'s currentTick)
    ///      as observations are only written to once per block, during the pool's first trade or liquidity change.
    /// @param pool Address of Uniswap V3 pool that we want to observe
    /// @param prevSteps Number of tick observations to go backwards from current
    /// @param currentObservationIndex Current observation index
    /// @param observationCardinality Observation cardinality
    /// @return observedTick Previously observed tick
    function fetchPreviouslyObservedTick(
        address pool,
        uint16 prevSteps,
        uint16 currentObservationIndex,
        uint16 observationCardinality
    ) private view returns (int24 observedTick) {
        // Fetch prior target observation (target) and the one before it (target-1)
        (uint32 targetTimestamp, int56 targetTickCumulative, uint16 targetIndex) =
            fetchPriorObservation(pool, prevSteps, currentObservationIndex, observationCardinality);
        (uint32 targetMinusOneTimestamp, int56 targetMinusOneTickCumulative, uint targetMinusOneIndex) =
            fetchPriorObservation(pool, 1, targetIndex, observationCardinality);
        require(targetMinusOneIndex != currentObservationIndex, 'BC'); // not enough cardinality for target-1

        // "Untransform" target and target-1 into the target's tick value
        // Assume these two observations were made within a uint32 second time window (~136 years)
        uint32 timeDelta = targetTimestamp - targetMinusOneTimestamp; // underflow is desired
        int56 tickDelta = targetTickCumulative - targetMinusOneTickCumulative;

        observedTick = int24(tickDelta / timeDelta);
        // Always round observed tick to negative infinity
        if (tickDelta < 0 && (tickDelta % timeDelta != 0)) observedTick--;
    }

    /// @dev Fetch a prior observation `prevSteps` before a starting index.
    ///      Handles cardinality wrapping and uninitialized observations after cardinality growth.
    /// @param pool Address of Uniswap V3 pool that we want to observe
    /// @param prevSteps Number of tick observations to go backwards from starting
    /// @param startingObservationIndex Observation index to start from
    /// @param observationCardinality Observation cardinality
    /// @return timestamp Prior observation's timestamp
    /// @return tickCumulative Prior observation's tick cumulative value
    /// @return observationIndex Prior observation's index
    function fetchPriorObservation(
        address pool,
        uint16 prevSteps,
        uint16 startingObservationIndex,
        uint16 observationCardinality
    ) private view returns (uint32 timestamp, int56 tickCumulative, uint16 observationIndex) {
        bool initialized;
        for(; !initialized && prevSteps < observationCardinality; ++prevSteps) {
            // This loop handles a specific case when the pool's cardinality has increased but has
            // not yet observed enough new trades to fill out the new indices.
            // If we loop back from 0 to the last index, we will find uninitialized observations and
            // will have to keep looking back.
            observationIndex = prevObservationIndex(prevSteps, startingObservationIndex, observationCardinality);
            (timestamp, tickCumulative, , initialized) = IUniswapV3Pool(pool).observations(observationIndex);
        }
        require(initialized, 'BO'); // ensure found observation is initialized and within cardinality
    }

    /// @dev Returns whether given timestamp (truncated to 32 bits) is before current block timestamp.
    ///      Safe in comparisons across uint32 overflow boundaries.
    ///      `beforeOrNow` _must_ originally have been within one uint32 time period chronologically
    ///      before or equal to `block.timestamp`.
    /// @param beforeOrNow A timestamp chronologically before or equal to the current block timestamp
    /// @return bool Whether `beforeOrNow` is chronologically < block.timestamp
    function beforeNow(uint32 beforeOrNow) private view returns (bool) {
        // If `beforeOrNow` was within one uint32 period to `block.timestamp` then a lower value is
        // naturally an earlier time and a higher value is also an earlier time, only pre-overflow
        return beforeOrNow != uint32(block.timestamp); // truncation is desired
    }

    /// @dev Calculate the index of a past observation `prevSteps` before a starting index.
    ///      Handles cardinality wrapping.
    ///      `prevSteps` _must_ be lte `cardinality`.
    /// @param prevSteps Number of indices to go backwards from starting
    /// @param starting Index to start from
    /// @param cardinality Observation cardinality
    /// @return uint16 Index of past observation
    function prevObservationIndex(uint16 prevSteps, uint16 starting, uint16 cardinality) private pure returns (uint16) {
        if (starting < prevSteps) {
            return cardinality - prevSteps + starting;
        } else {
            return starting - prevSteps;
        }
    }
}
