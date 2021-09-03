const hre = require('hardhat')
const inquirer = require('inquirer')

const frozenControllerConfig = require('../config/mainnet-frozen')
const synthetixControllerConfig = require('../config/mainnet-synthetix')

async function sanity() {
  const network = await ethers.provider.getNetwork()
  if (network.chainId !== 1) {
    console.log(`Wrong chain id! Expected 1 (mainnet), got: ${network.chainId}`)
    throw new Error('Wrong chain id')
  }

  if (!hre.config.etherscan.apiKey) {
    console.log('Missing Etherscan API key!')
    throw new Error('Missing Etherscan API key')
  }
}

async function selectConfig() {
  console.log()
  const { configName } = await inquirer.prompt([
    {
      type: 'list',
      name: 'configName',
      message: 'Select deployment configuration:',
      choices: [
        {
          name: 'frozen (no owner)',
          value: 'frozen',
        },
        {
          name: 'synthetix',
          value: 'synthetix',
        }
      ],
      default: 0, // default to frozen
    },
  ])
  console.log()

  if (configName === 'frozen') {
    return frozenControllerConfig
  } else if (configName === 'synthetix') {
    return synthetixControllerConfig
  }
}

async function confirm(config) {
  console.log(`Will deploy DexPriceAggregatorUniswapV3, initialized to:`)
  Object.entries(config).forEach(([k, v]) => {
    console.log(`  - ${k}: ${v}`)
  })
  console.log()

  const accounts = await hre.ethers.getSigners()
  console.log(`From address: ${accounts[0].address}`)
  console.log()

  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed?',
      default: false,
    },
  ])
  console.log()

  return confirmed
}

async function deploy(config) {
  console.log('Deploying...')
  console.log(
    config.owner,
    config.uniswapV3Factory,
    config.weth,
    config.defaultPoolFee
  )
  const dexPriceAggregatorUniswapV3Factory = await hre.ethers.getContractFactory('DexPriceAggregatorUniswapV3')
  const oracle = await dexPriceAggregatorUniswapV3Factory.deploy(
    config.owner,
    config.uniswapV3Factory,
    config.weth,
    config.defaultPoolFee
  )

  // Wait for a few confirmations to reduce chances of Etherscan verification failing
  await oracle.deployTransaction.wait(5)
  console.log(`Deployed to address: ${oracle.address}`)

  return oracle
}

async function verify(oracle, config) {
  console.log()
  console.log('Verifying on Etherscan...')
  await hre.run('verify:verify', {
    address: oracle.address,
    constructorArguments: [
      config.owner,
      config.uniswapV3Factory,
      config.weth,
      config.defaultPoolFee
    ],
  })
}

async function main() {
  console.log(`Connecting to ${hre.network.name}...`)
  await sanity()
  const config = await selectConfig()
  if (!(await confirm(config))) {
    console.log('Aborting...')
    return
  }

  // Ok, go ahead and deploy
  const oracle = await deploy(config)
  await verify(oracle, config)

  console.log()
  console.log('All done :)')
}

// Recommended pattern
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
