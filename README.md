Small Bank (Node.js / Egg.js + PostgreSQL)

專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 Node.js + Egg.js + PostgreSQL 實作，重點在：
	•	RESTful API 設計
	•	高併發下資料一致性處理
	•	帳戶餘額正確性保證
	•	轉帳操作的併發安全控制
	•	Transaction + Row-level Lock 實作

⸻

功能實作

1. 使用者（User）
	•	POST /users 建立使用者
	•	GET /users/:id 查詢使用者

⸻

2. 帳戶（Account）
	•	POST /accounts 建立帳戶
	•	GET /accounts/:id 查詢帳戶餘額

帳戶餘額不可直接修改，必須透過交易（transfer）改變。

⸻

3. 轉帳（Transfer）
	•	POST /transfers 進行帳戶間轉帳

轉帳特性：
	•	檢查餘額是否足夠
	•	使用 PostgreSQL Transaction
	•	使用 SELECT ... FOR UPDATE 進行 row-level locking
	•	固定順序上鎖避免 deadlock
	•	同時寫入 transfers 交易紀錄表

⸻

API 使用範例

建立使用者
```bash
curl -X POST http://127.0.0.1:7001/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

⸻

建立帳戶
```bash
curl -X POST http://127.0.0.1:7001/accounts \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"initialBalance":100}'
```

⸻

轉帳
```bash
curl -X POST http://127.0.0.1:7001/transfers \
  -H "Content-Type: application/json" \
  -d '{"fromId":1,"toId":2,"amount":30}'
```

⸻

執行方式

安裝套件
```bash
npm install
```

啟動 PostgreSQL（macOS）
```bash
brew services start postgresql@16
```

啟動開發模式
```bash
npm run dev
```

預設執行於：
```text
http://127.0.0.1:7001
```

⸻

高併發設計說明

Transaction + Row-Level Lock

每筆轉帳流程：
	1.	開啟資料庫 transaction
	2.	依 accountId 排序後加鎖（避免死鎖）
	3.	使用 SELECT ... FOR UPDATE 鎖定帳戶
	4.	檢查餘額
	5.	更新餘額
	6.	寫入 transfers 紀錄
	7.	Commit

⸻

為何需要固定順序上鎖？

若兩筆轉帳同時執行：
	•	A：1 → 2
	•	B：2 → 1

若未排序，可能發生：
	•	A 鎖 1 等 2
	•	B 鎖 2 等 1

造成 deadlock。

透過排序（先鎖較小 id），可避免交叉等待。

⸻

設計說明

為何不能直接修改餘額？

銀行系統中餘額不應直接透過 UPDATE 操作改變，而應透過交易（transaction）改變。

優點：
	•	保證交易可追溯性
	•	避免資料被任意覆寫
	•	確保帳務一致性
	•	保證 ACID 特性

⸻

Author: kanglei0613
