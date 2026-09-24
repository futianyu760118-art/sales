<script setup>
// 场景 3：穿透链路固定四层 Result → Reason → Evidence → Source，当前位于 Reason 层
defineProps({
  layers: { type: Array, default: () => ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE'] },
  current: { type: String, default: 'REASON' },
});

const LABELS = {
  RESULT: '结果 Result',
  REASON: '原因 Reason',
  EVIDENCE: '证据 Evidence',
  SOURCE: '来源 Source',
};
</script>

<template>
  <nav class="chain" aria-label="穿透链路">
    <ol class="chain__list">
      <li
        v-for="(layer, index) in layers"
        :key="layer"
        class="chain__item"
        :class="{ 'chain__item--current': layer === current }"
        :aria-current="layer === current ? 'step' : undefined"
      >
        <span class="chain__label">{{ LABELS[layer] ?? layer }}</span>
        <span v-if="index < layers.length - 1" class="chain__sep" aria-hidden="true">›</span>
      </li>
    </ol>
    <p class="chain__hint">原因层位于固定四层链路的 Reason 层，可逐级展开查看更多细分原因。</p>
  </nav>
</template>
