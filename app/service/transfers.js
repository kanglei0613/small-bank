'use strict';

const AccountsRepo = require('../repository/accountsRepo');
const lock = require('../utils/lock');

class TransfersService {
  constructor(ctx) {
    this.ctx = ctx;
    this.accountsRepo = new AccountsRepo(ctx);
  }

  async transfer({ fromAccountId, toAccountId, amount }) {
    const fromId = Number(fromAccountId);
    const toId = Number(toAccountId);
    const amt = Number(amount);

    if (!Number.isInteger(fromId) || fromId <= 0) {
      const err = new Error('fromAccountId must be a positive integer');
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(toId) || toId <= 0) {
      const err = new Error('toAccountId must be a positive integer');
      err.status = 400;
      throw err;
    }
    if (fromId === toId) {
      const err = new Error('fromAccountId and toAccountId must be different');
      err.status = 400;
      throw err;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      const err = new Error('amount must be a number > 0');
      err.status = 400;
      throw err;
    }

    // 關鍵：鎖順序固定（小 id 先鎖）避免 deadlock
    const lockKey = fromId < toId ? `${fromId}-${toId}` : `${toId}-${fromId}`;

    return await lock.withLock(lockKey, async () => {
      const [ fromAcc, toAcc ] = await this.accountsRepo.getBalances([ fromId, toId ]);

      if (!fromAcc) {
        const err = new Error('from account not found');
        err.status = 404;
        throw err;
      }
      if (!toAcc) {
        const err = new Error('to account not found');
        err.status = 404;
        throw err;
      }
      if (fromAcc.balance < amt) {
        const err = new Error('insufficient funds');
        err.status = 400;
        throw err;
      }

      const newFrom = fromAcc.balance - amt;
      const newTo = toAcc.balance + amt;

      await this.accountsRepo.updateBalance(fromId, newFrom);
      await this.accountsRepo.updateBalance(toId, newTo);

      return {
        transfer: {
          fromAccountId: fromId,
          toAccountId: toId,
          amount: amt,
          createdAt: Date.now(),
        },
        balances: {
          from: { id: fromId, balance: newFrom },
          to: { id: toId, balance: newTo },
        },
      };
    });
  }
}

module.exports = TransfersService;
