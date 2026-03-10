'use strict';

/**
 * TransferExecutor
 *
 * 作用：
 * - 專心處理「單筆 transfer 要怎麼執行」
 * - 不管 queue，不管 controller
 * - 只管 DB transaction
 */
class TransferExecutor {
  constructor(app) {
    this.app = app;
  }

  //
  // execute({ fromId, toId, amount })
  //
  // 真正執行一筆轉帳
  //
  async execute({ fromId, toId, amount }) {
    // 開 transaction
    // 這裡假設你目前的 pg 包裝有 beginTransaction()
    const client = await this.app.pg.beginTransaction();

    try {
      // 基本檢查：不能自己轉給自己
      if (fromId === toId) {
        const err = new Error('fromId and toId cannot be the same');
        err.status = 400;
        throw err;
      }

      // 基本檢查：amount 必須是正整數
      if (!Number.isInteger(amount) || amount <= 0) {
        const err = new Error('amount must be a positive integer');
        err.status = 400;
        throw err;
      }

      /**
       * 固定鎖順序，避免死鎖
       *
       * 例如 fromId=10, toId=6
       * 也要先鎖 6 再鎖 10
       *
       * 好處：
       * - 不同 transaction 對同兩個帳戶的鎖順序一致
       * - 可降低 deadlock 風險
       */
      const [ firstId, secondId ] =
        fromId < toId ? [ fromId, toId ] : [ toId, fromId ];

      const lockSql = `
        SELECT id, balance
        FROM accounts
        WHERE id IN ($1, $2)
        ORDER BY id
        FOR UPDATE
      `;

      // 鎖住兩個帳戶的 row
      const lockResult = await client.query(lockSql, [ firstId, secondId ]);

      // 正常情況應該要找到 2 個帳戶
      if (lockResult.rows.length !== 2) {
        const err = new Error('account not found');
        err.status = 404;
        throw err;
      }

      // 轉成 Map 方便後面依 id 取值
      const rowMap = new Map(
        lockResult.rows.map(row => [ Number(row.id), row ])
      );

      const fromAccount = rowMap.get(fromId);
      const toAccount = rowMap.get(toId);

      if (!fromAccount || !toAccount) {
        const err = new Error('account not found');
        err.status = 404;
        throw err;
      }

      // 檢查餘額是否足夠
      if (Number(fromAccount.balance) < amount) {
        const err = new Error('insufficient balance');
        err.status = 400;
        throw err;
      }

      // 扣款
      const updateFromSql = `
        UPDATE accounts
        SET balance = balance - $1, updated_at = NOW()
        WHERE id = $2
      `;
      await client.query(updateFromSql, [ amount, fromId ]);

      // 入帳
      const updateToSql = `
        UPDATE accounts
        SET balance = balance + $1, updated_at = NOW()
        WHERE id = $2
      `;
      await client.query(updateToSql, [ amount, toId ]);

      // 新增 transfer 紀錄
      const insertTransferSql = `
        INSERT INTO transfers (
          from_account_id,
          to_account_id,
          amount,
          created_at
        )
        VALUES ($1, $2, $3, NOW())
        RETURNING
          id,
          from_account_id AS "fromId",
          to_account_id AS "toId",
          amount,
          created_at
      `;

      const transferResult = await client.query(insertTransferSql, [
        fromId,
        toId,
        amount,
      ]);

      // 全部成功就 commit
      await client.commit();

      // 回傳結果
      return {
        success: true,
        transfer: transferResult.rows[0],
      };
    } catch (err) {
      // 任何失敗都 rollback
      await client.rollback();
      throw err;
    }
  }
}

module.exports = TransferExecutor;
