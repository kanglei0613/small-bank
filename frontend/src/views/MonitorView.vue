<template>
  <div>
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div>
        <h1>系統監控</h1>
        <p>即時負載與健康狀態 · 每 5 秒自動更新</p>
      </div>
      <div style="display:flex; align-items:center; gap:12px;">
        <div class="live-badge" :class="{ live: !systemStore.loading }">
          <span class="live-dot"></span>
          {{ systemStore.loading ? '更新中' : 'LIVE' }}
        </div>
        <el-button size="small" :loading="systemStore.loading" @click="systemStore.refresh()">
          手動重整
        </el-button>
      </div>
    </div>

    <!-- System Status -->
    <div class="metric-grid">
      <div class="metric-card" :class="systemStore.healthy ? 'status-ok' : 'status-error'">
        <div class="label">系統狀態</div>
        <div class="value" :style="{ color: systemStore.healthy ? '#059669' : '#dc2626' }">
          {{ systemStore.healthy === null ? '—' : systemStore.healthy ? 'Online' : 'Offline' }}
        </div>
        <div class="sub" v-if="systemStore.lastChecked">
          最後確認 {{ fmtTime(systemStore.lastChecked) }}
        </div>
      </div>

      <div class="metric-card" :class="{ 'status-warn': (systemStore.queueStats?.totalJobs ?? 0) > 0 }">
        <div class="label">Queue 待處理</div>
        <div class="value" :style="{ color: queueColor }">
          {{ systemStore.queueStats?.totalJobs ?? '—' }}
        </div>
        <div class="sub">跨 shard 轉帳 job</div>
      </div>

      <div class="metric-card">
        <div class="label">活躍 Queue</div>
        <div class="value">{{ systemStore.queueStats?.totalQueues ?? '—' }}</div>
        <div class="sub">有排隊的 fromId 數</div>
      </div>

      <div class="metric-card">
        <div class="label">Queue Worker</div>
        <div class="value" :style="{ color: workerColor }">
          {{ systemStore.queueStats?.workers ?? '—' }}
        </div>
        <div class="sub">運行中 worker 實例</div>
      </div>
    </div>

    <!-- Queue Health Bar -->
    <div class="card" v-if="systemStore.queueStats">
      <div class="card-title">📈 Queue 負載概況</div>
      <div class="health-row">
        <div class="health-label">
          <span>Queue 佔用率</span>
          <span :style="{ color: queueColor, fontWeight: 600 }">{{ queuePct }}%</span>
        </div>
        <div class="health-bar-wrap">
          <div class="health-bar" :style="{ width: queuePct + '%', background: queueColor }"></div>
        </div>
      </div>
      <div class="health-stats">
        <div class="hs-item">
          <div class="hs-num">{{ systemStore.queueStats.totalJobs }}</div>
          <div class="hs-label">總 Job 數</div>
        </div>
        <div class="hs-item">
          <div class="hs-num">{{ systemStore.queueStats.totalQueues }}</div>
          <div class="hs-label">活躍 Queue</div>
        </div>
        <div class="hs-item">
          <div class="hs-num">{{ systemStore.queueStats.workers }}</div>
          <div class="hs-label">Workers</div>
        </div>
        <div class="hs-item">
          <div class="hs-num">{{ hotCount }}</div>
          <div class="hs-label">熱點帳號</div>
        </div>
      </div>
    </div>

    <!-- Hot Accounts -->
    <div class="card" v-if="hotAccounts.length > 0">
      <div class="card-title" style="justify-content:space-between">
        <span>🔥 熱點帳號（Queue 壅塞）</span>
        <el-tag type="danger" size="small">{{ hotAccounts.length }} 個</el-tag>
      </div>
      <el-table :data="hotAccounts" style="width:100%" stripe>
        <el-table-column label="Account ID" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="goAccount(row.fromId)">#{{ row.fromId }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="Shard" width="100">
          <template #default="{ row }">s{{ row.fromId % 4 }}</template>
        </el-table-column>
        <el-table-column label="Queue 長度">
          <template #default="{ row }">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="queue-bar-wrap">
                <div
                  class="queue-bar"
                  :style="{
                    width: Math.min((row.queueLength / 600) * 100, 100) + '%',
                    background: row.queueLength > 300 ? '#dc2626' : row.queueLength > 100 ? '#d97706' : '#059669',
                  }"
                ></div>
              </div>
              <el-tag
                :type="row.queueLength > 300 ? 'danger' : row.queueLength > 100 ? 'warning' : 'success'"
                size="small"
              >
                {{ row.queueLength }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="goTransfers(row.fromId)">
              查看轉帳 →
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- No Hot Accounts -->
    <div class="card" v-else-if="systemStore.queueStats !== null">
      <div style="display:flex; align-items:center; gap:16px; padding:12px 0;">
        <div style="font-size:32px">✅</div>
        <div>
          <div style="font-weight:600; color:#059669">Queue 狀態正常</div>
          <div style="font-size:13px; color:#6b7280; margin-top:2px">目前沒有壅塞的帳號，系統運行順暢</div>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div class="card" v-if="systemStore.queueStats === null">
      <el-skeleton :rows="4" animated />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSystemStore } from '@/stores/system'

const systemStore = useSystemStore()
const router = useRouter()

const hotAccounts = computed(() => systemStore.queueStats?.hotAccounts ?? [])
const hotCount = computed(() => hotAccounts.value.length)

const queuePct = computed(() => {
  const jobs = systemStore.queueStats?.totalJobs ?? 0
  return Math.min(Math.round((jobs / 1000) * 100), 100)
})

const queueColor = computed(() => {
  const j = systemStore.queueStats?.totalJobs ?? 0
  if (j === 0) return '#059669'
  if (j < 100) return '#d97706'
  return '#dc2626'
})

const workerColor = computed(() => {
  const w = systemStore.queueStats?.workers ?? 0
  return w > 0 ? '#059669' : '#dc2626'
})

function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString('zh-TW') }
function goAccount(id: number) { router.push(`/accounts/${id}`) }
function goTransfers(id: number) { router.push({ path: '/transfers', query: { accountId: String(id) } }) }

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  systemStore.refresh()
  timer = setInterval(() => systemStore.refresh(), 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.live-badge {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: #6b7280;
  padding: 4px 10px; border-radius: 20px;
  background: #f3f4f6;
}
.live-badge.live { color: #059669; background: #ecfdf5; }
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor; animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-ok { border: 1px solid #a7f3d0; }
.status-error { border: 1px solid #fca5a5; }
.status-warn { border: 1px solid #fcd34d; }

.health-row { margin-bottom: 16px; }
.health-label {
  display: flex; justify-content: space-between;
  font-size: 13px; color: #6b7280; margin-bottom: 8px;
}
.health-bar-wrap {
  height: 8px; background: #f3f4f6; border-radius: 4px; overflow: hidden;
}
.health-bar {
  height: 100%; border-radius: 4px; transition: width 0.5s ease;
}

.health-stats {
  display: flex; gap: 0;
  border: 1px solid #f3f4f6; border-radius: 10px; overflow: hidden;
}
.hs-item {
  flex: 1; padding: 14px; text-align: center;
  border-right: 1px solid #f3f4f6;
}
.hs-item:last-child { border-right: none; }
.hs-num { font-size: 22px; font-weight: 700; color: #1a202c; }
.hs-label { font-size: 12px; color: #9ca3af; margin-top: 2px; }

.queue-bar-wrap {
  flex: 1; height: 6px; background: #f3f4f6; border-radius: 3px; overflow: hidden;
}
.queue-bar { height: 100%; border-radius: 3px; transition: width 0.3s; }
</style>
