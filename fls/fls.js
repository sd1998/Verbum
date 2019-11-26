const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const grpc = require('grpc');
const zookeeper = require('node-zookeeper-client');
const zookeeperClient = zookeeper.createClient('localhost:2181', {
  sessionTimeout: 30000,
  spinDelay: 1000,
  retries: 1
});
const winston = require('winston');
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'fls-service' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
})
const Multer = require('multer');
const multer = Multer({
  storage: Multer.MemoryStorage
})
const ip = require('ip');
const q = require('q');
const uuid = require('uuid/v3');
const Eureka = require('eureka-js-client').Eureka;
const { PubSub } = require('@google-cloud/pubsub');
const gcpConfig = require('./gcp_config.js');
const app = express();
const grpcServer = new grpc.Server();
const protoLoader = require('@grpc/proto-loader');
const gcpDatastore = require('./gcp_datastore.js');
const gcpStorage = require('./gcp_storage.js');

const PORT = 8030 || process.env.PORT;

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cors())

var config = null;
var pubSub = null;
var isConnectedToZookeeper = false;

function createEurekaClient(config) {
  return new Eureka({
    instance: {
      app: config['FLS_SERVICE_APP_ID'],
      instanceId: 'fls-1',
      hostName: 'localhost',
      ipAddr: ip.address(),
      port: {
        '$': PORT,
        '@enabled': true
      },
      vipAddress: 'notifvip',
      dataCenterInfo: {
        '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
        name: 'MyOwn'
      },
      registerWithEureka: true
    },
    eureka: {
      host: config['EUREKA_HOST'],
      port: config['EUREKA_PORT'],
      servicePath: '/eureka/apps/'
    }
  })
}

function getGrpcClient(serviceURL) {
  return new notifServiceProto.NotificationService(serviceURL, grpc.credentials.createInsecure())
}

function loadProtoFile(protoFilePath) {
  return grpc.loadPackageDefinition(
    protoLoader.loadSync(protoFilePath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    })
  )
}

const notifServiceProto = loadProtoFile('../proto/notif.proto')
const trainServiceProto = loadProtoFile('../proto/train_service.proto')

function getActiveClientList(serviceURL, modelId) {
  var deferred = q.defer()
  var grpcClient = getGrpcClient(serviceURL)
  grpcClient.GetActiveClients({
    modelId: modelId
  }, function(err, response) {
    if (err) {
      deferred.reject(err)
    }
    else {
      grpc.closeClient(grpcClient)
      deferred.resolve(response.clients)
    }
  })
  return deferred.promise
}

function unlockClients(serviceURL, clients) {
  var deferred = q.defer()
  var grpcClient = getGrpcClient(serviceURL)
  grpcClient.UnlockClients({
    clients: clients
  }, function(err, response) {
    if (err) {
      deferred.reject(err)
    }
    else {
      grpc.closeClient(grpcClient)
      deferred.resolve(response['successful'])
    }
  })
  return deferred.promise
}

function getClientProgress(serviceURL, clients) {
  var deferred = q.defer()
  var grpcClient = getGrpcClient(serviceURL)
  grpcClient.GetClientTrainingProgress({
    clients: clients
  }, function(err, response) {
    if (err) {
      deferred.reject(err)
    }
    else {
      grpc.closeClient(grpcClient)
      deferred.resolve(response['clientProgress'])
    }
  })
  return deferred.promise
}

function sendNotification(instanceId, clients, message) {
  return publish(instanceId, Buffer.from(JSON.stringify({
    clientIds: clients,
    message: messsage
  })))
}

function publish(topicName, data) {
  var deferred = q.defer()
  pubSub.topic(topicName).publisher().publish(data).then(function(messageId) {
    deferred.resolve(messageId)
  }).fail(function(err) {
    deferred.reject(err)
  })
  return deferred.promise
}

