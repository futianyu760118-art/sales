<script setup>
// F11（PAND-89）：四视图对象交叉跳转入口。
// 每个目标类型一组：有关联则逐个落点可点击，无关联则入口置灰并提示「无关联」。
import { computed } from 'vue';

const props = defineProps({
  model: { type: Object, required: true },
});
const emit = defineEmits(['navigate']);

const entries = computed(() => props.model.entries);

function open(link) {
  emit('navigate', link.href);
}
</script>

<template>
  <nav class="view-nav" aria-label="关联视图跳转">
    <span class="view-nav-title">关联跳转</span>

    <div
      v-for="entry in entries"
      :key="entry.targetType"
      class="view-nav-group"
      :class="{ disabled: entry.disabled }"
    >
      <span class="view-nav-label">{{ entry.label }}</span>

      <template v-if="entry.links.length">
        <button
          v-for="link in entry.links"
          :key="link.id"
          type="button"
          class="view-nav-link"
          :title="`跳转到 ${entry.fullLabel}：${link.title}`"
          @click="open(link)"
        >
          <span class="badge">{{ link.badge }}</span>
          <span class="view-nav-link-title">{{ link.title }}</span>
          <code class="muted">{{ link.code }}</code>
        </button>
      </template>

      <span v-else class="view-nav-hint" aria-disabled="true" :title="entry.hint">
        {{ entry.hint }}
      </span>
    </div>
  </nav>
</template>
