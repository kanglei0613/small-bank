const { Pool } = require('pg');

const SHARDS = [
  { host: 'postgres-s0', db: 'small_bank_s0' },
  { host: 'postgres-s1', db: 'small_bank_s1' },
  { host: 'postgres-s2', db: 'small_bank_s2' },
  { host: 'postgres-s3', db: 'small_bank_s3' },
];

async function testShard({ host, db }) {
  const p = new Pool({
    host, port: 5432,
    user: process.env.PG_USER || 'kanglei0613',
    password: process.env.PG_PASSWORD || '7522alex',
    database: db,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const r = await p.query(
      'SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [ db ]
    );
    console.log('OK  ' + host + ' (' + db + ') — active conns: ' + r.rows[0].count);
  } catch (e) {
    console.error('FAIL ' + host + ' (' + db + ') — ' + e.message);
  } finally {
    await p.end();
  }
}

async function testCrossShardPattern() {
  console.log('\n--- Cross-shard connect (fromShard=2, toShard=1) ---');
  const fromPool = new Pool({
    host: 'postgres-s2', port: 5432,
    user: process.env.PG_USER || 'kanglei0613',
    password: process.env.PG_PASSWORD || '7522alex',
    database: 'small_bank_s2',
    max: 10, connectionTimeoutMillis: 5000,
  });
  const toPool = new Pool({
    host: 'postgres-s1', port: 5432,
    user: process.env.PG_USER || 'kanglei0613',
    password: process.env.PG_PASSWORD || '7522alex',
    database: 'small_bank_s1',
    max: 10, connectionTimeoutMillis: 5000,
  });
  try {
    const fc = await fromPool.connect();
    console.log('fromClient (s2) acquired');
    const tc = await toPool.connect();
    console.log('toClient (s1) acquired');
    await fc.query('SELECT 1');
    console.log('fromClient query OK');
    await tc.query('SELECT 1');
    console.log('toClient query OK');
    fc.release();
    tc.release();
    console.log('SUCCESS — cross-shard connect pattern is fine');
  } catch (e) {
    console.error('FAIL: ' + e.message);
  } finally {
    await fromPool.end();
    await toPool.end();
  }
}

(async () => {
  console.log('=== Single-shard connection tests ===');
  for (const s of SHARDS) await testShard(s);
  await testCrossShardPattern();
})();
