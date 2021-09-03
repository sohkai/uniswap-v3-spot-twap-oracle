# DEX-based Oracle (Uniswap V3)

> 🚨 Security status: unaudited

A DEX-based price oracle aggregating spot and TWAP rates from Uniswap V3 that selects the worser rate between spot and TWAP.

Able to handle queries for asset prices across an intermediate liquidity pool (e.g. `WBTC -> WETH -> USDC`).

## Deployments

- Mainnet:
  - [Non-controllable: `0xEb3107117FEAd7de89Cd14D463D340A2E6917769`](https://etherscan.io/address/0xeb3107117fead7de89cd14d463d340a2e6917769)
    - Owner: `address(0xdead)`
    - UniswapV3Factory: [`0x1F98431c8aD98523631AE4a59f267346ea31F984`](https://etherscan.io/address/0x1f98431c8ad98523631ae4a59f267346ea31f984)
    - WETH: [WETH9](https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)
    - Default pool fee: `3000`
  - [Synthetix-controlled: `0x925fc225dD238A4637E4aaD343332Ea580a43bb8`](https://etherscan.io/address/0x925fc225dd238a4637e4aad343332ea580a43bb8#readContract)
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

### Spot price is nuanced

The spot quote reported by this oracle is nuanced. Its definition of "spot" changes based on how the underlying pool(s) were interacted with. The spot quote is always at least one block old, in price-freshness terms.

The following different measures of "spot" can be reported:

```
Were the underlying pool(s) interacted with (via trade or liquidity change) this block?
  -> No: report last observed price from a prior block (end of block price)
  -> Yes: Was the last observation made in a block with only one trade?
    -> No: report the first observed price from that block
    -> Yes: report the only observed price from that block (i.e. first and last observed price are same; end of block price)
```

In particular, the second "No" case is important: actors may influence the pool's recorded observation (and thereby reported spot and TWAP quotes) by making the first trade in a block. Assuming they reverse the trade immediately, it only costs the actor `2 * fee` to influence a pool's price, with `fee` determined by how much liquidity they needed to trade to move the price to a desired target.

This case is somewhat shielded in this oracle, requiring a multi-block operation. A diligent actor would have to:

1. Watch the mempool for a transaction that queries from this oracle
2. Prime the underlying pool by making the first interactions with the pool in prior blocks
3. Execute their sandwich

### Gas consumption can dramatically vary

Because Uniswap V3's pools do not contain an external API for fetching the prior initialized observations, this oracle makes its best attempt to loop through the pool's observation slots to find prior observations.

An out-of-gas (or very large gas spend) may occur if an underlying pool's cardinality was increased when its observation index was `0` or `1`. In this case, to obtain spot (requiring two prior initialized observations), the oracle will be forced to loop through `currentCardinality - lastCardinality` indices (~3-5k per index).

Due to the inherent gas costs involved in increasing cardinality (at least 20k per index, based on `SSTORE`s), it would be impossible to DDOS this oracle by doing this as reading each index only costs ~3-5k (less than 20k). However, it can still dramatically increase the gas cost of a price query until new observations are written to the pool.

Also worthwhile to note is that increasing the cardinality would also affect the cost to fetch the TWAP, but is largely mitigated from the binary search used in finding relevant observations for calculating the TWAP.

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
