<template>
  <div>
    <div class="page-header">
      <h1>轉帳明細</h1>
      <p>依帳號查詢轉帳記錄，可篩選異常狀態</p>
    </div>

    <!-- Search Bar -->
    <div class="card">
      <div style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
        <div>
          <div style="font-size: 12px; color: #718096; margin-bottom: 6px;">Account ID</div>
          <el-input-number
            v-model="searchAccountId"
            :min="1"
            placeholder="輸入帳號 ID"
            style="width: 200px"
            controls-position="right"
            @keyup.enter="doSearch"
          />
        </div>
        <div>
          <div style="font-size: 12px; color: #718096; margin-bottom: 6px;">筆數限制</div>
          <el-select v-model="limit" style="width: 100px">
            <el-option :value="20" label="20 筆" />
            <el-option :value="50" label="50 筆" />
            <el-option :value="100" label="100 筆" />
          </el-select>
        </div>
        <el-button type="primary" @click="doSearch" :loading="loading">查詢</el-button>
        <el-button @click="clear">清除</el-button>
      </div>
    </div>

    <!-- Status filter tabs -->
    <div v-if="transfers.length > 0" style="margin-bottom: 16px; display:flex; gap:8px; flex-wrap:wrap;">
      <el-tag
        v-for="tab in statusTabs"
        :key="tab.value"
        :type="tab.type"
        :effect="statusFilter === tab.value ? 'dark' : 'plain'"
        style="cursor: pointer"
        @click="statusFilter = tab.value"
      >
        {{ tab.label }} ({{ tab.count }})
      </el-tag>
    </div>

    <!-- Error -->
    <el-alert v-if="error" :title="error" type="error" show-icon style="margin-bottom: 16px" />

    <!-- Table -->
    <div class="card" v-if="searched">
      <div class="card-title" style="justify-content: space-between">
        <span>
          帳號 #{{ currentAccountId }} 的轉帳記錄
          <el-tag size="small" style="margin-left: 8px">{{ filteredTransfers.length }} 筆</el-tag>
          <el-tag
            v-if="pendingCount > 0"
            type="danger"
            size="small"
            style="margin-left: 6px"
          >
            ⚠ {{ pendingCount }} 筆異常
          </el-tag>
        </span>
        <el-button link type="primary" size="small" @click="goToAccount">
          查看帳號詳情 →
        </el-button>
      </div>

      <el-skeleton :rows="5" animated v-if="loading" />

      <el-table
        v-else
        :data="filteredTransfers"
        style="width: 100%"
        stripe
        empty-text="查無轉帳記錄"
        :row-class-name="rowClass"
      >
        <el-table-column label="ID" prop="id" width="80" />
        <el-table-column label="方向" width="80">
          <template #default="{ row }">
            <el-tag
              :type="row.from_account_id === currentAccountId ? 'danger' : 'success'"
              size="small"
            >
              {{ row.from_account_id === currentAccountId ? '出款' : '入款' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="付款方" width="110">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="jumpToAccount(row.from_account_id)">
              #{{ row.from_account_id }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="收款方" width="110">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="jumpToAccount(row.to_account_id)">
              #{{ row.to_account_id }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="金額" width="120">
          <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="狀態" width="170">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模式" width="80">
          <template #default="{ row }">
            <el-tag type="info" size="small" effect="plain">{{ row.mode }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="時間">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </div>

    <!-- Empty state -->
    <div class="card" v-if="!searched && !loading" style="text-align: center; padding: 60px 24px;">
      <el-empty description="輸入 Account ID 開始查詢" :image-size="100" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchTransfers } from '@/api'
import type { Transfer, TransferStatus } from '@/types'

const route = useRoute()
const router = useRouter()

const searchAccountId = ref<number | undefined>(undefined)
const currentAccountId = ref<number | null>(null)
const limit = ref(50)
const statusFilter = ref('')
const transfers = ref<Transfer[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const searched = ref(false)

const filteredTransfers = computed(() => {
  if (!statusFilter.value) return transfers.value
  return transfers.value.filter(t => t.status === statusFilter.value)
})

const pendingCount = computed(() =>
  transfers.value.filter(t => t.status === 'PENDING_FINALIZE' || t.status === 'FAILED').length,
)

const statusTabs = computed(() => {
  const counts = {
    '': transfers.value.length,
    COMPLETED: 0,
    FAILED: 0,
    PENDING_FINALIZE: 0,
    RESERVED: 0,
  } as Record<string, number>

  transfers.value.forEach(t => {
    if (t.status in counts) counts[t.status]++
  })

  return [
    { value: '', label: '全部', type: 'info' as const, count: counts[''] },
    { value: 'COMPLETED', label: 'COMPLETED', type: 'success' as const, count: counts.COMPLETED },
    { value: 'FAILED', label: 'FAILED', type: 'danger' as const, count: counts.FAILED },
    { value: 'PENDING_FINALIZE', label: 'PENDING_FINALIZE', type: 'warning' as const, count: counts.PENDING_FINALIZE },
    { value: 'RESERVED', label: 'RESERVED', type: 'info' as const, count: counts.RESERVED },
  ].filter(tab => tab.value === '' || tab.count > 0)
})

async function doSearch() {
  if (!searchAccountId.value) return
  loading.value = true
  error.value = null
  statusFilter.value = ''
  try {
    currentAccountId.value = searchAccountId.value
    transfers.value = await fetchTransfers(searchAccountId.value, limit.value)
    searched.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : '查詢失敗'
    transfers.value = []
  } finally {
    loading.value = false
  }
}

function clear() {
  searchAccountId.value = undefined
  currentAccountId.value = null
  transfers.value = []
  searched.value = false
  error.value = null
  statusFilter.value = ''
}

function goToAccount() {
  if (currentAccountId.value) {
    router.push(`/accounts/${currentAccountId.value}`)
  }
}

function jumpToAccount(id: number) {
  router.push(`/accounts/${id}`)
}

function formatAmount(v: number): string {
  return v.toLocaleString('zh-TW')
}

function formatDate(s: string): string {
  return new Date(s).toLocaleString('zh-TW')
}

function statusTagType(status: TransferStatus): 'success' | 'danger' | 'warning' | 'info' {
  const map: Record<TransferStatus, 'success' | 'danger' | 'warning' | 'info'> = {
    COMPLETED: 'success',
    FAILED: 'danger',
    PENDING_FINALIZE: 'warning',
    RESERVED: 'info',
  }
  return map[status] ?? 'info'
}

function rowClass({ row }: { row: Transfer }): string {
  if (row.status === 'PENDING_FINALIZE') return 'row-warning'
  if (row.status === 'FAILED') return 'row-danger'
  return ''
}

// 若從 Dashboard 帶 query 過來，自動執行查詢
onMounted(() => {
  const qId = route.query.accountId
  if (qId) {
    searchAccountId.value = Number(qId)
    doSearch()
  }
})
</script>

<style>
.row-warning td {
  background-color: #fffbeb !important;
}
.row-danger td {
  background-color: #fff5f5 !important;
}
</style>
