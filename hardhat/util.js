const path = require('path')
const util = require('util')

const glob = require('glob')

// Mimic https://github.com/nomiclabs/hardhat/blob/master/packages/hardhat-core/src/internal/util/glob.ts
async function globForTests(config, pattern, options) {
  const patternWithPath = path.join(config.paths.tests, pattern)
  const files = await util.promisify(glob)(patternWithPath, options)
  return files.map(path.normalize)
}

module.exports = {
  globForTests,
}
