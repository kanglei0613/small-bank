'use strict';

/**
 * test/transfers.test.js
 *
 * Integration tests for POST /transfers and GET /transfers.
 * Uses egg-mock to start the Egg app and make real HTTP requests.
 *
 * Shard assignment strategy:
 *   Account IDs come from a global auto-increment sequence.
 *   Since shardId = accountId % 4, consecutive IDs cycle through shards 0,1,2,3.
 *   Therefore accounts[i] and accounts[i+4] are ALWAYS on the same shard,
 *   and accounts[i] and accounts[i+1] are ALWAYS on different shards —
 *   regardless of what the starting sequence value is.
 *
 *   We create 9 accounts sequentially and assign:
 *     sameShardFrom  = accounts[0]  (same shard as accounts[4] and accounts[8])
 *     sameShardTo    = accounts[4]  (same shard as accounts[0])
 *     crossShardFrom = accounts[0]
 *     crossShardTo   = accounts[1]  (different shard from accounts[0])
 *     poorAccount    = accounts[8]  (balance=10, same shard as accounts[4])
 */

const { app } = require('egg-mock/bootstrap');
// before / after 是 Mocha 全域函式，不需要從 egg-mock/bootstrap 解構
const assert = require('assert');

// ── Test account IDs (populated in before()) ──────────────────────────────
let sameShardFrom;
let sameShardTo;
let crossShardFrom;
let crossShardTo;
let poorAccountId;
let testAccountIds = [];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a user and an account with the given label and initial balance.
 * Returns the account data object (with real auto-generated id).
 */
async function createTestAccount(label, initialBalance = 100000) {
  const userRes = await app.httpRequest()
    .post('/users')
    .send({ name: `test-${label}-${Date.now()}` })
    .expect(201);

  assert(userRes.body.ok, 'user create should succeed');
  const userId = userRes.body.data.id;

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

// ── Lifecycle ──────────────────────────────────────────────────────────────
//
// Create 9 accounts sequentially.
// accounts[i].id and accounts[i+4].id differ by exactly 4,
// so (accounts[i].id % 4) === (accounts[i+4].id % 4) — always same shard.
// accounts[i].id and accounts[i+1].id differ by 1,
// so their shards differ — always cross shard.

before(async () => {
  const accounts = [];
  for (let i = 0; i < 9; i++) {
    // last account is "poor" with only 10 units
    const balance = i === 8 ? 10 : 100000;
    const acc = await createTestAccount(`t${i}`, balance);
    accounts.push(acc);
  }

  sameShardFrom  = accounts[0].id;
  sameShardTo    = accounts[4].id;  // same shard as accounts[0] (diff = 4)
  crossShardFrom = accounts[0].id;
  crossShardTo   = accounts[1].id;  // different shard (diff = 1)
  poorAccountId  = accounts[8].id;  // same shard as accounts[0,4] (diff = 8)

  testAccountIds = accounts.map(a => a.id);
});

after(async () => {
  try {
    console.log('[teardown] test accounts left in DB:', testAccountIds);
  } catch (err) {
    // best-effort cleanup; CI wipes the DB between runs anyway
    console.warn('[teardown] cleanup warning:', err && err.message);
  }
});

// ── POST /transfers ────────────────────────────────────────────────────────

describe('POST /transfers', () => {

  describe('same-shard (sync) transfer', () => {
    const TRANSFER_AMOUNT = 500;

    it('should return 202 with mode=sync and status=COMPLETED', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({
          fromId: sameShardFrom,
          toId: sameShardTo,
          amount: TRANSFER_AMOUNT,
        })
        .expect(202);

      const { ok, data } = res.body;
      assert.strictEqual(ok, true);
      assert.strictEqual(data.mode, 'sync');
      assert.strictEqual(data.status, 'COMPLETED');
      assert.ok(data.transferId, 'transferId should be present');
      assert.strictEqual(data.type, 'same-shard');
      assert.strictEqual(data.fromId, sameShardFrom);
      assert.strictEqual(data.toId, sameShardTo);
      assert.strictEqual(data.amount, TRANSFER_AMOUNT);
    });

    it('should debit fromAccount and credit toAccount correctly', async () => {
      const AMOUNT = 1000;

      const beforeFrom = await getBalance(sameShardFrom);
      const beforeTo   = await getBalance(sameShardTo);

      await app.httpRequest()
        .post('/transfers')
        .send({ fromId: sameShardFrom, toId: sameShardTo, amount: AMOUNT })
        .expect(202);

      const afterFrom = await getBalance(sameShardFrom);
      const afterTo   = await getBalance(sameShardTo);

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
      // Total balance is conserved
      const beforeTotal = Number(beforeFrom.balance) + Number(beforeTo.balance);
      const afterTotal  = Number(afterFrom.balance)  + Number(afterTo.balance);
      assert.strictEqual(afterTotal, beforeTotal, 'balance conservation: sum must not change');
    });

    it('should include balance snapshot in response', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({ fromId: sameShardFrom, toId: sameShardTo, amount: 100 })
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

  describe('cross-shard (async) transfer', () => {
    it('should return 202 with mode=async and status=queued', async () => {
      const res = await app.httpRequest()
        .post('/transfers')
        .send({
          fromId: crossShardFrom,
          toId: crossShardTo,
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
        .send({ fromId: crossShardFrom, toId: crossShardTo, amount: 100 })
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

  describe('input validation', () => {
    // Use any valid account ID for validation tests; value doesn't matter
    // since these requests never reach DB
    const cases = [
      {
        label: 'missing fromId',
        body: { toId: 2, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'fromId = 0',
        body: { fromId: 0, toId: 2, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'negative fromId',
        body: { fromId: -1, toId: 2, amount: 100 },
        message: 'fromId must be a positive integer',
      },
      {
        label: 'missing toId',
        body: { fromId: 1, amount: 100 },
        message: 'toId must be a positive integer',
      },
      {
        label: 'amount = 0',
        body: { fromId: 1, toId: 2, amount: 0 },
        message: 'amount must be a positive integer',
      },
      {
        label: 'amount is float',
        body: { fromId: 1, toId: 2, amount: 1.5 },
        message: 'amount must be a positive integer',
      },
      {
        label: 'fromId === toId',
        body: { fromId: 1, toId: 1, amount: 100 },
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

  describe('insufficient balance', () => {
    it('should return 409 when fromAccount has insufficient funds', async () => {
      // poorAccountId was created with balance=10, on same shard as sameShardTo
      // (accounts[8] and accounts[4] have the same shard since diff=4 divides evenly)
      // Attempt to transfer 9999 (> 10) → same-shard sync path → 409
      const res = await app.httpRequest()
        .post('/transfers')
        .send({ fromId: poorAccountId, toId: sameShardTo, amount: 9999 })
        .expect(409);

      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.message, 'insufficient funds');
    });
  });
});

// ── GET /transfers ─────────────────────────────────────────────────────────

describe('GET /transfers', () => {
  it('should return transfer history for an account', async () => {
    // Perform a transfer first so there is at least one record
    await app.httpRequest()
      .post('/transfers')
      .send({ fromId: sameShardFrom, toId: sameShardTo, amount: 1 })
      .expect(202);

    const res = await app.httpRequest()
      .get(`/transfers?accountId=${sameShardFrom}`)
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
      .get(`/transfers?accountId=${sameShardFrom}&limit=201`)
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
