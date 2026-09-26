<script setup>
import { computed, onMounted, ref } from 'vue';

import { api } from './api/client.js';
import {
  ENTRY_MODES,
  createReverseNavigationStore,
  summarize,
} from './stores/reverseNavigation.js';

import ChainBreadcrumb from './components/ChainBreadcrumb.vue';
import AttributionCard from './components/AttributionCard.vue';
import ResultCard from './components/ResultCard.vue';
import EvidenceStrip from './components/EvidenceStrip.vue';
import EmptyStateNotice from './components/EmptyStateNotice.vue';

const store = createReverseNavigationStore({ api });
const { state } = store;

const sourceSystems = ref([]);
const summary = computed(() => summarize(state.result));
const isReversePayload = computed(() => Boolean(state.result?.entry && state.result.attributions));

onMounted(async () => {
  try {
    const payload = await api.get('/trace/source-systems');
    sourceSystems.value = payload.sourceSystems ?? [];
  } catch {
    sourceSystems.value = [];
  }
});

function onJump(item) {
  store.navigateForward(item);
}
</script>

<template>
  <main class="page">
    <header class="page__head">
      <h1>反向链路查询</h1>
      <p class="page__sub">
        从 Source 或 Evidence 反向查到其影响的原因项与最终结果指标 ——
        沿契约链 <code>Result ← Exception（归因）← Evidence ← source_system</code>，只读。
      </p>
    </header>

    <section class="panel">
      <div class="modes" role="tablist">
        <button
          v-for="mode in ENTRY_MODES"
          :key="mode.key"
          type="button"
          role="tab"
          class="modes__btn"
          :class="{ 'modes__btn--active': state.mode === mode.key }"
          :aria-selected="state.mode === mode.key"
          @click="store.setMode(mode.key)"
        >
          {{ mode.label }}
        </button>
      </div>

      <p class="panel__hint">
        {{ ENTRY_MODES.find((m) => m.key === state.mode)?.hint }}
      </p>

      <form class="query" @submit.prevent="store.run()">
        <input
          :value="state.input"
          class="query__input"
          :placeholder="ENTRY_MODES.find((m) => m.key === state.mode)?.placeholder"
          :aria-label="ENTRY_MODES.find((m) => m.key === state.mode)?.field"
          list="source-system-options"
          @input="store.setInput($event.target.value)"
        />
        <datalist v-if="state.mode === 'source_system'" id="source-system-options">
          <option v-for="value in sourceSystems" :key="value" :value="value" />
        </datalist>
        <button class="query__submit" type="submit" :disabled="state.loading">
          {{ state.loading ? '查询中…' : '反查' }}
        </button>
      </form>

      <p v-if="state.error" class="error">{{ state.error.message }}（{{ state.error.code }}）</p>
    </section>

    <ChainBreadcrumb :position="state.position" />

    <section v-if="isReversePayload && state.result.state === 'EMPTY'">
      <EmptyStateNotice :empty="state.result.empty" :position="state.position" />
    </section>

    <template v-else-if="isReversePayload">
      <section class="summary">
        <span>原因项 <strong>{{ summary.attributionCount }}</strong></span>
        <span>最终结果指标 <strong>{{ summary.resultCount }}</strong></span>
        <span>证据 <strong>{{ summary.evidenceCount }}</strong></span>
        <span class="summary__split">
          其中 映射至 Exception <strong>{{ summary.exceptionBackedCount }}</strong> ·
          M03 自有归因分析 <strong>{{ summary.m03AnalysisCount }}</strong>
        </span>
      </section>

      <section v-if="state.result.notices?.length" class="notices">
        <p v-for="notice in state.result.notices" :key="notice.code" class="notice">
          {{ notice.message }}
        </p>
      </section>

      <section class="block">
        <h2>关联的证据</h2>
        <EvidenceStrip :evidences="state.result.evidences" @jump="onJump" />
      </section>

      <section class="block">
        <h2>影响的原因项</h2>
        <div class="cards">
          <AttributionCard
            v-for="attribution in state.result.attributions"
            :key="attribution.attributionId"
            :attribution="attribution"
            @jump="onJump"
          />
        </div>
      </section>

      <section class="block">
        <h2>最终结果指标</h2>
        <div class="cards">
          <ResultCard
            v-for="result in state.result.results"
            :key="result.metricId"
            :result="result"
            @jump="onJump"
          />
        </div>
      </section>
    </template>

    <p v-if="state.jump" class="jumpbar">
      正向导航落点已解析：第 {{ state.jump.segment }} 段 · {{ state.jump.segmentLabel }}
      （{{ state.jump.contract }}）
      <code>{{ state.jump.path }}</code>
    </p>
  </main>
</template>
