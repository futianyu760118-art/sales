<script setup>
import { onMounted, ref } from 'vue';
import { api, getToken, setToken } from './api/client';
import ReasonEvidenceView from './views/ReasonEvidenceView.vue';

const authed = ref(Boolean(getToken()));
const booting = ref(false);
const error = ref('');

const username = ref('owner');
const currentUser = ref(null);

const types = ref([]);
const reasons = ref([]);
const selectedReasonId = ref('');

async function bootstrap() {
  booting.value = true;
  error.value = '';
  try {
    const [typeList, reasonList] = await Promise.all([api.evidenceTypes(), api.reasons()]);
    types.value = typeList;
    reasons.value = reasonList;
    if (!selectedReasonId.value && reasonList.length > 0) {
      selectedReasonId.value = reasonList[0].id;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    booting.value = false;
  }
}

async function refreshReasons() {
  try {
    reasons.value = await api.reasons();
  } catch (err) {
    error.value = err.message;
  }
}

async function login() {
  error.value = '';
  try {
    const result = await api.devLogin(username.value);
    setToken(result.token);
    currentUser.value = result.user;
    authed.value = true;
    await bootstrap();
  } catch (err) {
    error.value = err.message;
  }
}

function logout() {
  setToken('');
  authed.value = false;
  currentUser.value = null;
}

onMounted(() => {
  if (authed.value) bootstrap();
});

const selectedReason = () => reasons.value.find((r) => r.id === selectedReasonId.value);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">EBMS</span>
        <span class="brand-sub">经营管理系统 · 原因项证据（F3）</span>
      </div>
      <div v-if="authed" class="app-user">
        <span class="muted">{{ currentUser?.displayName || '已登录' }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="logout">退出</button>
      </div>
    </header>

    <main v-if="!authed" class="login-wrap">
      <form class="card login-card" @submit.prevent="login">
        <h1>登录 EBMS</h1>
        <p class="muted">操作留痕需要可归属的操作人，请先登录。</p>
        <label class="field">
          <span>账号</span>
          <input v-model="username" type="text" placeholder="owner / decider" />
        </label>
        <p v-if="error" class="alert alert-error">{{ error }}</p>
        <button class="btn btn-primary" type="submit">登录</button>
        <p class="muted hint">开发环境账号：<code>decider</code>（决策者）、<code>owner</code>（管理责任人）</p>
      </form>
    </main>

    <main v-else class="layout">
      <aside class="rail">
        <h2 class="rail-title">原因项</h2>
        <p v-if="booting" class="muted">加载中…</p>
        <ul v-else class="rail-list">
          <li v-for="r in reasons" :key="r.id">
            <button
              type="button"
              class="rail-item"
              :class="{ active: r.id === selectedReasonId, bare: r.evidenceCount === 0 }"
              @click="selectedReasonId = r.id"
            >
              <span class="rail-name">{{ r.name }}</span>
              <span class="rail-count" :class="{ zero: r.evidenceCount === 0 }">
                {{ r.evidenceCount === 0 ? '无证据' : `${r.evidenceCount} 条` }}
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <section class="content">
        <p v-if="error" class="alert alert-error">{{ error }}</p>
        <ReasonEvidenceView
          v-if="selectedReasonId"
          :key="selectedReasonId"
          :reason-id="selectedReasonId"
          :reason-name="selectedReason()?.name || ''"
          :types="types"
          @changed="refreshReasons"
        />
        <p v-else class="muted">暂无原因项数据。</p>
      </section>
    </main>
  </div>
</template>