function evenlyDistributeClients(allSetteledPromise, avgClients, minClients) {
  var deferred = q.defer()
  var avgNoClients = avgClients
  allSetteledPromise.then(function(responses) {
    var acceptedClients = []
    var leftOut = []
    var minLeftOut = Number.MAX_SAFE_INTEGER
    for (var i = 0; i < responses.length; i++) {
      if (responses[i].state == 'fulfilled') {
        if (acceptedClients.length < minClients) {
          if (responses[i].value.length > avgNoClients) {
            Array.prototype.push.apply(acceptedClients, responses[i].value.slice(0, avgNoClients))
            var leftOut = Math.min(0, responses[i].value.length - avgNoClients)
            if (leftOut < minLeftOut) {
              minLeftOut = leftOut
            }
            leftOuts.push({
              index: i,
              clinetNo: avgNoClients
            })
          }
          else {
            Array.prototype.push.apply(acceptedClients, responses[i].value)
          }
        }
      }
      else {
        logger.error("Invalid response")
        logger.error(responses[i].reason)
      }
    }
    logger.info('Accepted Clients: ')
    logger.info(acceptedClients)
    while (acceptedClients.length < minClients) {
      var temp = Number.MAX_SAFE_INTEGER
      for (var i = 0; i < leftOuts.length; i++) {
        var oldClientNo = leftOuts[i]['clientNo']
        var newClientNo = oldClientNo + minLeftOut
        if (nexClientNo > responses[leftOuts[i]['index']].value.length) {
          Array.prototype.push.apply(acceptedClients, responses[leftOuts[i]['index']].value.slice(leftOuts[i]['clientNo']))
          leftOuts[i]['clientNo'] = responses[leftOuts[i]['index']].value.length
        }
        else {
          Array.prototype.push.apply(acceptedClients, responses[leftOuts[i]['index']].value.slice(oldClientNo, newClientNo))
          leftOuts[i]['clientNo'] = newClientNo
          if (temp < newClientNo) {
            temp = newClientNo
          }
        }
      }
      if (temp == 0) {
        break
      }
      minLeftOut = temp
    }
    deferred.resolve(acceptedClients)
  })
  return deferred.promise
}

function getData(client, path, done) {
  client.getData(path, function(event) {
    getData(client, path, done)
  }, function(err, data, stat) {
    if (err) {
      console.error(err)
      return
    }
    if (stat) {
      done(data.toString('utf8'))
    }
    else {
      done(null)
    }
  })
}

function partitionClientsByInstanceId(clients) {
  clientPartitions = {}
  for (var i = 0; i < clients.length; i++) {
    if (clientPartitions[clients[i]['notifIns']] != null) {
      clientPartitions[clients[i]['notifIns']].push(clients[i])
    }
    else {
      clientPartitions[clients[i]['notifIns']] = [clients[i]]
    }
  }
  return clientPartitions
}

function searchForClient(participantClients, clientId) {
  for (var i = 0; i < participantClients.length; i++) {
    if (participantClients[i]['socketId'] == clientId) {
      return i
    }
  }
  return null
}

function min(values, key) {
  var minValue = Number.MAX_SAFE_INTEGER
  for (var value in values) {
    var actValue = value;
    if (key != null) {
      actValue = value[key]
    }
    if (actValue < minValue) {
      minValue = actValue
    }
  }
  return minValue
}

function getServiceURLs(appId) {
  var port = 0
  var instances = client.getInstancesByAppId(appId)
  var serviceURLs = []
  if (appId == 'notif') {
    port = '5001'
  }
  for (var i = 0; i < instances.length; i++) {
    serviceURLs.push({
      'serviceURL': instances[i]['hostName'] + ':' + port,
      'instanceId': instances[i]['instanceId']
    })
  }
  return serviceURLs
}

function getClientIds(clientMetadata) {
  return Object.values(clientMetadata).map(x => x.socketId)
}

function deRegister(isProcessExit) {
  client.stop(function() {
    if (isProcessExit) {
      process.exit()
    }
  })
}

zookeeperClient.on('connected', function() {
  if (config == null) {
    zookeeperClient.exists('/config', function(err, stat) {
      if (err) {
        console.error(err)
        return
      }
      if (stat) {
        isConnectedToZookeeper = true
        logger.info('Connected to Zookeeper')
        getData(zookeeperClient, '/config', function(data) {
          logger.info('Config obtained from Zookeeper')
          config = JSON.parse(data)
          logger.info(config)
          client = createEurekaClient(config)
          client.start(function(err) {
            if (err) {
              throw err
            }
          })
          grpcServer.bind(ip.address() + ':5002', grpc.ServerCredentials.createInsecure())
          grpcServer.start()
          pubSub = new PubSub(gcpConfig.GCP_CONFIG)
        })
      }
      else {
        process.exit(1)
      }
    })
  }
})

zookeeperClient.on('disconnected', function() {
  isConnectedToZookeeper = false
  zookeeperClient.connect()
})

grpcServer.addService(trainServiceProto.TextGenerationService.service, {
  OnTrainingFinished: function(call, callback) {
    gcpDatastore.get('/model-training/' + call.modelId + '/' + call.sessionId).then(function(trainingSession) {
      var sendNotificationPromises = []
      var clientPartitions = partitionClientsByInstanceId(trainingSession['paritcipantClients'])
      for (var serviceInstanceId in clientPartitions) {
        sendNotificationPromises.push(sendNotification(serviceInstanceId,
          getClientIds(clientPartitions[serviceInstanceId]), {
            id: 'FETCH_MODEL',
            link: call.globalModelCheckpointURL
          }))
      }
      callback(null, {
        isSuccess: true
      })
    }).fail(function(err) {
      logger.error(err)
      callback(null, {
        isSuccess: false
      })
    })
  }
})

