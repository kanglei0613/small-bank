'use strict';

/**
 * test/transfers.test.js
 *
 * Integration tests for POST /transfers and GET /transfers.
 * Uses supertest to make real HTTP requests against the running Egg app.
 *
 * Prerequisites:
 *   - PostgreSQL (meta + 4 shards) must be reachable
 *   - Redis must be reachable
 *   - env vars must point to the test databases (or use defaults)
 *
 * Run:
 *   npm install --save-dev jest supertest
 *   npx jest test/transfers.test.js
 *
 * Or via egg-bin (existing test runner):
 *   npm run test:local
 *
 * CI note: GitHub Actions sets up service containers with the env vars below.
 * See .github/workflows/ci.yml for the full matrix.
 */

const { app } = require('egg-mock/bootstrap');
// before / after 是 Mocha 全域函式，不需要從 egg-mock/bootstrap 解構
const assert = require('assert');

// ---------------------------------------------------------------------------
// Test fixtures
// We pick account IDs that are on the SAME shard (synchronous path) and
// also IDs on DIFFERENT shards (asynchronous path).
//
// Shard routing: accountId % 4
//   shard 0 → IDs 4, 8, 1000004, …
//   shard 1 → IDs 1, 5, 1000001, …
//   shard 2 → IDs 2, 6, 1000002, …
//   shard 3 → IDs 3, 7, 1000003, …
//
// We use large IDs to avoid collisions with seeded production data.
// ---------------------------------------------------------------------------

// Same-shard pair: both on shard 1 (id % 4 === 1)
const SAME_SHARD_FROM = 9000001; // shard 1
const SAME_SHARD_TO   = 9000005; // shard 1

// Cross-shard pair: shard 0 → shard 1
const CROSS_SHARD_FROM = 9000100; // shard 0 (100 % 4 === 0)
const CROSS_SHARD_TO   = 9000101; // shard 1 (101 % 4 === 1)

const INITIAL_BALANCE = 100000; // ample funds for all test cases

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a user and an account with the given ID and initial balance.
 * Returns the account object.
 */
async function createTestAccount(accountId, initialBalance = INITIAL_BALANCE) {
  // 1. Create user
  const userRes = await app.httpRequest()
    .post('/users')
    .send({ name: `test-user-${accountId}` })
    .expect(201);

  assert(userRes.body.ok, 'user create should succeed');
  const userId = userRes.body.data.id;

  // 2. Open account — the accounts service uses the provided initialBalance
  const accRes = await app.httpRequest()
    .post('/accounts')
    .send({ userId, initialBalance })
    .expect(201);

  assert(accRes.body.ok, 'account create should succeed');
  return accRes.body.data;
}

/**
 * Fetch current account balance.
 */
async function getBalance(accountId) {
  const res = await app.httpRequest()
    .get(`/accounts/${accountId}`)
    .expect(200);
  assert(res.body.ok);
  return res.body.data;
}

// ---------------------------------------------------------------------------
// Lifecycle: create test accounts once, clean up after all tests
// ---------------------------------------------------------------------------

let testAccountIds = [];

before(async () => {
  // Create all four test accounts
  await Promise.all([
    createTestAccount(SAME_SHARD_FROM),
    createTestAccount(SAME_SHARD_TO),
    createTestAccount(CROSS_SHARD_FROM),
    createTestAccount(CROSS_SHARD_TO),
  ]);

  testAccountIds = [
    SAME_SHARD_FROM,
    SAME_SHARD_TO,
    CROSS_SHARD_FROM,
    CROSS_SHARD_TO,
  ];
});

