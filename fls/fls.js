const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const grpc = require('grpc');
const amqp = require('amqplib');
const zookeeper = require('node-zookeeper-client');
const zookeeperClient = zookeeper.createClient('localhost:2181', {
  sessionTimeout: 30000,
  spinDelay: 1000,
  retries: 1
});
const winston = require('winston');
const logger = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: 'fls-service' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
})
const q = require('q');
const Eureka = require('eureka-js-client').Eureka;
const app = express()
const grpc = require('grpc');
const notifServiceProto = grpc.load('../proto/notif.proto');

const PORT = 8030 || process.env.PORT;

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cors())

var config = null;
var publisherChannel = null;
var isConnectedToZookeeper = false;

function createEurekaClient(config) {
  return new Eureka({
    instance: {
      app: 'fls',
      instanceId: 'fls-1',
      hostName: 'localhost',
      ipAddr: '127.0.0.1',
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

function getActiveClientList(serviceURL, modelId) {
  var deferred = q.defer()
  var grpcClient = getGrpcClient(serviceURL)
  grpcClient.GetActiveClients({
    modelId: modelId
  }, function(err, response) {
    if (err) {
      deferred.reject(err)
    }
    grpc.closeClient(grpcClient)
    deferred.resolve(response.clients)
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
      deferred.reject(eerr)
    }
    grpc.closeClient(grpcClient)
    deferred.resolve(response)
  })
  return deferres.promise
}

function startPublisher(amqpConnection) {
  amqpConnection.createChannel(onPublisherStart);
  function onPublisherStart(err, channel) {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    createQueueForNodes(nodePaths)
    publisherChannel = channel
  }
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

function startAMQP() {
  amqp.connect(config['RMQ_URL'], function(err, amqpConnection) {
    if (err) {
      console.error(err)
      return
    }
    startPublisher(amqpConnection)
  })
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
          console.log(config)
          client = createEurekaClient(config)
          client.start(function(err) {
            if (err) {
              throw err
            }
          })
          startAMQP()
        })
      }
      else {
        // No config present
        process.exit(1)
      }
    })
  }
})

zookeeperClient.on('disconnected', function() {
  isConnectedToZookeeper = false
})

function evenlyDistributeClients(allSetteledPromise, avgClients) {
  var deferred = q.defer()
  var avgNoClients = avgClients
  allSetteledPromise.then(function(responses) {
    var acceptedClients = []
    var leftOut = []
    var minLeftOut = 99999
    for (var i = 0; i < responses.length; i++) {
      if (acceptedClients.length < minClients) {
        if (responses[i].length > avgNoClients) {
          Array.prototype.push(acceptedClients, responses[i].slice(0, avgNoClients))
          var leftOut = Math.min(0, responses[i].length - avgNoClients)
          if (leftOut < minLeftOut) {
            minLeftOut = leftOut
          }
          leftOuts.push({
            index: i,
            clinetNo: avgNoClients
          })
        }
        else {
          Array.prototype.push(acceptedClients, responses[i])
        }
      }
    }
    //Can still result in an infinite loop need to break wehn leftOut for all responses == 0
    while (acceptedClients.length < minClients) {
      var temp = 9999
      for (var i = 0; i < leftOuts.length; i++) {
        var oldClientNo = leftOuts[i]['clientNo']
        var newClientNo = oldClientNo + minLeftOut
        if (nexClientNo > responses[leftOuts[i]['index']].length) {
          Array.prototype.push(acceptedClients, responses[leftOuts[i]['index']].slice(leftOuts[i]['clientNo']))
          leftOuts[i]['clientNo'] = responses[leftOuts[i]['index']].length
        }
        else {
          Array.prototype.push(acceptedClients, responses[leftOuts[i]['index']].slice(oldClientNo, newClientNo))
          leftOuts[i]['clientNo'] = newClientNo
          if (temp < newClientNo) {
            temp = newClientNo
          }
        }
      }
      minLeftOut = temps
    }
    deferred.resolve(acceptedClients)
  }).fail(function(err) {
    deferred.reject(err)
  })
  return deferred.promise
}

//Still have to figure out weather opening grpcClient with different URL's kills 
//the previously made RPC's as grpc works over HTTP which in turn works over HTTP

app.get('/train/:modelId/:minClients', function(req, res) {
  serviceURLs = []
  serviceRequestPromises = []
  var notifServices = client.getInstancesByAppId('notif')
  for (var i = 0; i < notifServices.length; i++) {
    serviceURLs.push(notifServices[i]['ipAddr'] + ':' + notifServices[i]['port']['$'])
  }
  for (var serviceURL in serviceURLs) {
    serviceRequestPromises.push(getActiveClientList(serviceURL, modelId))
  }
  var avgNoClients = Math.max(1, Math.floor(minClients / servieURLs.length))
  evenlyDistributeClients(q.allSettled(serviceRequestPromises), avgNoClients).then(function(acceptedClients) {
    if (acceptedClients.length < minClients) {
      // Lock is obtained on the clients when obtaining active client list for each notif service instnce
      var unlockClientPromises = []
      for (var serviceURL in serviceURLs) {
        //Need to partition the acceptedClients list based on instance ids
        //which will have to be obtaines from eureka service discovery
        unlockClientPromises.push(unlockClients(serviceURL, acceptedClients))
      }
      q.allSettled(unlockClientPromises).then(function(responses) {
        var unlocked = true
        for (var response in responses) {
          unlocked = uncloked && response
        }
        console.log('Clients: ' + unlocked)
        res.status(204).json({
          message: 'minimum clients criteria cannot be fullfilled'
        })
      }).fail(function(err) {
        console.error(err)
        logger.error(err)
      })
    }
    else {

    }
  }).fail(function(err) {
    console.error(err)
    logger.error(err)
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