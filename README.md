# Small Bank (Node.js / Egg.js)

## 專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 **Node.js + Egg.js** 實作，重點在：

- RESTful API 設計
- 高併發下資料一致性處理
- 帳戶餘額正確性保證
- 轉帳操作的併發安全控制

---

## 功能實作

### 1. 使用者（User）

- `POST /users` 建立使用者
- `GET /users/:id` 查詢使用者

### 2. 帳戶（Account）

- `POST /accounts` 建立帳戶
- `GET /accounts/:id` 查詢帳戶餘額

帳戶餘額不可直接修改，必須透過交易（transfer）改變。

### 3. 轉帳（Transfer）

- `POST /transfers` 進行帳戶間轉帳

轉帳特性：

- 檢查餘額是否足夠
- 使用 per-account locking 保證併發安全
- 固定順序上鎖避免 deadlock

---

## API 使用範例

### 建立使用者

```bash
curl -X POST http://127.0.0.1:7001/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

---

### 建立帳戶

```bash
curl -X POST http://127.0.0.1:7001/accounts \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"initialBalance":100}'
```

---

### 轉帳

```bash
curl -X POST http://127.0.0.1:7001/transfers \
  -H "Content-Type: application/json" \
  -d '{"fromAccountId":1,"toAccountId":2,"amount":30}'
```

---

## 執行方式

### 安裝套件

```bash
npm install
```

### 啟動開發模式

```bash
npm run dev
```

預設執行於：

```
http://127.0.0.1:7001
```

---

## 高併發設計說明

### 鎖機制（Per-Account Lock）

- 每個帳戶修改前需取得鎖
- 同一帳戶不可同時被兩個轉帳修改

### Deadlock 預防

- 依 accountId 排序後再上鎖
- 避免交叉等待

---

## 設計說明

### 為何不能直接修改餘額？

銀行系統中餘額不應直接透過 Update 操作改變，而應透過交易（transaction）改變。

優點：

- 保證交易可追溯性
- 避免資料被任意覆寫
- 確保帳務一致性