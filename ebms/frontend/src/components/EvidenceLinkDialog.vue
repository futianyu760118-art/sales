<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import { formatDateTime } from '../format';

const props = defineProps({
  reasonId: { type: String, required: true },
  reasonName: { type: String, default: '' },
});
const emit = defineEmits(['close', 'linked']);

const candidates = ref([]);
const loading = ref(true);
const keyword = ref('');
const error = ref('');
const linkingId = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.evidenceCandidates(props.reasonId, keyword.value);
    candidates.value = data.items;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function link(evidence) {
  linkingId.value = evidence.id;
  error.value = '';
  try {
    const result = await api.linkEvidence(props.reasonId, evidence.id);
    emit('linked', result);
  } catch (err) {
    error.value = err.message;
  } finally {
    linkingId.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="关联已有证据">
      <header class="dialog-header">
        <h2>关联已有证据</h2>
        <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <p class="muted">选择一条证据关联到原因项：<strong>{{ reasonName }}</strong></p>

      <div class="search-row">
        <input
          v-model="keyword"
          type="search"
          placeholder="按标题或责任人筛选"
          @keyup.enter="load"
        />
        <button class="btn" type="button" @click="load">筛选</button>
      </div>

      <p v-if="error" class="alert alert-error">{{ error }}</p>

      <div v-if="loading" class="muted">加载中…</div>
      <p v-else-if="candidates.length === 0" class="muted">
        没有可关联的证据（已关联到本原因项的证据不会重复列出）。
      </p>

      <ul v-else class="candidate-list">
        <li v-for="c in candidates" :key="c.id">
          <div class="candidate-main">
            <span class="tag">{{ c.typeLabel }}</span>
            <span class="strong">{{ c.title }}</span>
            <span class="muted">{{ formatDateTime(c.formedAt) }} · {{ c.owner }}</span>
          </div>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="linkingId === c.id"
            @click="link(c)"
          >
            {{ linkingId === c.id ? '关联中…' : '关联' }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
