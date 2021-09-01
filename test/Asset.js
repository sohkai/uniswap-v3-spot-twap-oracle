const { ethers } = require('hardhat')

class Asset {
  constructor(address, decimals) {
    this.address = address
    this.decimals = decimals
  }

  toAmountD(amount) {
    if (typeof amount === 'number') {
      amount = String(amount)
    }
    return ethers.utils.parseUnits(amount, this.decimals)
  }

  formatAmountD(amount) {
    return ethers.utils.formatUnits(amount, this.decimals)
  }
}

module.exports = Asset
