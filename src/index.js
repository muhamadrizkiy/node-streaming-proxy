// load config
import config from "../config/config.json"

import http from "http"
import url from "url"
import util from "util"

import { Listener } from "./listener"
import * as functions from "./functions"

var Countly = require('countly-sdk-nodejs');
var moment = require('moment');
var geoip = require('geoip-lite');
var fs = require('fs');
var request = require('request');
var crypto = require('crypto');
var useragent = require('useragent');
var parser = require('ua-parser-js');
var Promise = require('bluebird');
var rp = require('request-promise');

var MongoClient = require('mongodb').MongoClient;
var assert = require('assert');
var ObjectId = require('mongodb').ObjectID;
var urls = 'mongodb://localhost:27017/cyclone_db_dev';

let clients = []

// Prozess einrichten
process.stdin.resume()
process.stdin.setEncoding("utf8")

// get radio data from file
//var radios = JSON.parse(fs.readFileSync('../radios.json', 'utf8'));
var global_app_key = "725fd2ea5baa18b3779ee9675ed8097c71e0b753";

var findRadio = function(db, callback) {
   var radio = [];
   var cursor =db.collection('Radio').find();
   cursor.each(function(err, doc) {
      assert.equal(err, null);
      if (doc != null) {
        radio.push(doc);
      } else {
         callback(null,radio);
      }
   });
};

var radios = function(callback){
    MongoClient.connect(urls, function(err, db) {
      assert.equal(null, err);
      findRadio(db, function(err, instance){
          callback(instance);
          db.close();
      });
  });
};
/*
var posix = require("posix")
posix.setrlimit("nofile", { soft: 10000, hard: 10000 })
*/

http.createServer((req, res) => {

  radios(function(instance){
      let parsedUrl = url.parse(req.url)
      var obj = instance.filter(function(radio){
          var uri = "http://stream.suararadio.com:8000"+parsedUrl.pathname;
          if (radio.stream_1 === uri || radio.stream_2 === uri) {
              return radio.app_key;
          }
      });

      var streamObj = instance.filter(function(radio){
          var uri = "http://stream.suararadio.com:8000"+parsedUrl.pathname;
          if (radio.stream_1 === uri || radio.stream_2 === uri) {
              return radio.name;
          }
      });
      var stream = streamObj[0].name;

      switch (parsedUrl.pathname) {

      // simple stats API
      case "/stats/clients":
          statsHandler(res)
          break

      default:

          let client = new Listener(config, req, res, parsedUrl)
          clients.push(client)
          let now = new Date()

          // Add the response to the clients array to receive streaming
          res.connection.on("close", () => {
              // get ip client
              var clientIp = client.remoteAddress;
              var clientIps = '180.253.149.155';
              var uri = parsedUrl.pathname;
              // get user info
              var ua = parser(req.headers['user-agent']);
              var os = ua.os['name'];
              var version = ua.os['version'];
              var vendor = ua.device['vendor'];
              var model = ua.device['model'];
              var device = vendor + ' ' +model;
              var visitors = {
                  "_os": os,
                  "_os_version": version,
                  "_device": device
              }

              console.log(visitors)

              var visitor = JSON.stringify(visitors);

              // hashing deviceId
              var md5sum = crypto.createHash('md5');
              var data = clientIp + 'user'
              var device_id = crypto.createHash('md5').update(data).digest("hex");
              console.log(device_id);

              // get client location
              var geo = geoip.lookup(clientIp);
              var country_code = geo.country;
              var city = geo.city;

              // calculate stream duration
              var a = moment();
              var b = moment(client.connectStart);
              var duration = a.diff(b) / 1000;
              console.log('duration : '+duration);

              // Tracking session radio app
              trackingSession(obj[0].app_key, device_id, visitor, duration, clientIp, country_code, city, stream, uri, function(err,instance){
                  return(instance);
              });
              // Tracking session global app
              trackingSession(global_app_key, device_id, visitor, duration, clientIp, country_code, city, stream, uri, function(err,instance){
                  return(instance);
              });

              removeClient(client)
          })

          res.connection.on("error", () => {

              removeClient(client)
          })
          res.connection.on("timeout", () => {

              removeClient(client)
          })

          client.on("close", () => {

              removeClient(client)
          })

          console.log(`Client ${req.connection.remoteAddress} connected -> streaming ${parsedUrl.pathname}`)
      }

  })

}).listen(config.server.port, () => {
    console.log("> Server listening on port " + config.server.port)
})

