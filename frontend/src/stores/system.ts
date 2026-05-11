import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchHealth, fetchGlobalQueueStats } from '@/api'
import type { GlobalQueueStats } from '@/types'

export const useSystemStore = defineStore('system', () => {
  // ── 狀態 ─────────────────────────────────────────────
  const healthy = ref<boolean | null>(null)
  const lastChecked = ref<number | null>(null)
  const queueStats = ref<GlobalQueueStats | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // ── 計算屬性 ──────────────────────────────────────────
  const hasPendingJobs = computed(() => (queueStats.value?.totalJobs ?? 0) > 0)
  const hotAccountCount = computed(() => queueStats.value?.hotAccounts.length ?? 0)

  // ── 動作 ─────────────────────────────────────────────
  async function refresh() {
    loading.value = true
    error.value = null

    try {
      const [health, stats] = await Promise.allSettled([
        fetchHealth(),
        fetchGlobalQueueStats(),
      ])

      if (health.status === 'fulfilled') {
        healthy.value = health.value.ok
        lastChecked.value = health.value.ts
      } else {
        healthy.value = false
      }

      if (stats.status === 'fulfilled') {
        queueStats.value = stats.value
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '無法連線至 API'
      healthy.value = false
    } finally {
      loading.value = false
    }
  }

  return {
    healthy,
    lastChecked,
    queueStats,
    loading,
    error,
    hasPendingJobs,
    hotAccountCount,
    refresh,
  }
})
