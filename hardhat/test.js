const { extendConfig, task } = require('hardhat/config')
const { HardhatPluginError } = require('hardhat/plugins')
const { TASK_TEST } = require('hardhat/builtin-tasks/task-names')

const { globForTests } = require('./util')
const mainnetE2eConfiguration = require('../config/mainnet-e2e')

const PLUGIN_NAME = 'TestType'
const TEST_TYPES = {
  unit: 'unit',
  mainnetE2e: 'mainnet-e2e',
}

const forkingEnabled = !!process.env.FORK_NODE

extendConfig((config) => {
  if (forkingEnabled) {
    config.networks.hardhat.forking = {
      url: process.env.FORK_NODE,
      blockNumber: mainnetE2eConfiguration.forkBlockNumber,
      enabled: true,
    }
  }
})

task(TASK_TEST)
  .addOptionalParam('testType', 'Type of test to run ([unit, mainnet-e2e])', 'unit', {
    name: 'testType',
    parse: (argName, strValue) => strValue,
    validate: (argName, value) => {
      const validTypes = Object.values(TEST_TYPES)
      const isValid = validTypes.includes(value.toLowerCase())
      if (!isValid) {
        throw new HardhatPluginError(
          PLUGIN_NAME,
          `Test type parameter invalid (${value}). Valid options: [${validTypes.join(', ')}]`
        )
      }
    },
  })
  .setAction(async ({ testFiles, testType }, hre, runSuper) => {
    if (testType === TEST_TYPES.mainnetE2e) {
      if (!forkingEnabled) {
        throw new HardhatPluginError(
          PLUGIN_NAME,
          'Mainnet E2E tests require the FORK_NODE environment variable to be set.'
        )
      }
    } else if (forkingEnabled) {
      throw new HardhatPluginError(
        PLUGIN_NAME,
        `The test mode selected (${testType}) cannot be used in conjunction with the FORK_NODE environment variable.`
      )
    }

    // Default test file selection only if the user doesn't include any
    if (!Array.isArray(testFiles) || !testFiles.length) {
      if (testType === TEST_TYPES.mainnetE2e) {
        testFiles = await globForTests(hre.config, 'mainnet-e2e/**/*.js')
      } else if (testType === TEST_TYPES.unit) {
        testFiles = await globForTests(hre.config, 'unit/**/*.js')
      }
    }
    // Always attach any shared common setup in the root test dir
    testFiles.push(...(await globForTests(hre.config, '*.js')))

    await runSuper({ testFiles })
  })