app.get('/train/:modelId/:minClients', function(req, res) {
  var serviceURLs = getServiceURLs('notif')
  serviceRequestPromises = []
  for (var i = 0; i < serviceURLs.length; i++) {
    serviceRequestPromises.push(getActiveClientList(serviceURLs[i]['serviceURL'], req.params.modelId))
  }
  var avgNoClients = Math.max(1, Math.floor(req.params.minClients / serviceURLs.length))
  logger.info('Averagee no.of clients: ' + avgNoClients)
  evenlyDistributeClients(q.allSettled(serviceRequestPromises), avgNoClients, req.params.minClients).then(function(acceptedClients) {
    if (acceptedClients.length < req.params.minClients) {
      var unlockClientPromises = []
      var clientPartitions = partitionClientsByInstanceId(acceptedClients)
      for (var i = 0; i < serviceURLs.length; i++) {
        if (clientPartitions[serviceURLs[i]['instanceId']] != null) {
          unlockClientPromises.push(unlockClients(serviceURLs[i]['serviceURL'],
            getClientIds(clientPartitions[serviceURLs[i]['instanceId']])))
        }
      }
      q.allSettled(unlockClientPromises).then(function(responses) {
        var failedUnlocks = []
        var unlocked = true
        for (var i = 0; i < responses.length; i++) {
          if (responses[i].state == 'fullfilled') {
            unlocked = uncloked && responses[i].value
          }
          else {
            logger.error(responses[i].reason)
            failedUnlocks.push({
              'instanceId': serviceURLs[i]['instanceId'],
              'modelId': req.params.modelId
            })
          }
        }
        logger.info('Clients: ' + unlocked)
        res.status(204).json({
          message: 'minimum clients criteria cannot be fullfilled',
          availableClients: acceptedClients.length
        })
        if (failedUnlocks.length != 0) {
          for (var i = 0; i < failedUnlocks.length; i++) {
            zookeeperClient.create('/verbum/unlock/' + failedUnlocks[i]['instanceId'] + '/' + failedUnlocks[i]['modelId'],
              Buffer.from(JSON.stringify({
                clients: getClientIds(clientPartitions[serviceURLs[i]['instanceId']])
              })),
              zookeeper.CreateMode.PERSISTENT,
              function(err, path) {
                if (err) {
                  logger.error(err)
                }
                logger.info('Flag added to unlock clients')
              })
          }
        }
      })
    }
    else {
      var trainingSession = {
        modelVersion: 1.0,
        modelId: req.params.modelId,
        participantClients: acceptedClients,
        createdAt: Date.now()
      }
      trainingSession['sessionId'] = uuid(trainingSession['createdAt'], config['UUID_NAMESPACE'])
      // for (var i = 0; i < serviceURLs.length; i++) {
      //   if (clientPartitions[serviceURLs[i]['instanceId']] != null) {
      //     unlockClientPromises.push(unlockClients(serviceURLs[i]['serviceURL'],
      //       getClientIds(clientPartitions[serviceURLs[i]['instanceId']])))
      //   }
      // }
      gcpDatastore.put(datastore,
        'model-training/' + req.params.modelId + '/' + trainingSession['sessionId'],
        trainingSession).then(function(_) {
          logger.info('Training session info stored on GCP datastore')
          res.status(200).json({
            message: 'training started',
            trainingSession: trainingSession
          })
        }).fail(function(err) {
          logger.error(err)
        })
    }
  }).fail(function(err) {
    console.error(err)
    logger.error(err)
  })
})

