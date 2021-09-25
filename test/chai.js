const { ethers } = require('hardhat')

const chai = require('chai')
const { jestSnapshotPlugin } = require('mocha-chai-jest-snapshot')

chai.use(jestSnapshotPlugin())

// Custom matchers
chai.use(function (chai) {
  chai.Assertion.addMethod('addressEqual', function (address2) {
    const subject = this._obj
    this.assert(
      ethers.utils.getAddress(subject) === ethers.utils.getAddress(address2),
      `Expected ${subject} to equal ${address2}`,
      `Expected ${subject} to not equal ${address2}`
    )
  })
})

module.exports = chai
