<script setup>
// PAND-92：引用位置上的来源标注。来源中心名称 + 结论时间 / 版本取自中心结论快照字段，
// EBMS 不推算；来源不可用时显示「来源不可用」（不使用 — / 空白占位）。
defineProps({
  sourceLabel: { type: Object, required: true },
});
</script>

<template>
  <span
    class="source-label"
    :class="{ 'source-label--unavailable': !sourceLabel.available }"
    data-testid="source-label"
    :data-center="sourceLabel.center"
    :data-available="String(sourceLabel.available)"
  >
    <span class="source-label__text" data-testid="source-label-text">{{ sourceLabel.label }}</span>
    <span
      v-if="!sourceLabel.available && sourceLabel.unavailable_reason_label"
      class="source-label__reason"
      data-testid="source-label-reason"
    >
      （{{ sourceLabel.unavailable_reason_label }}）
    </span>
  </span>
</template>
