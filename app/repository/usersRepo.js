'use strict';

// 先用記憶體模擬資料庫（之後再換成 MySQL）
const store = {
  nextId: 1,
  users: new Map(), // id -> { id, name, createdAt }
};

class UsersRepo {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async create({ name }) {
    const id = store.nextId++;
    const user = { id, name, createdAt: Date.now() };
    store.users.set(id, user);
    return user;
  }

  async getById(id) {
    return store.users.get(id) || null;
  }
}

module.exports = UsersRepo;
