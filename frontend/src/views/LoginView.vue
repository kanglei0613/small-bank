<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">🏦</div>
        <h1>SmallBank</h1>
        <p>請輸入您的帳號 ID 以進入網路銀行</p>
      </div>

      <el-form @submit.prevent="handleLogin" class="login-form">
        <div class="field-label">帳號 ID</div>
        <el-input-number
          v-model="inputId"
          :min="1"
          :controls="false"
          placeholder="例如：1"
          size="large"
          class="login-input"
          @keyup.enter="handleLogin"
        />
        <div v-if="error" class="login-error">{{ error }}</div>
        <el-button
          type="primary"
          size="large"
          class="login-btn-main"
          :loading="loading"
          @click="handleLogin"
        >
          進入帳戶
        </el-button>
      </el-form>

      <div class="login-divider">
        <span>或跳過帳戶</span>
      </div>

      <div class="quick-links">
        <router-link to="/monitor" class="quick-link">
          <span>📊</span> 系統監控
        </router-link>
        <router-link to="/accounts" class="quick-link">
          <span>🔍</span> 帳號查詢
        </router-link>
        <router-link to="/transfers" class="quick-link">
          <span>💸</span> 轉帳中心
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const inputId = ref<number | undefined>(undefined)
const loading = ref(false)
const error = ref('')

async function handleLogin() {
  if (!inputId.value) {
    error.value = '請輸入帳號 ID'
    return
  }
  error.value = ''
  loading.value = true
  try {
    await auth.login(inputId.value)
    const redirect = route.query.redirect as string | undefined
    router.push(redirect || '/banking')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '帳號不存在，請確認 ID 是否正確'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.login-card {
  background: #fff;
  border-radius: 20px;
  padding: 48px 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}
.login-logo {
  font-size: 48px;
  margin-bottom: 12px;
}
.login-header h1 {
  font-size: 28px;
  font-weight: 800;
  color: #1a202c;
  margin-bottom: 8px;
}
.login-header p {
  font-size: 14px;
  color: #718096;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #4a5568;
}
.login-input {
  width: 100%;
}
:deep(.login-input .el-input__wrapper) {
  border-radius: 10px;
  font-size: 18px;
  height: 52px;
  padding: 0 16px;
}

.login-error {
  font-size: 13px;
  color: #e53e3e;
  padding: 8px 12px;
  background: #fff5f5;
  border-radius: 8px;
  border: 1px solid #feb2b2;
}

.login-btn-main {
  width: 100%;
  height: 52px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  margin-top: 4px;
}

.login-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
  color: #a0aec0;
  font-size: 13px;
}
.login-divider::before,
.login-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e2e8f0;
}

.quick-links {
  display: flex;
  gap: 8px;
}
.quick-link {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  text-decoration: none;
  font-size: 12px;
  color: #4a5568;
  font-weight: 500;
  transition: all 0.15s;
  text-align: center;
}
.quick-link:hover {
  border-color: #4f46e5;
  color: #4f46e5;
  background: #f5f3ff;
}
.quick-link span { font-size: 18px; }
</style>
