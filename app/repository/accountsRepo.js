'use strict';

const store = {
  nextId: 1,
  accounts: new Map(), // id -> { id, userId, balance, createdAt }
};

class AccountsRepo {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async create({ userId, initialBalance }) {
    const id = store.nextId++;
    const account = {
      id,
      userId,
      balance: initialBalance,
      createdAt: Date.now(),
    };
    store.accounts.set(id, account);
    return account;
  }

  async getById(id) {
    return store.accounts.get(id) || null;
  }
  async updateBalance(id, newBalance) {
    const acc = store.accounts.get(id);
    if (!acc) return null;
    acc.balance = newBalance;
    return acc;
  }

  async getBalances(ids) {
    return ids.map(id => store.accounts.get(id) || null);
  }
}

module.exports = AccountsRepo;
