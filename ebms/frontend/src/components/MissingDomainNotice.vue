<script setup>
// 边界：某专业中心数据缺失时的标注。缺失域不参与判断，但不阻断其余域输出。
defineProps({
  centerLabel: { type: String, default: '' },
  label: { type: String, default: '该域数据缺失' },
  reasonLabel: { type: String, default: '' },
});
</script>

<template>
  <p class="domain-missing" data-testid="domain-missing-notice">
    <span class="domain-missing__label" data-testid="domain-missing-label">{{ label }}</span>
    <span v-if="centerLabel" class="domain-missing__center">{{ centerLabel }}</span>
    <span v-if="reasonLabel" class="domain-missing__reason">原因：{{ reasonLabel }}</span>
  </p>
</template>
