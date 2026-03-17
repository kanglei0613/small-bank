'use strict';

const autocannon = require('autocannon');

function getArg(name, defaultValue) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (!found) return defaultValue;
  return found.slice(prefix.length);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getShardId(accountId, shardCount) {
  return accountId % shardCount;
}

function buildCrossShardTransferBody({
  minAccountId,
  maxAccountId,
  amount,
  shardCount,
}) {
  const fromId = randomInt(minAccountId, maxAccountId);
  const fromShardId = getShardId(fromId, shardCount);

  let toId = randomInt(minAccountId, maxAccountId);

  while (
    toId === fromId ||
    getShardId(toId, shardCount) === fromShardId
  ) {
    toId = randomInt(minAccountId, maxAccountId);
  }

  return JSON.stringify({
    fromId,
    toId,
    amount,
  });
}

async function main() {
  const url = getArg('url', 'http://127.0.0.1:7001/bench/db-transfer');
  const connections = toPositiveInt(getArg('connections', '10'), 10);
  const duration = toPositiveInt(getArg('duration', '30'), 30);
  const amount = toPositiveInt(getArg('amount', '1'), 1);
  const minAccountId = toPositiveInt(getArg('minAccountId', '1'), 1);
  const maxAccountId = toPositiveInt(getArg('maxAccountId', '1000'), 1000);
  const shardCount = toPositiveInt(getArg('shardCount', '4'), 4);

  if (maxAccountId <= minAccountId) {
    throw new Error('maxAccountId must be greater than minAccountId');
  }

  console.log('=== Cross-Shard Random Bench Config ===');
  console.log(`url           : ${url}`);
  console.log(`connections   : ${connections}`);
  console.log(`duration      : ${duration}s`);
  console.log(`amount        : ${amount}`);
  console.log(`account range : ${minAccountId} ~ ${maxAccountId}`);
  console.log(`shardCount    : ${shardCount}`);
  console.log('');

  const instance = autocannon({
    url,
    method: 'POST',
    connections,
    duration,
    headers: {
      'Content-Type': 'application/json',
    },
    setupClient(client) {
      client.setBody(buildCrossShardTransferBody({
        minAccountId,
        maxAccountId,
        amount,
        shardCount,
      }));

      client.on('response', () => {
        client.setBody(buildCrossShardTransferBody({
          minAccountId,
          maxAccountId,
          amount,
          shardCount,
        }));
      });
    },
  });

  autocannon.track(instance, {
    renderProgressBar: true,
    renderResultsTable: true,
    renderLatencyTable: true,
  });

  instance.on('done', result => {
    const statusCodes = result.statusCodeStats || {};
    console.log('\n=== Status Codes ===');
    if (Object.keys(statusCodes).length === 0) {
      console.log('No status code stats available');
    } else {
      for (const code of Object.keys(statusCodes).sort()) {
        console.log(`${code}: ${statusCodes[code]}`);
      }
    }

    console.log('\n=== Summary ===');
    console.log(`requests.average : ${result.requests.average}`);
    console.log(`latency.average  : ${result.latency.average}`);
    console.log(`errors           : ${result.errors}`);
    console.log(`timeouts         : ${result.timeouts}`);
    console.log(`non2xx           : ${result.non2xx}`);
  });
}

main().catch(err => {
  console.error('[random_bench_cross_shard] failed:', err.message);
  process.exit(1);
});
