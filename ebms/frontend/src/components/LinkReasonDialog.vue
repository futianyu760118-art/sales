<script setup>
// 边界「未归因」时的关联入口：把原因项关联到结果指标。
import { reactive, ref } from 'vue';
import { api } from '../api/client.js';

const props = defineProps({
  metricId: { type: String, required: true },
  metricName: { type: String, default: '' },
  parentId: { type: String, default: null },
  parentName: { type: String, default: '' },
});

const emit = defineEmits(['linked', 'close']);

const DIRECTION_OPTIONS = [
  { value: 'negative', label: '负向' },
  { value: 'positive', label: '正向' },
  { value: 'neutral', label: '中性' },
];

const form = reactive({
  name: '',
  direction: 'negative',
  contribution_pct: '',
  impact_value: '',
  owner: '',
});

const submitting = ref(false);
const errorMessage = ref('');

async function submit() {
  errorMessage.value = '';
  const toNumber = (value) => (value === '' || value === null ? null : Number(value));
  submitting.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      direction: form.direction,
      contribution_pct: toNumber(form.contribution_pct),
      impact_value: toNumber(form.impact_value),
      owner: form.owner.trim(),
    };
    if (props.parentId) payload.parent_id = props.parentId;
    const res = await api.linkReasons(props.metricId, { reasons: [payload] });
    emit('linked', res);
  } catch (err) {
    // 例如：影响方向非法、合计超出 100% —— 后端校验错误如实回显
    errorMessage.value = err.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="dialog-backdrop" data-testid="link-dialog">
    <form class="dialog" @submit.prevent="submit">
      <h3 class="dialog__title">
        关联原因
        <span class="dialog__subject">{{ parentId ? parentName : metricName }}</span>
      </h3>

      <label class="field">
        <span>原因名称 *</span>
        <input v-model="form.name" name="name" required data-testid="field-name" />
      </label>

      <label class="field">
        <span>影响方向 *</span>
        <select v-model="form.direction" name="direction" data-testid="field-direction">
          <option v-for="opt in DIRECTION_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </label>

      <label class="field">
        <span>贡献占比（%）</span>
        <input v-model="form.contribution_pct" name="contribution_pct" type="number" step="0.01" min="0" max="100" />
      </label>

      <label class="field">
        <span>影响量</span>
        <input v-model="form.impact_value" name="impact_value" type="number" step="0.01" />
      </label>

      <label class="field">
        <span>责任方 *</span>
        <input v-model="form.owner" name="owner" required data-testid="field-owner" />
      </label>

      <p class="dialog__hint">影响量与贡献占比至少填写一项；影响方向仅限 正向 / 负向 / 中性。</p>
      <p v-if="errorMessage" class="dialog__error" role="alert" data-testid="dialog-error">{{ errorMessage }}</p>

      <div class="dialog__actions">
        <button type="button" class="btn" @click="emit('close')">取消</button>
        <button type="submit" class="btn btn--primary" :disabled="submitting">
          {{ submitting ? '提交中…' : '关联' }}
        </button>
      </div>
    </form>
  </div>
</template>
