// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol';

/// @dev Stripped-down essentials of a UniswapV3Pool for oracle tests
contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;

    // Stripped-down slot0
    struct Slot0 {
        int24 tick;
        uint16 observationIndex;
        uint16 observationCardinality;
    }
    Slot0 public _slot0;

    struct Observation {
        uint32 blockTimestamp;
        int56 tickCumulative;
        bool initialized;
    }
    Observation[] public _observations;

    constructor(
        address _tokenA,
        address _tokenB,
        uint16 _observationCardinality
    ) {
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(
            _tokenA,
            _tokenB,
            uint24(0) // pool fee is unused
        );

        token0 = poolKey.token0;
        token1 = poolKey.token1;

        _slot0.observationCardinality = _observationCardinality;
        for (; _observationCardinality > 0; --_observationCardinality) {
            _observations.push();
        }
    }

    /*****************************
     * Used by SpotOracleLibrary *
     *****************************/

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        tick = _slot0.tick;
        observationIndex = _slot0.observationIndex;
        observationCardinality = _slot0.observationCardinality;
        // Other parts of slot0 are not used
    }

    function observations(uint256 _index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        )
    {
        require(
            _index < _slot0.observationCardinality,
            'MockUniswapV3Pool#observations called with invalid index (must be < observationCardinality)'
        );
        Observation memory observation = _observations[_index];

        blockTimestamp = observation.blockTimestamp;
        tickCumulative = observation.tickCumulative;
        initialized = observation.initialized;
        // Other parts of observation are not used
    }

    /*************************
     * Used by OracleLibrary *
     *************************/

    function observe(uint32[] calldata _secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(_secondsAgos.length == 2, 'MockUniswapV3Pool#observe called with invalid array length (must be 2)');
        int56[] memory _tickCumulatives = new int56[](2);
        _tickCumulatives[0] = _calculateTickCumulative(_secondsAgos[0]);
        _tickCumulatives[1] = _calculateTickCumulative(_secondsAgos[1]);

        // secondsPerLiquidityCumulativeX128s is not used
        uint160[] memory _secondsPerLiquidityCumulativeX128s = new uint160[](2);

        return (_tickCumulatives, _secondsPerLiquidityCumulativeX128s);
    }

    /**********************
     * Mocking management *
     **********************/

    function setObservations(uint32[] calldata _blockTimestamps, int56[] calldata _tickCumulatives) external {
        require(
            _blockTimestamps.length == _tickCumulatives.length,
            'MockUniswapV3Pool#setObservations called with invalid array lengths (must be matching)'
        );
        require(
            _blockTimestamps.length <= _slot0.observationCardinality,
            'MockUniswapV3Pool#setObservations called with invalid array lengths (must be < slot0.observationCardinality)'
        );

        for (uint256 ii; ii < _blockTimestamps.length; ++ii) {
            _observations[ii] = Observation(_blockTimestamps[ii], _tickCumulatives[ii], true);
        }
    }

    function setSlot0(int24 _tick, uint16 _observationIndex) external {
        require(
            _observationIndex < _slot0.observationCardinality,
            'MockUniswapV3Pool#setSlot0 called with invalid observationIndex (must be < slot0.observationCardinality)'
        );

        _slot0.tick = _tick;
        _slot0.observationIndex = _observationIndex;
    }

    /*************
     * Internals *
     *************/

    /// @dev Mimic Oracle#observeSingle's behaviour
    ///      See https://github.com/Uniswap/uniswap-v3-core/blob/main/contracts/libraries/Oracle.sol#L245
    function _calculateTickCumulative(uint32 _secondsAgo) private view returns (int56 tickCumulative) {
        uint32 currentTimestamp = _blockTimestamp();
        uint32 target = currentTimestamp - _secondsAgo;

        uint16 currentObsIndex = _slot0.observationIndex;
        uint16 currentObsCardinality = _slot0.observationCardinality;

        for (uint16 ii; ii < currentObsCardinality; ++ii) {
            uint16 obsIndex = _prevObservationIndex(ii, currentObsIndex, currentObsCardinality);
            Observation memory obs = _observations[obsIndex];

            if (_lte(currentTimestamp, obs.blockTimestamp, target)) {
                if (obs.blockTimestamp == target) {
                    // Timestamp matches exactly
                    return obs.tickCumulative;
                } else if (ii == 0) {
                    // Last observation matched but needs adjustment to target
                    // We avoid using slot0 because it's set separately, instead adjusting based on
                    // historical observations' tick cumulatives
                    uint16 priorIndex = _prevObservationIndex(1, currentObsIndex, currentObsCardinality);
                    require(
                        priorIndex != currentObsIndex,
                        'MockUniswapV3Pool#_calculateTickCumulative needed more historical observations'
                    );
                    Observation memory priorObs = _observations[priorIndex];

                    int24 tick = _calculateTickValueFromObservations(obs, priorObs);
                    uint32 delta = target - obs.blockTimestamp;
                    return obs.tickCumulative + int56(tick) * delta;
                } else {
                    // Older observation matched but needs adjustment to target with next observation (in future)
                    uint16 nextIndex = _prevObservationIndex(ii - 1, currentObsIndex, currentObsCardinality);
                    Observation memory nextObs = _observations[nextIndex];

                    int24 nextTick = _calculateTickValueFromObservations(nextObs, obs);
                    uint32 delta = target - obs.blockTimestamp;
                    return obs.tickCumulative + int56(nextTick) * delta;
                }
            }
        }

        revert('MockUniswapV3Pool#_calculateTickCumulative could not find matching observation');
    }

    function _prevObservationIndex(
        uint16 _prevSteps,
        uint16 _current,
        uint16 _cardinality
    ) private pure returns (uint16) {
        if (_current < _prevSteps) {
            return _cardinality - _prevSteps + _current;
        } else {
            return _current - _prevSteps;
        }
    }

    function _calculateTickValueFromObservations(Observation memory _new, Observation memory _old)
        private
        pure
        returns (int24 tick)
    {
        uint32 delta = _new.blockTimestamp - _old.blockTimestamp;
        return int24((_new.tickCumulative - _old.tickCumulative) / delta);
    }

    /// @dev Comparator for 32-bit timestamps
    ///      See https://github.com/Uniswap/uniswap-v3-core/blob/main/contracts/libraries/Oracle.sol#L128
    function _lte(
        uint32 _time,
        uint32 _a,
        uint32 _b
    ) private pure returns (bool) {
        // if there hasn't been overflow, no need to adjust
        if (_a <= _time && _b <= _time) return _a <= _b;

        uint256 aAdjusted = _a > _time ? _a : _a + 2**32;
        uint256 bAdjusted = _b > _time ? _b : _b + 2**32;

        return aAdjusted <= bAdjusted;
    }

    function _blockTimestamp() private view returns (uint32) {
        // truncation is desired
        return uint32(block.timestamp);
    }
}
