<script setup>
import ForwardJumpButton from './ForwardJumpButton.vue';

defineProps({
  result: { type: Object, required: true },
});
const emit = defineEmits(['jump']);

function deviation(result) {
  if (result.target == null || result.actual == null) return null;
  const abs = result.actual - result.target;
  const pct = result.target === 0 ? null : (abs / result.target) * 100;
  return { abs, pct };
}
</script>

<template>
  <article class="card card--result">
    <header class="card__head">
      <h3 class="card__title">{{ result.name }}</h3>
      <span class="tag tag--result">Result 契约</span>
    </header>

    <dl class="card__meta">
      <div>
        <dt>指标编码</dt>
        <dd><code>{{ result.code }}</code></dd>
      </div>
      <div>
        <dt>期间</dt>
        <dd>{{ result.periodValue }}（{{ result.periodType }}）</dd>
      </div>
      <div>
        <dt>目标 / 实际</dt>
        <dd>{{ result.target }} / {{ result.actual }} {{ result.unit }}</dd>
      </div>
      <template v-if="deviation(result)">
        <div>
          <dt>偏差</dt>
          <dd>
            {{ deviation(result).abs.toFixed(2) }}
            <template v-if="deviation(result).pct != null">
              （{{ deviation(result).pct.toFixed(2) }}%）
            </template>
          </dd>
        </div>
      </template>
      <div>
        <dt>供给方</dt>
        <dd>{{ result.sourceSystem }} · {{ result.calculationVersion }}</dd>
      </div>
    </dl>

    <footer class="card__foot">
      <ForwardJumpButton :item="result" label="查看该结果指标" @jump="emit('jump', $event)" />
    </footer>
  </article>
</template>
