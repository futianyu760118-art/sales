<script setup>
import ForwardJumpButton from './ForwardJumpButton.vue';

defineProps({
  attribution: { type: Object, required: true },
});
const emit = defineEmits(['jump']);
</script>

<template>
  <article class="card" :class="`card--${attribution.kind.kind}`" :data-depth="attribution.depth">
    <header class="card__head">
      <h3 class="card__title">
        <span v-if="attribution.depth > 0" class="card__indent">└</span>
        {{ attribution.name }}
      </h3>
      <span class="tag" :class="attribution.kind.kind === 'exception' ? 'tag--exc' : 'tag--m03'">
        {{ attribution.kind.label }}
      </span>
    </header>

    <dl class="card__meta">
      <div v-if="attribution.reasonCode">
        <dt>reason_code</dt>
        <dd><code>{{ attribution.reasonCode }}</code></dd>
      </div>
      <div v-if="attribution.severity">
        <dt>severity</dt>
        <dd><span class="sev" :data-sev="attribution.severity">{{ attribution.severity }}</span></dd>
      </div>
      <div>
        <dt>影响方向</dt>
        <dd>{{ attribution.directionLabel }}</dd>
      </div>
      <div>
        <dt>贡献占比</dt>
        <dd>{{ attribution.contributionPct != null ? `${attribution.contributionPct}%` : '—' }}</dd>
      </div>
      <div>
        <dt>责任方</dt>
        <dd>{{ attribution.owner }}</dd>
      </div>
      <div v-if="attribution.viaEvidenceId">
        <dt>经由证据</dt>
        <dd><code>{{ attribution.viaEvidenceId }}</code></dd>
      </div>
      <div v-if="attribution.depth > 0">
        <dt>层级</dt>
        <dd>第 {{ attribution.depth }} 级展开</dd>
      </div>
    </dl>

    <footer class="card__foot">
      <ForwardJumpButton :item="attribution" label="查看该原因项" @jump="emit('jump', $event)" />
    </footer>
  </article>
</template>
