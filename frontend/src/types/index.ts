// ── 系統健康 ──────────────────────────────────────────
export interface HealthResponse {
  ok: boolean
  ts: number
}

// ── Queue 統計 ─────────────────────────────────────────
export interface HotAccount {
  fromId: number
  queueLength: number
}

export interface GlobalQueueStats {
  totalQueues: number
  totalJobs: number
  hotAccounts: HotAccount[]
  workers: number
}

// ── 帳號（API 回傳 camelCase）─────────────────────────
export interface Account {
  id: number
  userId: number
  balance: number
  availableBalance: number
  reservedBalance: number
  createdAt: string
  updatedAt?: string
}

// ── 轉帳紀錄（DB 欄位 snake_case）────────────────────
export type TransferStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'RESERVED'
  | 'PENDING_FINALIZE'

export interface Transfer {
  id: number
  from_account_id: number
  to_account_id: number
  amount: number
  status: TransferStatus
  created_at: string
  updated_at?: string
  mode?: 'sync' | 'async'
}

// ── 轉帳 Job（異步 Saga 狀態）────────────────────────
export type TransferJobStatus = 'queued' | 'processing' | 'success' | 'failed'

export interface TransferJob {
  jobId: string
  status: TransferJobStatus
  fromId: number
  toId: number
  amount: number
  createdAt: number
  updatedAt: number
  result: unknown | null
  error: {
    message: string
    status: number | null
    code: string | null
  } | null
}

// ── 轉帳提交結果 ──────────────────────────────────────
export type TransferMode = 'sync' | 'async'

export interface TransferSubmitResult {
  mode: TransferMode
  transferId?: string | number
  jobId?: string
  status: string
}

// ── 即時回饋（前端組合用）────────────────────────────
export type FeedbackStatus = 'pending' | 'polling' | 'success' | 'failed'

export interface TransferFeedback {
  id: string
  fromId: number
  toId: number
  amount: number
  mode: TransferMode
  feedbackStatus: FeedbackStatus
  transferStatus?: TransferStatus
  errorMessage?: string
  submittedAt: number
  completedAt?: number
}

// ── API 通用回應格式 ───────────────────────────────────
export interface ApiResponse<T> {
  ok: boolean
  data: T
}
