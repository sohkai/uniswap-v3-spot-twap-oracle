const hre = require('hardhat')
const { expect } = require('chai')
const Asset = require('../Asset')
const Timer = require('../Timer')
const { toBn, units } = require('../math')

const { ethers } = hre

describe('DexPriceAggregatorUniswapV3', () => {
  let oracle, owner
  let poolFactory, uniswapV3Factory
  let weth, token0, token1, tokenZ
  const defaultPoolFee = toBn('3000')

  const timer = new Timer(hre)

  async function setupPool({ cardinality, matchTime, observationIndex, observations, tokens, slot0Tick = 0 }) {
    if (!Array.isArray(tokens) || !tokens.length) {
      tokens = [token0, token1]
    }

    const pool = await poolFactory.deploy(tokens[0].address, tokens[1].address, cardinality)
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
    owner = accounts[1]
    uniswapV3Factory = accounts[2].address

    // Note: we don't need to care about differing token decimals (e.g. 6 or 8 instead of 18)
    // because Uniswap V3's ticks already account for the conversion.
    // Going from an 18-decimal token to a 6-decimal token implies a negative tick (i.e. smaller
    // output) and on the opposite direction, a positive tick (i.e. a larger output)
    weth = new Asset(accounts[3].address, 18)
    // Ensure token0 and token1 are respectively before and after weth to keep tick math sane
    token0 = new Asset(ethers.utils.getAddress(toBn(weth.address).sub(1).toHexString()), 18)
    token1 = new Asset(ethers.utils.getAddress(toBn(weth.address).add(1).toHexString()), 18)
    tokenZ = new Asset(accounts[4].address, 18)

    poolFactory = await ethers.getContractFactory('MockUniswapV3Pool')

    const dexPriceAggregatorUniswapV3Factory = await ethers.getContractFactory('DexPriceAggregatorUniswapV3')
    oracle = await dexPriceAggregatorUniswapV3Factory.deploy(
      owner.address,
      uniswapV3Factory,
      weth.address,
      defaultPoolFee
    )
  })

  context('route management', () => {
    let poolOverride
    let poolAddress

    beforeEach('setup pools', async () => {
      poolOverride = await poolFactory.deploy(token0.address, token1.address, 0)

      const poolAddressFactory = await ethers.getContractFactory('MockPoolAddress')
      poolAddress = await poolAddressFactory.deploy()
    })

    context('#setPoolForRoute', () => {
      it('can set pool with matching tokens for route', async () => {
        const interaction = oracle.connect(owner).setPoolForRoute(token0.address, token1.address, poolOverride.address)
        await expect(interaction)
          .to.emit(oracle, 'PoolForRouteSet')
          .withArgs(token0.address, token1.address, poolOverride.address)
      })

      it('cannot set pool with non-matching tokens for route', async () => {
        const invalidPool = await poolFactory.deploy(token0.address, tokenZ.address, 0)
        await expect(
          oracle.connect(owner).setPoolForRoute(token0.address, token1.address, invalidPool.address)
        ).to.be.revertedWith('Tokens or pool not correct')
      })

      it('cannot set pool if calling as non-owner', async () => {
        await expect(oracle.setPoolForRoute(token0.address, token1.address, poolOverride.address)).to.be.revertedWith(
          'Only the contract owner may perform this action'
        )
      })
    })

    context('with no route override set', () => {
      it('defaults pool routing to computed pool', async () => {
        const expectedPool = await poolAddress.computeAddress(
          uniswapV3Factory,
          token0.address,
          token1.address,
          defaultPoolFee
        )
        const readPool = await oracle.getPoolForRoute(token0.address, token1.address)

        expect(readPool).to.addressEqual(expectedPool)
      })
    })

    context('with route override set', () => {
      beforeEach('set route override', async () => {
        await oracle.connect(owner).setPoolForRoute(token0.address, token1.address, poolOverride.address)
      })

      it('changes pool routing to overridden pool', async () => {
        const readPool = await oracle.getPoolForRoute(token0.address, token1.address)
        expect(readPool).to.addressEqual(poolOverride.address)
      })
    })
  })

  context('price queries', () => {
    let pool1Pos, pool1Neg, pool2Pos, pool2Neg
    const amountIn = units.oneInEighteen
    const twapPeriod = toBn('60')
    const cardinality = 2
    const observationIndex = 1

    const tickConversionRatios = {}
    beforeEach('calculate conversion ratios', async () => {
      const baseQuoteAtTickArgs = [token0.address, amountIn, token1.address]

      // Calculate the expected amountOut for a tick, controlling for amountIn, by "cheating" and
      // using the #getQuoteAtTick utility with a single tick.
      // These results are verified with a check against Wolfram Alpha (who do not suffer loses of
      // precision).

      // 1001000450120021002; close to 1001000450120020900
      // See https://www.wolframalpha.com/input/?i=1.0001%5E10
      // 1.0010004501200210025202100120004500100001 * 1e18
      tickConversionRatios.ten = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '10')
      // 1005012269623051203; close to 1005012269623051300
      // See https://www.wolframalpha.com/input/?i=1.0001%5E50
      // 1.0050122696230512035006938112929613014758231465325678850425814079 * 1e18
      tickConversionRatios.fifty = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '50')
      // 1010049662092876568; close to 1010049662092876500
      // See https://www.wolframalpha.com/input/?i=1.0001%5E100
      // 1.0100496620928765688550188629072566948229834795798171809198011591 * 1e18
      tickConversionRatios.oneHundred = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '100')
      // 1015112303331957826; close to 1015112303331957800
      // See https://www.wolframalpha.com/input/?i=1.0001%5E150
      // 1.0151123033319578267643530983123038913261133530625837466568160093 * 1e18
      tickConversionRatios.oneHundredFifty = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '150')
      // 999000549780071479; close to 999000549780071400
      // See https://www.wolframalpha.com/input/?i=1.0001%5E-10
      // 0.9990005497800714799850038562430513892361206938802661705927002662 * 1e18
      tickConversionRatios.minusTen = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-10')
      // 995012727929250903; close to 995012727929251000
      // See https://www.wolframalpha.com/input/?i=1.0001%5E-50
      // 0.9950127279292509038664997734721554603704755158639167078309052855 * 1e18
      tickConversionRatios.minusFifty = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-50')
      // 990050328741209481; close to 990050328741209500
      // See https://www.wolframalpha.com/input/?i=1.0001%5E-100
      // 0.9900503287412094817103488094315301300297482178915619517176393374 * 1e18
      tickConversionRatios.minusOneHundred = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-100')
      // 985112678388042486; close to 985112678388042500
      // See https://www.wolframalpha.com/input/?i=1.0001%5E-150
      // 0.9851126783880424865309649427654647904769999405977165468499548697 * 1e18
      tickConversionRatios.minusOneHundredFifty = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-150')
      // 970446989120862830; close to 970446989120862800
      // See https://www.wolframalpha.com/input/?i=1.0001%5E-300
      // 0.9704469891208628303191725807367416003440537327063766025905847184 * 1e18
      tickConversionRatios.minusThreeHundred = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-300')
    })

    beforeEach('setup pools', async () => {
      pool1Pos = await setupPool({
        cardinality,
        observationIndex,
        tokens: [token0, weth],
        observations: [
          // Needs two historical observations due to how the mock's #observe works
          [toBn('-100'), toBn('10000')],
          [toBn('0'), toBn('15000')], // twap tick rate of change = 50
        ],
      })

      pool1Neg = await setupPool({
        cardinality,
        observationIndex,
        tokens: [token0, weth],
        observations: [
          // Needs two historical observations due to how the mock's #observe works
          [toBn('-100'), toBn('-10000')],
          [toBn('0'), toBn('-15000')], // twap tick rate of change = -50
        ],
      })

      pool2Pos = await setupPool({
        cardinality,
        observationIndex,
        tokens: [weth, token1],
        observations: [
          // Needs two historical observations due to how the mock's #observe works
          [toBn('-100'), toBn('10000')],
          [toBn('0'), toBn('20000')], // twap tick rate of change = 100
        ],
      })

      pool2Neg = await setupPool({
        cardinality,
        observationIndex,
        tokens: [weth, token1],
        observations: [
          // Needs two historical observations due to how the mock's #observe works
          [toBn('-100'), toBn('-10000')],
          [toBn('0'), toBn('-20000')], // twap tick rate of change = -100
        ],
      })
    })

    context('asset to asset', () => {
      // Anticipate some loss of precision when "crossing" due to the separate calculations
      const accuracyBuffer = toBn('1')

      context('token0 -> token1', () => {
        // token0 -> token1 is in normal tick direction (e.g. higher tick -> higher output)
        context('spot < twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('10')
          const pool2Slot0Tick = toBn('40')

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.fifty, accuracyBuffer)
          })
        })

        context('spot > twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('100')
          const pool2Slot0Tick = toBn('200')

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.oneHundredFifty, accuracyBuffer)
          })
        })

        context('mixed spot < twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('70')
          const pool2Slot0Tick = toBn('30')

          // cross pool spot = 70 + 30 = 100
          // cross pool twap = 50 + 100 = 150

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.oneHundred, accuracyBuffer)
          })
        })

        context('mixed spot > twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('20')
          const pool2Slot0Tick = toBn('300')

          // cross pool spot = 20 + 300 = 320
          // cross pool twap = 50 + 100 = 150

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.oneHundredFifty, accuracyBuffer)
          })
        })
      })

      context('token1 -> token2', () => {
        // token0 -> token1 is in inverted tick direction (e.g. higher tick -> lower output)
        context('spot < twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('10')
          const pool2Slot0Tick = toBn('40')

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token1.address, amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.minusOneHundredFifty, accuracyBuffer)
          })
        })

        context('spot > twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('100')
          const pool2Slot0Tick = toBn('200')

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.assetToAsset(token1.address, amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.minusThreeHundred, accuracyBuffer)
          })
        })

        context('mixed spot < twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('70')
          const pool2Slot0Tick = toBn('30')

          // cross pool spot = 70 + 30 = 100
          // cross pool twap = 50 + 100 = 150

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token1.address, amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.minusOneHundredFifty, accuracyBuffer)
          })
        })

        context('mixed spot > twap', () => {
          let pool1, pool2
          const pool1Slot0Tick = toBn('30')
          const pool2Slot0Tick = toBn('270')

          // cross pool spot = 30 + 270 = 300
          // cross pool twap = 50 + 100 = 150

          beforeEach('set pool overrides', async () => {
            pool1 = pool1Pos
            pool2 = pool2Pos
            // By default the oracle will use the factory-derived pool address,
            // so we override it to use the mock pools for the routes
            await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool1.address)
            await oracle.connect(owner).setPoolForRoute(weth.address, token1.address, pool2.address)
          })

          beforeEach('set spot ticks', async () => {
            await pool1.setSlot0(pool1Slot0Tick, observationIndex)
            await pool2.setSlot0(pool2Slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token1.address, amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.be.closeTo(tickConversionRatios.minusThreeHundred, accuracyBuffer)
          })
        })
      })

      context('through token0:token1 pool', () => {
        let pool

        beforeEach('setup token0:token1 pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            tokens: [token0, token1],
            observations: [
              // Needs two historical observations due to how the mock's #observe works
              [toBn('-100'), toBn('10000')],
              [toBn('0'), toBn('15000')], // twap tick rate of change = 50
            ],
          })

          await oracle.connect(owner).setPoolForRoute(token0.address, token1.address, pool.address)
        })

        context('spot == twap', () => {
          const slot0Tick = toBn('50')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot/twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })
        })

        context('spot > twap', () => {
          const slot0Tick = toBn('100')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })
        })

        context('spot < twap', () => {
          const slot0Tick = toBn('10')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.ten)
          })
        })
      })
    })

    context('asset to eth', () => {
      // eth is token1 for these tests, so with normal tick direction (e.g. higher tick -> higher output)

      context('with positive ticks', () => {
        let pool

        beforeEach('set pool override', async () => {
          pool = pool1Pos
          // By default the oracle will use the factory-derived pool address,
          // so we override it to use the mock pool for the route
          await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool.address)
        })

        context('spot == twap', () => {
          const slot0Tick = toBn('50')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot/twap', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot > twap', () => {
          const slot0Tick = toBn('100')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot < twap', () => {
          const slot0Tick = toBn('10')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.ten)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })
      })

      context('with negative ticks', () => {
        beforeEach('set pool override', async () => {
          pool = pool1Neg
          // By default the oracle will use the factory-derived pool address,
          // so we override it to use the mock pool for the route
          await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool.address)
        })

        context('spot == twap', () => {
          const slot0Tick = toBn('-50')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot/twap', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusFifty)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot > twap', () => {
          const slot0Tick = toBn('-10')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusFifty)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot < twap', () => {
          const slot0Tick = toBn('-100')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusOneHundred)
          })

          it('is the same between #assetToEth and #assetToAsset', async () => {
            const assetToEthAmount = await oracle.assetToEth(token0.address, amountIn, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(token0.address, amountIn, weth.address, twapPeriod)
            expect(assetToEthAmount).to.equal(assetToAssetAmount)
          })
        })
      })
    })

    context('eth to asset', () => {
      // eth is token1 for these tests, so with inverted tick direction (e.g. higher tick -> lower output)

      context('with positive ticks', () => {
        let pool

        beforeEach('set pool override', async () => {
          pool = pool1Pos
          // By default the oracle will use the factory-derived pool address,
          // so we override it to use the mock pool for the route
          await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool.address)
        })

        context('spot == twap', () => {
          const slot0Tick = toBn('50')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot/twap', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusFifty)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot > twap', () => {
          const slot0Tick = toBn('100')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusOneHundred)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot < twap', () => {
          const slot0Tick = toBn('10')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.minusFifty)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })
      })

      context('with negative ticks', () => {
        let pool

        beforeEach('set pool override', async () => {
          pool = pool1Neg
          // By default the oracle will use the factory-derived pool address,
          // so we override it to use the mock pool for the route
          await oracle.connect(owner).setPoolForRoute(token0.address, weth.address, pool.address)
        })

        context('spot == twap', () => {
          const slot0Tick = toBn('-50')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot/twap', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot > twap', () => {
          const slot0Tick = toBn('-10')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects spot', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.ten)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })

        context('spot < twap', () => {
          const slot0Tick = toBn('-100')

          beforeEach('set spot tick', async () => {
            await pool.setSlot0(slot0Tick, observationIndex)
          })

          it('selects twap', async () => {
            const readAmountOut = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            expect(readAmountOut).to.equal(tickConversionRatios.fifty)
          })

          it('is the same between #ethToAsset and #assetToAsset', async () => {
            const ethToAssetAmount = await oracle.ethToAsset(amountIn, token0.address, twapPeriod)
            const assetToAssetAmount = await oracle.assetToAsset(weth.address, amountIn, token0.address, twapPeriod)
            expect(ethToAssetAmount).to.equal(assetToAssetAmount)
          })
        })
      })
    })
  })

  context('price query failures', () => {
    const amountIn = units.oneInEighteen
    const twapPeriod = toBn('60')

    context('when no pool is found', () => {
      it('cannot query price', async () => {
        // No revert message; this will call into an invalid address
        await expect(oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)).to.be.reverted
      })
    })

    context('when twap period is 0', () => {
      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality: 2,
          observationIndex: 1,
          tokens: [token0, token1],
          observations: [
            // Needs two historical observations due to how the mock's #observe works
            [toBn('-70'), toBn('10000')],
            [toBn('-20'), toBn('12000')],
          ],
        })

        await oracle.connect(owner).setPoolForRoute(token0.address, token1.address, pool.address)
      })

      it('cannot query price', async () => {
        const zeroPeriod = '0'
        await expect(oracle.assetToAsset(token0.address, amountIn, token1.address, zeroPeriod)).to.be.revertedWith('BP')
      })
    })

    context("when there's not enough history to fetch spot", () => {
      const observationIndex = 0

      beforeEach('setup pool', async () => {
        pool = await setupPool({
          observationIndex,
          cardinality: 1,
          tokens: [token0, token1],
          observations: [
            [
              toBn('0').sub(twapPeriod).sub(toBn('1')), // set prior to twap window
              toBn('10000'), // cumulative tick
            ],
          ],
        })

        await oracle.connect(owner).setPoolForRoute(token0.address, token1.address, pool.address)
      })

      it('cannot query price', async () => {
        // With production V3 pools this will revert with 'ONI' but this test reverts on the mock
        // pool instead because TWAP is queried first and the mock pool requires two observations
        // for its #observe
        await expect(oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)).to.be.reverted
      })
    })

    context("when there's not enough history to fetch twap", () => {
      beforeEach('setup pool', async () => {
        pool = await setupPool({
          cardinality: 1,
          observationIndex: 0,
          observations: [
            [
              toBn('0').sub(twapPeriod).add(toBn('1')), // set inside twap window
              toBn('10000'), // cumulative tick
            ],
          ],
        })

        await oracle.connect(owner).setPoolForRoute(token0.address, token1.address, pool.address)
      })

      it('cannot fetch ticks', async () => {
        // invalid opcode
        await expect(oracle.assetToAsset(token0.address, amountIn, token1.address, twapPeriod)).to.be.reverted
      })
    })
  })

  context('utilities', () => {
    context('#fetchCurrentTicks', () => {
      let pool

      context('when current observation is before now', () => {
        const cardinality = 2
        const observationIndex = 1
        const slot0Tick = toBn('88')
        const twapPeriod = toBn('60') // 1min

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            slot0Tick,
            observations: [
              // Needs two historical observations due to how the mock's #observe works
              [toBn('-70'), toBn('10000')],
              [toBn('-20'), toBn('12000')],
            ],
          })
        })

        it('fetches correct spot and twap ticks', async () => {
          // prior observation's tick rate of change = (12000 - 10000) / (70 - 20) = 40
          const expectedTwapTick = toBn('40')

          const obs = await pool.observe([twapPeriod, 0])
          const outputs = await oracle.fetchCurrentTicks(pool.address, twapPeriod)
          expect(outputs.spotTick).to.equal(slot0Tick)
          expect(outputs.twapTick).to.equal(expectedTwapTick)
        })
      })

      context('when current observation matches now', () => {
        const cardinality = 3
        const observationIndex = 2
        const slot0Tick = toBn('88')
        const twapPeriod = toBn('60') // 1min

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            slot0Tick,
            matchTime: true, // force spot to use historical observations
            observations: [
              [toBn('-70'), toBn('10000')],
              [toBn('-20'), toBn('12000')],
              [toBn('10'), toBn('13000')],
            ],
          })
        })

        it('fetches correct spot and twap ticks', async () => {
          // prior observation's tick rate of change = (13000 - 12000) / (10 - -20) = 33
          const expectedSpotTick = toBn('33')
          // prior two observations' twap rate of change = (30s * 40 + 30s * 33) / 60s ~= 36
          const expectedTwapTick = toBn('36')

          const obs = await pool.observe([twapPeriod, 0])
          const outputs = await oracle.fetchCurrentTicks(pool.address, twapPeriod)
          expect(outputs.spotTick).to.equal(expectedSpotTick)
          expect(outputs.twapTick).to.equal(expectedTwapTick)
        })
      })

      context("when there's not enough history to fetch spot", () => {
        const cardinality = 1
        const observationIndex = 0
        const twapPeriod = toBn('60') // 1min

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            observations: [
              [
                toBn('0').sub(twapPeriod).sub(toBn('1')), // set prior to twap window
                toBn('10000'), // cumulative tick
              ],
            ],
          })
        })

        it('cannot fetch ticks', async () => {
          // With production V3 pools this will revert with 'ONI' but this test reverts on the mock
          // pool instead because TWAP is queried first and the mock pool requires two observations
          // for its #observe
          await expect(oracle.fetchCurrentTicks(pool.address, twapPeriod)).to.be.reverted
        })
      })

      context("when there's not enough history to fetch twap", () => {
        const cardinality = 1
        const observationIndex = 0
        const twapPeriod = toBn('60') // 1min

        beforeEach('setup pool', async () => {
          pool = await setupPool({
            cardinality,
            observationIndex,
            observations: [
              [
                toBn('0').sub(twapPeriod).add(toBn('1')), // set inside twap window
                toBn('10000'), // cumulative tick
              ],
            ],
          })
        })

        it('cannot fetch ticks', async () => {
          // invalid opcode
          await expect(oracle.fetchCurrentTicks(pool.address, twapPeriod)).to.be.reverted
        })
      })
    })

    // Similar to https://github.com/Uniswap/uniswap-v3-periphery/blob/v1.1.1/test/OracleLibrary.spec.ts#L125-L192
    context('#getQuoteAtTick', () => {
      const maxTick = toBn('887272')
      const minTick = toBn('-887272')

      context('with base asset (token0) as input', () => {
        it('quotes correctly at zero tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token0.address, units.oneInEighteen, token1.address, '0')
          expect(amountOut).to.equal(units.oneInEighteen)
        })

        it('quotes correctly at max tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token0.address, units.maxUint128, token1.address, maxTick)
          expect(amountOut).to.equal(
            toBn('115783384785599357996676985412062652720342362943929506828539444553934033845703')
          )
        })

        it('quotes correctly at min tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token0.address, units.maxUint128, token1.address, minTick)
          expect(amountOut).to.equal(toBn('1'))
        })
      })

      context('when quote asset (token1) as input', () => {
        it('quotes correctly at zero tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token1.address, units.oneInEighteen, token1.address, '0')
          expect(amountOut).to.equal(units.oneInEighteen)
        })

        it('quotes correctly at max tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token1.address, units.maxUint128, token0.address, maxTick)
          expect(amountOut).to.equal(toBn('1'))
        })

        it('quotes correctly at min tick', async () => {
          const amountOut = await oracle.getQuoteAtTick(token1.address, units.maxUint128, token0.address, minTick)
          expect(amountOut).to.equal(
            toBn('115783384738768196242144082653949453838306988932806144552194799290216044976282')
          )
        })
      })
    })

    context('#getQuoteCrossingTicksThroughWeth', () => {
      // These tests are based on the mathematical properties of multiplying exponentials (ticks):
      // e^x * e^y == e^(x + y)
      // Each tick represents 1.0001^(tick/2), so two tick values taken together simply turn into:
      // 1.0001^((tick1 + tick 2) / 2)
      // (Assuming each tick represents the correct direction in the conversion ratio, i.e.
      // tick1 represents asset1 -> asset2 and tick2 represents asset2 -> asset3)

      // We use a constant 1e18 amountIn (1 token for 18-decimal tokens) to simplify output calculations
      const amountIn = units.oneInEighteen
      // Anticipate some loss of precision when "crossing" due to the separate calculations
      const accuracyBuffer = toBn('1')

      const tickConversionRatios = {}
      beforeEach('calculate conversion ratios', async () => {
        const baseQuoteAtTickArgs = [token0.address, amountIn, token1.address]

        // Given the note above about exponentials, we calculate the expected amountOut for any
        // combination of intermediate ticks, controlling for amountIn, by "cheating" and using the
        // #getQuoteAtTick utility with a single tick.
        // These results are verified with a check against Wolfram Alpha (who do not suffer loses of
        // precision).

        // 1000000000000000000; same as amountIn
        tickConversionRatios.zero = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '0')
        // 1105165392603232697; close to 1105165392603232800
        // See https://www.wolframalpha.com/input/?i=1.0001%5E1000
        // 1.1051653926032326972401842401090585374647894196649496734036554685 * 1e18
        tickConversionRatios.oneThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '1000')
        // 1648680055931175769; close to 1648680055931176000
        // See https://www.wolframalpha.com/input/?i=1.0001%5E5000
        // 1.6486800559311757696282000454510489768440112494650304001935948698 * 1e18
        tickConversionRatios.fiveThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '5000')
        // 2225451914569830285; close to 2225451914569830100
        // See https://www.wolframalpha.com/input/?i=1.0001%5E8000
        // 2.2254519145698302859661795853614403180614594406421280533537328872 * 1e18
        tickConversionRatios.eightThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '8000')
        // 904841941932768878; close to 904841941932768900
        // See https://www.wolframalpha.com/input/?i=1.0001%5E-1000
        // 0.9048419419327688780828649606813621769468236040098577028904490006 * 1e18
        tickConversionRatios.minusOneThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-1000')
        // 606545822157834757; close to 606545822157834800
        // See https://www.wolframalpha.com/input/?i=1.0001%5E-5000
        // 0.6065458221578347578405131291196676381010272902296962274902334230 * 1e18
        tickConversionRatios.minusFiveThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-5000')
        // 449346936437085607; close to 449346936437085630
        // See https://www.wolframalpha.com/input/?i=1.0001%5E-8000
        // 0.4493469364370856079130851023830621442001220514453128349382277413 * 1e18
        tickConversionRatios.minusEightThousand = await oracle.getQuoteAtTick(...baseQuoteAtTickArgs, '-8000')
      })

      it('quotes correctly at [0, 0] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '0',
          '0'
        )
        expect(amountOut).to.equal(tickConversionRatios.zero)
      })

      it('quotes correctly at [0, positive] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '0',
          '5000'
        )
        expect(amountOut).to.equal(tickConversionRatios.fiveThousand)
      })

      it('quotes correctly at [positive, 0] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '1000',
          '0'
        )
        expect(amountOut).to.equal(tickConversionRatios.oneThousand)
      })

      it('quotes correctly at [0, negative] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '0',
          '-1000'
        )
        expect(amountOut).to.equal(tickConversionRatios.minusOneThousand)
      })

      it('quotes correctly at [negative, 0] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '-5000',
          '0'
        )
        expect(amountOut).to.equal(tickConversionRatios.minusFiveThousand)
      })

      it('quotes correctly at [positive, positive] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '3000',
          '5000'
        )
        expect(amountOut).to.be.closeTo(tickConversionRatios.eightThousand, accuracyBuffer)
      })

      it('quotes correctly at [positive, negative] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '-4000',
          '5000'
        )
        expect(amountOut).to.be.closeTo(tickConversionRatios.oneThousand, accuracyBuffer)
      })

      it('quotes correctly at [negative, positive] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '4000',
          '-5000'
        )
        expect(amountOut).to.be.closeTo(tickConversionRatios.minusOneThousand, accuracyBuffer)
      })

      it('quotes correctly at [negative, negative] ticks', async () => {
        const amountOut = await oracle.getQuoteCrossingTicksThroughWeth(
          token0.address,
          amountIn,
          token1.address,
          '-3000',
          '-5000'
        )
        expect(amountOut).to.be.closeTo(tickConversionRatios.minusEightThousand, accuracyBuffer)
      })

      it('quotes "realistic" examples', async () => {
        const usdc = new Asset('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6)
        const wbtc = new Asset('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8)
        const snx = new Asset('0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', 18)

        // WBTC -> ETH -> USDC on 08/29/2021
        // WBTC -> ETH tick: 257449 (1 WBTC ~= 15.146 ETH)
        // ETH -> USDC tick: 195470 (1 ETH ~= 3245.415 USDC)
        const expectedAmountOutForWbtc = usdc.toAmountD('49155')
        const amountOutForWbtc = await oracle.getQuoteCrossingTicksThroughWeth(
          wbtc.address,
          wbtc.toAmountD('1'),
          usdc.address,
          '257449', // WBTC is token 0 in WBTC:ETH
          '-195470' // USDC is token 0 in USDC:ETH
        )
        expect(amountOutForWbtc).to.be.closeTo(expectedAmountOutForWbtc, usdc.toAmountD('2'))

        // SNX -> ETH -> USDC on 08/29/2021
        // SNX -> ETH tick: -56244 (1 SNX ~= 0.00361 ETH)
        // ETH -> USDC tick: 195470 (1 ETH ~= 3245.415 USDC)
        const expectedAmountOutForSnx = usdc.toAmountD('11.716')
        const amountOutForSnx = await oracle.getQuoteCrossingTicksThroughWeth(
          snx.address,
          snx.toAmountD('1'),
          usdc.address,
          '56244', // SNX is token 0 in SNX:ETH
          '-195470' // USDC is token 0 in USDC:ETH
        )
        expect(amountOutForSnx).to.be.closeTo(expectedAmountOutForSnx, usdc.toAmountD('0.005'))
      })
    })
  })
})
