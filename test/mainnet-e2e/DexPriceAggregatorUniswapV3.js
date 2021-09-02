const { ethers, network } = require('hardhat')
const { expect } = require('chai')
const Asset = require('../Asset')
const { toBn } = require('../math')

const config = require('../../config/mainnet-e2e')

describe('DexPriceAggregatorUniswapV3 (mainnet fork)', function () {
  const weth = new Asset(config.weth, 18)
  const wbtc = new Asset('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8)
  const usdc = new Asset('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6)
  const usdt = new Asset('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6)
  const snx = new Asset('0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', 18)

  let oracle, owner
  const twapPeriod = toBn('60')

  before('ensure fork node', async () => {
    expect(network.config, 'specified fork node').to.have.nested.property('forking.url').that.exists
    expect(network.config, 'enabled fork').to.have.nested.property('forking.enabled').that.exists

    const connectedBlockNumber = await ethers.provider.getBlockNumber()
    expect(connectedBlockNumber).to.equal(config.forkBlockNumber)
  })

  before('ensure configuration', async () => {
    const expectedContracts = [config.uniswapV3Factory, config.weth]
    for (const contract of expectedContracts) {
      expect(
        await ethers.provider.getCode(contract),
        `expected contract at ${contract} is indeed contract`
      ).to.not.equal('0x')
    }

    expect([toBn('500'), toBn('3000'), toBn('10000')]).to.deep.include(toBn(config.defaultPoolFee))
  })

  before('deploy DexPriceAggregatorUniswapV3', async () => {
    const accounts = await ethers.getSigners()
    owner = accounts[1]

    const dexPriceAggregatorUniswapV3Factory = await ethers.getContractFactory('DexPriceAggregatorUniswapV3')
    oracle = await dexPriceAggregatorUniswapV3Factory.deploy(
      owner.address,
      config.uniswapV3Factory,
      config.weth,
      config.defaultPoolFee
    )
    await oracle.deployed()
  })

  it('was deployed correctly', async () => {
    expect(await oracle.owner()).to.addressEqual(owner.address)
    expect(await oracle.uniswapV3Factory()).to.addressEqual(config.uniswapV3Factory)
    expect(await oracle.weth()).to.addressEqual(config.weth)
    expect(await oracle.defaultPoolFee()).to.equal(toBn(config.defaultPoolFee))
  })

  context('price queries', () => {
    async function itQueriesTrade(name, { input, output }) {
      it(name, async () => {
        const { token: tokenIn, amount: amountIn } = input
        const { token: tokenOut, amount: expectedAmountOut, buffer: expectedOutputBuffer } = output

        const readAmountOut = await oracle.assetToAsset(
          tokenIn.address,
          tokenIn.toAmountD(amountIn),
          tokenOut.address,
          twapPeriod
        )
        expect(readAmountOut).to.be.closeTo(
          tokenOut.toAmountD(expectedAmountOut),
          tokenOut.toAmountD(expectedOutputBuffer)
        )
      })
    }

    context('asset to asset', () => {
      // Single pool with eth, from 6 to 18 decimals
      itQueriesTrade('usdc -> eth', {
        input: {
          token: usdc,
          amount: '10000',
        },
        output: {
          token: weth,
          // 1 ETH ~= 3767 USD
          amount: '2.65',
          buffer: '0.01',
        },
      })

      // Single pool with eth, from 18 to 6 decimals
      itQueriesTrade('eth -> usdc', {
        input: {
          token: weth,
          amount: '10',
        },
        output: {
          token: usdc,
          // 1 ETH ~= 3767 USD
          amount: '37670',
          buffer: '10',
        },
      })

      // Two pools through eth, from 6 to 18 to 8 decimals
      itQueriesTrade('usdc -> wbtc', {
        input: {
          token: usdc,
          amount: '10000',
        },
        output: {
          token: wbtc,
          // 1 BTC ~= 49570 USD
          amount: '0.2017',
          buffer: '0.00005',
        },
      })

      // Two pools through eth, from 8 to 18 to 6 decimals
      itQueriesTrade('wbtc -> usdc', {
        input: {
          token: wbtc,
          amount: '10',
        },
        output: {
          token: usdc,
          // 1 BTC ~= 49570 USD
          amount: '495700',
          buffer: '10',
        },
      })

      // Two pools through eth, from 6 to 18 to 18 decimals
      // Note USDT is token1 in USDT:WETH pool whereas all others are token0 in <token>:WETH pool
      itQueriesTrade('usdt -> snx', {
        input: {
          token: usdt,
          amount: '10000',
        },
        output: {
          token: snx,
          // 1 SNX ~= 12.90 USD
          amount: '775',
          buffer: '1',
        },
      })

      // Two pools through eth, from 18 to 18 to 6 decimals
      // Note USDT is token1 in USDT:WETH pool whereas all others are token0 in <token>:WETH pool
      itQueriesTrade('snx -> usdt', {
        input: {
          token: snx,
          amount: '1000',
        },
        output: {
          token: usdt,
          // 1 SNX ~= 12.90 USD
          amount: '12900',
          buffer: '5',
        },
      })
    })

    context('with overriden pools', () => {
      // These tests change the oracle's pool routing behaviour and should be kept last
      before('set overriden pools', async () => {
        const usdcWethFiveBpsPool = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
        const wbtcUsdcThirtyBpsPool = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35'

        await oracle.connect(owner).setPoolForRoute(usdc.address, weth.address, usdcWethFiveBpsPool)
        await oracle.connect(owner).setPoolForRoute(usdc.address, wbtc.address, wbtcUsdcThirtyBpsPool)
      })

      context('asset to asset', () => {
        // Single non-default pool with eth, from 18 to 6 decimals
        itQueriesTrade('usdc -> eth', {
          input: {
            token: usdc,
            amount: '10000',
          },
          output: {
            token: weth,
            // 1 ETH ~= 3755 USD
            // USDC:WETH 5bps pool quotes slightly lower than default quote (~3767 USD)
            amount: '2.66',
            buffer: '0.01',
          },
        })

        // Single pool, from 8 to 6 decimals
        itQueriesTrade('wbtc -> usdc', {
          input: {
            token: wbtc,
            amount: '10',
          },
          output: {
            token: usdc,
            // 1 BTC ~= 49561 USD
            // USDC:WBTC pool quotes slightly lower than default quote (~49570 USD)
            amount: '495610',
            buffer: '10',
          },
        })

        // Two pools through eth, using overridden USDC:WETH 5bps pool, from 6 to 18 to 18 decimals
        itQueriesTrade('usdc -> snx', {
          input: {
            token: usdc,
            amount: '10000',
          },
          output: {
            token: snx,
            // 1 SNX ~= 12.87 USD
            // USDC:WETH bps pool pushes quote slightly lower than default quote (~12.90 USD)
            amount: '777',
            buffer: '1',
          },
        })
      })
    })
  })
})
