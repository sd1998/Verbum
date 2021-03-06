const fs = require('fs');
const server = require('http').createServer();
const io = require('socket.io')(server, { 'pingInterval': 5000, 'pingTimeout': 15000 });
const uuid = require('uuid/v3');
const getMac = require('getmac');
const ip = require('ip');
const q = require('q');
const winston = require('winston');
const winstonLogstashTrns = require('winston-logstash-transport');
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'notification-service', timestamp: Date.now() },
  transports: [
    new winston.transports.Console(),
    new winstonLogstashTrns.LogstashTransport({ host: 'localhost', port: 5001 })
  ]
})
const Eureka = require('eureka-js-client').Eureka;
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const sections = [
  {
    header: 'Options',
    optionList: [
      {
        name: 'help',
        description: 'Display this usage guide.'
      },
      {
        name: 'hostname',
        typeLabel: '{underline} string',
        description: 'Hostname for Zookeeper instance'
      },
      {
        name: 'port',
        typeLabel: '{underline} string',
        description: 'Port for Zookeeper instance'
      }
    ]
  }
];
const optionDefinitions = [
  {
    name: 'help',
    alias: 'help',
    type: Boolean
  },
  {
    name: 'hostname',
    alias: 'hostname',
    type: String,
    multiple: false
  },
  {
    name: 'port',
    alias: 'port',
    type: String,
    multiple: false
  }
];
const commandLineOptions = commandLineArgs(optionDefinitions);
const zookeeper = require('node-zookeeper-client');
const zookeeperClient = zookeeper.createClient(commandLineOptions['hostname'] + ':' + commandLineOptions['port'], {
  sessionTimeout: 30000,
  spinDelay: 1000,
  retries: 1
});
const { PubSub } = require("@google-cloud/pubsub");
const gcpConfig = require("./gcp_config.js");
const grpc = require('grpc');
const protoLoader = require('@grpc/proto-loader');
const grpcServer = new grpc.Server();
const notifServiceProto = grpc.loadPackageDefinition(
  protoLoader.loadSync('../proto/notif.proto', {
    keepCase: true,
    longs: String,
    enum: String,
    defaults: true,
    oneofs: true
  })
)

const PORT = 8000 || process.env.PORT

var config = null;

var openConnections = {}
var isZookeeperConnected = false
var nodeId = null
var registeredWithEureka = false
var pubSub = null
var subscription = null

