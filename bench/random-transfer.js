const http = require('http');

const BASE_URL = 'http://127.0.0.1:7001';
const CONCURRENCY = 500;
const DURATION = 10000;

const MIN_ID = 1;
const MAX_ID = 1000;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function doTransfer() {
  const fromId = rand(MIN_ID, MAX_ID);
  let toId = rand(MIN_ID, MAX_ID);

  while (toId === fromId) {
    toId = rand(MIN_ID, MAX_ID);
  }

  const body = JSON.stringify({
    fromId,
    toId,
    amount: 1,
  });

  const req = http.request(
    BASE_URL + '/transfers',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    res => {
      res.resume();
    }
  );

  req.on('error', () => {});
  req.write(body);
  req.end();
}

async function worker(stopTime) {
  while (Date.now() < stopTime) {
    doTransfer();
  }
}

async function main() {
  const stopTime = Date.now() + DURATION;

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(stopTime));
  }

  await Promise.all(workers);
}

main();
