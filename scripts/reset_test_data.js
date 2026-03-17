// scripts/reset_test_data.js
const { Client } = require('pg');

const DBS = [
  'small_bank_meta',
  'small_bank_s0',
  'small_bank_s1',
  'small_bank_s2',
  'small_bank_s3',
];

async function reset() {
  for (const dbName of DBS) {
    const client = new Client({
      user: 'kanglei0613',
      host: '127.0.0.1',
      database: dbName,
      password: '',
      port: 5432,
    });

    await client.connect();
    console.log(`Resetting ${dbName}...`);

    try {
      if (dbName === 'small_bank_meta') {
        await client.query(`
          TRUNCATE users, account_shards RESTART IDENTITY CASCADE;
        `);
      } else {
        await client.query(`
          TRUNCATE accounts, transfers RESTART IDENTITY CASCADE;
        `);
      }

      console.log(`OK: ${dbName}`);
    } catch (err) {
      console.error(`FAILED: ${dbName}`, err.message);
    }

    await client.end();
  }

  console.log('All DB reset done');
}

reset();
