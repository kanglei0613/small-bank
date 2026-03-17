import React, { useState, useMemo } from "react";

const GENERAL_API = "http://127.0.0.1:7001";
const TRANSFER_API = "http://127.0.0.1:7010";

async function request(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }

  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMoney(v) {
  return new Intl.NumberFormat("zh-TW").format(Number(v || 0));
}

export default function App() {
  const [userName, setUserName] = useState("");
  const [userId, setUserId] = useState("");

  const [accountUserId, setAccountUserId] = useState("");
  const [initialBalance, setInitialBalance] = useState("");
  const [accountId, setAccountId] = useState("");
  const [account, setAccount] = useState(null);

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");

  const [historyId, setHistoryId] = useState("");
  const [history, setHistory] = useState([]);

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState("");

  const status = useMemo(() => {
    if (!result) return null;
    return result.status;
  }, [result]);

  async function createUser() {
    setLoading("user");

    try {
      const res = await request(`${GENERAL_API}/users`, {
        method: "POST",
        body: JSON.stringify({ name: userName }),
      });

      const newUser = res?.data;

      setUserId(String(newUser?.id || ""));

      setResult({
        status: "success",
        msg: `使用者建立成功：${newUser?.name || userName}（使用者編號：${newUser?.id}）`,
      });
    } catch (e) {
      setResult({
        status: "error",
        msg: `建立使用者失敗：${e.message}`,
      });
    } finally {
      setLoading("");
    }
  }

  async function getUser() {
    setLoading("user");

    try {
      const res = await request(`${GENERAL_API}/users/${userId}`);

      const user = res?.data;

      setResult({
      status: "success",
      msg: `查詢使用者成功

  使用者名稱：${user?.name || ""}
  使用者編號：${user?.id || ""}

  帳戶列表：
  ${user?.accounts?.length ? user.accounts.map(id => `- 帳戶 ${id}`).join("\n") : "無帳戶"}`,
      });
    } catch (e) {
      setResult({
        status: "error",
        msg: `查詢使用者失敗：${e.message}`,
      });
  } finally {
    setLoading("");
  }
}

  async function createAccount() {
    setLoading("account");

    try {
      const res = await request(`${GENERAL_API}/accounts`, {
        method: "POST",
        body: JSON.stringify({
          userId: Number(accountUserId),
          initialBalance: Number(initialBalance),
        }),
      });

      setAccount(res?.data || null);
      setAccountId(String(res?.data?.id || ""));

      setResult({
        status: "success",
        msg: `帳戶建立成功：帳戶編號 ${res?.data?.id}`,
      });
    } catch (e) {
      setResult({
        status: "error",
        msg: `建立帳戶失敗：${e.message}`,
      });
    } finally {
      setLoading("");
    }
  }

  async function getAccount() {
    setLoading("account");

    try {
      const res = await request(`${GENERAL_API}/accounts/${accountId}`);

      setAccount(res?.data || null);

      setResult({
        status: "success",
        msg: `查詢帳戶成功：帳戶編號 ${res?.data?.id}`,
      });
    } catch (e) {
      setResult({
        status: "error",
        msg: `查詢帳戶失敗：${e.message}`,
      });
    } finally {
      setLoading("");
    }
  }

  async function transfer() {
    setLoading("transfer");

    try {
      const init = await request(`${TRANSFER_API}/transfers`, {
        method: "POST",
        body: JSON.stringify({
          fromId: Number(fromId),
          toId: Number(toId),
          amount: Number(amount),
        }),
      });

      if (init?.data?.mode === "sync-same-shard") {
        setResult({
          status: "success",
          msg: `轉帳成功（同 shard）：${fromId} → ${toId}，金額 ${formatMoney(amount)}`,
        });

        if (String(accountId) === String(fromId) || String(accountId) === String(toId)) {
          try {
            const refreshed = await request(`${GENERAL_API}/accounts/${accountId}`);
            setAccount(refreshed?.data || null);
          } catch (err) {
            console.error("refresh account failed:", err);
          }
        }

        return;
      }

      const jobId = init?.data?.jobId;

      for (let i = 0; i < 60; i += 1) {
        await sleep(500);

        const r = await request(`${GENERAL_API}/transfer-jobs/${jobId}`);

        if (r?.data?.status === "success") {
          setResult({
            status: "success",
            msg: `轉帳成功（跨 shard）：${fromId} → ${toId}，金額 ${formatMoney(amount)}`,
          });

          if (String(accountId) === String(fromId) || String(accountId) === String(toId)) {
            try {
              const refreshed = await request(`${GENERAL_API}/accounts/${accountId}`);
              setAccount(refreshed?.data || null);
            } catch (err) {
              console.error("refresh account failed:", err);
            }
          }

          return;
        }

        if (r?.data?.status === "failed") {
          throw new Error(r?.data?.error?.message || "轉帳失敗");
        }
      }

      throw new Error("轉帳處理逾時");
    } catch (e) {
      setResult({
        status: "error",
        msg: `轉帳失敗：${e.message}`,
      });
    } finally {
      setLoading("");
    }
  }

  async function fetchHistory() {
    setLoading("history");

    try {
      const res = await request(`${GENERAL_API}/transfers?accountId=${historyId}`);

      setHistory(res?.data?.items || []);

      setResult({
        status: "success",
        msg: `查詢轉帳歷史成功：帳戶編號 ${historyId}`,
      });
    } catch (e) {
      setResult({
        status: "error",
        msg: `查詢轉帳歷史失敗：${e.message}`,
      });
    } finally {
      setLoading("");
    }
  }

  return (
    <div
      style={{
        padding: 30,
        fontFamily: "Arial, sans-serif",
        backgroundColor: "#f5f7fb",
        minHeight: "100vh",
        color: "#1f2937",
      }}
    >
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          backgroundColor: "#ffffff",
          borderRadius: 20,
          boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #0f172a, #1d4ed8)",
            color: "#ffffff",
            padding: 24,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 32 }}>Small Bank 網路銀行</h1>
          <p style={{ marginTop: 8, marginBottom: 0, opacity: 0.9 }}>
            建立使用者、建立帳戶、查詢帳戶、送出轉帳、查詢轉帳歷史
          </p>
        </div>

        <div style={{ padding: 24 }}>
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ marginBottom: 12 }}>使用者服務</h2>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                style={inputStyle}
                placeholder="請輸入使用者名稱（例如：王小明）"
                value={userName}
                onChange={e => setUserName(e.target.value)}
              />
              <button style={buttonStyle} onClick={createUser}>
                {loading === "user" ? "處理中..." : "建立使用者"}
              </button>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <input
                style={inputStyle}
                placeholder="請輸入使用者編號"
                value={userId}
                onChange={e => setUserId(e.target.value)}
              />
              <button style={buttonOutlineStyle} onClick={getUser}>
                {loading === "user" ? "處理中..." : "查詢使用者"}
              </button>
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ marginBottom: 12 }}>帳戶服務</h2>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                style={inputStyle}
                placeholder="請輸入使用者編號"
                value={accountUserId}
                onChange={e => setAccountUserId(e.target.value)}
              />
              <input
                style={inputStyle}
                placeholder="請輸入初始金額"
                value={initialBalance}
                onChange={e => setInitialBalance(e.target.value)}
              />
              <button style={buttonStyle} onClick={createAccount}>
                {loading === "account" ? "處理中..." : "建立帳戶"}
              </button>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <input
                style={inputStyle}
                placeholder="請輸入帳戶編號"
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
              />
              <button style={buttonOutlineStyle} onClick={getAccount}>
                {loading === "account" ? "處理中..." : "查詢帳戶"}
              </button>
            </div>

            {account && (
              <div
                style={{
                  marginTop: 12,
                  padding: 16,
                  borderRadius: 14,
                  background: "linear-gradient(135deg, #111827, #2563eb)",
                  color: "#ffffff",
                }}
              >
                <div style={{ fontSize: 14, opacity: 0.9 }}>帳戶資訊卡</div>
                <div style={{ fontSize: 24, fontWeight: "bold", marginTop: 6 }}>
                  帳戶編號：{account.id}
                </div>
                <div style={{ marginTop: 12 }}>餘額：{formatMoney(account.balance)}</div>
                {account.availableBalance !== undefined && (
                  <div style={{ marginTop: 6 }}>
                    可用餘額：{formatMoney(account.availableBalance)}
                  </div>
                )}
                {account.reservedBalance !== undefined && (
                  <div style={{ marginTop: 6 }}>
                    保留金額：{formatMoney(account.reservedBalance)}
                  </div>
                )}
                {account.totalBalance !== undefined && (
                  <div style={{ marginTop: 6 }}>
                    總餘額：{formatMoney(account.totalBalance)}
                  </div>
                )}
              </div>
            )}
          </section>

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ marginBottom: 12 }}>轉帳服務</h2>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div>
                <div style={labelStyle}>轉出帳戶</div>
                <input
                  style={inputStyle}
                  placeholder="請輸入轉出帳戶編號"
                  value={fromId}
                  onChange={e => setFromId(e.target.value)}
                />
              </div>

              <div>
                <div style={labelStyle}>轉入帳戶</div>
                <input
                  style={inputStyle}
                  placeholder="請輸入轉入帳戶編號"
                  value={toId}
                  onChange={e => setToId(e.target.value)}
                />
              </div>

              <div>
                <div style={labelStyle}>轉帳金額</div>
                <input
                  style={inputStyle}
                  placeholder="請輸入金額（例如：100）"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", alignItems: "end" }}>
                <button style={transferButtonStyle} onClick={transfer}>
                  {loading === "transfer" ? "處理中..." : "送出轉帳"}
                </button>
              </div>
            </div>

            <div style={{ fontSize: 13, color: "#6b7280" }}>
              若為跨 shard 交易，前端會自動等待後端完成，不會顯示 jobId，只會顯示最終結果。
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ marginBottom: 12 }}>轉帳歷史查詢</h2>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <div>
                <div style={labelStyle}>帳戶編號</div>
                <input
                  style={inputStyle}
                  placeholder="請輸入要查詢的帳戶編號（例如：1）"
                  value={historyId}
                  onChange={e => setHistoryId(e.target.value)}
                />
              </div>

              <div style={{ display: "flex", alignItems: "end" }}>
                <button style={buttonOutlineStyle} onClick={fetchHistory}>
                  {loading === "history" ? "查詢中..." : "查詢轉帳歷史"}
                </button>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                overflow: "hidden",
                backgroundColor: "#ffffff",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ backgroundColor: "#f9fafb" }}>
                    <th style={thStyle}>交易編號</th>
                    <th style={thStyle}>轉出帳戶</th>
                    <th style={thStyle}>轉入帳戶</th>
                    <th style={thStyle}>金額</th>
                    <th style={thStyle}>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr>
                      <td style={tdEmptyStyle} colSpan={5}>
                        尚無轉帳紀錄
                      </td>
                    </tr>
                  ) : (
                    history.map(h => (
                      <tr key={h.id}>
                        <td style={tdStyle}>{h.id}</td>
                        <td style={tdStyle}>{h.fromId}</td>
                        <td style={tdStyle}>{h.toId}</td>
                        <td style={tdStyle}>{formatMoney(h.amount)}</td>
                        <td style={tdStyle}>{h.status}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {result && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <div
              style={{
                fontSize: 20,
                fontWeight: "bold",
                marginBottom: 12,
                color: status === "error" ? "#b91c1c" : "#166534",
              }}
            >
              {status === "error" ? "操作失敗" : "操作成功"}
            </div>
            
            <div style={modalContentStyle}>
              {result.msg}
            </div>

            <div
              style={{
                fontSize: 15,
                lineHeight: 1.7,
                color: "#374151",
                marginBottom: 20,
                whiteSpace: "pre-wrap",
              }}
            >
              {result.msg}
            </div>

            <div style={{ display: "flex", justifyContent: "center" }}>
              <button
                style={modalButtonStyle}
                onClick={() => setResult(null)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = {
  fontSize: 13,
  marginBottom: 6,
  color: "#374151",
  fontWeight: 500,
};

const inputStyle = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  minWidth: 220,
  fontSize: 14,
};

const buttonStyle = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "none",
  backgroundColor: "#111827",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: 14,
};

const buttonOutlineStyle = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "1px solid #cbd5e1",
  backgroundColor: "#ffffff",
  color: "#111827",
  cursor: "pointer",
  fontSize: 14,
};

const transferButtonStyle = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "none",
  backgroundColor: "#2563eb",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: 14,
};

const thStyle = {
  textAlign: "left",
  padding: "12px 14px",
  borderBottom: "1px solid #e5e7eb",
  fontSize: 14,
};

const tdStyle = {
  padding: "12px 14px",
  borderBottom: "1px solid #f3f4f6",
  fontSize: 14,
};

const tdEmptyStyle = {
  padding: "24px 14px",
  textAlign: "center",
  color: "#9ca3af",
  fontSize: 14,
};

const modalOverlayStyle = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const modalBoxStyle = {
  width: "90%",
  maxWidth: 420,
  backgroundColor: "#ffffff",
  borderRadius: 16,
  boxShadow: "0 20px 50px rgba(0, 0, 0, 0.18)",
  padding: 24,
  textAlign: "center",
};

const modalButtonStyle = {
  padding: "10px 28px",
  borderRadius: 10,
  border: "none",
  backgroundColor: "#2563eb",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

const modalContentStyle = {
  fontSize: 15,
  lineHeight: 1.7,
  color: "#374151",
  marginBottom: 20,
  whiteSpace: "pre-wrap",
  overflowY: "auto",
  maxHeight: "50vh",
  paddingRight: 6,
};

