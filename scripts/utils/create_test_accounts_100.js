'use strict';

/*
create_test_accounts_1000.js

用途：
建立 100 個測試 users 與 accounts

流程：
1. 建立 user
2. 建立 account
3. 每個 account 初始餘額 = 100000
*/

const axios = require('axios');

// API base URL
const BASE_URL = 'http://127.0.0.1:7001';

// 要建立的帳戶數量
const TOTAL = 100;

// 初始餘額
const INITIAL_BALANCE = 100000;

// 建立 user
async function createUser(index) {
  const res = await axios.post(`${BASE_URL}/users`, {
    name: `test_user_${index}`,
  });

  return Number(res.data.data.id);
}

// 建立 account
async function createAccount(userId) {
  const res = await axios.post(`${BASE_URL}/accounts`, {
    userId,
    initialBalance: INITIAL_BALANCE,
  });

  return res.data;
}

// 主流程
async function main() {
  console.log('========================================');
  console.log('Creating 1000 test accounts');
  console.log('========================================');

  let success = 0;
  let fail = 0;

  for (let i = 1; i <= TOTAL; i++) {
    try {
      // 建立 user
      const userId = await createUser(i);

      // 建立 account
      await createAccount(userId);

      success++;

      if (i % 50 === 0) {
        console.log(`Progress: ${i}/${TOTAL}`);
      }
    } catch (err) {
      fail++;
      console.error(`Error creating account ${i}:`, err.response?.data || err.message);
    }
  }

  console.log('========================================');
  console.log('Create accounts finished');
  console.log(`Success: ${success}`);
  console.log(`Fail: ${fail}`);
  console.log('========================================');
}

main();
