/* eslint-disable no-unused-vars */
const { GasPriceOracle } = require('gas-price-oracle')
const tornadoABI = require('../abis/tornadoABI.json')
const tornadoProxyABI = require('../abis/tornadoProxyABI.json')
const { queue } = require('./queue')
const {
  getInstance,
  fromDecimals,
  toBN,
  toWei,
  fromWei,
  RelayerError,
  logRelayerError,
} = require('./utils')
const { jobType, status } = require('./constants')
const {
  gasLimits,
  privateKey,
  httpRpcUrl,
  oracleRpcUrl,
  baseFeeReserve,
  tornadoServiceFee,
} = require('./config')
const { TxManager } = require('tx-manager')
const { redis } = require('./modules/redis')
const getWeb3 = require('./modules/web3')

let web3
let currentTx
let currentJob
let txManager
const gasPriceOracle = new GasPriceOracle({ defaultRpc: oracleRpcUrl })

// async function fetchTree() {
//   const elements = await redis.get('tree:elements')
//   const convert = (_, val) => (typeof val === 'string' ? toBN(val) : val)
//   tree = MerkleTree.deserialize(JSON.parse(elements, convert), poseidonHash2)

//   if (currentTx && currentJob && ['MINING_REWARD', 'MINING_WITHDRAW'].includes(currentJob.data.type)) {
//     const { proof, args } = currentJob.data
//     if (toBN(args.account.inputRoot).eq(toBN(tree.root()))) {
//       console.log('Account root is up to date. Skipping Root Update operation...')
//       return
//     } else {
//       console.log('Account root is outdated. Starting Root Update operation...')
//     }

//     const update = await controller.treeUpdate(args.account.outputCommitment, tree)

//     const minerAddress = await resolver.resolve(torn.miningV2.address)
//     const instance = new web3.eth.Contract(miningABI, minerAddress)
//     const data =
//       currentJob.data.type === 'MINING_REWARD'
//         ? instance.methods.reward(proof, args, update.proof, update.args).encodeABI()
//         : instance.methods.withdraw(proof, args, update.proof, update.args).encodeABI()
//     await currentTx.replace({
//       to: minerAddress,
//       data,
//     })
//     console.log('replaced pending tx')
//   }
// }

async function start() {
  try {
    console.log('debug->start1')
    await clearErrors()
    web3 = getWeb3()
    const { CONFIRMATIONS, MAX_GAS_PRICE } = process.env
    txManager = new TxManager({
      privateKey,
      rpcUrl: httpRpcUrl,
      config: {
        CONFIRMATIONS,
        MAX_GAS_PRICE,
        THROW_ON_REVERT: false,
        BASE_FEE_RESERVE_PERCENTAGE: baseFeeReserve,
      },
    })
    queue.process(processJob)
    console.log('Worker started')
  } catch (e) {
    await logRelayerError(redis, e)
    console.error('error on start worker', e.message)
  }
}


async function getGasPrice() {
  const block = await web3.eth.getBlock('latest')
  const block1 = await web3.eth.getBlockNumber()
  console.log('block', block)
  console.log('block1', block1)
  if (block && block.baseFeePerGas) {
    return block.baseFeePerGas
  }
  return 3000000000000000
}

async function checkTornadoFee({ args, contract }) {
  const { currency, amount, decimals } = getInstance(contract)
  const [fee, refund] = [args[4], args[5]].map(toBN)
  const gasPrice = await getGasPrice()

  const ethPrice = await redis.hget('prices', currency)
  const expense = gasPrice.mul(toBN(gasLimits[jobType.TORNADO_WITHDRAW]))

  const feePercent = toBN(fromDecimals(amount, decimals))
    .mul(toBN(parseInt(tornadoServiceFee * 1e10)))
    .div(toBN(1e10 * 100))

  let desiredFee
  switch (currency) {
    case 'eth':
    {
      desiredFee = expense.add(feePercent)
      break
    }
    default:
    {
      desiredFee = expense
        .add(refund)
        .mul(toBN(10 ** decimals))
        .div(toBN(ethPrice))
      desiredFee = desiredFee.add(feePercent)
      break
    }
  }
  console.log(
    'sent fee, desired fee, feePercent',
    fromWei(fee.toString()),
    fromWei(desiredFee.toString()),
    fromWei(feePercent.toString()),
  )
}

