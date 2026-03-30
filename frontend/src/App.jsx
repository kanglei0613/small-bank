import React, { useState, useCallback } from "react";

const GENERAL_API = "http://127.0.0.1:7001";
const TRANSFER_API = "http://127.0.0.1:7010";

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

function formatMoney(v) {
  return new Intl.NumberFormat("zh-TW").format(Number(v || 0));
}

function formatDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-TW", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_LABEL = {
  COMPLETED: "完成",
  RESERVED:  "預留",
  FAILED:    "失敗",
  PENDING:   "處理中",
};

const STATUS_COLOR = {
  COMPLETED: "#16a34a",
  RESERVED:  "#d97706",
  FAILED:    "#dc2626",
  PENDING:   "#6366f1",
};

// ─── CopyBtn ──────────────────────────────────────────────
function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(String(value)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button onClick={handleCopy} style={{
      padding: "2px 10px",
      borderRadius: 6,
      border: "1px solid #d1d5db",
      background: copied ? "#f0fdf4" : "#f9fafb",
      color: copied ? "#16a34a" : "#6b7280",
      fontSize: 12,
      cursor: "pointer",
      fontWeight: 500,
      transition: "all 0.15s",
      whiteSpace: "nowrap",
    }}>
      {copied ? "已複製" : "複製"}
    </button>
  );
}