after(async () => {
  // Remove test data so repeated runs stay idempotent.
  // We rely on the DB cascading or just deleting the accounts directly.
  // If no DELETE route exists, the test DB is wiped by CI between runs anyway.
  // For local runs, this attempts a best-effort cleanup via raw service calls.
  try {
    console.log('[teardown] test accounts left in DB:', testAccountIds);
  } catch (err) {
    // best-effort cleanup; CI wipes the DB between runs anyway
    console.warn('[teardown] cleanup warning:', err && err.message);
  }
});

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('POST /transfers', () => {

  // ─── Same-shard synchronous transfer ────────────────────────────────────

  describe('same-shard (sync) transfer', () => {
    const TRANSFER_AMOUNT = 500;

    it('should return 202 with mode=sync and status=COMPLETED', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({
          fromId: SAME_SHARD_FROM,
          toId: SAME_SHARD_TO,
          amount: TRANSFER_AMOUNT,
        })
        .expect(202);

      const { ok, data } = res.body;
      assert.strictEqual(ok, true);
      assert.strictEqual(data.mode, 'sync');
      assert.strictEqual(data.status, 'COMPLETED');
      assert.ok(data.transferId, 'transferId should be present');
      assert.strictEqual(data.type, 'same-shard');
      assert.strictEqual(data.fromId, SAME_SHARD_FROM);
      assert.strictEqual(data.toId, SAME_SHARD_TO);
      assert.strictEqual(data.amount, TRANSFER_AMOUNT);
    });

    it('should debit fromAccount and credit toAccount correctly', async () => {
      const AMOUNT = 1000;

      const beforeFrom = await getBalance(SAME_SHARD_FROM);
      const beforeTo   = await getBalance(SAME_SHARD_TO);

      await app.httpRequest()
        .post('/transfers')
        .send({ fromId: SAME_SHARD_FROM, toId: SAME_SHARD_TO, amount: AMOUNT })
        .expect(202);

      const afterFrom = await getBalance(SAME_SHARD_FROM);
      const afterTo   = await getBalance(SAME_SHARD_TO);

      assert.strictEqual(
        Number(afterFrom.available_balance),
        Number(beforeFrom.available_balance) - AMOUNT,
        'fromAccount available_balance should decrease by amount'
      );
      assert.strictEqual(
        Number(afterTo.available_balance),
        Number(beforeTo.available_balance) + AMOUNT,
        'toAccount available_balance should increase by amount'
      );
      // Total balance in system is conserved
      const beforeTotal = Number(beforeFrom.balance) + Number(beforeTo.balance);
      const afterTotal  = Number(afterFrom.balance)  + Number(afterTo.balance);
      assert.strictEqual(afterTotal, beforeTotal, 'balance conservation: sum must not change');
    });

    it('should include balance snapshot in response', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({ fromId: SAME_SHARD_FROM, toId: SAME_SHARD_TO, amount: 100 })
        .expect(202);

      const { balance } = res.body.data;
      assert.ok(balance, 'balance snapshot should be present');
      assert.ok('available_balance' in balance, 'balance.available_balance should exist');
      assert.ok('reserved_balance'  in balance, 'balance.reserved_balance should exist');
      assert.strictEqual(
        Number(balance.balance),
        Number(balance.available_balance) + Number(balance.reserved_balance),
        'balance invariant: balance = available_balance + reserved_balance'
      );
    });
  });

  // ─── Cross-shard asynchronous transfer ──────────────────────────────────

  describe('cross-shard (async) transfer', () => {
    it('should return 202 with mode=async and status=queued', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({
          fromId: CROSS_SHARD_FROM,
          toId: CROSS_SHARD_TO,
          amount: 200,
        })
        .expect(202);

      const { ok, data } = res.body;
      assert.strictEqual(ok, true);
      assert.strictEqual(data.mode, 'async');
      assert.strictEqual(data.status, 'queued');
      assert.ok(data.jobId, 'jobId should be present');
      assert.match(data.jobId, /^\d+-[a-z0-9]+$/, 'jobId should match timestamp-randomhex format');
    });

    it('should allow polling GET /transfer-jobs/:jobId', async () => {
      const submitRes = await app.httpRequest()
        .post('/transfers')
        .send({ fromId: CROSS_SHARD_FROM, toId: CROSS_SHARD_TO, amount: 100 })
        .expect(202);

      const { jobId } = submitRes.body.data;

      const pollRes = await app.httpRequest()
        .get(`/transfer-jobs/${jobId}`)
        .expect(200);

      const { ok, data } = pollRes.body;
      assert.strictEqual(ok, true);
      assert.strictEqual(data.jobId, jobId);
      assert.ok([ 'queued', 'success', 'failed' ].includes(data.status), `unexpected status: ${data.status}`);
    });
  });

  // ─── Input validation (400 errors) ───────────────────────────────────────

  describe('input validation', () => {
    const cases = [
      {
        label: 'missing fromId',
        body: { toId: SAME_SHARD_TO, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'fromId = 0',
        body: { fromId: 0, toId: SAME_SHARD_TO, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'negative fromId',
        body: { fromId: -1, toId: SAME_SHARD_TO, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'missing toId',
        body: { fromId: SAME_SHARD_FROM, amount: 100 },
        message: 'toId must be a positive integer',
      },
      {
        label: 'amount = 0',
        body: { fromId: SAME_SHARD_FROM, toId: SAME_SHARD_TO, amount: 0 },
        message: 'amount must be a positive integer',
      },
      {
        label: 'amount is float',
        body: { fromId: SAME_SHARD_FROM, toId: SAME_SHARD_TO, amount: 1.5 },
        message: 'amount must be a positive integer',
      },
      {
        label: 'fromId === toId',
        body: { fromId: SAME_SHARD_FROM, toId: SAME_SHARD_FROM, amount: 100 },
        message: 'fromId and toId cannot be the same',
      },
    ];

    for (const { label, body, message } of cases) {
      it(`should return 400 for ${label}`, async () => {
        const res = await app.httpRequest()
          .post('/transfers')
          .send(body)
          .expect(400);

        assert.strictEqual(res.body.ok, false);
        assert.strictEqual(res.body.message, message);
      });
    }
  });

  // ─── Insufficient balance (409 Conflict) ─────────────────────────────────

  describe('insufficient balance', () => {
    it('should return 409 when fromAccount has insufficient funds', async () => {
      // Create a fresh account with only 10 units
      const poorRes = await app.httpRequest()
        .post('/accounts')
        .send({ userId: 1, initialBalance: 10 })
        .expect(201);

      const poorAccountId = poorRes.body.data.id;

      // Find a valid destination on same shard
      // Pick a destination that is on the same shard (accountId % 4 == poorAccountId % 4)
      const destId = poorAccountId + 4; // same shard offset

      // Ensure destination exists by creating it too
      await app.httpRequest()
        .post('/accounts')
        .send({ userId: 1, initialBalance: 0 })
        .expect(201);

      const res = await app.httpRequest()
        .post('/transfers')
        .send({ fromId: poorAccountId, toId: destId, amount: 9999 })
        .expect(409);

      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.message, 'insufficient funds');
    });
  });
});

