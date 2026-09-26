<script setup>
import { computed } from 'vue';

const props = defineProps({
  attribution: { type: Object, required: true },
});

const isFully = computed(() => props.attribution.status === 'fully_attributed');
const isUnattributed = computed(() => props.attribution.status === 'unattributed');
const total = computed(() => props.attribution.total_contribution_pct ?? 0);
</script>

<template>
  <div class="summary" data-testid="attribution-summary">
    <span class="badge" :class="`badge--${attribution.status}`" data-testid="attribution-status">
      {{ attribution.status_label }}
    </span>
    <span class="summary__count">原因项 {{ attribution.reason_count }} 条</span>

    <!-- 场景 2：完全归因时贡献占比合计为 100%（误差 ≤ 1%） -->
    <span v-if="isFully" class="summary__total" data-testid="attribution-total">
      贡献占比合计 {{ total }}%（容差 ±{{ attribution.tolerance_pct }}%，判定为完全归因）
    </span>
    <span v-else-if="!isUnattributed" class="summary__total" data-testid="attribution-total">
      贡献占比合计 {{ total }}%，未归因余量 {{ attribution.unattributed_pct }}%
    </span>
  </div>
</template>
