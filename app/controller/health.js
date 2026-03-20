'use strict';

const Controller = require('egg').Controller;

class HealthController extends Controller {
  async index() {
    this.ctx.body = { ok: true, ts: Date.now() };
  }
}

module.exports = HealthController;
