<script setup>
// 反向链路的位置指示：空态与有结果态都渲染，保证「保留当前位置」可见。
defineProps({
  position: { type: Object, default: null },
});
</script>

<template>
  <nav v-if="position" class="breadcrumb" aria-label="当前位置">
    <ol>
      <li
        v-for="segment in position.breadcrumb"
        :key="segment.segment"
        class="crumb"
        :class="{ 'crumb--anchor': segment.segment === position.breadcrumb[0].segment }"
      >
        <span class="crumb__label">{{ segment.label }}</span>
        <span class="crumb__contract">{{ segment.contract }}</span>
      </li>
    </ol>
    <p class="breadcrumb__anchor">
      当前锚点：<strong>{{ position.label }}</strong>
      <span class="badge">{{ position.anchorType === 'source_system' ? '来源系统' : '证据' }}</span>
    </p>
  </nav>
</template>
