<script setup>
import ForwardJumpButton from './ForwardJumpButton.vue';

defineProps({
  evidences: { type: Array, default: () => [] },
});
const emit = defineEmits(['jump']);
</script>

<template>
  <ul class="strip">
    <li v-for="evidence in evidences" :key="evidence.evidenceId" class="strip__item">
      <div class="strip__head">
        <code class="strip__id">{{ evidence.evidenceId }}</code>
        <span class="tag tag--evidence">{{ evidence.typeLabel }}</span>
      </div>
      <p class="strip__title">{{ evidence.title }}</p>
      <p class="strip__meta">
        形成时间 {{ evidence.formedAt }} · 责任人 {{ evidence.owner ?? '—' }}
      </p>
      <p class="strip__source" :class="{ 'strip__source--none': !evidence.sourceLabelled }">
        来源：{{ evidence.sourceLabel }}
      </p>
      <ForwardJumpButton :item="evidence" label="查看该证据" @jump="emit('jump', $event)" />
    </li>
  </ul>
</template>
