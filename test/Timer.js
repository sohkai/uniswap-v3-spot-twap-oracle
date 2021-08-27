const { toBn } = require('./math')

// Hardhat network unfortunately does not roll back time between snapshots.
// By using evm_setNextBlockTimestamp, all future timestamps are be affected even across snapshot
// boundaries (i.e. test contexts with beforeEach() and afterEach()).
// This is a simple class to keep track of the current EVM timestamp and to help instantiate mocks
// with the intended timestamp (usually expressed in deltas).
class Timer {
  #utils

  constructor(hre) {
    this.#utils = require('../hardhat/time')(hre)
  }

  async now() {
    return toBn(await this.#utils.getChainTime())
  }

  async setTime(time) {
    await this.#utils.setChainTime(time)
  }
}

module.exports = Timer
