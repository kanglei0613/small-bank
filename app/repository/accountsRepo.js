'use strict';

const BaseShardRepo = require('./baseShardRepo');

class AccountsRepo extends BaseShardRepo {

  async create({ userId, initialBalance } = {}) {
    const uid = Number(userId);
    const bal = Math.floor(Number(initialBalance || 0));

    const idResult = await this.metaPg.query(
      "SELECT nextval('global_account_id_seq') AS account_id"
    );
    const accountId = Number(idResult.rows[0].account_id);
    const shardId = this.calcShardId(accountId);
    const shardPg = this.getShardPg(shardId);

    const metaClient = await this.metaPg.connect();
    const shardClient = await shardPg.connect();
    let routingInserted = false;

    try {
      await metaClient.query('BEGIN');
      await metaClient.query(
        'INSERT INTO account_shards (account_id, shard_id) VALUES ($1, $2)',
        [ accountId, shardId ]
      );
      await metaClient.query('COMMIT');

      routingInserted = true;

      await shardClient.query('BEGIN');

      const result = await shardClient.query(
        `
          INSERT INTO accounts (id, user_id, balance, available_balance, reserved_balance)
          VALUES ($1, $2, $3, $3, 0)
          RETURNING
            id,
            user_id AS "userId",
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [ accountId, uid, bal ]
      );

      await shardClient.query('COMMIT');

      return result.rows[0];
    } catch (err) {
      try { await metaClient.query('ROLLBACK'); } catch (e) { void e; }
      try { await shardClient.query('ROLLBACK'); } catch (e) { void e; }

      if (routingInserted) {
        try {
          await this.metaPg.query(
            'DELETE FROM account_shards WHERE account_id = $1',
            [ accountId ]
          );
        } catch (e) { void e; }
      }

      throw err;
    } finally {
      metaClient.release();
      shardClient.release();
    }
  }

  async getById(id) {
    const accountId = Number(id);
    const shardPg = this.getShardPg(this.calcShardId(accountId));

    const result = await shardPg.query(
      `
        SELECT
          id,
          user_id AS "userId",
          balance,
          available_balance AS "availableBalance",
          reserved_balance AS "reservedBalance",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM accounts
        WHERE id = $1
      `,
      [ accountId ]
    );

    return result.rows[0] || null;
  }

  async deposit({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);
    const shardPg = this.getShardPg(this.calcShardId(aid));
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `
          UPDATE accounts
          SET
            balance = balance + $1,
            available_balance = available_balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING
            id,
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            updated_at AS "updatedAt"
        `,
        [ amt, aid ]
      );

      if (result.rowCount === 0) {
        const { NotFoundError } = require('../lib/errors');
        throw new NotFoundError('account not found');
      }

      await client.query('COMMIT');

      return { type: 'deposit', accountId: aid, amount: amt, account: result.rows[0] };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { void e; }
      throw err;
    } finally {
      client.release();
    }
  }

  async withdraw({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);
    const shardPg = this.getShardPg(this.calcShardId(aid));
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `
          UPDATE accounts
          SET
            balance = balance - $1,
            available_balance = available_balance - $1,
            updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING
            id,
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            updated_at AS "updatedAt"
        `,
        [ amt, aid ]
      );

      if (result.rowCount === 0) {
        const existsResult = await client.query(
          'SELECT id FROM accounts WHERE id = $1 LIMIT 1',
          [ aid ]
        );
        const { NotFoundError, ConflictError } = require('../lib/errors');
        if (existsResult.rowCount === 0) throw new NotFoundError('account not found');
        throw new ConflictError('insufficient funds');
      }

      await client.query('COMMIT');

      return { type: 'withdraw', accountId: aid, amount: amt, account: result.rows[0] };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { void e; }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = AccountsRepo;