function removeClient(client) {

    client.remove()

    clients = clients.filter((myclient) => {
        if (myclient !== client) return myclient
    })

    client = null

    console.log("Client disconnected")
}

//setInterval(() => {
//    global.gc()
//},config.gcinterval*1000)

// Auf Eingaben von der Konsole reagieren. Im Moment ist folgendes implementiert: quit | info
process.stdin.on("data", (text) => {
    //logger.info('received data:', util.inspect(text));
    switch (text) {

    case "quit\n":
        process.exit()
        break

    case "info\n":
        console.log(`Clients insgesamt: ${clients.length}`)
        break

    case "memory\n":
        console.log(util.inspect(process.memoryUsage()))
        break

    case "meta\n":
        for (let client of clients) {
            console.log(`Client:${functions.getRemoteAddress(client.remoteAddress)} ${client.mount} Meta: ${client.getMeta().timestamp} ${client.getMeta().data}`)
        }
        break
    }

})

function statsHandler(res) {
    res.writeHead(200, {
        "Content-Type": "application/json"
    })

    let stats = []
    let now = new Date()

    for (let client of clients) {
        stats.push({
            ip: client.remoteAddress,
            mount: client.mount,
            url: client.url,
            start: client.connectStart,
            duration: now-client.connectStart,
            meta: client.getMeta()
        })
    }
    res.end(JSON.stringify(stats))
}

function extendSession(app_key, device_id, visitor, duration, clientIp, country_code, city, stream, uri, cb) {
    var event = [
        {
            "key": "play_stream",
            "count": 1,
            "dur" : duration,
            "segmentation"  : {
              radio: stream,
              link: uri
             }
        }
    ];
    var dataString = {
            app_key         : app_key,
            device_id       : device_id,
            session_duration: duration,
            ip_address      : clientIp,
            country_code    : country_code,
            city            : city,
            metrics         : visitor,
            events          : JSON.stringify(event)

    };
    var options = {
        url: 'http://countly.suararadio.com/i',
        method: 'GET',
        qs: dataString
    };

    request(options,function(error, response, body){
        console.log(response.statusCode);
        if (error) throw new Error(error);
        console.log(body);
    });
};

function endSession(app_key, device_id, visitor, duration, clientIp, country_code, city, cb) {
    var dataString = {
            app_key         : app_key,
            device_id       : device_id,
            ip_address      : clientIp,
            country_code    : country_code,
            city            : city,
            end_session     : 1,
            metrics         : visitor
    };
    var options = {
        url: 'http://countly.suararadio.com/i',
        method: 'GET',
        qs: dataString
    };
    request(options,function(error, response, body){
        console.log(response.statusCode);
        if (error) throw new Error(error);
        console.log(body);
    });
};

function trackingSession(app_key, device_id, visitor, duration, clientIp, country_code, city, stream, uri, cb) {
    var dataString= {
            app_key         : app_key,
            device_id       : device_id,
            begin_session   : 1,
            ip_address      : clientIp,
            country_code    : country_code,
            city            : city,
            metrics         : visitor
        };
    var options = {
        url: 'http://countly.suararadio.com/i',
        method: 'GET',
        qs: dataString
    };

    rp(options)
    .then(function (repos) {
        extendSession(app_key, device_id, visitor, duration, clientIp, country_code, city, stream, uri, function(err,instance){
            return(instance);
        });
    })
    .catch(function (err) {
    }).then(function(res) {
        endSession(app_key, device_id, visitor, duration, clientIp, country_code, city, function(err,instance){
            return(instance);
        });
    });
};
