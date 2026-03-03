'use strict';

const Service = require('egg').Service;
const AccountRepo = require('../repository/accountsRepo');

class TransferService extends Service {
  async transfer({ fromId, toId, amount }) {
    const repo = new AccountRepo(this.app);
    return await repo.transfer(fromId, toId, amount);
  }
}

module.exports = TransferService;
