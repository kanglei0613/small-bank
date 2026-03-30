'use strict';

const { spawn } = require('child_process');

const API = process.env.API || 'http://127.0.0.1:7001';
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 30);
const CONCURRENCY = Number(process.env.CONCURRENCY || 300);
const AMOUNT = Number(process.env.AMOUNT || 1);
const SHARD_COUNT = Number(process.env.SHARD_COUNT || 4);
const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 100000);
const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 100);
const JOB_POLL_TIMEOUT_MS = Number(process.env.JOB_POLL_TIMEOUT_MS || 10000);

const ACCOUNT_COUNT_LIST = [ 1000, 5000, 10000 ];

/*
  改成新的 shell script 名稱
*/
const BENCHMARK_SCRIPT = 'scripts/benchmark/run_account_count_matrix.sh';

function runOneBenchmark(accountCount) {
  return new Promise((resolve, reject) => {

    const child = spawn('bash', [ BENCHMARK_SCRIPT ], {
      env: {
        ...process.env,
        API,
        ACCOUNT_COUNT: String(accountCount),
        INITIAL_BALANCE: String(INITIAL_BALANCE),
        CONCURRENCY: String(CONCURRENCY),
        DURATION_SECONDS: String(DURATION_SECONDS),
        AMOUNT: String(AMOUNT),
        SHARD_COUNT: String(SHARD_COUNT),
        JOB_POLL_INTERVAL_MS: String(JOB_POLL_INTERVAL_MS),
        JOB_POLL_TIMEOUT_MS: String(JOB_POLL_TIMEOUT_MS),
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
        const result = parseBenchmarkOutput(stdout, accountCount);
        resolve(result);
      } catch (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }

    });

  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function parseIntegerOrDefault(output, label, defaultValue = 0) {
  try {
    return parseInteger(output, label);
  } catch (err) {
    return defaultValue;
  }
}

function parseBenchmarkOutput(output, accountCount) {

  const elapsedSeconds = parseNumber(output, 'Elapsed Seconds');
  const totalRequests = parseInteger(output, 'Total Requests');
  const successRequests = parseInteger(output, 'Success Requests');
  const failedRequests = parseInteger(output, 'Failed Requests');
  const successRate = parseNumber(output, 'Success Rate');
  const avgTotalRps = parseNumber(output, 'Avg Total RPS');
  const avgSuccessRps = parseNumber(output, 'Avg Success RPS');

  const sameShardSuccess = parseIntegerOrDefault(output, 'Same-Shard Success', 0);
  const crossShardSuccess = parseIntegerOrDefault(output, 'Cross-Shard Success', 0);
  const enqueueFailed = parseIntegerOrDefault(output, 'Enqueue Failed', 0);
  const requestErrors = parseIntegerOrDefault(output, 'Request Errors', 0);

  return {
    accountCount,
    elapsedSeconds,
    totalRequests,
    successRequests,
    failedRequests,
    successRate,
    avgTotalRps,
    avgSuccessRps,
    sameShardSuccess,
    crossShardSuccess,
    enqueueFailed,
    requestErrors,
  };
}

function printMarkdownTable(results) {

  console.log('');
  console.log('========================================');
  console.log('Markdown Table');
  console.log('========================================');
  console.log('');

  console.log('## Mixed Random Account Count Sweep');
  console.log('');

  console.log('| Account Count | Total Requests | Success Requests | Failed Requests | Success Rate | Avg Total RPS | Avg Success RPS | Same-Shard Success | Cross-Shard Success | Enqueue Failed | Request Errors |');
  console.log('|---------------|----------------|------------------|-----------------|--------------|---------------|-----------------|--------------------|---------------------|----------------|----------------|');

  for (const item of results) {

    console.log(
      `| ${item.accountCount} | ${item.totalRequests} | ${item.successRequests} | ${item.failedRequests} | ${item.successRate.toFixed(2)}% | ${item.avgTotalRps.toFixed(2)} | ${item.avgSuccessRps.toFixed(2)} | ${item.sameShardSuccess} | ${item.crossShardSuccess} | ${item.enqueueFailed} | ${item.requestErrors} |`
    );

  }

  const best = results.reduce((prev, curr) => {

    if (!prev) {
      return curr;
    }

    return curr.avgSuccessRps > prev.avgSuccessRps ? curr : prev;

  }, null);

  console.log('');
  console.log('### Best Result');
  console.log('');
  console.log('```');

  console.log(`Best Account Count = ${best.accountCount}`);
  console.log(`Best Avg Success RPS = ${best.avgSuccessRps.toFixed(2)}`);
  console.log(`Success Rate = ${best.successRate.toFixed(2)}%`);
  console.log(`Enqueue Failed = ${best.enqueueFailed}`);
  console.log(`Request Errors = ${best.requestErrors}`);

  console.log('```');
  console.log('');
}

async function main() {

  console.log('========================================');
  console.log('Small Bank Account Count Matrix Runner');
  console.log('========================================');

  console.log(`SCRIPT=${BENCHMARK_SCRIPT}`);
  console.log(`API=${API}`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`DURATION_SECONDS=${DURATION_SECONDS}`);
  console.log(`AMOUNT=${AMOUNT}`);
  console.log(`SHARD_COUNT=${SHARD_COUNT}`);
  console.log(`INITIAL_BALANCE=${INITIAL_BALANCE}`);
  console.log(`JOB_POLL_INTERVAL_MS=${JOB_POLL_INTERVAL_MS}`);
  console.log(`JOB_POLL_TIMEOUT_MS=${JOB_POLL_TIMEOUT_MS}`);

  console.log(`ACCOUNT_COUNT_LIST=${ACCOUNT_COUNT_LIST.join(', ')}`);
  console.log('');

  const results = [];

  for (const accountCount of ACCOUNT_COUNT_LIST) {

    console.log('');
    console.log('========================================');
    console.log(`Running benchmark: ACCOUNT_COUNT=${accountCount}`);
    console.log('========================================');
    console.log('');

    const result = await runOneBenchmark(accountCount);

    results.push(result);

  }

  printMarkdownTable(results);
}

main().catch(err => {

  console.error('run account count matrix failed:', err.message);

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
