const { ethers } = require('hardhat')

function toBn(num) {
  return ethers.BigNumber.from(num)
}

module.exports = {
  toBn,
}
