import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchAccount } from '@/api'
import type { Account } from '@/types'

export const useAuthStore = defineStore('auth', () => {
  const accountId = ref<number | null>(null)
  const account = ref<Account | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isLoggedIn = computed(() => accountId.value !== null)

  async function login(id: number) {
    loading.value = true
    error.value = null
    try {
      const acc = await fetchAccount(id)
      accountId.value = id
      account.value = acc
    } catch (e) {
      error.value = e instanceof Error ? e.message : `帳號 #${id} 不存在`
      throw e
    } finally {
      loading.value = false
    }
  }

  async function refreshAccount() {
    if (!accountId.value) return
    try {
      account.value = await fetchAccount(accountId.value)
    } catch {
      // 靜默失敗
    }
  }

  function logout() {
    accountId.value = null
    account.value = null
    error.value = null
  }

  return { accountId, account, loading, error, isLoggedIn, login, logout, refreshAccount }
})
