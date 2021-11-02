# DEX-based Oracle (Uniswap V3)

> 🚨 Security status: unaudited

A DEX-based price oracle aggregating spot and TWAP rates from Uniswap V3 that selects the worser rate between spot and TWAP.

Able to handle queries for asset prices across an intermediate liquidity pool (e.g. `WBTC -> WETH -> USDC`).

## Deployments

- Mainnet:
  - [Non-controllable: `0x813A5C304b8E37fA98F43A33DCCf60fA5cDb8739`](https://etherscan.io/address/0x813a5c304b8e37fa98f43a33dccf60fa5cdb8739#readContract)
    - Owner: `address(0xdead)`
    - UniswapV3Factory: [`0x1F98431c8aD98523631AE4a59f267346ea31F984`](https://etherscan.io/address/0x1f98431c8ad98523631ae4a59f267346ea31f984)
    - WETH: [WETH9](https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)
    - Default pool fee: `3000`
  - [Synthetix-controlled: `0xf120F029Ac143633d1942e48aE2Dfa2036C5786c`](https://etherscan.io/address/0xf120f029ac143633d1942e48ae2dfa2036c5786c#readContract)
    - Owner: [`0xEb3107117FEAd7de89Cd14D463D340A2E6917769`](https://etherscan.io/address/0xeb3107117fead7de89cd14d463d340a2e6917769) (Synthetix protocolDAO)
    - UniswapV3Factory: [`0x1F98431c8aD98523631AE4a59f267346ea31F984`](https://etherscan.io/address/0x1f98431c8ad98523631ae4a59f267346ea31f984)
    - WETH: [WETH9](https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)
    - Default pool fee: `3000`

‼️ This oracle's behaviour can be modified by the contract owner. If you would like to have control (see [owner functionality](#owner-functionality)), you should deploy another instance of this oracle with your desired owner.

The frozen, non-controllable instance was deployed with no owner (`address(0xdead)`) and a default pool fee of `3000`. It should be sufficient for testing and basic integrations.

## Price queries

Useful for all price queries:

- Reverts if no pool route is found for the given `tokenIn` and `tokenOut`
- Reverts if `twapPeriod` is `0`
- Reverts if the `twapPeriod` is too large for the underlying pool's history. In this case, you will have to increase the history stored by the pool by calling `UniswapV3Pool#increaseObservationCardinalityNext()` (see [v3 whitepaper section 5.1](https://uniswap.org/whitepaper-v3.pdf)).

It may also be useful to understand the [security considerations](#security-considerations) in using this oracle.

### `assetToAsset()`

Query price of one asset in another asset.

Example query:

- `tokenIn`: [`0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599`](https://etherscan.io/address/0x2260fac5e5542a773aa44fbcfedf7c193bc2c599) (WBTC)
- `amountIn`: `100000000` (1 WBTC; 8 decimals)
- `tokenOut`: [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) (USDC)
- `twapPeriod`: `1800` (30min)

Outputs ~`50099000000` (50099 USDC) as the WBTC/USDC price on 09-03-2021.

### `assetToEth()`

Query price of asset in ETH.

Example query:

- `tokenIn`: [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) (USDC)
- `amountIn`: `1000000000` (1000 USDC; 6 decimals)
- `twapPeriod`: `1800` (30min)

Outputs ~`254000000000000000` (0.254 ETH) as the USDC/ETH price on 09-03-2021.

### `ethToAsset()`

Query price of ETH in asset.

Example query:

- `ethAmountIn`: `1000000000000000000` (1 ETH; 18 decimals)
- `tokenOut`: [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) (USDC)
- `twapPeriod`: `1800` (30min)

Outputs ~`3912000000` (3912 USDC) as the ETH/USDC price on 09-03-2021.

## Owner functionality

### `setPoolForRoute()`

Set the pool to query for a given `tokenIn` and `tokenOut`.

This can be used to configure the oracle to query alternative pools (e.g. 5bps fee pools) instead of the default pool. It can also be used to configure a direct `tokenIn` to `tokenOut` pool for tokens that would have normally crossed with an intermediate pool (e.g. `WBTC -> USDC` instead of `WBTC -> WETH -> USDC`).

## Security considerations

### Spot price is at least one block old

The spot quote reported by this oracle is delayed. To protect from intra-block manipulation, this quote is always at least one block old and does not consider any changes to the pool from the current block.

### Oracle can revert in rare but predictable occasions

The spot quote can be influenced to not be retrievable in certain, predictable scenarios, causing price queries to fail. Specifically, when the underlying pool's observations "rewinds" back to the 0 slot, any account can extend the pool's cardinality and create uninitialized slots at the end of the cardinality. The oracle chooses to revert in this situation rather than loop back through the uninitialized slots to avoid using an unbounded amount of gas.

This situation fixes itself in the block after the next iteration with the underlying pool due to the observation slot moving away from 0. In the worst case, a blocked user can interact with the pool themselves to restore access to any applications querying prices.

This situation becomes rarer with larger cardinalities, so another approach of alleviating this issue is to increase the cardinalities of the pools being queried.

## Development

### Tests

A custom hardhat plugin is included to switch between different test modes. See [`hardhat/test.js`](./hardhat/test.js) for more details.

#### Unit tests

Run `npm run test`.

#### Mainnet-forked E2E

Run `npm run test:mainnet-e2e`.

Expects a fork node url to be specified with the `FORK_NODE` environment variable.

### Deployment

Run `npm run deploy:mainnet`. This will prompt for the different deployment configurations available.

Expects:

- A mainnet node url to be specified with the `MAINNET_NODE` environment variable
- An Etherscan API key to be specified with the `ETHERSCAN_API_KEY` environment variable
