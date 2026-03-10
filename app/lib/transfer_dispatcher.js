'use strict';

const queueManager = require('./transfer_queue_manager');
const TransferExecutor = require('./transfer_executor');

//
// TransferDispatcher
//
// 作用：
// - 接收 transfer payload
// - 依照 fromId 決定 queue key
// - 把工作丟進 queue
//
class TransferDispatcher {
  constructor(app) {
    this.app = app;
    this.executor = new TransferExecutor(app);
  }

  //
  // dispatch(payload)
  //
  // payload 例如：
  // {
  //   fromId: 6,
  //   toId: 7,
  //   amount: 1
  // }
  //
  async dispatch(payload) {
    // 用 fromId 產生 queue key
    const key = this._buildQueueKey(payload.fromId);

    // 丟進 queue
    return await queueManager.enqueue(
      key,
      async jobPayload => {
        // 真正執行 transfer
        return await this.executor.execute(jobPayload);
      },
      payload
    );
  }

  //
  // 產生 queue key
  // 例如 fromId=6 -> "transfer:6"
  //
  _buildQueueKey(fromId) {
    return `transfer:${fromId}`;
  }
}

module.exports = TransferDispatcher;
