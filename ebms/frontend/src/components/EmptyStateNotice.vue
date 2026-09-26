<script setup>
// AC 边界：未关联任何归因项时显示空态并保留当前位置，不得回落到专业原始表查询。
defineProps({
  empty: { type: Object, required: true },
  position: { type: Object, default: null },
});
</script>

<template>
  <section class="empty" role="status">
    <h3 class="empty__title">{{ empty.message }}</h3>
    <p class="empty__hint">{{ empty.hint }}</p>
    <p class="empty__keep">
      当前位置已保留：
      <strong>{{ position?.label }}</strong>
      <span v-if="position">（{{ position.anchorType === 'source_system' ? '来源系统' : '证据' }}）</span>
    </p>
    <p class="empty__policy">未回落到专业原始表查询</p>
  </section>
</template>
