<script setup>
// AC 场景 3：反向结果每一项都可继续跳转到正向导航对应位置。
const props = defineProps({
  item: { type: Object, required: true },
  label: { type: String, default: '跳转到正向导航' },
});

const emit = defineEmits(['jump']);
</script>

<template>
  <button
    v-if="item.forwardTarget"
    type="button"
    class="jump"
    :data-segment="item.forwardTarget.segment"
    :title="`${item.forwardTarget.segmentLabel} · ${item.forwardTarget.contract}`"
    @click="emit('jump', item)"
  >
    {{ label }}
    <span class="jump__target">
      第 {{ item.forwardTarget.segment }} 段 · {{ item.forwardTarget.segmentLabel }}
    </span>
  </button>
</template>