function getEurekaClient(config) {
  return new Eureka({
    instance: {
      app: config['NOTIFICATION_SERVICE_APP_ID'],
      instanceId: nodeId,
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

function getData(client, path, done) {
  client.getData(path, function(event) {
    if (event.getName() == 'NODE_DATA_CHANGED') {
      client.getData(path, function(err, data, stat) {
        if (err) {
          logger.error(err)
          throw err
        }
        if (stat) {
          done(data.toString('utf8'))
        }
      })
    }
    else if (event.getName() == "NODE_DELETED") {
      deRegister(true)
    }
  }, function(err, data, stat) {
    if (err) {
      logger.error(err)
      throw err
    }
    if (stat) {
      done(data.toString('utf8'))
    }
    else {
      done(null)
    }
  })
}

function getChildren(client, path, done) {
  client.getChildren(path, function(event) {
    if (event.getName() == 'NODE_CHILDREN_CHANGED') {
      client.exists(event.getPath(), function(err, stat) {
        if (err) {
          logger.error(err)
          throw err
        }
        if (stat) {
          done([event.getPath().slice(event.getPath().indexOf(path + '/'))])
        }
      })
    }
  }, function(err, children, stat) {
    if (err) {
      loggeer.error(err)
      throw err
    }
    if (stat) {
      done(children)
    }
    else {
      done(null)
    }
  })
}

function cleanup() {
  if (nodeId != null) {
    zookeeperClient.remove(config['ZOOKEEPER_NODES_PATH'] + '/' + nodeId, -1, function(err) {
      if (err) {
        logger.error(err)
        throw err
      }
      logger.info('Service instance zookeeper node removed.')
    })
  }
}

function updateZookeeper(nodePath, value) {
  var deferred = q.defer()
  zookeeperClient.exists(nodePath, function(err, stat) {
    if (err) {
      deferred.reject(err)
    }
    if (stat) {
      deferred.resolve(true)
    }
    else {
      zookeeperClient.create(nodePath, Buffer.from(value), function(err, path) {
        if (err) {
          deferred.reject(err)
        }
        logger.info('Zookeeper updated at path: ' + path)
        deferred.resolve(true)
      })
    }
  })
  return deferred.promise
}

function sendPushNotification(message) {
  for (var i = 0; i < message.clientIds.length; i++) {
    if (openConnections[message.clientIds[i]] != null) {
      if (openConnections[message.clientIds[i]]['isUnavailable']) {
        openConnections[message.clientIds[i]]['pendingMessages'].push({
          'topic': config['NOTIFICATION_CHANNEL'],
          'message': message.body
        })
      }
      else {
        openConnections[message.clientIds[i]].emit(config['NOTIFICATION_CHANNEL'], message.body)
      }
    }
  }
}

function generateNodeId() {
  var deferred = q.defer()
  if (!fs.existsSync(config['NODE_NAME_FILE_PATH'])) {
    getMac.getMac(function(err, macAddress) {
      if (err) {
        deferred.reject(err)
      }
      var generatedId = uuid(macAddress, config['UUID_NAMESPACE'])
      var writeStream = fs.createWriteStream(config['NODE_NAME_FILE_PATH'])
      writeStream.write(generatedId)
      writeStream.end()
      updateZookeeper(config['ZOOKEEPER_NODES_PATH'] + '/' + generatedId, generatedId).then(function(_) {
        deferred.resolve(generatedId)
      }).fail(function(err) {
        deferred.reject(err)
      })
    })
  }
  else {
    fs.readFile(config['NODE_NAME_FILE_PATH'], function(err, data) {
      if (err) {
        deferred.reject(err)
      }
      var id = data.toString('utf8')
      updateZookeeper(config['ZOOKEEPER_NODES_PATH'] + '/' + id, id).then(function(_) {
        deferred.resolve(id)
      }).fail(function(err) {
        deferred.reject(err)
      })
    })
  }
  return deferred.promise
}

function init() {
  startEurekaClient()
  startGrpcServer()
  connectToRMQ()
  setupSubscriber()
  unlockClients()
}

function unlockClients() {
  getChildren(zookeeperClient, '/verbum/unlock/' + nodeId, function(modelIds) {
    if (modelIds != null) {
      for (var modelId in modelIds) {
        zookeeperClient.getData('/verbum/unlock/' + nodeId + '/' + modelId, function(err, data, stat) {
          if (err) {
            logger.error(err)
            throw err
          }
          if (stat) {
            var clientIds = JSON.parse(data.toString('utf8')).clients
            for (var i = 0; i < clientIds.length; i++) {
              if (openConnections[clientIds[i]] != null && openConnections[clientIds[i]]['modelIdLock']
                && openConnections[clientIds[i]]['modelId'] == modelId) {
                openConnections[clientIds[i]]['modelIdLock'] = false
                openConnections[clientIds[i]]['modelId'] = null
              }
            }
            zookeeperClient.remove('/verbum/unlock/' + nodeId + '/' + modelId, -1, function(err) {
              if (err) {
                logger.error(err)
                throw err
              }
              logger.info('Clients unlocked')
            })
          }
        })
      }
    }
    else {
      logger.info('No cients to unlock')
    }
  })
}

function setupSubscriber() {
  pubSub = new PubSub(gcpConfig.GCP_CONFIG)
  subscription = pubSub.subscription(nodeId)
  subscription.on('message', function(message) {
    if (message != null) {
      sendPushNotification(message.data)
      message.ack()
    }
  })
}

function startEurekaClient() {
  client = getEurekaClient(config)
  client.start(function(err) {
    if (err) {
      throw err
    }
    logger.info('Registered with Eureka')
    registeredWithEureka = true
  })
}

function startGrpcServer() {
  grpcServer.bind('localhost' + ':5001', grpc.ServerCredentials.createInsecure())
  grpcServer.start()
}

function deRegister(isProcessExit) {
  if (registeredWithEureka) {
    registerWithEureka = false
    client.stop(function() {
      cleanup()
      logger.info('Service stopped')
      if (isProcessExit) {
        process.exit()
      }
    })
  }
}

grpcServer.addService(notifServiceProto.NotificationService.service, {
  GetActiveClients: function(call, callback) {
    logger.info('RPC call to GetActiveClients')
    availableClients = []
    for (var id in openConnections) {
      logger.info(openConnections[id]['modelIdLock'])
      if (openConnections[id] != null && !openConnections[id]['modelIdLock'] && !openConnections[id]['isUnavailable']) {
        availableClients.push({
          socketId: id,
          notifIns: nodeId
        })
        openConnections[id]['modelIdLock'] = true
        openConnections[id]['modelId'] = call.request.modelId
      }
    }
    callback(null, {
      clients: availableClients
    })
  },
  UnlockClients: function(call, callback) {
    var clients = call.clients
    for (var i = 0; i < clients.length; i++) {
      var id = clients[i]['socketId']
      openConnections[id]['modelIdLock'] = false
      openConnections[id]['modelId'] = null
    }
    callback(null, {
      successful: true
    })
  },
  GetClientTrainingProgress: function(call, callback) {
    var clientProgress = []
    var clients = call.clients
    for (var i = 0; i < clients.length; i++) {
      if (openConnections[clients[i]['socketId']] != null && openConnections[clients[i]['socketId']]['modelIdLock']) {
        clientProgress.push({
          clientId: socket['id'],
          trainingProgress: openConnections[socket['id']]['trainingProgress']
        })
      }
    }
    callback(null, {
      clientProgress: clientProgress
    })
  },
  StartClientTraining: function(call, callback) {
    var clients = call.request.clients
    for (var i = 0; i < clients.length; i++) {
      if (openConnections[clients[i]['socketId']] != null && openConnections[clients[i]['socketId']]['modelIdLock']) {
        var message = {
          'modelId': call.request.modelId,
          'trainingSessionId': call.request.trainingSessionId
        }
        if (openConnections[clients[i]['socketId']]['isUnavailable']) {
          openConnections[clients[i]['scoketId']]['pendingMessages'].push({
            'topic': 'start-training',
            'message': message
          })
        }
        else {
          openConnections[clients[i]['socketId']].socket.emit('start-training', message)
        }
      }
    }
    callback(null, {
      successful: true
    })
  },
  GetTrainedClients: function(call, callback) {
    var trainedClients = []
    for (var id in openConnections) {
      if (openConnections[id]['modelIdLock'] && openConnections[id]['modelId'] == call.request.modelId) {
        if (openConnections[id]['lastTrainingSession'] != null) {
          trainedClients.push({
            client: {
              socketId: id,
              notifIns: nodeId
            },
            lastTrainingSession: openConnections[id]['lastTrainingSession'],
            lastTrainingFinish: openConnections[id]['lastTrainingFinish']
          })
        }
      }
    }
    callback(null, {
      clients: trainedClients
    })
  }
})

zookeeperClient.on('connected', function() {
  logger.info("Connected to zookeeper")
  zookeeperClient.exists('/config', function(err, stat) {
    if (err) {
      logger.error(err)
      throw err
    }
    if (stat) {
      getData(zookeeperClient, '/config', function(data) {
        if (err) {
          logger.error(err)
          throw err
        }
        config = JSON.parse(data)
        zookeeperClient.exists(config['ZOOKEEPER_NODES_PATH'], function(err, stat) {
          if (err) {
            logger.error(err)
            throw err
          }
          if (stat) {
            generateNodeId().then(function(instanceId) {
              nodeId = instanceId
              init()
            }).fail(function(err) {
              logger.error(err)
              throw err
            })
          }
          else {
            zookeeperClient.mkdirp(config['ZOOKEEPER_NODES_PATH'], function(err, path) {
              if (err) {
                logger.error(err)
                throw err
              }
              generateNodeId().then(function(instanceId) {
                nodeId = instanceId
                init()
              }).fail(function(err) {
                logger.error(err)
                throw err
              })
            })
          }
        })
      })
    }
    else {
      logger.error("Config not present on zookeeper")
      process.exit(1)
    }
  })
})

zookeeperClient.on('disconnected', function() {
  isZookeeperConnected = false
  logger.info('Disconnected from zookeeper')
  zookeeperClient.connect()
})

io.on('connection', (socket) => {
  if (socket['id'] != null && openConnections[socket['id']] == null) {
    logger.info('New connection: ' + socket['id'])
    openConnections[socket['id']] = {
      socket: socket,
      modelIdLock: false,
      modelId: null,
      isUnavailable: false,
      uneligible: true,
      pendingMessages: []
    }
    socket.on('init', (data) => {
      logger.info('Received init event for: ' + data.prevId)
      if (openConnections[data.prevId] != null) {
        if (openConnections[data.prevId].modelIdLock) {
          openConnections[socket['id']].modelIdLock = true
          openConnections[socket['id']].modelId = openConnections[data.prevId].modelId
          openConnections[data.prevId] = openConnections[socket['id']]
        }
        else {
          delete openConnections[data.prevId]
        }
      }
    })
    socket.on('disconnect', (response) => {
      logger.info(response)
      if (openConnections[socket['id']] != null) {
        if (!openConnections[socket['id']]['modelIdLock'] && !openConnections[socket['id']]['uneligible']) {
          logger.info('Client disconnected: ' + socket['id'])
          openConnections[socket['id']] = null
        }
      }
    })
    socket.on('error', (error) => {
      if (openConnections[socket['id']] != null) {
        if (!openConnections[socket['id']]['modelIdLock']) {
          openConnections[socket['id']]['isUnavailable'] = true
        }
      }
    })
    socket.on('reconnect', () => {
      if (openConnections[socket['id'] != null]) {
        if (openConnections[socket['id']]['isUnavailable']) {
          openConnections[socket['id']['isUnavailable']] = false
          if (openConnections[socket['id']]['pendingMessages'].length != 0) {
            logger.info('Sending pending messages to client: ' + socket['id'])
            var pendingMessages = openConnections[socket['id']]['pendingMessages']
            for (var i = 0; i < pendingMessages.length; i++) {
              socket.emit(pendingMessages['topic'], pendingMessages['message'])
            }
            openConnections[socket['id']]['peendingMessages'] = []
          }
        }
      }
      else {
        openConnections[socket['id']] = {
          socket: socket,
          modelIdLock: false,
          modelId: null,
          isUnavailable: false
        }
      }
    })
    socket.on('training-complete', (data) => {
      if (openConnections[socket['id']] != null) {
        if (openConnections[socket['id']]['modelIdLock'] && openConnections[socket['id']]['modelId'] == data.modelId) {
          openConnections[socket['id']]['modelIdLock'] = false
          openConnections[socket['id']]['modelIf'] = null
          openConnections[socket['id']]['lastTrainingSession'] = data.trainingSessionId
          openConnections[socket['id']]['lastTrainingFinish'] = data.trainingFinish
        }
      }
    })
    socket.on('progress-update', (data) => {
      if (openConnections[socket['id']] != null && openConnections[socket['id']]['modelId'] == data.modelId) {
        openConnections[socket['id']]['trainingProgress'] = data['trainingProgress']
      }
    })
    socket.on('battery-status', (data) => {
      if (openConnections[socket['id']] != null) {
        openConnections[socket['id']]['batteryStatus'] = data.batteryStatus
        if (data.batteryStatus < config['client']['batteryLimit']) {
          openConnections[socket['id']]['uneligible'] = true
        }
        else if (openConnections[socket['id']]['uneligible'] && data.batteryStatus > config['client']['batteryLimit']) {
          openConnections[socket['id']]['uneligible'] = false
        }
      }
    })
  }
  else if (socket['id'] != null && openConnections[socket['id']] != null && openConnections[socket['id']]['isUnavailable']) {
    openConnections[socket['id']]['isUnavailable'] = false
  }
})

if (!commandLineArgs['help']) {
  server.listen(PORT, function() {
    zookeeperClient.connect()
    logger.info("Listening on: " + PORT)
    logger.info("Host IP address: " + ip.address())
  });
}
else {
  console.log(commandLineUsage(sections))
}

process.on('exit', function() {
  deRegister(true)
})

process.on('SIGINT', function() {
  deRegister(true)
}) 