// eslint-disable-next-line require-await
async function getProxyContract() {
  const contract = new web3.eth.Contract(tornadoProxyABI, '0xe563D633D32690b6c63c2520F41EDF970a5ae91E')
  return {
    contract,
    isOldProxy: false,
  }
}

async function getTxObject({ data }) {
  console.log('debug->getTxObject', data)
  let { contract, isOldProxy } = await getProxyContract()

  let calldata = contract.methods.withdraw(data.contract, data.proof, ...data.args).encodeABI()

  if (isOldProxy && getInstance(data.contract).currency !== 'eth') {
    contract = new web3.eth.Contract(tornadoABI, data.contract)
    calldata = contract.methods.withdraw(data.proof, ...data.args).encodeABI()
  }
  const gasPrice = await getGasPrice()
  console.log('debug->gasPrice', gasPrice)
  return {
    value: data.args[5],
    to: contract._address,
    data: calldata,
    gasLimit: gasLimits['TORNADO_WITHDRAW'],
    gasPrice: gasPrice
  }
}

async function isOutdatedTreeRevert(receipt, currentTx) {
  try {
    await web3.eth.call(currentTx.tx, receipt.blockNumber)
    console.log('Simulated call successful')
    return false
  } catch (e) {
    console.log('Decoded revert reason:', e.message)
    return (
      e.message.indexOf('Outdated account merkle root') !== -1 ||
            e.message.indexOf('Outdated tree update merkle root') !== -1
    )
  }
}

async function processJob(job) {
  console.log(job + ' : job process job')
  console.log(job.data.type + ': job type')
  try {
    if (!jobType[job.data.type]) {
      throw new RelayerError(`Unknown job type: ${job.data.type}`)
    }
    currentJob = job
    await updateStatus(status.ACCEPTED)
    console.log(`Start processing a new ${job.data.type} job #${job.id}`)
    await submitTx(job)
  } catch (e) {
    console.error('processJob', e.message)
    await updateStatus(status.FAILED)
    throw new RelayerError(e.message)
  }
}

async function submitTx(job, retry = 0) {
  // await checkFee(job)
  currentTx = await txManager.createTx(await getTxObject(job))

  // if (job.data.type !== jobType.TORNADO_WITHDRAW) {
  //   await fetchTree()
  // }

  try {
    const receipt = await currentTx
      .send()
      .on('transactionHash', txHash => {
        updateTxHash(txHash)
        updateStatus(status.SENT)
      })
      .on('mined', receipt => {
        console.log('Mined in block', receipt.blockNumber)
        updateStatus(status.MINED)
      })
      .on('confirmations', updateConfirmations)

    if (receipt.status === 1) {
      await updateStatus(status.CONFIRMED)
    } else {
      if (job.data.type !== jobType.TORNADO_WITHDRAW && (await isOutdatedTreeRevert(receipt, currentTx))) {
        if (retry < 3) {
          await updateStatus(status.RESUBMITTED)
          await submitTx(job, retry + 1)
        } else {
          throw new RelayerError('Tree update retry limit exceeded')
        }
      } else {
        throw new RelayerError('Submitted transaction failed')
      }
    }
  } catch (e) {
    // todo this could result in duplicated error logs
    // todo handle a case where account tree is still not up to date (wait and retry)?
    // if (
    //   job.data.type !== jobType.TORNADO_WITHDRAW &&
    //   (e.message.indexOf('Outdated account merkle root') !== -1 ||
    //     e.message.indexOf('Outdated tree update merkle root') !== -1)
    // ) {
    //   if (retry < 5) {
    //     await sleep(3000)
    //     console.log('Tree is still not up to date, resubmitting')
    //     await submitTx(job, retry + 1)
    //   } else {
    //     throw new RelayerError('Tree update retry limit exceeded')
    //   }
    // } else {
    throw new RelayerError(`Revert by smart contract ${e.message}`)
    // }
  }
}

async function updateTxHash(txHash) {
  console.log(`A new successfully sent tx ${txHash}`)
  currentJob.data.txHash = txHash
  await currentJob.update(currentJob.data)
}

async function updateConfirmations(confirmations) {
  console.log(`Confirmations count ${confirmations}`)
  currentJob.data.confirmations = confirmations
  await currentJob.update(currentJob.data)
}

async function updateStatus(status) {
  console.log(`Job status updated ${status}`)
  currentJob.data.status = status
  await currentJob.update(currentJob.data)
}

async function clearErrors() {
  console.log('Errors list cleared')
  await redis.del('errors')
}

start()