// ─── ResultModal ──────────────────────────────────────────
// 通用彈出式結果視窗，支援滑動、底部確定按鈕
function ResultModal({ modal, onClose }) {
  if (!modal) return null;
  const isError = modal.type === "error";
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(15,23,42,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9998,
      padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 18,
        width: "100%", maxWidth: 400,
        maxHeight: "80vh",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* 標題 */}
        <div style={{
          padding: "20px 22px 14px",
          borderBottom: "1px solid #f3f4f6",
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 17, fontWeight: 700,
            color: isError ? "#991b1b" : "#111827",
          }}>
            {isError ? "操作失敗" : modal.title || "操作成功"}
          </div>
        </div>

        {/* 內容（可滑動） */}
        <div style={{
          padding: "16px 22px",
          overflowY: "auto",
          flex: 1,
          fontSize: 14,
          color: "#374151",
          lineHeight: 1.7,
        }}>
          {modal.content}
        </div>

        {/* 底部確定按鈕 */}
        <div style={{
          padding: "14px 22px",
          borderTop: "1px solid #f3f4f6",
          flexShrink: 0,
        }}>
          <button onClick={onClose} style={{
            width: "100%", padding: "11px 0",
            background: isError ? "#dc2626" : "#2563eb",
            color: "#fff", border: "none",
            borderRadius: 10, fontSize: 15, fontWeight: 600,
            cursor: "pointer",
          }}>確定</button>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 10 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === "error" ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${t.type === "error" ? "#fca5a5" : "#86efac"}`,
          color: t.type === "error" ? "#991b1b" : "#166534",
          padding: "12px 18px",
          borderRadius: 12,
          fontSize: 14,
          maxWidth: 340,
          boxShadow: "0 4px 20px rgba(0,0,0,0.10)",
          animation: "slideIn 0.2s ease",
        }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────
function Card({ title, children, accent }) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 16,
      boxShadow: "0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)",
      overflow: "hidden",
      marginBottom: 20,
    }}>
      {title && (
        <div style={{
          padding: "14px 20px",
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}>
          {accent && <span style={{ width: 4, height: 18, background: accent, borderRadius: 2, display: "inline-block" }} />}
          <span style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>{title}</span>
        </div>
      )}
      <div style={{ padding: "16px 20px" }}>{children}</div>
    </div>
  );
}

// ─── Input ────────────────────────────────────────────────
function Input({ label, ...props }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 160 }}>
      {label && <label style={{ fontSize: 12, fontWeight: 500, color: "#6b7280" }}>{label}</label>}
      <input style={{
        padding: "9px 13px",
        borderRadius: 9,
        border: "1.5px solid #e5e7eb",
        fontSize: 14,
        color: "#111827",
        outline: "none",
        transition: "border 0.15s",
        background: "#fafafa",
        width: "100%",
        boxSizing: "border-box",
      }}
        onFocus={e => e.target.style.border = "1.5px solid #2563eb"}
        onBlur={e => e.target.style.border = "1.5px solid #e5e7eb"}
        {...props}
      />
    </div>
  );
}

// ─── Button ───────────────────────────────────────────────
function Btn({ children, variant = "primary", loading, ...props }) {
  const styles = {
    primary: { background: "#111827", color: "#fff", border: "none" },
    blue:    { background: "#2563eb", color: "#fff", border: "none" },
    outline: { background: "#fff", color: "#374151", border: "1.5px solid #e5e7eb" },
    green:   { background: "#16a34a", color: "#fff", border: "none" },
    danger:  { background: "#dc2626", color: "#fff", border: "none" },
  };
  return (
    <button
      disabled={loading}
      style={{
        padding: "9px 18px",
        borderRadius: 9,
        fontSize: 14,
        fontWeight: 500,
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.65 : 1,
        transition: "opacity 0.15s, transform 0.1s",
        whiteSpace: "nowrap",
        ...styles[variant],
      }}
      onMouseDown={e => !loading && (e.currentTarget.style.transform = "scale(0.97)")}
      onMouseUp={e => (e.currentTarget.style.transform = "scale(1)")}
      {...props}
    >
      {loading ? "處理中..." : children}
    </button>
  );
}

// ─── InfoRow ──────────────────────────────────────────────
function InfoRow({ label, value, copy }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #f3f4f6" }}>
      <span style={{ fontSize: 13, color: "#6b7280" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: "#111827" }}>{value}</span>
        {copy && <CopyBtn value={value} />}
      </div>
    </div>
  );
}

// ─── Account Card ─────────────────────────────────────────
function AccountCard({ account }) {
  if (!account) return null;
  return (
    <div style={{
      marginTop: 14,
      background: "linear-gradient(135deg, #0f172a 0%, #1e40af 100%)",
      borderRadius: 14,
      padding: "20px 22px",
      color: "#fff",
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: -30, right: -30,
        width: 120, height: 120,
        background: "rgba(255,255,255,0.04)",
        borderRadius: "50%",
      }} />
      <div style={{ fontSize: 11, opacity: 0.6, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>
        帳戶編號 · {account.id}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5, marginBottom: 14, fontVariantNumeric: "tabular-nums" }}>
        NT$ {formatMoney(account.balance)}
      </div>
      <div style={{ display: "flex", gap: 20, fontSize: 12, opacity: 0.75 }}>
        <div>
          <div style={{ marginBottom: 2 }}>可用餘額</div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>NT$ {formatMoney(account.availableBalance)}</div>
        </div>
        {account.reservedBalance > 0 && (
          <div>
            <div style={{ marginBottom: 2 }}>預留金額</div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#fbbf24" }}>NT$ {formatMoney(account.reservedBalance)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Transfer Row ─────────────────────────────────────────
function TransferRow({ item, currentAccountId }) {
  const isOut = String(item.fromId) === String(currentAccountId);
  return (
    <div style={{
      display: "flex", alignItems: "center",
      padding: "12px 0",
      borderBottom: "1px solid #f9fafb",
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: isOut ? "#fef2f2" : "#f0fdf4",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, marginRight: 12, flexShrink: 0,
      }}>
        {isOut ? "↑" : "↓"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "#111827" }}>
          {isOut ? `轉出至 ${item.toId}` : `轉入自 ${item.fromId}`}
        </div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
          #{item.id} · {formatDate(item.createdAt)}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{
          fontSize: 15, fontWeight: 600,
          color: isOut ? "#dc2626" : "#16a34a",
          fontVariantNumeric: "tabular-nums",
        }}>
          {isOut ? "-" : "+"}NT$ {formatMoney(item.amount)}
        </div>
        <div style={{ fontSize: 11, color: STATUS_COLOR[item.status] || "#6b7280", marginTop: 2 }}>
          {STATUS_LABEL[item.status] || item.status}
        </div>
      </div>
    </div>
  );
}

// ─── Transfer Progress Modal ──────────────────────────────
function TransferModal({ state, onClose }) {
  if (!state) return null;
  const isDone = state.status === "success" || state.status === "failed";
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(15,23,42,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999, padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 18,
        width: "100%", maxWidth: 400,
        maxHeight: "80vh",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{ padding: "24px 24px 16px", overflowY: "auto", flex: 1, textAlign: "center" }}>
          {!isDone && (
            <>
              <div style={{
                width: 48, height: 48,
                border: "4px solid #e5e7eb",
                borderTop: "4px solid #2563eb",
                borderRadius: "50%",
                margin: "0 auto 14px",
                animation: "spin 0.8s linear infinite",
              }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: "#111827" }}>轉帳處理中</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
                NT$ {formatMoney(state.amount)} &nbsp;{state.fromId} → {state.toId}
              </div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 10 }}>
                正在處理...
              </div>
            </>
          )}
          {state.status === "success" && (
            <>
              <div style={{ fontSize: 40, marginBottom: 10 }}>✓</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 6 }}>轉帳成功</div>
              <div style={{ fontSize: 14, color: "#374151", marginBottom: 6 }}>
                NT$ {formatMoney(state.amount)} &nbsp;{state.fromId} → {state.toId}
              </div>
              {state.balance != null && (
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  轉出帳戶餘額：NT$ {formatMoney(state.balance)}
                </div>
              )}
            </>
          )}
          {state.status === "failed" && (
            <>
              <div style={{ fontSize: 40, marginBottom: 10 }}>✕</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#991b1b", marginBottom: 6 }}>轉帳失敗</div>
              <div style={{ fontSize: 14, color: "#6b7280" }}>{state.errorMsg || "請稍後再試"}</div>
            </>
          )}
        </div>
        {isDone && (
          <div style={{ padding: "14px 24px", borderTop: "1px solid #f3f4f6", flexShrink: 0 }}>
            <button onClick={onClose} style={{
              width: "100%", padding: "11px 0",
              background: state.status === "success" ? "#2563eb" : "#dc2626",
              color: "#fff", border: "none",
              borderRadius: 10, fontSize: 15, fontWeight: 600,
              cursor: "pointer",
            }}>確定</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Nav Tab ──────────────────────────────────────────────
function NavTab({ tabs, active, onChange }) {
  return (
    <div style={{
      display: "flex", gap: 4,
      background: "#f3f4f6", borderRadius: 10,
      padding: 4, marginBottom: 20,
    }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          flex: 1, padding: "8px 0",
          borderRadius: 8, border: "none",
          fontSize: 14, fontWeight: active === t.key ? 600 : 400,
          background: active === t.key ? "#fff" : "transparent",
          color: active === t.key ? "#111827" : "#6b7280",
          cursor: "pointer",
          boxShadow: active === t.key ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
          transition: "all 0.15s",
        }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("account");
  const [toasts, setToasts] = useState([]);
  const [resultModal, setResultModal] = useState(null);

  // User
  const [userName, setUserName] = useState("");
  const [userId, setUserId] = useState("");
  const [userInfo, setUserInfo] = useState(null);

  // Account
  const [accountUserId, setAccountUserId] = useState("");
  const [initialBalance, setInitialBalance] = useState("");
  const [accountId, setAccountId] = useState("");
  const [account, setAccount] = useState(null);

  // Deposit / Withdraw
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  // Transfer
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [transferModal, setTransferModal] = useState(null);

  // History
  const [historyId, setHistoryId] = useState("");
  const [history, setHistory] = useState([]);

  const [loading, setLoading] = useState("");

  const toast = useCallback((msg, type = "success") => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const showResult = useCallback((title, content, type = "success") => {
    setResultModal({ title, content, type });
  }, []);

  // ── User actions ──
  async function createUser() {
    if (!userName.trim()) return toast("請輸入使用者名稱", "error");
    setLoading("createUser");
    try {
      const res = await request(`${GENERAL_API}/users`, {
        method: "POST",
        body: JSON.stringify({ name: userName.trim() }),
      });
      const u = res?.data;
      setUserId(String(u?.id || ""));
      setUserInfo(u);
      showResult("建立使用者成功", (
        <div>
          <InfoRow label="名稱" value={u?.name} />
          <InfoRow label="使用者編號" value={u?.id} copy />
        </div>
      ));
    } catch (e) {
      showResult("建立使用者失敗", <div style={{ color: "#6b7280" }}>{e.message}</div>, "error");
    } finally {
      setLoading("");
    }
  }

  async function getUser() {
    if (!userId.trim()) return toast("請輸入使用者編號", "error");
    setLoading("getUser");
    try {
      const res = await request(`${GENERAL_API}/users/${userId.trim()}`);
      const u = res?.data;
      setUserInfo(u);
      showResult("使用者資訊", (
        <div>
          <InfoRow label="名稱" value={u?.name} />
          <InfoRow label="使用者編號" value={u?.id} copy />
          <div style={{ marginTop: 12, fontSize: 13, color: "#6b7280", marginBottom: 6 }}>帳戶列表</div>
          {u?.accounts?.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {u.accounts.map(aid => (
                <span key={aid}
                  onClick={() => { setAccountId(String(aid)); setTab("account"); setResultModal(null); }}
                  style={{
                    padding: "3px 10px", background: "#e0e7ff",
                    color: "#3730a3", borderRadius: 20,
                    fontSize: 12, fontWeight: 500, cursor: "pointer",
                  }}>
                  帳戶 {aid}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ color: "#9ca3af", fontSize: 13 }}>無帳戶</div>
          )}
        </div>
      ));
    } catch (e) {
      showResult("查詢失敗", <div style={{ color: "#6b7280" }}>{e.message}</div>, "error");
    } finally {
      setLoading("");
    }
  }

  // ── Account actions ──
  async function createAccount() {
    if (!accountUserId) return toast("請輸入使用者編號", "error");
    setLoading("createAccount");
    try {
      const res = await request(`${GENERAL_API}/accounts`, {
        method: "POST",
        body: JSON.stringify({
          userId: Number(accountUserId),
          initialBalance: Number(initialBalance || 0),
        }),
      });
      const a = res?.data;
      setAccount(a);
      setAccountId(String(a?.id || ""));
      showResult("開立帳戶成功", (
        <div>
          <InfoRow label="帳戶編號" value={a?.id} copy />
          <InfoRow label="初始餘額" value={`NT$ ${formatMoney(a?.balance)}`} />
        </div>
      ));
    } catch (e) {
      showResult("開立帳戶失敗", <div style={{ color: "#6b7280" }}>{e.message}</div>, "error");
    } finally {
      setLoading("");
    }
  }

  async function getAccount() {
    if (!accountId.trim()) return toast("請輸入帳戶編號", "error");
    setLoading("getAccount");
    try {
      const res = await request(`${GENERAL_API}/accounts/${accountId.trim()}`);
      setAccount(res?.data);
      toast("帳戶資訊已更新");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setLoading("");
    }
  }

  // ── Deposit ──
  async function doDeposit() {
    if (!accountId.trim()) return toast("請先查詢帳戶", "error");
    const amt = Number(depositAmount);
    if (!Number.isInteger(amt) || amt <= 0) return toast("金額必須為正整數", "error");
    setLoading("deposit");
    try {
      const res = await request(`${GENERAL_API}/accounts/${accountId.trim()}/deposit`, {
        method: "POST",
        body: JSON.stringify({ amount: amt }),
      });
      const a = res?.data?.account;
      setAccount(prev => prev ? { ...prev, ...a } : a);
      showResult("存款成功", (
        <div>
          <InfoRow label="帳戶編號" value={accountId} copy />
          <InfoRow label="存入金額" value={`NT$ ${formatMoney(amt)}`} />
          <InfoRow label="目前餘額" value={`NT$ ${formatMoney(a?.balance)}`} />
          <InfoRow label="可用餘額" value={`NT$ ${formatMoney(a?.availableBalance)}`} />
        </div>
      ));
      setDepositAmount("");
    } catch (e) {
      showResult("存款失敗", <div style={{ color: "#6b7280" }}>{e.message}</div>, "error");
    } finally {
      setLoading("");
    }
  }

  // ── Withdraw ──
  async function doWithdraw() {
    if (!accountId.trim()) return toast("請先查詢帳戶", "error");
    const amt = Number(withdrawAmount);
    if (!Number.isInteger(amt) || amt <= 0) return toast("金額必須為正整數", "error");
    setLoading("withdraw");
    try {
      const res = await request(`${GENERAL_API}/accounts/${accountId.trim()}/withdraw`, {
        method: "POST",
        body: JSON.stringify({ amount: amt }),
      });
      const a = res?.data?.account;
      setAccount(prev => prev ? { ...prev, ...a } : a);
      showResult("提款成功", (
        <div>
          <InfoRow label="帳戶編號" value={accountId} copy />
          <InfoRow label="提取金額" value={`NT$ ${formatMoney(amt)}`} />
          <InfoRow label="目前餘額" value={`NT$ ${formatMoney(a?.balance)}`} />
          <InfoRow label="可用餘額" value={`NT$ ${formatMoney(a?.availableBalance)}`} />
        </div>
      ));
      setWithdrawAmount("");
    } catch (e) {
      showResult("提款失敗", <div style={{ color: "#6b7280" }}>{e.message}</div>, "error");
    } finally {
      setLoading("");
    }
  }

  // ── Transfer ──
  async function doTransfer() {
    if (!fromId || !toId || !amount) return toast("請填寫完整轉帳資訊", "error");
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) return toast("金額必須為正整數", "error");

    setTransferModal({ status: "pending", fromId, toId, amount: amt });

    try {
      const init = await request(`${TRANSFER_API}/transfers`, {
        method: "POST",
        body: JSON.stringify({ fromId: Number(fromId), toId: Number(toId), amount: amt }),
      });

      // 同 shard：直接回結果
      if (init?.data?.mode === "sync") {
        const balance = init?.data?.balance?.balance;
        setTransferModal({ status: "success", fromId, toId, amount: amt, balance });
        if (String(accountId) === String(fromId) || String(accountId) === String(toId)) {
          request(`${GENERAL_API}/accounts/${accountId}`)
            .then(res => setAccount(res?.data || null))
            .catch(() => {});
        }
        return;
      }

      // 跨 shard：積極輪詢 + SSE 並行，誰先到誰算
      //
      // 設計重點：
      // - jobId 拿到後立即開始輪詢，不等任何 timer
      // - 輪詢間隔從 80ms 指數退避到 500ms，避免 server 壓力
      // - SSE 作為加速路徑，若後端推送更快則優先
      // - 任一路徑先 settle 後，另一路徑自動放棄
      const jobId = init?.data?.jobId;
      if (!jobId) throw new Error("未取得 jobId");

      const handleJobResult = job => {
        const balance = job?.result?.balance?.balance;
        setTransferModal({ status: "success", fromId, toId, amount: amt, balance });
        if (String(accountId) === String(fromId) || String(accountId) === String(toId)) {
          request(`${GENERAL_API}/accounts/${accountId}`)
            .then(res => setAccount(res?.data || null))
            .catch(() => {});
        }
      };

      await new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer = null;
        let es = null;

        const settle = fn => {
          if (settled) return;
          settled = true;
          clearTimeout(pollTimer);
          if (es) { es.close(); es = null; }
          fn();
        };

        // 積極輪詢：jobId 拿到後立即執行第一次，間隔指數退避
        const deadline = Date.now() + 30000;
        let pollInterval = 80;

        const poll = async () => {
          if (settled) return;
          try {
            const check = await request(`${GENERAL_API}/transfer-jobs/${jobId}`);
            const job = check?.data;
            if (job?.status === "success") {
              settle(() => { handleJobResult(job); resolve(); });
            } else if (job?.status === "failed") {
              settle(() => reject(new Error(job?.error?.message || "轉帳失敗")));
            } else if (Date.now() < deadline) {
              pollInterval = Math.min(pollInterval * 1.5, 500);
              pollTimer = setTimeout(poll, pollInterval);
            } else {
              settle(() => reject(new Error("轉帳處理逾時，請至紀錄頁確認結果")));
            }
          } catch {
            if (!settled) {
              pollInterval = Math.min(pollInterval * 1.5, 500);
              pollTimer = setTimeout(poll, pollInterval);
            }
          }
        };

        poll();

        // SSE 作為加速路徑：若後端 pub/sub 推送比輪詢更快則優先
        try {
          es = new EventSource(`${GENERAL_API}/transfer-jobs/${jobId}/stream`);

          es.onmessage = e => {
            try {
              const job = JSON.parse(e.data);
              if (job.status === "success") {
                settle(() => { handleJobResult(job); resolve(); });
              } else if (job.status === "failed") {
                settle(() => reject(new Error(job?.error?.message || "轉帳失敗")));
              }
              // timeout → 繼續靠輪詢，不需特別處理
            } catch {
              // parse error → 繼續靠輪詢
            }
          };

          es.onerror = () => {
            if (es) { es.close(); es = null; }
            // SSE 失敗不 reject，輪詢會繼續接手
          };
        } catch {
          // EventSource 不支援或被擋，只靠輪詢
        }
      });
    } catch (e) {
      setTransferModal(prev => prev ? { ...prev, status: "failed", errorMsg: e.message } : prev);
    }
  }

  // ── History ──
  async function fetchHistory() {
    const id = historyId.trim() || accountId.trim();
    if (!id) return toast("請輸入帳戶編號", "error");
    setLoading("history");
    try {
      const res = await request(`${GENERAL_API}/transfers?accountId=${id}`);
      setHistory(res?.data?.items || []);
      setHistoryId(id);
      if ((res?.data?.items || []).length === 0) toast("此帳戶尚無轉帳紀錄");
      else toast(`載入 ${res.data.items.length} 筆紀錄`);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setLoading("");
    }
  }

  const tabs = [
    { key: "account",  label: "帳戶" },
    { key: "cashier",  label: "存提款" },
    { key: "transfer", label: "轉帳" },
    { key: "history",  label: "紀錄" },
    { key: "user",     label: "使用者" },
  ];

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f1f5f9; font-family: -apple-system, "PingFang TC", "Helvetica Neue", sans-serif; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        input::placeholder { color: #c4c9d4; }
      `}</style>

      <Toast toasts={toasts} />
      <TransferModal state={transferModal} onClose={() => setTransferModal(null)} />
      <ResultModal modal={resultModal} onClose={() => setResultModal(null)} />

      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)",
        padding: "18px 20px 28px",
        color: "#fff",
      }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ fontSize: 11, opacity: 0.5, letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>
            Small Bank
          </div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>網路銀行</div>
        </div>
      </div>

      {/* Main */}
      <div style={{ maxWidth: 480, margin: "-12px auto 0", padding: "0 16px 40px", position: "relative" }}>

        {/* Tab nav */}
        <div style={{
          background: "#fff",
          borderRadius: 14,
          padding: "14px 14px 0",
          boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
          marginBottom: 16,
        }}>
          <NavTab tabs={tabs} active={tab} onChange={setTab} />
        </div>

        {/* ── 帳戶 ── */}
        {tab === "account" && (
          <>
            <Card title="查詢帳戶" accent="#2563eb">
              <div style={{ display: "flex", gap: 10 }}>
                <Input label="帳戶編號" placeholder="例：33288" value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && getAccount()} />
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <Btn variant="blue" loading={loading === "getAccount"} onClick={getAccount}>查詢</Btn>
                </div>
              </div>
              <AccountCard account={account} />
            </Card>

            <Card title="開立帳戶" accent="#111827">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <Input label="使用者編號" placeholder="例：1" value={accountUserId}
                    onChange={e => setAccountUserId(e.target.value)} />
                  <Input label="初始存款" placeholder="例：10000" value={initialBalance}
                    onChange={e => setInitialBalance(e.target.value)} />
                </div>
                <Btn variant="primary" loading={loading === "createAccount"} onClick={createAccount}>開立帳戶</Btn>
              </div>
            </Card>
          </>
        )}

        {/* ── 存提款 ── */}
        {tab === "cashier" && (
          <>
            <Card title="查詢帳戶" accent="#2563eb">
              <div style={{ display: "flex", gap: 10 }}>
                <Input label="帳戶編號" placeholder="例：33288" value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && getAccount()} />
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <Btn variant="blue" loading={loading === "getAccount"} onClick={getAccount}>查詢</Btn>
                </div>
              </div>
              <AccountCard account={account} />
            </Card>

            {account && (
              <>
                <Card title="存款" accent="#16a34a">
                  <div style={{ display: "flex", gap: 10 }}>
                    <Input label="存款金額（元）" placeholder="例：1000" value={depositAmount}
                      onChange={e => setDepositAmount(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && doDeposit()} />
                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                      <Btn variant="green" loading={loading === "deposit"} onClick={doDeposit}>存款</Btn>
                    </div>
                  </div>
                </Card>

                <Card title="提款" accent="#dc2626">
                  <div style={{ display: "flex", gap: 10 }}>
                    <Input label="提款金額（元）" placeholder="例：500" value={withdrawAmount}
                      onChange={e => setWithdrawAmount(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && doWithdraw()} />
                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                      <Btn variant="danger" loading={loading === "withdraw"} onClick={doWithdraw}>提款</Btn>
                    </div>
                  </div>
                </Card>
              </>
            )}
          </>
        )}

        {/* ── 轉帳 ── */}
        {tab === "transfer" && (
          <Card title="轉帳" accent="#2563eb">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <Input label="轉出帳戶" placeholder="帳戶編號" value={fromId}
                  onChange={e => setFromId(e.target.value)} />
                <Input label="轉入帳戶" placeholder="帳戶編號" value={toId}
                  onChange={e => setToId(e.target.value)} />
              </div>
              <Input label="金額（元）" placeholder="例：100" value={amount}
                onChange={e => setAmount(e.target.value)}
                onKeyDown={e => e.key === "Enter" && doTransfer()} />
              {amount && Number(amount) > 0 && (
                <div style={{
                  padding: "10px 14px",
                  background: "#f0f9ff",
                  borderRadius: 9,
                  fontSize: 13,
                  color: "#0369a1",
                }}>
                  確認轉帳：NT$ {formatMoney(amount)} 從帳戶 {fromId || "?"} 至帳戶 {toId || "?"}
                </div>
              )}
              <Btn variant="blue" onClick={doTransfer}>送出轉帳</Btn>
            </div>
          </Card>
        )}

        {/* ── 紀錄 ── */}
        {tab === "history" && (
          <Card title="轉帳紀錄" accent="#6366f1">
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <Input label="帳戶編號" placeholder="例：33288" value={historyId}
                onChange={e => setHistoryId(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fetchHistory()} />
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <Btn variant="outline" loading={loading === "history"} onClick={fetchHistory}>查詢</Btn>
              </div>
            </div>
            {history.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontSize: 14 }}>
                尚無紀錄
              </div>
            ) : (
              <div>
                {history.map(h => (
                  <TransferRow key={h.id} item={h} currentAccountId={historyId || accountId} />
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── 使用者 ── */}
        {tab === "user" && (
          <>
            <Card title="查詢使用者" accent="#6366f1">
              <div style={{ display: "flex", gap: 10 }}>
                <Input label="使用者編號" placeholder="例：1" value={userId}
                  onChange={e => setUserId(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && getUser()} />
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <Btn variant="outline" loading={loading === "getUser"} onClick={getUser}>查詢</Btn>
                </div>
              </div>
              {userInfo && (
                <div style={{ marginTop: 14, padding: "12px 14px", background: "#f9fafb", borderRadius: 10, fontSize: 14 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{userInfo.name}</div>
                  <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>編號：{userInfo.id}</span>
                    <CopyBtn value={userInfo.id} />
                  </div>
                  {userInfo.accounts?.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {userInfo.accounts.map(aid => (
                        <span key={aid}
                          onClick={() => { setAccountId(String(aid)); setTab("account"); }}
                          style={{
                            padding: "3px 10px", background: "#e0e7ff",
                            color: "#3730a3", borderRadius: 20,
                            fontSize: 12, fontWeight: 500, cursor: "pointer",
                          }}>
                          帳戶 {aid}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card title="新增使用者" accent="#111827">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Input label="使用者名稱" placeholder="例：王小明" value={userName}
                  onChange={e => setUserName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && createUser()} />
                <Btn variant="primary" loading={loading === "createUser"} onClick={createUser}>建立使用者</Btn>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
