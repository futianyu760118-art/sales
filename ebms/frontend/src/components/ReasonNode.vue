<script setup>
// 单条原因项（可递归）：场景 1 的字段完整性 + 场景 3 的多级展开
import { ref } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },
  // 默认展开 L1，深层折叠以体现「逐级展开」
  defaultExpanded: { type: Boolean, default: false },
});

const emit = defineEmits(['toggle-child']);

const expanded = ref(props.defaultExpanded && props.node.expandable);

// 影响方向：图标 + 文字 + 颜色三重表达，不依赖颜色单独区分
const DIRECTION_META = {
  positive: { icon: '▲', label: '正向' },
  negative: { icon: '▼', label: '负向' },
  neutral: { icon: '■', label: '中性' },
};

function directionMeta(direction, label) {
  const meta = DIRECTION_META[direction] ?? { icon: '?', label: direction };
  return { ...meta, label: label || meta.label };
}

function fmt(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function toggle() {
  expanded.value = !expanded.value;
  emit('toggle-child', { id: props.node.id, expanded: expanded.value });
}
</script>

<template>
  <li class="reason" :class="`reason--level-${node.level}`" :data-reason-id="node.id">
    <div class="reason__row">
      <button
        v-if="node.expandable"
        type="button"
        class="reason__toggle"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? '收起' : '展开'} ${node.name} 的细分原因（${node.child_count} 项）`"
        @click="toggle"
      >
        {{ expanded ? '▾' : '▸' }}
      </button>
      <span v-else class="reason__toggle reason__toggle--leaf" aria-hidden="true">·</span>

      <span class="reason__name" data-testid="reason-name">{{ node.name }}</span>
      <span class="reason__level" :title="`Reason 层第 ${node.level} 级`">Reason L{{ node.level }}</span>

      <span
        class="dir"
        :class="`dir--${node.direction}`"
        data-testid="reason-direction"
      >
        <span aria-hidden="true">{{ directionMeta(node.direction, node.direction_label).icon }}</span>
        {{ directionMeta(node.direction, node.direction_label).label }}
      </span>

      <span class="reason__metric" data-testid="reason-contribution">
        贡献占比 {{ fmt(node.contribution_pct, '%') }}
      </span>
      <span class="reason__metric" data-testid="reason-impact">
        影响量 {{ fmt(node.impact_value) }}
      </span>
      <span class="reason__owner" data-testid="reason-owner">责任方 {{ node.owner }}</span>

      <span v-if="node.expandable" class="reason__decomp">
        已细分 {{ fmt(node.decomposed_pct, '%') }}
        <template v-if="node.undecomposed_pct">（未细分 {{ node.undecomposed_pct }}%）</template>
      </span>
    </div>

    <ul v-if="node.expandable && expanded" class="reason__children" data-testid="reason-children">
      <ReasonNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :default-expanded="false"
        @toggle-child="(payload) => emit('toggle-child', payload)"
      />
    </ul>
  </li>
</template>
