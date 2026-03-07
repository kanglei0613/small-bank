'use strict';

const Controller = require('egg').Controller;

class HomeController extends Controller {
  async index() {
    const { app, ctx } = this;

    await app.redis.set('test:redis', 'ok', 'EX', 60);
    const value = await app.redis.get('test:redis');

    ctx.body = {
      message: 'redis test success',
      value,
    };
  }
}

module.exports = HomeController;
