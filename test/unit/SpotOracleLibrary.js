const hre = require('hardhat')
const { expect } = require('chai')
const Timer = require('../Timer')
const { toBn } = require('../math')

const { ethers } = hre

describe('OracleSpotLibrary', () => {
  let tokenA, tokenB
  let poolFactory
  let oracle
  let pool

  const timer = new Timer(hre)

  async function setupPool({ cardinality, matchTime, observationIndex, observations, slot0Tick = 0 }) {
    const pool = await poolFactory.deploy(tokenA, tokenB, cardinality)
    await pool.setSlot0(slot0Tick, observationIndex)

    const now = await timer.now()
    const observationTimes = observations.map(([timeDelta]) => now.add(timeDelta))
    const observationTicks = observations.map(([_, cumulativeTick]) => cumulativeTick)
    await pool.setObservations(observationTimes, observationTicks)

    if (matchTime) {
      // Bring the EVM time to match current observation
      await timer.setTime(observationTimes[observationIndex])
    }

    return pool
  }

  beforeEach('setup mocks', async () => {
    const accounts = await ethers.getSigners()
    tokenA = accounts[1].address
    tokenB = accounts[2].address

    const oracleSpotLibraryFactory = await ethers.getContractFactory('MockSpotOracleLibrary')
    oracle = await oracleSpotLibraryFactory.deploy()

    poolFactory = await ethers.getContractFactory('MockUniswapV3Pool')
  })

  context('#consult', () => {
    context('when current observation is before now', () => {
      const slot0Tick = 8888
      const cardinality = 1
      const observationIndex = 0

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality,
          observationIndex,
          observations: [
            [
              (await timer.now()).sub(toBn('100')), // prior to now
              0, // cumulative tick, unused
            ],
          ],
          slot0Tick,
        })
      })

      it('reads correct spot tick', async () => {
        const spotTick = await oracle.consult(pool.address)
        expect(spotTick).to.equal(slot0Tick)
      })
    })

    context('when current observation is before truncation', () => {
      const slot0Tick = 8888
      const cardinality = 1
      const observationIndex = 0

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality,
          observationIndex,
          observations: [
            [
              (await timer.now()).add(toBn('100')), // prior to now and prior to time truncation
              0, // cumulative tick, unused
            ],
          ],
          slot0Tick,
        })
      })

      it('reads correct spot tick', async () => {
        const spotTick = await oracle.consult(pool.address)
        expect(spotTick).to.equal(slot0Tick)
      })
    })

    context('when current observation matches now', () => {
      context('with enough prior observations', () => {
        const cardinality = 3
        const observationIndex = 2

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('100'), toBn('5000')], // prior-1 observation
              [toBn('200'), toBn('6000')], // prior observation
              [toBn('201'), 0], // current observation (tick unused)
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 100s
          // prior - prior-1 tick cumulative = 1000
          // tick delta = 10
          const expectedTick = toBn('10')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('with enough prior observations on imprecise ticks', () => {
        const cardinality = 3
        const observationIndex = 2

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('134'), toBn('5133')], // prior-1 observation
              [toBn('200'), toBn('6000')], // prior observation
              [toBn('201'), 0], // current observation (tick unused)
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 64s
          // prior - prior-1 tick cumulative = 867
          // tick delta ~= 13.54
          // tick delta floored = 13
          const expectedTick = toBn('13')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('with enough prior observations on negative ticks', () => {
        const cardinality = 3
        const observationIndex = 2

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('134'), toBn('-5133')], // prior-1 observation
              [toBn('200'), toBn('-6000')], // prior observation
              [toBn('201'), 0], // current observation (tick unused)
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 64s
          // prior - prior-1 tick cumulative = -867
          // tick delta ~= -13.54
          // tick delta rounded to neg infinity = -14
          const expectedTick = toBn('-14')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('with enough prior observations by wrapping cardinality', () => {
        const cardinality = 3
        const observationIndex = 0

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('201'), 0], // current observation (tick unused)
              [toBn('31'), toBn('4269')], // prior-1 observation
              [toBn('200'), toBn('8888')], // prior observation
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 169s
          // prior - prior-1 tick cumulative = 4619
          // tick delta ~= 27.33
          // tick delta floored = 27
          const expectedTick = toBn('27')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('with enough prior observations but with uninitialized ones', () => {
        const cardinality = 4
        const observationIndex = 0

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('201'), 0], // current observation (tick unused)
              [toBn('42'), toBn('1337')], // prior-1 observation
              [toBn('210'), toBn('6969')], // prior observation
              // last observation is left uninitialized
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 168s
          // prior - prior-1 tick cumulative = 5632
          // tick delta ~= 33.52
          // tick delta floored = 33
          const expectedTick = toBn('33')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('with enough prior observations but with uninitialized ones for prior-1', () => {
        const cardinality = 6
        const observationIndex = 1

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('314'), toBn('117110105')], // prior observation
              [toBn('201'), 0], // current observation (tick unused)
              [toBn('42'), toBn('115110120')], // prior-1 observation
              // last 3 observations are left uninitialized
            ],
          })
        })

        it('reads correct spot tick', async () => {
          // prior - prior-1 observation time = 272s
          // prior - prior-1 tick cumulative = 1999985
          // tick delta ~= 7352.89
          // tick delta floored = 7352
          const expectedTick = toBn('7352')

          const spotTick = await oracle.consult(pool.address)
          expect(spotTick).to.equal(expectedTick)
        })
      })

      context('without any prior observations', () => {
        const cardinality = 1
        const observationIndex = 0

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('100'), 0], // current observation (tick unused)
            ],
          })
        })

        it('cannot read spot tick', async () => {
          await expect(oracle.consult(pool.address)).to.be.revertedWith('BO')
        })
      })

      context('without enough prior observations', () => {
        const cardinality = 2
        const observationIndex = 1

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('100'), toBn('5000')], // prior observation
              [toBn('101'), 0], // current observation (tick unused)
            ],
          })
        })

        it('cannot read spot tick', async () => {
          await expect(oracle.consult(pool.address)).to.be.revertedWith('BC')
        })
      })

      context('without enough prior observations even by wrapping cardinality with uninitialized ones', () => {
        const cardinality = 4
        const observationIndex = 1

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            matchTime: true,
            observations: [
              [toBn('100'), toBn('5000')], // prior observation
              [toBn('101'), 0], // current observation (tick unused)
              // last two observations are left uninitialized
            ],
          })
        })

        it('cannot read spot tick', async () => {
          await expect(oracle.consult(pool.address)).to.be.revertedWith('BC')
        })
      })
    })
  })

  context('#consultPreviouslyObservedTick', () => {
    context('with all prior observations initialized', () => {
      const cardinality = 4
      const observationIndex = 2

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality,
          observationIndex,
          matchTime: true,
          observations: [
            [toBn('-100'), toBn('1000')], // prior-1 observation
            [toBn('100'), toBn('5000')], // prior observation
            [toBn('200'), toBn('6000')], // current observation
            [toBn('-150'), toBn('850')], // prior-2 observation
          ],
        })
      })

      it('can fetch up to cardinality - 2 prior ticks', async () => {
        const readTick0 = await oracle.consultPreviouslyObservedTick(pool.address, 0)
        const readTick1 = await oracle.consultPreviouslyObservedTick(pool.address, 1)
        const readTick2 = await oracle.consultPreviouslyObservedTick(pool.address, 2)

        // current - prior observation time = 100s
        // current - prior tick cumulative = 1000
        // tick delta = 10
        const expectedTick0 = toBn('10')
        expect(readTick0).to.equal(expectedTick0)

        // prior - prior-1 observation time = 200s
        // prior - prior-1 tick cumulative = 4000
        // tick delta = 20
        const expectedTick1 = toBn('20')
        expect(readTick1).to.equal(expectedTick1)

        // prior-1 - prior-2 observation time = 50s
        // prior-1- prior-2 tick cumulative = 150
        // tick delta = 3
        const expectedTick2 = toBn('3')
        expect(readTick2).to.equal(expectedTick2)
      })

      it('cannot fetch past cardinality - 2 prior ticks', async () => {
        await expect(oracle.consultPreviouslyObservedTick(pool.address, cardinality - 1)).to.be.revertedWith('BC') // edge of cardinality
        await expect(oracle.consultPreviouslyObservedTick(pool.address, cardinality)).to.be.revertedWith('BO') // past cardinality
      })
    })

    context('with some observations uninitialized', () => {
      const cardinality = 4
      const observationIndex = 2

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality,
          observationIndex,
          observations: [
            [toBn('-100'), toBn('1000')], // prior-1 observation
            [toBn('100'), toBn('5000')], // prior observation
            [toBn('200'), toBn('6000')], // current observation
            // last observation is left uninitialized
          ],
        })
      })

      it('can fetch up to initialized observations - 2 prior ticks', async () => {
        const readTick0 = await oracle.consultPreviouslyObservedTick(pool.address, 0)
        const readTick1 = await oracle.consultPreviouslyObservedTick(pool.address, 1)

        // current - prior observation time = 100s
        // current - prior tick cumulative = 1000
        // tick delta = 10
        const expectedTick0 = toBn('10')
        expect(readTick0).to.equal(expectedTick0)

        // prior - prior-1 observation time = 200s
        // prior - prior-1 tick cumulative = 4000
        // tick delta = 20
        const expectedTick1 = toBn('20')
        expect(readTick1).to.equal(expectedTick1)
      })

      it('cannot fetch further in the past', async () => {
        await expect(oracle.consultPreviouslyObservedTick(pool.address, 2)).to.be.revertedWith('BC') // edge of cardinality
        await expect(oracle.consultPreviouslyObservedTick(pool.address, 3)).to.be.revertedWith('BO') // past cardinality
      })
    })

    context('without any prior observations', () => {
      const cardinality = 1
      const observationIndex = 0

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality,
          observationIndex,
          observations: [
            [toBn('100'), 0], // current observation (tick unused)
          ],
        })
      })

      it('cannot fetch any past ticks', async () => {
        await expect(oracle.consultPreviouslyObservedTick(pool.address, 0)).to.be.revertedWith('BO')
        await expect(oracle.consultPreviouslyObservedTick(pool.address, 1)).to.be.revertedWith('BO')
      })
    })
  })
})
