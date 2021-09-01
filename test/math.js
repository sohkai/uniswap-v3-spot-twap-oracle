const { ethers } = require('hardhat')

function toBn(num) {
  return ethers.BigNumber.from(num)
}

const units = {
  oneInEighteen: toBn('10').pow('18'),
  maxUint256: toBn('2').pow('256').sub('1'),
  maxUint128: toBn('2').pow('128').sub('1'),
}

module.exports = {
  toBn,
  units,
}
