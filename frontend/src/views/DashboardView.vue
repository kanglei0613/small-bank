<template>
  <div>
    <!-- Header -->
    <div class="page-header">
      <h1>Dashboard</h1>
      <p>系統即時狀態監控</p>
    </div>

    <!-- Metric Cards -->
    <div class="metric-grid">
      <div class="metric-card">
        <div class="label">系統狀態</div>
        <div class="value" :style="{ color: healthColor }">
          {{ systemStore.healthy === null ? '—' : systemStore.healthy ? 'Online' : 'Offline' }}
        </div>
        <div class="sub" v-if="systemStore.lastChecked">
          {{ formatTs(systemStore.lastChecked) }}
        </div>
      </div>

      <div class="metric-card">
        <div class="label">Queue 總量</div>
        <div class="value" :style="{ color: systemStore.hasPendingJobs ? '#e53e3e' : '#2d3748' }">
          {{ systemStore.queueStats?.totalJobs ?? '—' }}
        </div>
        <div class="sub">待處理跨 shard 轉帳</div>
      </div>

      <div class="metric-card">
        <div class="label">活躍 Queue</div>
        <div class="value">{{ systemStore.queueStats?.totalQueues ?? '—' }}</div>
        <div class="sub">有排隊的 fromId 數</div>
      </div>

      <div class="metric-card">
        <div class="label">Worker 數</div>
        <div class="value">{{ systemStore.queueStats?.workers ?? '—' }}</div>
        <div class="sub">Queue Worker 實例</div>
      </div>
    </div>

    <!-- Hot Accounts -->
    <div class="card" v-if="hotAccounts.length > 0">
      <div class="card-title">
        🔥 Hot Accounts（Queue 擁塞帳號）
        <el-tag type="danger" size="small">{{ hotAccounts.length }} 個</el-tag>
      </div>
      <el-table :data="hotAccounts" style="width: 100%" stripe>
        <el-table-column label="Account ID" prop="fromId" width="160" />
        <el-table-column label="Queue 長度" prop="queueLength" width="140">
          <template #default="{ row }">
            <el-tag :type="row.queueLength > 50 ? 'danger' : 'warning'" size="small">
              {{ row.queueLength }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              size="small"
              @click="goToAccount(row.fromId)"
            >
              查看帳號 →
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="card" v-else-if="systemStore.queueStats !== null">
      <div class="card-title">Queue 狀態</div>
      <el-empty description="目前沒有排隊中的轉帳" :image-size="80" />
    </div>

    <!-- Quick Search -->
    <div class="card">
      <div class="card-title">🔍 快速帳號查詢</div>
      <div class="search-row">
        <el-input-number
          v-model="searchId"
          :min="1"
          placeholder="輸入 Account ID"
          style="width: 240px"
          controls-position="right"
        />
        <el-button type="primary" @click="goToAccount(searchId)" :disabled="!searchId">
          查詢帳號
        </el-button>
        <el-button @click="goToTransactions(searchId)" :disabled="!searchId">
          查看轉帳記錄
        </el-button>
      </div>
    </div>

    <!-- Refresh -->
    <div style="text-align: right; margin-top: 8px;">
      <el-button
        :loading="systemStore.loading"
        size="small"
        @click="systemStore.refresh()"
      >
        重新整理
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSystemStore } from '@/stores/system'

const router = useRouter()
const systemStore = useSystemStore()
const searchId = ref<number | undefined>(undefined)

const hotAccounts = computed(() => systemStore.queueStats?.hotAccounts ?? [])

const healthColor = computed(() => {
  if (systemStore.healthy === null) return '#a0aec0'
  return systemStore.healthy ? '#48bb78' : '#e53e3e'
})

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-TW')
}

function goToAccount(id: number | undefined) {
  if (!id) return
  router.push(`/accounts/${id}`)
}

function goToTransactions(id: number | undefined) {
  if (!id) return
  router.push({ path: '/transactions', query: { accountId: String(id) } })
}

// 每 15 秒自動重整
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  systemStore.refresh()
  timer = setInterval(() => systemStore.refresh(), 15_000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.search-row {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
