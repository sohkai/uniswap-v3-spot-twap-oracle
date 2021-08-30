const hre = require('hardhat')
const { expect } = require('chai')
const Timer = require('../Timer')
const { toBn } = require('../math')

const { ethers } = hre

describe('MockUniswapV3Pool', () => {
  let tokenA, tokenB, poolFactory
  let pool
  const observationCardinality = toBn('3')

  const timer = new Timer(hre)

  beforeEach('setup mocks', async () => {
    const accounts = await ethers.getSigners()
    tokenA = accounts[1].address
    tokenB = accounts[2].address

    poolFactory = await ethers.getContractFactory('MockUniswapV3Pool')
    pool = await poolFactory.deploy(tokenA, tokenB, observationCardinality)
  })

  context('#slot0', () => {
    it('constructed with correct observation cardinality', async () => {
      const { observationCardinality: readCardinality } = await pool.slot0()
      expect(readCardinality).to.equal(observationCardinality)
    })

    it('rest of slot0 defaults to 0', async () => {
      const { sqrtPriceX96, tick, observationIndex, observationCardinalityNext, feeProtocol, unlocked } =
        await pool.slot0()

      expect(sqrtPriceX96).to.equal(0)
      expect(tick).to.equal(0)
      expect(observationIndex).to.equal(0)
      expect(observationCardinalityNext).to.equal(0)
      expect(feeProtocol).to.equal(0)
      expect(unlocked).to.be.false
    })

    context('#setSlot0', () => {
      it('cannot set invalid observation index', async () => {
        await expect(pool.setSlot0(0, observationCardinality.add('1'))).to.be.revertedWith(
          'MockUniswapV3Pool#setSlot0 called with invalid observationIndex (must be < slot0.observationCardinality)'
        )
      })
    })

    context('with slot0 set', () => {
      const newTick = toBn('5000')
      const newObservationIndex = toBn('1')

      beforeEach('', async () => {
        await pool.setSlot0(newTick, newObservationIndex)
      })

      it('reads slot0', async () => {
        const {
          sqrtPriceX96,
          tick,
          observationIndex,
          observationCardinality,
          observationCardinalityNext,
          feeProtocol,
          unlocked,
        } = await pool.slot0()

        expect(tick).to.equal(newTick)
        expect(observationIndex).to.equal(newObservationIndex)
        expect(observationCardinality).to.equal(observationCardinality)

        // Rest of slot0 is untouched
        expect(sqrtPriceX96).to.equal(0)
        expect(observationCardinalityNext).to.equal(0)
        expect(feeProtocol).to.equal(0)
        expect(unlocked).to.be.false
      })
    })
  })

  context('#observations', () => {
    const observations = [
      [toBn('10000000'), toBn('5000')],
      [toBn('10000001'), toBn('5500')],
    ]
    const observationTimes = observations.map(([time]) => time)
    const observationTicks = observations.map(([_, cumulativeTick]) => cumulativeTick)

    context('#setObservations', () => {
      it('can set observations with matching arrays', async () => {
        await pool.setObservations(observationTimes, observationTicks)
      })

      it('cannot set observations with non-matching arrays', async () => {
        await expect(pool.setObservations(observationTimes, [observationTicks[0]])).to.be.revertedWith(
          'MockUniswapV3Pool#setObservations called with invalid array lengths (must be matching)'
        )
      })

      it('cannot set observations larger than cardinality', async () => {
        const tooLargeTimes = Array(observationCardinality.toNumber() + 1).fill(toBn('1000000'))
        const tooLargeTicks = Array(observationCardinality.toNumber() + 1).fill(toBn('5000'))
        await expect(pool.setObservations(tooLargeTimes, tooLargeTicks)).to.be.revertedWith(
          'MockUniswapV3Pool#setObservations called with invalid array lengths (must be < slot0.observationCardinality)'
        )
      })
    })

    context('without observations', () => {
      it('all cardinality is left uninitialized', async () => {
        for (index = 0; index < observationCardinality; ++index) {
          const observation = await pool.observations(index)
          expect(observation.initialized).to.be.false
        }
      })
    })

    context('with observations', () => {
      beforeEach('set observations', async () => {
        await pool.setObservations(observationTimes, observationTicks)
      })

      it('reads set observations', async () => {
        const observation1 = await pool.observations(0)
        expect(observation1.blockTimestamp).to.equal(observationTimes[0])
        expect(observation1.tickCumulative).to.equal(observationTicks[0])
        expect(observation1.initialized).to.be.true

        const observation2 = await pool.observations(1)
        expect(observation2.blockTimestamp).to.equal(observationTimes[1])
        expect(observation2.tickCumulative).to.equal(observationTicks[1])
        expect(observation2.initialized).to.be.true
      })

      it('remaining cardinality is left uninitialized', async () => {
        const observation3 = await pool.observations(2)
        expect(observation3.blockTimestamp).to.equal(0)
        expect(observation3.tickCumulative).to.equal(0)
        expect(observation3.initialized).to.be.false
      })

      it('cannot read observations outside cardinality', async () => {
        await expect(pool.observations(3)).to.be.revertedWith(
          'MockUniswapV3Pool#observations called with invalid index (must be < observationCardinality)'
        )
      })
    })
  })

  context('#observe', () => {
    const observationIndex = 1
    const observations = [
      [toBn('100'), toBn('5000')], // prior observation
      [toBn('200'), toBn('6000')], // current observation
      [toBn('-100'), toBn('4500')], // wrapped cardinality
    ]
    const observationTimeDeltas = observations.map(([time]) => time)
    const observationTicks = observations.map(([_, cumulativeTick]) => cumulativeTick)
    const emptySecondsPerLiquidityCumulative = [toBn('0'), toBn('0')]

    async function setupMocks(chainTimeIncrease) {
      const now = await timer.now()
      const observationTimes = observationTimeDeltas.map((delta) => now.add(delta))
      await pool.setObservations(observationTimes, observationTicks)
      await timer.setTime(now.add(chainTimeIncrease))
    }

    beforeEach('set observation index', async () => {
      await pool.setSlot0(0, observationIndex)
    })

    it('cannot observe with invalid seconds ago (must be 2)', async () => {
      const oneMinute = toBn('60')
      await expect(pool.observe([oneMinute])).to.be.revertedWith(
        'MockUniswapV3Pool#observe called with invalid array length (must be 2)'
      )
      await expect(pool.observe([oneMinute, oneMinute, oneMinute])).to.be.revertedWith(
        'MockUniswapV3Pool#observe called with invalid array length (must be 2)'
      )
    })

    context('without enough historical observations', async () => {
      context('with only one observation', async () => {
        const observationCardinality = 1

        beforeEach('setup mocks', async () => {
          const now = await timer.now()
          pool = await poolFactory.deploy(tokenA, tokenB, observationCardinality)
          await pool.setObservations([now.sub('100')], [toBn('5000')])
        })

        it('cannot observe', async () => {
          await expect(pool.observe([0, 60])).to.be.revertedWith(
            'MockUniswapV3Pool#_calculateTickCumulative needed more historical observations'
          )
        })
      })

      context('without older observations', async () => {
        beforeEach('setup mocks', async () => {
          chainTimeIncrease = toBn('200') // match current observation
          await setupMocks(chainTimeIncrease)
        })

        it('cannot observe past history', async () => {
          await expect(
            pool.observe([
              0,
              350, // past oldest observation
            ])
          ).to.be.revertedWith('MockUniswapV3Pool#_calculateTickCumulative could not find matching observation')
        })
      })
    })

    context('with exactly matching times', () => {
      beforeEach('setup mocks', async () => {
        chainTimeIncrease = toBn('200') // match current observation
        await setupMocks(chainTimeIncrease)
      })

      it('observes correctly', async () => {
        const [tickCumulatives, secondsPerLiquidityCumulatives] = await pool.observe([
          0, // match current observation
          100, // match prior observation
        ])
        expect(tickCumulatives).to.deep.equal([observationTicks[1], observationTicks[0]])
        expect(secondsPerLiquidityCumulatives).to.deep.equal(emptySecondsPerLiquidityCumulative)
      })
    })

    context('with interpolated end time', () => {
      beforeEach('setup mocks', async () => {
        chainTimeIncrease = toBn('300') // extend past current observation
        await setupMocks(chainTimeIncrease)
      })

      it('observes correctly', async () => {
        const [tickCumulatives, secondsPerLiquidityCumulatives] = await pool.observe([
          0, // extrapolate from current observation to now
          200, // match prior observation (300 - 200 = 100)
        ])

        // current observation's cumulative tick = 6000
        // selected time - current observation time = 100s
        // tick delta / s between current and last = 10 tick / s
        // 6000 + 100 * 10 => 7000
        const interpolatedEndTickCumulative = toBn('7000')
        expect(tickCumulatives).to.deep.equal([interpolatedEndTickCumulative, observationTicks[0]])
        expect(secondsPerLiquidityCumulatives).to.deep.equal(emptySecondsPerLiquidityCumulative)
      })
    })

    context('with interpolated start time', () => {
      beforeEach('setup mocks', async () => {
        chainTimeIncrease = toBn('200') // match current observation
        await setupMocks(chainTimeIncrease)
      })

      it('observes correctly', async () => {
        const [tickCumulatives, secondsPerLiquidityCumulatives] = await pool.observe([
          0, // match current observation
          50, // extrapolate from current and prior observation (200 - 50 = 150)
        ])

        // prior observation's cumulative tick = 5000
        // target - prior's observation time = 50s
        // tick delta / s between current and prior = 10 tick / s
        // 5000 + 50 * 10 => 5500
        const interpolatedStartTickCumulative = toBn('5500')
        expect(tickCumulatives).to.deep.equal([observationTicks[1], interpolatedStartTickCumulative])
        expect(secondsPerLiquidityCumulatives).to.deep.equal(emptySecondsPerLiquidityCumulative)
      })
    })

    context('with wrapping cardinality', () => {
      beforeEach('setup mocks', async () => {
        chainTimeIncrease = toBn('200') // match current observation
        await setupMocks(chainTimeIncrease)
      })

      it('observes correctly', async () => {
        const [tickCumulatives, secondsPerLiquidityCumulatives] = await pool.observe([
          0, // match current observation
          300, // match prior-1 observation (200 - 300 = -100)
        ])

        expect(tickCumulatives).to.deep.equal([observationTicks[1], observationTicks[2]])
        expect(secondsPerLiquidityCumulatives).to.deep.equal(emptySecondsPerLiquidityCumulative)
      })
    })

    context('with rounded interpolated time', () => {
      beforeEach('setup mocks', async () => {
        chainTimeIncrease = toBn('200') // match current observation
        await setupMocks(chainTimeIncrease)
      })

      it('observes correctly', async () => {
        const [tickCumulatives, secondsPerLiquidityCumulatives] = await pool.observe([
          0, // match current observation
          150, // extrapolate from prior and prior-1 observation (200 - 150 = 50)
        ])

        // prior-1 observation's cumulative tick = 4500
        // target - prior-1's observation time = 150s
        // tick delta / s between prior and prior-1 = 2.5 tick / s
        // tick delta / s floored to whole number = 2 tick / s
        // 4500 + 150 * 2 => 4800
        const interpolatedStartTickCumulative = toBn('4800')
        expect(tickCumulatives).to.deep.equal([observationTicks[1], interpolatedStartTickCumulative])
        expect(secondsPerLiquidityCumulatives).to.deep.equal(emptySecondsPerLiquidityCumulative)
      })
    })
  })
})
