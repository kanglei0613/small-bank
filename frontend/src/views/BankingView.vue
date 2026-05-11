<template>
  <div>
    <!-- Header -->
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div>
        <h1>歡迎回來 👋</h1>
        <p>帳號 #{{ auth.accountId }} · Shard {{ shardId }}</p>
      </div>
      <el-button size="small" :loading="refreshing" @click="refresh">重新整理</el-button>
    </div>

    <!-- Balance Cards -->
    <div class="metric-grid" v-if="auth.account">
      <div class="metric-card balance-card">
        <div class="label">總餘額</div>
        <div class="value">{{ fmt(auth.account.balance) }}</div>
        <div class="sub">總資產</div>
      </div>
      <div class="metric-card balance-card available">
        <div class="label">可用餘額</div>
        <div class="value" style="color:#059669">{{ fmt(auth.account.availableBalance) }}</div>
        <div class="sub">可立即動用</div>
      </div>
      <div class="metric-card balance-card" :class="{ frozen: auth.account.reservedBalance > 0 }">
        <div class="label">凍結中</div>
        <div class="value" :style="{ color: auth.account.reservedBalance > 0 ? '#dc2626' : '#a0aec0' }">
          {{ fmt(auth.account.reservedBalance) }}
        </div>
        <div class="sub">跨 shard 轉帳中</div>
      </div>
      <div class="metric-card balance-card">
        <div class="label">帳號資訊</div>
        <div class="value" style="font-size:22px">s{{ shardId }}</div>
        <div class="sub">Shard {{ shardId }} · ID {{ auth.accountId }}</div>
      </div>
    </div>

    <el-alert
      v-if="auth.account && auth.account.reservedBalance > 0"
      title="有跨 shard 轉帳正在進行中"
      :description="`凍結金額 ${fmt(auth.account.reservedBalance)}，Saga 完成後自動解凍`"
      type="warning" show-icon style="margin-bottom:20px"
    />

    <!-- Operations Row -->
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px;">

      <!-- Deposit / Withdraw -->
      <div class="card">
        <div class="card-title">💰 存提款</div>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <div class="field-label">金額</div>
            <el-input-number
              v-model="opAmount"
              :min="1"
              :controls="false"
              placeholder="輸入金額"
              style="width:100%"
            />
          </div>
          <div style="display:flex; gap:8px;">
            <el-button type="success" style="flex:1" :loading="opLoading" @click="doDeposit">
              存款
            </el-button>
            <el-button type="danger" style="flex:1" :loading="opLoading" @click="doWithdraw">
              提款
            </el-button>
          </div>
          <div v-if="opMsg" class="op-feedback" :class="opMsgType">{{ opMsg }}</div>
        </div>
      </div>

      <!-- Transfer -->
      <div class="card">
        <div class="card-title">🔄 發起轉帳</div>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <div class="field-label">付款帳號</div>
            <el-input :model-value="`#${auth.accountId}`" disabled />
          </div>
          <div>
            <div class="field-label">收款帳號 ID</div>
            <el-input-number
              v-model="txTo"
              :min="1"
              :controls="false"
              placeholder="對方帳號 ID"
              style="width:100%"
            />
          </div>
          <div>
            <div class="field-label">金額</div>
            <el-input-number
              v-model="txAmount"
              :min="1"
              :controls="false"
              placeholder="轉帳金額"
              style="width:100%"
            />
          </div>
          <el-button type="primary" :loading="txLoading" @click="doTransfer" style="width:100%">
            立即轉帳
          </el-button>

          <!-- Feedback list -->
          <div v-if="feedbacks.length > 0" class="feedback-list">
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
                  → #{{ fb.toId }} · {{ fmtAmt(fb.amount) }}
                  <el-tag size="small" :type="modeTagType(fb.mode)" style="margin-left:4px">{{ fb.mode }}</el-tag>
                </div>
                <div class="fb-sub">
                  <span v-if="fb.feedbackStatus === 'polling'">處理中...</span>
                  <span v-else-if="fb.feedbackStatus === 'success'">{{ fb.transferStatus }}</span>
                  <span v-else-if="fb.feedbackStatus === 'failed'" style="color:#dc2626">{{ fb.errorMessage }}</span>
                  <span style="margin-left:8px; color:#a0aec0">{{ fmtTime(fb.submittedAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Transfers -->
    <div class="card">
      <div class="card-title" style="justify-content:space-between">
        <span>最近轉帳記錄</span>
        <el-button link size="small" @click="loadTransfers">重整</el-button>
      </div>
      <el-skeleton :rows="4" animated v-if="txLoading && transfers.length === 0" />
      <el-table
        v-else
        :data="transfers.slice(0, 10)"
        style="width:100%"
        empty-text="尚無轉帳記錄"
        :row-class-name="rowClass"
        stripe
      >
        <el-table-column label="ID" prop="id" width="70" />
        <el-table-column label="方向" width="80">
          <template #default="{ row }">
            <el-tag :type="row.from_account_id === auth.accountId ? 'danger' : 'success'" size="small">
              {{ row.from_account_id === auth.accountId ? '出款' : '入款' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="對手帳號" width="110">
          <template #default="{ row }">
            <el-button link type="primary" size="small"
              @click="goAccount(row.from_account_id === auth.accountId ? row.to_account_id : row.from_account_id)">
              #{{ row.from_account_id === auth.accountId ? row.to_account_id : row.from_account_id }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="金額" width="120">
          <template #default="{ row }">{{ fmtAmt(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="模式" width="80">
          <template #default="{ row }">
            <el-tag :type="row.mode === 'sync' ? 'success' : 'warning'" size="small" effect="plain">
              {{ row.mode ?? '—' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="狀態" width="160">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="時間">
          <template #default="{ row }">{{ fmtDate(row.created_at) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="transfers.length === 0 && !txLoading" style="text-align:center; padding:24px 0; color:#a0aec0; font-size:14px">
        此帳號尚無轉帳記錄
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { fetchTransfers, deposit, withdraw, submitTransfer, fetchTransferJob } from '@/api'
import type { Transfer, TransferFeedback, TransferMode, TransferStatus } from '@/types'

const auth = useAuthStore()
const router = useRouter()

const shardId = computed(() => (auth.accountId ?? 0) % 4)

const opAmount = ref<number | undefined>(undefined)
const opLoading = ref(false)
const opMsg = ref('')
const opMsgType = ref<'success' | 'error'>('success')

const txTo = ref<number | undefined>(undefined)
const txAmount = ref<number | undefined>(undefined)
const txLoading = ref(false)
const transfers = ref<Transfer[]>([])
const refreshing = ref(false)
const feedbacks = ref<TransferFeedback[]>([])

function fmt(v: number) { return v?.toLocaleString('zh-TW') ?? '—' }
function fmtAmt(v: number) { return v?.toLocaleString('zh-TW') ?? '0' }
function fmtDate(s: string) { return new Date(s).toLocaleString('zh-TW') }
function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString('zh-TW') }

async function refresh() {
  refreshing.value = true
  await Promise.allSettled([auth.refreshAccount(), loadTransfers()])
  refreshing.value = false
}

async function loadTransfers() {
  if (!auth.accountId) return
  try { transfers.value = await fetchTransfers(auth.accountId, 20) } catch { transfers.value = [] }
}

async function doDeposit() {
  if (!opAmount.value) return
  opLoading.value = true
  try {
    await deposit(auth.accountId!, opAmount.value)
    opMsg.value = `✅ 存款 ${fmtAmt(opAmount.value)} 成功`
    opMsgType.value = 'success'
    opAmount.value = undefined
    await auth.refreshAccount()
  } catch (e) {
    opMsg.value = `❌ ${e instanceof Error ? e.message : '存款失敗'}`
    opMsgType.value = 'error'
  } finally { opLoading.value = false }
}

async function doWithdraw() {
  if (!opAmount.value) return
  opLoading.value = true
  try {
    await withdraw(auth.accountId!, opAmount.value)
    opMsg.value = `✅ 提款 ${fmtAmt(opAmount.value)} 成功`
    opMsgType.value = 'success'
    opAmount.value = undefined
    await auth.refreshAccount()
  } catch (e) {
    opMsg.value = `❌ ${e instanceof Error ? e.message : '提款失敗（餘額不足）'}`
    opMsgType.value = 'error'
  } finally { opLoading.value = false }
}

async function doTransfer() {
  if (!txTo.value || !txAmount.value) {
    ElMessage.warning('請填寫收款帳號和金額')
    return
  }
  if (txTo.value === auth.accountId) {
    ElMessage.warning('不能轉帳給自己')
    return
  }

  txLoading.value = true
  const fb: TransferFeedback = {
    id: String(Date.now()),
    fromId: auth.accountId!,
    toId: txTo.value,
    amount: txAmount.value,
    mode: 'sync',
    feedbackStatus: 'pending',
    submittedAt: Date.now(),
  }
  feedbacks.value.unshift(fb)

  const toId = txTo.value
  const amount = txAmount.value
  txTo.value = undefined
  txAmount.value = undefined

  try {
    const result = await submitTransfer({ fromId: auth.accountId!, toId, amount })
    fb.mode = result.mode as TransferMode
    fb.id = result.jobId ?? String(result.transferId ?? fb.id)

    if (result.mode === 'sync') {
      fb.feedbackStatus = 'success'
      fb.transferStatus = result.status as TransferStatus
      fb.completedAt = Date.now()
      await auth.refreshAccount()
      await loadTransfers()
    } else {
      fb.feedbackStatus = 'polling'
      pollJob(fb, result.jobId!)
    }
  } catch (e) {
    fb.feedbackStatus = 'failed'
    fb.errorMessage = e instanceof Error ? e.message : '提交失敗'
  } finally {
    txLoading.value = false
  }
}

async function pollJob(fb: TransferFeedback, jobId: string) {
  const MAX = 30
  for (let i = 0; i < MAX; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const job = await fetchTransferJob(jobId)
      if (job.status === 'success') {
        fb.feedbackStatus = 'success'
        fb.transferStatus = 'COMPLETED'
        fb.completedAt = Date.now()
        await auth.refreshAccount()
        await loadTransfers()
        return
      }
      if (job.status === 'failed') {
        fb.feedbackStatus = 'failed'
        fb.errorMessage = job.error?.message ?? '轉帳失敗'
        fb.completedAt = Date.now()
        return
      }
    } catch { /* 繼續 poll */ }
  }
  fb.feedbackStatus = 'failed'
  fb.errorMessage = 'Polling 逾時，請至轉帳記錄查詢結果'
}

function goAccount(id: number) { router.push(`/accounts/${id}`) }

function statusType(s: string): '' | 'success' | 'danger' | 'warning' | 'info' {
  const m: Record<string, '' | 'success' | 'danger' | 'warning' | 'info'> = {
    COMPLETED: 'success', FAILED: 'danger', PENDING_FINALIZE: 'warning', RESERVED: 'info',
  }
  return m[s] ?? 'info'
}

function modeTagType(m: string): '' | 'success' | 'warning' | 'info' {
  return m === 'sync' ? 'success' : 'warning'
}

function rowClass({ row }: { row: Transfer }) {
  if (row.status === 'PENDING_FINALIZE') return 'row-warning'
  if (row.status === 'FAILED') return 'row-danger'
  return ''
}

onMounted(() => { loadTransfers() })
</script>

<style scoped>
.field-label { font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: 6px; }
.op-feedback {
  font-size: 13px; padding: 8px 12px; border-radius: 8px;
}
.op-feedback.success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.op-feedback.error { background: #fff5f5; color: #dc2626; border: 1px solid #fecaca; }

.frozen { border: 1px solid #fca5a5 !important; }
.balance-card { border: 1px solid transparent; }

.feedback-list {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 240px; overflow-y: auto;
  border-top: 1px solid #f3f4f6; padding-top: 12px;
}
.feedback-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 8px 10px; border-radius: 8px; font-size: 13px;
}
.fb-pending { background: #f9fafb; }
.fb-polling { background: #fffbeb; }
.fb-success { background: #f0fdf4; }
.fb-failed { background: #fff5f5; }
.fb-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.fb-body { flex: 1; min-width: 0; }
.fb-main { font-weight: 500; color: #374151; }
.fb-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
</style>
