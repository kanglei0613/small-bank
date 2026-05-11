<template>
  <div>
    <div class="page-header">
      <h1>💸 轉帳中心</h1>
      <p>提交轉帳、即時追蹤狀態、查詢歷史紀錄</p>
    </div>

    <!-- Top Section: Form + Feedback -->
    <div class="top-section">
      <!-- Submit Form -->
      <div class="card form-card">
        <div class="card-title">提交轉帳</div>

        <div class="field-group">
          <div class="field-label">轉出帳號 (From)</div>
          <el-input-number
            v-model="form.fromId"
            :min="1" :controls="false"
            placeholder="轉出帳號 ID"
            style="width:100%"
            :disabled="submitLoading"
          />
          <span v-if="form.fromId" class="shard-hint">Shard {{ form.fromId % 4 }}</span>
        </div>

        <div class="field-group">
          <div class="field-label">轉入帳號 (To)</div>
          <el-input-number
            v-model="form.toId"
            :min="1" :controls="false"
            placeholder="轉入帳號 ID"
            style="width:100%"
            :disabled="submitLoading"
          />
          <span v-if="form.toId" class="shard-hint">Shard {{ form.toId % 4 }}</span>
        </div>

        <div class="field-group">
          <div class="field-label">金額</div>
          <el-input-number
            v-model="form.amount"
            :min="1" :controls="false"
            placeholder="轉帳金額"
            style="width:100%"
            :disabled="submitLoading"
          />
        </div>

        <!-- Mode Preview -->
        <el-alert
          v-if="form.fromId && form.toId"
          :title="previewMode === 'sync' ? '⚡ 同步模式 (Sync)' : '🔄 非同步模式 (Async)'"
          :description="previewMode === 'sync' ? '同一 Shard，直接完成' : '跨 Shard，需要 Saga 協調'"
          :type="previewMode === 'sync' ? 'success' : 'warning'"
          :closable="false"
          show-icon
          style="margin-bottom: 4px"
        />

        <div v-if="submitError" class="submit-error">{{ submitError }}</div>

        <el-button
          type="primary"
          style="width:100%; height:44px; font-size:15px"
          :loading="submitLoading"
          :disabled="!canSubmit"
          @click="submitTransfer"
        >
          發起轉帳
        </el-button>
      </div>

      <!-- Real-time Feedback -->
      <div class="card feedback-card">
        <div class="card-title" style="justify-content:space-between">
          <span>即時反饋</span>
          <div style="display:flex; gap:8px; align-items:center;">
            <el-tag v-if="feedbacks.length" size="small" type="info">{{ feedbacks.length }} 筆</el-tag>
            <el-button v-if="feedbacks.length" link size="small" @click="clearFeedbacks">清除</el-button>
          </div>
        </div>

        <div v-if="feedbacks.length === 0" class="empty-state">
          <el-empty description="提交轉帳後，即時狀態將在此顯示" :image-size="80" />
        </div>

        <div class="feedback-list">
          <div
            v-for="fb in feedbacks"
            :key="fb.id"
            class="feedback-item"
            :class="`fb-${fb.feedbackStatus}`"
          >
            <div class="fb-icon">
              <span v-if="fb.feedbackStatus === 'polling'">⏳</span>
              <span v-else-if="fb.feedbackStatus === 'success'">✅</span>
              <span v-else-if="fb.feedbackStatus === 'failed'">❌</span>
              <span v-else>⌛</span>
            </div>
            <div class="fb-body">
              <div class="fb-main">
                {{ fb.fromId }} → {{ fb.toId }} ·
                <strong>{{ fb.amount.toLocaleString() }}</strong>
                <el-tag size="small" :type="fb.mode === 'sync' ? 'success' : 'warning'" style="margin-left:6px">
                  {{ fb.mode }}
                </el-tag>
              </div>
              <div class="fb-sub">
                <span :class="`status-text-${fb.feedbackStatus}`">
                  {{ feedbackLabel(fb.feedbackStatus) }}
                  <span v-if="fb.transferStatus"> ({{ fb.transferStatus }})</span>
                </span>
                <span style="margin-left:8px; color:#a0aec0">{{ formatTime(fb.submittedAt) }}</span>
                <span v-if="fb.completedAt" style="margin-left:6px; color:#cbd5e0; font-size:11px">
                  +{{ ((fb.completedAt - fb.submittedAt) / 1000).toFixed(1) }}s
                </span>
              </div>
              <div v-if="fb.errorMessage" class="fb-error">{{ fb.errorMessage }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Records Table -->
    <div class="card">
      <div class="card-title" style="justify-content:space-between; flex-wrap:wrap; gap:12px">
        <span>轉帳紀錄查詢</span>
        <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
          <div>
            <div class="field-label" style="margin-bottom:4px">帳號 ID</div>
            <div style="display:flex; gap:6px;">
              <el-input-number
                v-model="filter.accountId"
                :min="1" :controls="false"
                placeholder="帳號 ID"
                style="width:150px"
                @keyup.enter="loadRecords"
              />
              <el-button type="primary" :loading="recordsLoading" @click="loadRecords">查詢</el-button>
              <el-button @click="clearFilter">清除</el-button>
            </div>
          </div>
          <div>
            <div class="field-label" style="margin-bottom:4px">狀態</div>
            <el-select v-model="filter.status" placeholder="全部" clearable style="width:170px">
              <el-option label="COMPLETED" value="COMPLETED" />
              <el-option label="RESERVED" value="RESERVED" />
              <el-option label="PENDING_FINALIZE" value="PENDING_FINALIZE" />
              <el-option label="FAILED" value="FAILED" />
            </el-select>
          </div>
          <div>
            <div class="field-label" style="margin-bottom:4px">模式</div>
            <el-select v-model="filter.mode" placeholder="全部" clearable style="width:120px">
              <el-option label="sync" value="sync" />
              <el-option label="async" value="async" />
            </el-select>
          </div>
          <div>
            <div class="field-label" style="margin-bottom:4px">排序</div>
            <el-select v-model="filter.order" style="width:120px">
              <el-option label="最新優先" value="newest" />
              <el-option label="最舊優先" value="oldest" />
            </el-select>
          </div>
        </div>
      </div>

      <el-alert v-if="recordsError" :title="recordsError" type="error" show-icon style="margin-bottom:16px" />

      <div v-if="!filter.accountId && !allRecords.length" class="empty-state">
        <el-empty description="輸入帳號 ID 查詢轉帳紀錄" :image-size="80">
          <template #description>
            <p>輸入帳號 ID 查詢轉帳紀錄</p>
            <p style="font-size:12px; color:#a0aec0; margin-top:4px">注意：跨 Shard 的入款紀錄儲存在轉出方的 Shard，在此不會顯示</p>
          </template>
        </el-empty>
      </div>

      <template v-else>
        <div v-if="filteredRecords.length" style="font-size:12px; color:#a0aec0; margin-bottom:10px">
          顯示 {{ filteredRecords.length }} 筆
          <span v-if="filter.status || filter.mode">（已篩選）</span>
        </div>

        <el-table
          :data="filteredRecords"
          style="width:100%"
          stripe
          empty-text="查無符合條件的記錄"
          :row-class-name="rowClass"
        >
          <el-table-column label="ID" prop="id" width="80" />
          <el-table-column label="方向" width="80">
            <template #default="{ row }">
              <el-tag v-if="filter.accountId" size="small"
                :type="row.to_account_id === filter.accountId ? 'success' : 'danger'">
                {{ row.to_account_id === filter.accountId ? '收入' : '轉出' }}
              </el-tag>
              <span v-else class="text-muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="轉出" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="navigateTo(row.from_account_id)">
                #{{ row.from_account_id }}
              </el-button>
              <el-tag size="small" type="info" effect="plain" style="margin-left:4px">S{{ row.from_account_id % 4 }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="轉入" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="navigateTo(row.to_account_id)">
                #{{ row.to_account_id }}
              </el-button>
              <el-tag size="small" type="info" effect="plain" style="margin-left:4px">S{{ row.to_account_id % 4 }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金額" width="120">
            <template #default="{ row }">
              <strong>{{ row.amount.toLocaleString() }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="模式" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.mode === 'sync' ? 'success' : 'warning'" effect="plain">
                {{ row.mode ?? '—' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="狀態" width="170">
            <template #default="{ row }">
              <el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="時間">
            <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { submitTransfer as submitTransferApi, fetchTransfers, fetchTransferJob } from '@/api'
import type { Transfer, TransferFeedback, FeedbackStatus, TransferStatus } from '@/types'

const router = useRouter()

// ── Form ─────────────────────────────────────────────────────
const form = ref({ fromId: null as number | null, toId: null as number | null, amount: null as number | null })
const submitLoading = ref(false)
const submitError = ref<string | null>(null)

const previewMode = computed(() => {
  if (!form.value.fromId || !form.value.toId) return 'async'
  return (form.value.fromId % 4 === form.value.toId % 4) ? 'sync' : 'async'
})

const canSubmit = computed(() =>
  !!form.value.fromId && !!form.value.toId && !!form.value.amount && form.value.amount > 0
)

// ── Feedback ─────────────────────────────────────────────────
const feedbacks = ref<TransferFeedback[]>([])
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>()

function feedbackLabel(status: FeedbackStatus): string {
  switch (status) {
    case 'pending': return '提交中...'
    case 'polling': return '處理中（輪詢）'
    case 'success': return '完成'
    case 'failed': return '失敗'
    default: return status
  }
}

async function submitTransfer() {
  if (!canSubmit.value) return
  submitLoading.value = true
  submitError.value = null

  const { fromId, toId, amount } = form.value
  const mode = previewMode.value

  const fbId = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const fb: TransferFeedback = {
    id: fbId,
    fromId: fromId!,
    toId: toId!,
    amount: amount!,
    mode: mode as 'sync' | 'async',
    feedbackStatus: 'pending',
    submittedAt: Date.now(),
  }
  feedbacks.value.unshift(fb)

  try {
    const result = await submitTransferApi({ fromId: fromId!, toId: toId!, amount: amount! })

    if (result.mode === 'sync') {
      fb.feedbackStatus = result.status === 'COMPLETED' ? 'success' : 'failed'
      fb.transferStatus = result.status as TransferStatus
      fb.completedAt = Date.now()
      if (result.status !== 'COMPLETED') {
        fb.errorMessage = '轉帳未完成，請確認帳戶餘額'
      }
    } else {
      fb.feedbackStatus = 'polling'
      const jobId = result.jobId
      if (jobId) {
        startPolling(fbId, jobId)
      } else {
        fb.feedbackStatus = 'failed'
        fb.errorMessage = '未取得 jobId，無法追蹤'
        fb.completedAt = Date.now()
      }
    }
  } catch (e: unknown) {
    fb.feedbackStatus = 'failed'
    fb.errorMessage = e instanceof Error ? e.message : '提交失敗'
    fb.completedAt = Date.now()
    submitError.value = fb.errorMessage
  } finally {
    submitLoading.value = false
  }
}

function startPolling(fbId: string, jobId: string) {
  let retries = 0
  const MAX = 30
  const timer = setInterval(async () => {
    retries++
    const fb = feedbacks.value.find(f => f.id === fbId)
    if (!fb) { clearInterval(timer); pollingTimers.delete(fbId); return }

    try {
      const job = await fetchTransferJob(jobId)
      if (job.status === 'success') {
        fb.feedbackStatus = 'success'
        fb.transferStatus = 'COMPLETED'
        fb.completedAt = Date.now()
        clearInterval(timer); pollingTimers.delete(fbId)
      } else if (job.status === 'failed') {
        fb.feedbackStatus = 'failed'
        fb.errorMessage = job.error?.message ?? '轉帳失敗'
        fb.completedAt = Date.now()
        clearInterval(timer); pollingTimers.delete(fbId)
      } else if (retries >= MAX) {
        fb.feedbackStatus = 'failed'
        fb.errorMessage = '輪詢超時（已等待 60 秒）'
        fb.completedAt = Date.now()
        clearInterval(timer); pollingTimers.delete(fbId)
      }
    } catch {
      if (retries >= MAX) {
        fb.feedbackStatus = 'failed'
        fb.errorMessage = '輪詢失敗'
        fb.completedAt = Date.now()
        clearInterval(timer); pollingTimers.delete(fbId)
      }
    }
  }, 2000)
  pollingTimers.set(fbId, timer)
}

function clearFeedbacks() {
  pollingTimers.forEach(t => clearInterval(t))
  pollingTimers.clear()
  feedbacks.value = []
}

onBeforeUnmount(() => {
  pollingTimers.forEach(t => clearInterval(t))
})

// ── Records ───────────────────────────────────────────────────
const allRecords = ref<Transfer[]>([])
const recordsLoading = ref(false)
const recordsError = ref<string | null>(null)
const filter = ref({ accountId: null as number | null, status: '', mode: '', order: 'newest' })

const filteredRecords = computed(() => {
  let list = [...allRecords.value]
  if (filter.value.status) list = list.filter(t => t.status === filter.value.status)
  if (filter.value.mode) list = list.filter(t => t.mode === filter.value.mode)
  if (filter.value.order === 'oldest') list.reverse()
  return list
})

async function loadRecords() {
  if (!filter.value.accountId) return
  recordsLoading.value = true
  recordsError.value = null
  try {
    allRecords.value = await fetchTransfers(filter.value.accountId, 100)
  } catch (e: unknown) {
    recordsError.value = e instanceof Error ? e.message : '查詢失敗'
    allRecords.value = []
  } finally {
    recordsLoading.value = false
  }
}

function clearFilter() {
  filter.value = { accountId: null, status: '', mode: '', order: 'newest' }
  allRecords.value = []
  recordsError.value = null
}

function rowClass({ row }: { row: Transfer }) {
  if (row.status === 'FAILED') return 'row-danger'
  if (row.status === 'RESERVED' || row.status === 'PENDING_FINALIZE') return 'row-warning'
  return ''
}

function statusType(s: string): '' | 'success' | 'danger' | 'warning' | 'info' {
  const m: Record<string, '' | 'success' | 'danger' | 'warning' | 'info'> = {
    COMPLETED: 'success', FAILED: 'danger', PENDING_FINALIZE: 'warning', RESERVED: 'info',
  }
  return m[s] ?? 'info'
}

function navigateTo(accountId: number) {
  router.push({ name: 'accounts', params: { id: accountId } })
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-TW')
}

function formatDateTime(isoStr: string): string {
  return new Date(isoStr).toLocaleString('zh-TW')
}
</script>

<style scoped>
.top-section {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 20px;
  margin-bottom: 20px;
}

.form-card { display: flex; flex-direction: column; gap: 14px; }
.feedback-card { display: flex; flex-direction: column; }

.field-group { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: #6b7280; }
.shard-hint {
  font-size: 11px; color: #6366f1;
  background: #eef2ff; padding: 2px 8px; border-radius: 4px;
  align-self: flex-start;
}

.submit-error {
  font-size: 13px; color: #dc2626;
  padding: 8px 12px; background: #fff5f5;
  border: 1px solid #fecaca; border-radius: 8px;
}

.empty-state { padding: 20px 0; }

.feedback-list {
  display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto; max-height: 420px;
}

.feedback-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 10px 12px; border-radius: 8px; font-size: 13px;
}
.fb-pending { background: #f9fafb; }
.fb-polling { background: #fffbeb; }
.fb-success { background: #f0fdf4; }
.fb-failed  { background: #fff5f5; }

.fb-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.fb-body { flex: 1; min-width: 0; }
.fb-main { font-weight: 500; color: #374151; margin-bottom: 3px; }
.fb-sub  { font-size: 12px; color: #6b7280; }
.fb-error { font-size: 12px; color: #dc2626; margin-top: 4px; }

.status-text-pending { color: #9ca3af; }
.status-text-polling { color: #d97706; }
.status-text-success { color: #059669; font-weight: 500; }
.status-text-failed  { color: #dc2626; font-weight: 500; }

.text-muted { color: #a0aec0; }

@media (max-width: 900px) {
  .top-section { grid-template-columns: 1fr; }
}
</style>
