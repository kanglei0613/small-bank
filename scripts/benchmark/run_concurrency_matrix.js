'use strict';

const { spawn } = require('child_process');

const TARGET = process.env.TARGET || 'same-shard';
const API = process.env.API || 'http://127.0.0.1:7001';
const MAX_ACCOUNT_ID = Number(process.env.MAX_ACCOUNT_ID || 1000);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 30);
const AMOUNT = Number(process.env.AMOUNT || 1);

const CONCURRENCY_LIST = [ 300, 400, 500, 550, 600, 650, 700 ];

const TARGET_SCRIPT_MAP = {
  'same-shard': 'scripts/benchmark/random_transfer_same_shard.js',
  'all-shards': 'scripts/benchmark/random_transfer_all_shards.js',
};

function getTargetScript(target) {
  const script = TARGET_SCRIPT_MAP[target];

  if (!script) {
    const err = new Error(`invalid TARGET: ${target}`);
    err.status = 400;
    throw err;
  }

  return script;
}

function runOneBenchmark({ concurrency, targetScript }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ targetScript ], {
      env: {
        ...process.env,
        API,
        CONCURRENCY: String(concurrency),
        DURATION_SECONDS: String(DURATION_SECONDS),
        MAX_ACCOUNT_ID: String(MAX_ACCOUNT_ID),
        AMOUNT: String(AMOUNT),
      },
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code !== 0) {
        const err = new Error(`benchmark process exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      try {
        const result = parseBenchmarkOutput(stdout, concurrency);
        resolve(result);
      } catch (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function parseNumber(output, label) {
  const pattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([0-9.]+)`);
  const match = output.match(pattern);

  if (!match) {
    throw new Error(`failed to parse field: ${label}`);
  }

  return Number(match[1]);
}

function parseInteger(output, label) {
  const pattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([0-9]+)`);
  const match = output.match(pattern);

  if (!match) {
    throw new Error(`failed to parse field: ${label}`);
  }

  return Number(match[1]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBenchmarkOutput(output, concurrency) {
  const elapsedSeconds = parseNumber(output, 'Elapsed Seconds');
  const totalRequests = parseInteger(output, 'Total Requests');
  const successRequests = parseInteger(output, 'Success Requests');
  const failedRequests = parseInteger(output, 'Failed Requests');
  const successRate = parseNumber(output, 'Success Rate');
  const avgTotalRps = parseNumber(output, 'Avg Total RPS');
  const avgSuccessRps = parseNumber(output, 'Avg Success RPS');

  return {
    concurrency,
    elapsedSeconds,
    totalRequests,
    successRequests,
    failedRequests,
    successRate,
    avgTotalRps,
    avgSuccessRps,
  };
}

function printMarkdownTable(results, target) {
  console.log('');
  console.log('========================================');
  console.log('Markdown Table');
  console.log('========================================');
  console.log('');

  console.log(`## ${target === 'same-shard' ? 'Same-Shard' : 'Mixed Random'} Concurrency Sweep`);
  console.log('');
  console.log('| Concurrency | Total Requests | Success Requests | Failed Requests | Success Rate | Avg Total RPS | Avg Success RPS |');
  console.log('|-------------|----------------|------------------|----------------|--------------|---------------|-----------------|');

  for (const item of results) {
    console.log(
      `| ${item.concurrency} | ${item.totalRequests} | ${item.successRequests} | ${item.failedRequests} | ${item.successRate.toFixed(2)}% | ${item.avgTotalRps.toFixed(2)} | ${item.avgSuccessRps.toFixed(2)} |`
    );
  }

  const best = results.reduce((prev, curr) => {
    if (!prev) {
      return curr;
    }

    return curr.avgSuccessRps > prev.avgSuccessRps ? curr : prev;
  }, null);

  console.log('');
  console.log('### Sweet Spot');
  console.log('');
  console.log('```');
  console.log(`Best Concurrency = ${best.concurrency}`);
  console.log(`Best Avg Success RPS = ${best.avgSuccessRps.toFixed(2)}`);
  console.log(`Success Rate = ${best.successRate.toFixed(2)}%`);
  console.log('```');
  console.log('');
}

async function main() {
  const targetScript = getTargetScript(TARGET);

  console.log('========================================');
  console.log('Small Bank Concurrency Matrix Runner');
  console.log('========================================');
  console.log(`TARGET=${TARGET}`);
  console.log(`SCRIPT=${targetScript}`);
  console.log(`API=${API}`);
  console.log(`MAX_ACCOUNT_ID=${MAX_ACCOUNT_ID}`);
  console.log(`DURATION_SECONDS=${DURATION_SECONDS}`);
  console.log(`AMOUNT=${AMOUNT}`);
  console.log(`CONCURRENCY_LIST=${CONCURRENCY_LIST.join(', ')}`);
  console.log('');

  const results = [];

  for (const concurrency of CONCURRENCY_LIST) {
    console.log('');
    console.log('========================================');
    console.log(`Running benchmark: CONCURRENCY=${concurrency}`);
    console.log('========================================');
    console.log('');

    const result = await runOneBenchmark({
      concurrency,
      targetScript,
    });

    results.push(result);
  }

  printMarkdownTable(results, TARGET);
}

main().catch(err => {
  console.error('run concurrency matrix failed:', err.message);

  if (err.stdout) {
    console.error('');
    console.error('----- stdout -----');
    console.error(err.stdout);
  }

  if (err.stderr) {
    console.error('');
    console.error('----- stderr -----');
    console.error(err.stderr);
  }

  process.exit(1);
});
