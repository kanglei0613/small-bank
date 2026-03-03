Small Bank (Node.js / Egg.js + PostgreSQL)

專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 Node.js + Egg.js + PostgreSQL 實作，重點在：
	- RESTful API 設計  
	- 高併發下資料一致性處理  
	- 帳戶餘額正確性保證  
	- 轉帳操作的併發安全控制  
	- Transaction + Row-level Lock 實作  

⸻

功能實作

1. 使用者（User)  
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

壓測結果（Benchmark）

本專案使用 autocannon 進行壓力測試，測試環境為：  
	•	MacBook Air (M-series)  
	•	Node.js v20  
	•	PostgreSQL 16  
	•	單 worker（未開啟 cluster）  

⸻

Health API（不經資料庫）

測試指令：
```bash
autocannon -c 200 -d 15 http://127.0.0.1:7001/health
```

測試結果：  
	•	約 26,900 RPS  
	•	平均延遲：約 6.9ms  

說明：  
	•	此 API 不存取資料庫  
	•	可視為 Node/Egg.js 本身的極限吞吐能力  
	•	證明應用層並非主要瓶頸  

⸻

熱點帳戶轉帳（高鎖競爭）

測試情境：  
	•	所有請求集中於兩個帳戶間互轉

測試結果：  
	•	約 1,800 RPS  
	•	平均延遲：約 55ms  

說明：  
	•	由於 row-level lock 競爭集中於相同帳戶  
	•	所有交易需序列化執行  
	•	PostgreSQL transaction 成為瓶頸  

⸻

多帳戶隨機轉帳（分散鎖競爭）

測試情境：  
	•	多帳戶隨機互轉  
	•	分散 row-level lock 競爭  

測試結果：  
	•	約 5,200 RPS  
	•	平均延遲：約 38ms  
	•	0 error  

說明：  
	•	分散鎖競爭後吞吐量顯著提升  
	•	證明 bottleneck 來自 lock contention  
	•	資料庫 WAL 與 transaction commit 為主要成本  

⸻

效能觀察  
	•	應用層最大可達 ~27k RPS  
	•	真正瓶頸在 PostgreSQL transaction + lock contention  
	•	單機單 worker 約可穩定達 5k RPS  
	•	若啟用 cluster + DB tuning，理論上可進一步提升  

Author: kanglei0613
