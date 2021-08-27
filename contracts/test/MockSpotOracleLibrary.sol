// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../libraries/SpotOracleLibrary.sol';

/// @dev Exposes SpotOracleLibrary's internal methods for testing
contract MockSpotOracleLibrary {
    function consult(address _pool) external view returns (int24 spotTick) {
        return SpotOracleLibrary.consult(_pool);
    }

    function consultPreviouslyObservedTick(address _pool, uint16 _prevSteps)
        external
        view
        returns (int24 observedTick)
    {
        return SpotOracleLibrary.consultPreviouslyObservedTick(_pool, _prevSteps);
    }
}
