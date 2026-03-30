'use strict';

const autocannon = require('autocannon');

const url = 'http://127.0.0.1:7001/transfers';
const headers = { 'content-type': 'application/json' };

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 你原本有 id=1..4，再加 seed 的 5000 筆後，範圍大概會到 5004 左右
const MIN_ID = 1;
const MAX_ID = 5004;

autocannon({
  url,
  connections: 200,
  duration: 30,
  method: 'POST',
  headers,
  setupClient(client) {
    client.on('request', () => {
      const fromId = randInt(MIN_ID, MAX_ID);
      let toId = randInt(MIN_ID, MAX_ID);
      while (toId === fromId) toId = randInt(MIN_ID, MAX_ID);

      const body = { fromId, toId, amount: 1 };
      client.setBody(Buffer.from(JSON.stringify(body)));
    });
  },
}, console.log);
