<template>
  <div v-if="route.meta.layout === 'blank'" class="blank-layout">
    <router-view />
  </div>

  <div v-else class="shell">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <span class="logo-icon">🏦</span>
        <span class="logo-text">SmallBank</span>
      </div>

      <nav class="sidebar-nav">
        <router-link to="/banking" class="nav-item" :class="{ disabled: !auth.isLoggedIn }">
          <span class="nav-icon">💳</span>
          <div class="nav-body">
            <span class="nav-label">網路銀行</span>
            <span class="nav-sub">{{ auth.isLoggedIn ? `帳號 #${auth.accountId}` : '請先登入' }}</span>
          </div>
        </router-link>

        <router-link to="/monitor" class="nav-item">
          <span class="nav-icon">📊</span>
          <div class="nav-body">
            <span class="nav-label">系統監控</span>
            <span class="nav-sub">即時負載狀態</span>
          </div>
        </router-link>

        <router-link to="/accounts" class="nav-item">
          <span class="nav-icon">🔍</span>
          <div class="nav-body">
            <span class="nav-label">帳號查詢</span>
            <span class="nav-sub">餘額與交易明細</span>
          </div>
        </router-link>

        <router-link to="/transfers" class="nav-item">
          <span class="nav-icon">💸</span>
          <div class="nav-body">
            <span class="nav-label">轉帳中心</span>
            <span class="nav-sub">提交與查詢轉帳</span>
          </div>
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <div v-if="auth.isLoggedIn" class="user-chip" @click="handleLogout">
          <div class="avatar">{{ String(auth.accountId).slice(-2) }}</div>
          <div class="user-info">
            <span class="user-id">帳號 #{{ auth.accountId }}</span>
            <span class="logout-hint">點擊登出</span>
          </div>
        </div>
        <router-link v-else to="/" class="login-btn">登入帳號</router-link>
      </div>
    </aside>

    <!-- Main -->
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

function handleLogout() {
  auth.logout()
  router.push('/')
}
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', sans-serif;
  background: #f0f2f5;
  color: #1a202c;
}

.blank-layout {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.shell {
  display: flex;
  min-height: 100vh;
}

/* ── Sidebar ── */
.sidebar {
  width: 240px;
  background: #1e2130;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: fixed;
  top: 0; left: 0; bottom: 0;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 20px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.logo-icon { font-size: 24px; }
.logo-text { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 0.5px; }

.sidebar-nav {
  flex: 1;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  text-decoration: none;
  transition: background 0.15s;
  cursor: pointer;
}
.nav-item:hover { background: rgba(255,255,255,0.07); }
.nav-item.router-link-active { background: rgba(99,102,241,0.25); }
.nav-item.router-link-active .nav-label { color: #a5b4fc; }
.nav-item.disabled { opacity: 0.45; pointer-events: none; }

.nav-icon { font-size: 18px; width: 24px; text-align: center; flex-shrink: 0; }
.nav-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.nav-label { font-size: 14px; font-weight: 500; color: #e2e8f0; }
.nav-sub { font-size: 11px; color: #718096; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.user-chip:hover { background: rgba(255,255,255,0.07); }
.avatar {
  width: 34px; height: 34px;
  background: #4f46e5;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: #fff;
  flex-shrink: 0;
}
.user-info { display: flex; flex-direction: column; }
.user-id { font-size: 13px; font-weight: 500; color: #e2e8f0; }
.logout-hint { font-size: 11px; color: #718096; }
.login-btn {
  display: block;
  text-align: center;
  padding: 10px;
  background: #4f46e5;
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.15s;
}
.login-btn:hover { background: #4338ca; }

/* ── Main Content ── */
.main-content {
  flex: 1;
  margin-left: 240px;
  padding: 32px;
  min-height: 100vh;
  max-width: calc(100vw - 240px);
}

/* ── Common Components ── */
.page-header { margin-bottom: 28px; }
.page-header h1 { font-size: 24px; font-weight: 700; color: #1a202c; }
.page-header p { font-size: 14px; color: #718096; margin-top: 4px; }

.card {
  background: #fff;
  border-radius: 14px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
  margin-bottom: 20px;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.metric-card {
  background: #fff;
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
}
.metric-card .label { font-size: 12px; color: #718096; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
.metric-card .value { font-size: 28px; font-weight: 700; color: #1a202c; margin: 6px 0 4px; line-height: 1; }
.metric-card .sub { font-size: 12px; color: #a0aec0; }

/* Row highlight */
.row-warning td { background-color: #fffbeb !important; }
.row-danger td { background-color: #fff5f5 !important; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 3px; }
</style>