app.post('/grads/:modelId/:sessionId/:socketId',
  multer.any(),
  gcpStorage.UPLOAD_TO_GCS_MIDDLEWARE, function(req, res) {
    req.setTimeout(3000, function() {
      res.status(408).json({
        message: 'Request timeout!'
      })
    })
    res.setTimeout(3000, function() {
      res.status(503).json({
        message: 'Response timeout!'
      })
    })
    if (req.file != null && req.file.cloudStorageError != null) {
      console.error(req.file.cloudstorageError)
      logger.error(req.file.cloudStorageError)
      res.status(406).json({
        message: 'Gradient file not found'
      })
    }
    else {
      var getAndUpdatePromise = gcpDatastore.getAndUpdate(
        '/model-training/' + req.params.modelId + '/' + req.params.sessionId, function(value) {
          var deferred = q.defer()
          var trainingSession = value
          var index = searchForClient(trainingSession['participantClients'], req.params.socketId)
          if (index != null && req.file && req.file.cloudStoragePublicURL) {
            trainingSession['participantClients'][index]['gradientPath'] = req.file.cloudStoragePublicURL
            trainingSession['participantClients'][index]['gradSubTime'] = Date.now()
            deferred.resolve(trainingSession)
          }
          else {
            deferred.resolve({
              status: 404,
              message: 'Not a paritcipant of current training round'
            })
          }
          return deferred.promise
        })
      gcpDatastore.executeTransactionWithRetry(getAndUpdatePromise,
        config['FLS_SERVICE_MAX_RETRIES']).then(function(currentValue) {
          if (currentValue['status'] != null && currentValue['status'] != 200) {
            res.status(currentValue['status']).json(currentValue)
          }
          else {
            var gradientPaths = []
            var clientIds = []
            for (var participant in currentValue['participantClients']) {
              if (participant['gradientPath'] != null) {
                gradientPaths.push(participant['gradientPath'])
                clientIds.push(participant['socketId'])
              }
            }
            if (gradientPaths.length == currentValue['participantClients'].length) {
              publish(config['LEARNING_SERVICE_TOPIC'], Buffer.from(JSON.stringify({
                gradientPaths: gradientPaths,
                clientIds: clientIds,
                createdAt: Date.now()
              }))).then(function(messsageId) {
                logger.info("Message Id: " + messageId)
                res.status(200).json({
                  message: 'Gradient averaging started'
                })
              }).fail(function(err) {
                console.error(err)
                logger.error(err)
              })
            }
            else {
              logger.info('[' + Date.now() + '] No. Clients pending gradient submission: ' + noNotSubmitted)
              res.status(200).json({
                message: 'Gradients saved. Waiting for other clients.'
              })
            }
          }
        }).fail(function(err) {
          console.error(err)
          logger.error(err)
        })
    }
  })

app.get('/model/:modelId/:sessionId/checkpoint/:socketId', function(req, res) {
  gcpStore.get('/model-training/' + req.params.modelId + '/' + req.params.sessionId).then(function(trainingSession) {
    if (searchForClient(trainingSession['participantClients'], req.params.socketId) != null) {
      if (trainingSession['isTrainingComplete'] != null && trainingSession['isTrainingComplete']) {
        res.status(200).json({
          message: 'Model training compleeted at ' + trainingSession['completionTimestamp'],
          checkpointURL: trainingSession['globalModelCheckpointURL']
        })
      }
      else {
        res.status(200).json({
          message: 'Model training not completed',
          progress: trainingSession['modelTrainingProgress']
        })
      }
    }
    else {
      res.status(404).json({
        message: 'Client: ' + req.params.socketId + ' not part of current training round'
      })
    }
  })
})

app.get('/training/progress/:modelId/:sessionId/:flag', function(req, res) {
  gcpStore.get('/model-training/' + req.params.modelId + '/' + req.params.sessionId).then(function(trainingSession) {
    var clientProgressPromises = []
    var clientPartitions = partitionClientsByInstanceId(trainingSession['participantClients'])
    var serviceURLs = getServiceURLs('notif')
    for (var serviceURL in serviceURLs) {
      if (clientPartitions[serviceURL['instanceId']] != null) {
        clientProgressPromises.push(getClientProgress(serviceURL['serviceURL'],
          getClientIds(clientPartitions[serviceURL['instanceId']])))
      }
    }
    var progress = Number.MAX_SAFE_INTEGER
    var indvClientProgress = []
    var progressUnvClientId = []
    q.allSettled(clientProgressPromises).then(function(responses) {
      for (var i = 0; i < responses.length; i++) {
        if (responses[i].state == 'fullfilled') {
          var minProgress = min(responses[i].value, 'trainingProgress')
          if (minProgress < progress) {
            progress = minProgress
          }
          Array.prototype.push(indvClientProgress, responses[i].value)
        }
        else {
          logger.error(responses[i].reason)
          Array.prototype.push(progressUnvClientId, getClientIds(clientPartitions[serviceURLs[i]['instanceId']]))
        }
      }
      logger.info("Training progress: " + progress)
      logger.info("Individual training progress: " + indvClientProgress)
      var response = {
        trainingProgress: progress
      }
      if (req.params.flag == 1) {
        response['clientProgress'] = indvClientProgress
      }
      if (progressUnvClientId.length != 0) {
        response['progressUnavailable'] = progressUnvClientId
      }
      res.status(200).json(response)
    })
  })
})

app.listen(PORT, function() {
  logger.info("FLS service listening on: " + PORT)
  zookeeperClient.connect()
})

process.on('exit', function() {
  deRegister(true)
})

process.on('SIGINT', function() {
  deRegister(true)
})