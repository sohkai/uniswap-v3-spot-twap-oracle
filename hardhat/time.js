const ethers = require('ethers')

let _moduleHre

async function getChainTime() {
  const blockNum = await hre.network.provider.request({
    method: 'eth_blockNumber',
    params: [],
  })
  const block = await hre.network.provider.request({
    method: 'eth_getBlockByNumber',
    params: [blockNum, true],
  })
  return parseInt(block.timestamp, 16)
}

async function setChainTime(time) {
  if (ethers.BigNumber.isBigNumber(time)) {
    time = time.toNumber()
  }

  await hre.network.provider.request({
    method: 'evm_setNextBlockTimestamp',
    params: [time],
  })
  await hre.network.provider.request({
    method: 'evm_mine',
    params: [],
  })
}

module.exports = function (hre) {
  _moduleHre = hre

  return {
    getChainTime,
    setChainTime,
  }
}