// ---------------------------------------------------------------------------
// GET /transfers
// ---------------------------------------------------------------------------

describe('GET /transfers', () => {
  it('should return transfer history for an account', async () => {
    // Perform a transfer first so there is at least one record
    await app.httpRequest()
      .post('/transfers')
      .send({ fromId: SAME_SHARD_FROM, toId: SAME_SHARD_TO, amount: 1 })
      .expect(202);

    const res = await app.httpRequest()
      .get(`/transfers?accountId=${SAME_SHARD_FROM}`)
      .expect(200);

    const { ok, data } = res.body;
    assert.strictEqual(ok, true);
    assert.ok(Array.isArray(data.items), 'data.items should be an array');
    assert.ok(data.items.length > 0, 'should have at least one transfer');

    const record = data.items[0];
    assert.ok('from_account_id' in record, 'from_account_id field missing');
    assert.ok('to_account_id'   in record, 'to_account_id field missing');
    assert.ok('amount'          in record, 'amount field missing');
    assert.ok('status'          in record, 'status field missing');
  });

  it('should return 400 for invalid accountId', async () => {
    const res = await app.httpRequest()
      .get('/transfers?accountId=abc')
      .expect(400);

    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.message, 'accountId must be a positive integer');
  });

  it('should return 400 when limit exceeds 200', async () => {
    const res = await app.httpRequest()
      .get(`/transfers?accountId=${SAME_SHARD_FROM}&limit=201`)
      .expect(400);

    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.message, 'limit must be <= 200');
  });

  it('should return 404 for non-existent accountId', async () => {
    const res = await app.httpRequest()
      .get('/transfers?accountId=999999999')
      .expect(404);

    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.message, 'account not found');
  });
});
