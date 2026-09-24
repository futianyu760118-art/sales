<script setup>
import { reactive, ref } from 'vue';
import { api } from '../api/client';

const props = defineProps({
  reasonId: { type: String, required: true },
  reasonName: { type: String, default: '' },
  types: { type: Array, required: true },
});
const emit = defineEmits(['close', 'created']);

const form = reactive({
  type: props.types[0]?.code || '',
  title: '',
  formedAt: '',
  owner: '',
  content: '',
});
const submitting = ref(false);
const error = ref('');
const fieldErrors = ref({});

async function submit() {
  error.value = '';
  fieldErrors.value = {};
  submitting.value = true;
  try {
    const result = await api.createEvidence({
      type: form.type,
      title: form.title,
      // 以本地时间语义提交，避免时区偏移
      formedAt: form.formedAt ? new Date(form.formedAt).toISOString() : '',
      owner: form.owner,
      content: form.content,
      reasonId: props.reasonId,
    });
    emit('created', result);
  } catch (err) {
    error.value = err.message;
    // 后端一次性返回全部字段错误，逐项提示；无 fields 时回退到错误码映射。
    const fields = err.details?.fields;
    if (fields) {
      fieldErrors.value = { ...fields };
    } else if (err.code === 'EVIDENCE_TITLE_REQUIRED') {
      fieldErrors.value.title = err.message;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="新增证据">
      <header class="dialog-header">
        <h2>新增证据</h2>
        <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <p class="muted">新增后自动关联到原因项：<strong>{{ reasonName }}</strong></p>

      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span>证据类型 <em>*</em></span>
          <select v-model="form.type">
            <option v-for="t in types" :key="t.code" :value="t.code">{{ t.label }}</option>
          </select>
          <small v-if="fieldErrors.type" class="field-error">{{ fieldErrors.type }}</small>
        </label>

        <label class="field">
          <span>标题 <em>*</em></span>
          <input v-model="form.title" type="text" placeholder="例如：采购框架合同 SC-2026-014" />
          <small v-if="fieldErrors.title" class="field-error">{{ fieldErrors.title }}</small>
        </label>

        <label class="field">
          <span>形成时间 <em>*</em></span>
          <input v-model="form.formedAt" type="datetime-local" />
          <small v-if="fieldErrors.formedAt" class="field-error">{{ fieldErrors.formedAt }}</small>
        </label>

        <label class="field">
          <span>责任人 <em>*</em></span>
          <input v-model="form.owner" type="text" placeholder="例如：生产中心 / 赵计划" />
          <small v-if="fieldErrors.owner" class="field-error">{{ fieldErrors.owner }}</small>
        </label>

        <label class="field">
          <span>文本说明</span>
          <textarea v-model="form.content" rows="4" placeholder="人工说明类证据请填写说明内容"></textarea>
        </label>

        <p v-if="error" class="alert alert-error">{{ error }}</p>

        <footer class="dialog-footer">
          <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn btn-primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '保存并关联' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
