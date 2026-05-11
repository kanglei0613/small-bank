import axios from 'axios'
import type {
  HealthResponse,
  GlobalQueueStats,
  Account,
  Transfer,
  TransferSubmitResult,
  TransferJob,
  ApiResponse,
} from '@/types'

const generalApi = axios.create({ baseURL: '/api' })
const transferApi = axios.create({ baseURL: '/transfer-api' })

// ── 系統 ───────────────────────────────────────────────

export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await generalApi.get<HealthResponse>('/health')
  return data
}

export async function fetchGlobalQueueStats(): Promise<GlobalQueueStats> {
  const { data } = await generalApi.get<ApiResponse<GlobalQueueStats>>('/queue/global-stats')
  return data.data
}

// ── 帳號 ───────────────────────────────────────────────

export async function fetchAccount(accountId: number): Promise<Account> {
  const { data } = await generalApi.get<ApiResponse<Account>>(`/accounts/${accountId}`)
  return data.data
}

// ── 轉帳紀錄 ──────────────────────────────────────────

export async function fetchTransfers(accountId: number, limit = 50): Promise<Transfer[]> {
  const { data } = await generalApi.get<ApiResponse<{ items: Transfer[] }>>('/transfers', {
    params: { accountId, limit },
  })
  const items = data.data.items ?? []
  // pg driver 對 bigint 欄位回傳字串，強制轉 number 確保 === 比較正確
  return items.map(t => ({
    ...t,
    id:              Number(t.id),
    from_account_id: Number(t.from_account_id),
    to_account_id:   Number(t.to_account_id),
    amount:          Number(t.amount),
    mode: (Number(t.from_account_id) % 4 === Number(t.to_account_id) % 4) ? 'sync' : 'async',
  }))
}

// ── 轉帳操作 ──────────────────────────────────────────

export async function submitTransfer(payload: {
  fromId: number
  toId: number
  amount: number
}): Promise<TransferSubmitResult> {
  const { data } = await transferApi.post<ApiResponse<TransferSubmitResult>>('/transfers', payload)
  return data.data
}

// ── 轉帳 Job（異步狀態查詢）─────────────────────────

export async function fetchTransferJob(jobId: string): Promise<TransferJob> {
  const { data } = await generalApi.get<ApiResponse<TransferJob>>(`/transfer-jobs/${jobId}`)
  return data.data
}

// ── 存提款 ────────────────────────────────────────────

export async function deposit(accountId: number, amount: number): Promise<void> {
  await generalApi.post(`/accounts/${accountId}/deposit`, { amount })
}

export async function withdraw(accountId: number, amount: number): Promise<void> {
  await generalApi.post(`/accounts/${accountId}/withdraw`, { amount })
}
