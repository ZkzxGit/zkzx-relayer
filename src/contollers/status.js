const queue = require('../queue.js')
const { netId, tornadoServiceFee, miningServiceFee, instances, rewardAccount } = require('../config')
const { version } = require('../../package.json')
const { redis } = require('../modules/redis')
const { readRelayerErrors } = require('../utils')

async function status(req, res) {
  const ethPrices = await redis.hgetall('prices')
  const health = await redis.hgetall('health')
  health.errorsLog = await readRelayerErrors(redis)

  res.json({
    rewardAccount,
    instances: instances[`netId${netId}`],
    netId,
    ethPrices,
    tornadoServiceFee,
    miningServiceFee,
    version,
    health,
  })
}

function index(req, res) {
  res.send(
    'This is <a href=https://tornadocash.one>tornado cash</a> Relayer service. Check the <a href=/v1/status>/status</a> for settings',
  )
}

async function getJob(req, res) {
  const status = await queue.getJobStatus(req.params.id)
  console.log('debug->status')
  return status ? res.json(status) : res.status(400).json({ error: "The job doesn't exist" })
}

module.exports = {
  status,
  index,
  getJob,
}