<template>
  <div>
    <div class="page-header">
      <h1>帳號查詢</h1>
      <p>輸入帳號 ID 查看餘額、shard 資訊與交易記錄</p>
    </div>

    <!-- Search -->
    <div class="card">
      <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="field-label">帳號 ID</div>
          <el-input-number
            v-model="searchId"
            :min="1"
            :controls="false"
            placeholder="輸入帳號 ID"
            style="width:200px"
            @keyup.enter="() => doSearch()"
          />
        </div>
        <el-button type="primary" :loading="loadingAccount" @click="() => doSearch()">查詢</el-button>
        <el-button @click="clear">清除</el-button>
        <el-button v-if="account" type="success" plain @click="loginAsAccount">
          以此帳號登入
        </el-button>
      </div>
    </div>

    <!-- Error -->
    <el-alert v-if="error" :title="error" type="error" show-icon style="margin-bottom:20px" />

    <div v-if="account">
      <!-- Balance Cards -->
      <div class="metric-grid">
        <div class="metric-card">
          <div class="label">總餘額</div>
          <div class="value">{{ fmt(account.balance) }}</div>
          <div class="sub">balance</div>
        </div>
        <div class="metric-card">
          <div class="label">可用餘額</div>
          <div class="value" style="color:#059669">{{ fmt(account.availableBalance) }}</div>
          <div class="sub">availableBalance</div>
        </div>
        <div class="metric-card" :class="{ frozen: account.reservedBalance > 0 }">
          <div class="label">凍結中</div>
          <div class="value" :style="{ color: account.reservedBalance > 0 ? '#dc2626' : '#a0aec0' }">
            {{ fmt(account.reservedBalance) }}
          </div>
          <div class="sub">reservedBalance</div>
        </div>
        <div class="metric-card">
          <div class="label">Shard 位置</div>
          <div class="value" style="font-size:22px">s{{ account.id % 4 }}</div>
          <div class="sub">accountId {{ account.id }} % 4 = {{ account.id % 4 }}</div>
        </div>
      </div>

      <el-alert
        v-if="account.reservedBalance > 0"
        title="有跨 shard 轉帳正在進行"
        :description="`凍結金額 ${fmt(account.reservedBalance)}，Saga 完成後自動解凍`"
        type="warning" show-icon style="margin-bottom:20px"
      />

      <!-- Deposit / Withdraw -->
      <div class="card">
        <div class="card-title">💰 存提款操作</div>
        <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap;">
          <div>
            <div class="field-label">金額</div>
            <el-input-number v-model="opAmount" :min="1" :controls="false" placeholder="金額" style="width:180px" />
          </div>
          <el-button type="success" :loading="opLoading" @click="doDeposit">存款</el-button>
          <el-button type="danger" :loading="opLoading" @click="doWithdraw">提款</el-button>
          <span v-if="opMsg" class="op-msg" :class="opMsgType">{{ opMsg }}</span>
        </div>
      </div>

      <!-- Transfers -->
      <div class="card">
        <div class="card-title" style="justify-content:space-between">
          <span>轉帳記錄</span>
          <div style="display:flex; gap:8px; align-items:center;">
            <el-select v-model="statusFilter" placeholder="篩選狀態" clearable size="small" style="width:170px">
              <el-option label="全部" value="" />
              <el-option label="COMPLETED" value="COMPLETED" />
              <el-option label="FAILED" value="FAILED" />
              <el-option label="PENDING_FINALIZE" value="PENDING_FINALIZE" />
              <el-option label="RESERVED" value="RESERVED" />
            </el-select>
            <el-select v-model="modeFilter" placeholder="篩選模式" clearable size="small" style="width:130px">
              <el-option label="全部" value="" />
              <el-option label="sync" value="sync" />
              <el-option label="async" value="async" />
            </el-select>
            <el-button size="small" @click="loadTransfers">重整</el-button>
          </div>
        </div>

        <el-skeleton :rows="5" animated v-if="loadingTransfers" />

        <el-table
          v-else
          :data="filteredTransfers"
          style="width:100%"
          stripe empty-text="查無轉帳記錄"
          :row-class-name="rowClass"
        >
          <el-table-column label="ID" prop="id" width="80" sortable />
          <el-table-column label="方向" width="80">
            <template #default="{ row }">
              <el-tag :type="row.from_account_id === accountId ? 'danger' : 'success'" size="small">
                {{ row.from_account_id === accountId ? '出款' : '入款' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="對手帳號" width="110">
            <template #default="{ row }">
              <el-button link type="primary" size="small"
                @click="doSearch(row.from_account_id === accountId ? row.to_account_id : row.from_account_id)">
                #{{ row.from_account_id === accountId ? row.to_account_id : row.from_account_id }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="金額" width="120">
            <template #default="{ row }">{{ fmt(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="模式" width="90">
            <template #default="{ row }">
              <el-tag :type="row.mode === 'sync' ? 'success' : 'warning'" size="small" effect="plain">
                {{ row.mode ?? '—' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="狀態" width="170">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="時間">
            <template #default="{ row }">{{ fmtDate(row.created_at) }}</template>
          </el-table-column>
        </el-table>

        <div class="shard-note">
          ℹ️ 注意：跨 shard 的入款記錄儲存在轉出方的 shard，此處僅顯示此帳號所在 shard 的轉帳紀錄
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="!loadingAccount" class="card" style="text-align:center; padding:60px 24px;">
      <el-empty description="輸入帳號 ID 開始查詢" :image-size="100" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { fetchAccount, fetchTransfers, deposit, withdraw } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Account, Transfer, TransferStatus } from '@/types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const searchId = ref<number | undefined>(undefined)
const accountId = ref<number>(0)
const account = ref<Account | null>(null)
const transfers = ref<Transfer[]>([])
const loadingAccount = ref(false)
const loadingTransfers = ref(false)
const error = ref<string | null>(null)
const statusFilter = ref('')
const modeFilter = ref('')
const opAmount = ref<number | undefined>(undefined)
const opLoading = ref(false)
const opMsg = ref('')
const opMsgType = ref<'success' | 'error'>('success')

const filteredTransfers = computed(() => {
  return transfers.value.filter(t => {
    if (statusFilter.value && t.status !== statusFilter.value) return false
    if (modeFilter.value && t.mode !== modeFilter.value) return false
    return true
  })
})

function fmt(v: number) { return v?.toLocaleString('zh-TW') ?? '—' }
function fmtDate(s: string) { return new Date(s).toLocaleString('zh-TW') }

async function doSearch(id?: number) {
  const targetId = id ?? searchId.value
  if (!targetId) return

  searchId.value = targetId
  accountId.value = targetId
  loadingAccount.value = true
  error.value = null

  try {
    account.value = await fetchAccount(targetId)
    await loadTransfers()
    router.replace(`/accounts/${targetId}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : `帳號 #${targetId} 不存在`
    account.value = null
  } finally {
    loadingAccount.value = false
  }
}

async function loadTransfers() {
  loadingTransfers.value = true
  try { transfers.value = await fetchTransfers(accountId.value) } catch { transfers.value = [] }
  finally { loadingTransfers.value = false }
}

async function doDeposit() {
  if (!opAmount.value) return
  opLoading.value = true
  try {
    await deposit(accountId.value, opAmount.value)
    opMsg.value = `✅ 存款 ${fmt(opAmount.value)} 成功`
    opMsgType.value = 'success'
    opAmount.value = undefined
    account.value = await fetchAccount(accountId.value)
  } catch (e) {
    opMsg.value = `❌ ${e instanceof Error ? e.message : '存款失敗'}`
    opMsgType.value = 'error'
  } finally { opLoading.value = false }
}

async function doWithdraw() {
  if (!opAmount.value) return
  opLoading.value = true
  try {
    await withdraw(accountId.value, opAmount.value)
    opMsg.value = `✅ 提款 ${fmt(opAmount.value)} 成功`
    opMsgType.value = 'success'
    opAmount.value = undefined
    account.value = await fetchAccount(accountId.value)
  } catch (e) {
    opMsg.value = `❌ ${e instanceof Error ? e.message : '提款失敗（餘額不足）'}`
    opMsgType.value = 'error'
  } finally { opLoading.value = false }
}

async function loginAsAccount() {
  if (!account.value) return
  try {
    await auth.login(account.value.id)
    ElMessage.success(`已切換到帳號 #${account.value.id}`)
    router.push('/banking')
  } catch { ElMessage.error('切換失敗') }
}

function clear() {
  searchId.value = undefined
  account.value = null
  transfers.value = []
  error.value = null
  router.replace('/accounts')
}

function statusType(s: string): '' | 'success' | 'danger' | 'warning' | 'info' {
  const m: Record<string, '' | 'success' | 'danger' | 'warning' | 'info'> = {
    COMPLETED: 'success', FAILED: 'danger', PENDING_FINALIZE: 'warning', RESERVED: 'info',
  }
  return m[s] ?? 'info'
}

function rowClass({ row }: { row: Transfer }) {
  if (row.status === 'PENDING_FINALIZE') return 'row-warning'
  if (row.status === 'FAILED') return 'row-danger'
  return ''
}

onMounted(() => {
  const paramId = route.params.id
  if (paramId) {
    searchId.value = Number(paramId)
    doSearch(Number(paramId))
  }
})
</script>

<style scoped>
.field-label { font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: 6px; }
.op-msg { font-size: 13px; padding: 6px 12px; border-radius: 6px; }
.op-msg.success { background: #f0fdf4; color: #166534; }
.op-msg.error { background: #fff5f5; color: #dc2626; }
.frozen { border: 1px solid #fca5a5; }
.shard-note {
  margin-top: 12px; font-size: 12px; color: #9ca3af;
  padding: 8px 12px; background: #f9fafb; border-radius: 6px;
}
</style>
