import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { layout: 'blank' },
    },
    {
      path: '/banking',
      name: 'banking',
      component: () => import('@/views/BankingView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/monitor',
      name: 'monitor',
      component: () => import('@/views/MonitorView.vue'),
    },
    {
      path: '/accounts/:id?',
      name: 'accounts',
      component: () => import('@/views/AccountView.vue'),
    },
    {
      path: '/transfers',
      name: 'transfers',
      component: () => import('@/views/TransfersView.vue'),
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
})

export default router
