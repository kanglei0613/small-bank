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

function buildRandomTransferBody({ minAccountId, maxAccountId, amount }) {
  const fromId = randomInt(minAccountId, maxAccountId);
  let toId = randomInt(minAccountId, maxAccountId);

  while (toId === fromId) {
    toId = randomInt(minAccountId, maxAccountId);
  }

  return JSON.stringify({
    fromId,
    toId,
    amount,
  });
}

async function main() {
  const url = getArg('url', 'http://127.0.0.1:7001/transfers');
  const connections = toPositiveInt(getArg('connections', '100'), 100);
  const duration = toPositiveInt(getArg('duration', '10'), 10);
  const amount = toPositiveInt(getArg('amount', '1'), 1);
  const minAccountId = toPositiveInt(getArg('minAccountId', '1'), 1);
  const maxAccountId = toPositiveInt(getArg('maxAccountId', '1000'), 1000);

  if (maxAccountId <= minAccountId) {
    throw new Error('maxAccountId must be greater than minAccountId');
  }

  console.log('=== Random Bench Config ===');
  console.log(`url           : ${url}`);
  console.log(`connections   : ${connections}`);
  console.log(`duration      : ${duration}s`);
  console.log(`amount        : ${amount}`);
  console.log(`account range : ${minAccountId} ~ ${maxAccountId}`);
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
      client.setBody(buildRandomTransferBody({
        minAccountId,
        maxAccountId,
        amount,
      }));

      client.on('response', () => {
        client.setBody(buildRandomTransferBody({
          minAccountId,
          maxAccountId,
          amount,
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
  console.error('[random_bench] failed:', err.message);
  process.exit(1);
});
