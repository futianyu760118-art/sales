<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import { auditLabel, formatDateTime, formatDateTimeLong } from '../format';
import EvidenceDetailPanel from '../components/EvidenceDetailPanel.vue';
import EvidenceCreateDialog from '../components/EvidenceCreateDialog.vue';
import EvidenceLinkDialog from '../components/EvidenceLinkDialog.vue';

const props = defineProps({
  reasonId: { type: String, required: true },
  reasonName: { type: String, default: '' },
  types: { type: Array, required: true },
});
// 关联关系变化后通知外层刷新原因项计数
const emit = defineEmits(['changed']);

const data = ref(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const detail = ref(null);
const detailOpen = ref(false);
const detailLoading = ref(false);
const showCreate = ref(false);
const showLink = ref(false);
const unlinkingId = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.reasonEvidences(props.reasonId);
  } catch (err) {
    error.value = err.message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

async function openDetail(item) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await api.evidenceDetail(item.id);
  } catch (err) {
    error.value = err.message;
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  detailOpen.value = false;
  detail.value = null;
}

function openCreate() {
  notice.value = '';
  showCreate.value = true;
}

function openLink() {
  notice.value = '';
  showLink.value = true;
}

async function unlink(item) {
  unlinkingId.value = item.id;
  error.value = '';
  try {
    const result = await api.unlinkEvidence(props.reasonId, item.id);
    notice.value = `已解除关联：${item.title}（留痕已记录，操作人 ${result.audit.actorName || result.audit.actor}）`;
    await load();
    emit('changed');
  } catch (err) {
    error.value = err.message;
  } finally {
    unlinkingId.value = '';
  }
}

async function afterCreate(result) {
  showCreate.value = false;
  notice.value = `已新增并关联：${result.evidence.title}（留痕已记录）`;
  await load();
  emit('changed');
}

async function afterLink(result) {
  showLink.value = false;
  notice.value = result.alreadyLinked ? '该证据此前已关联，无需重复操作' : '已关联所选证据（留痕已记录）';
  await load();
  emit('changed');
}

watch(
  () => props.reasonId,
  () => {
    notice.value = '';
    load();
  }
);
onMounted(load);
</script>

<template>
  <section class="view">
    <div v-if="loading" class="muted">加载中…</div>
    <p v-else-if="error && !data" class="alert alert-error">{{ error }}</p>

    <template v-else-if="data">
      <header class="view-header">
        <div>
          <h2>原因项：{{ data.reason.name }}</h2>
          <p class="muted">
            责任人 {{ data.reason.owner || '—' }} · 影响方向 {{ data.reason.direction }}
            <template v-if="data.reason.contributionPct !== null">
              · 贡献占比 {{ data.reason.contributionPct }}%
            </template>
          </p>
        </div>
        <div class="view-actions">
          <button class="btn" type="button" @click="openLink">关联已有证据</button>
          <button class="btn btn-primary" type="button" @click="openCreate">新增证据</button>
        </div>
      </header>

      <!-- 边界：原因项无证据时醒目提示 -->
      <p v-if="!data.hasEvidence" class="alert alert-warning alert-prominent" role="alert">
        <strong>⚠ 无证据支撑</strong>
        <span>该原因项当前没有任何支撑证据，结论的可信度无法验证，请补充或关联证据。</span>
      </p>
      <p v-else class="alert alert-ok">
        已有 {{ data.total }} 条证据支撑（{{ data.evidenceStatusLabel }}）
      </p>

      <p v-if="notice" class="alert alert-info">{{ notice }}</p>
      <p v-if="error && data" class="alert alert-error">{{ error }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th>证据类型</th>
            <th>标题</th>
            <th>形成时间</th>
            <th>责任人</th>
            <th class="col-actions">详情入口</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="data.items.length === 0">
            <td colspan="5" class="empty-cell">无证据支撑 —— 该原因项尚未挂载任何证据。</td>
          </tr>
          <tr v-for="item in data.items" :key="item.id">
            <td><span class="tag">{{ item.typeLabel }}</span></td>
            <td class="strong">
              {{ item.title }}
              <span v-if="item.attachmentCount > 0" class="badge" :title="`含 ${item.attachmentCount} 个附件`">
                附件 {{ item.attachmentCount }}
              </span>
            </td>
            <td>{{ formatDateTime(item.formedAt) }}</td>
            <td>{{ item.owner }}</td>
            <td class="col-actions">
              <button class="btn btn-sm" type="button" @click="openDetail(item)">查看详情</button>
              <button
                class="btn btn-sm btn-danger"
                type="button"
                :disabled="unlinkingId === item.id"
                @click="unlink(item)"
              >
                {{ unlinkingId === item.id ? '处理中…' : '解除关联' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <section class="audit-section">
        <h3>操作留痕（{{ data.auditTrail.length }}）</h3>
        <p v-if="data.auditTrail.length === 0" class="muted">暂无操作记录。</p>
        <ul v-else class="audit-list">
          <li v-for="a in data.auditTrail" :key="a.id">
            <span class="audit-action">{{ auditLabel(a.action) }}</span>
            <span class="muted" :title="a.actor">操作人 {{ a.actorName || a.actor }}</span>
            <span class="muted">{{ formatDateTimeLong(a.at) }}</span>
          </li>
        </ul>
      </section>
    </template>

    <EvidenceDetailPanel
      v-if="detailOpen"
      :evidence="detail"
      :loading="detailLoading"
      @close="closeDetail"
    />
    <EvidenceCreateDialog
      v-if="showCreate"
      :reason-id="reasonId"
      :reason-name="reasonName || data?.reason?.name || ''"
      :types="types"
      @close="showCreate = false"
      @created="afterCreate"
    />
    <EvidenceLinkDialog
      v-if="showLink"
      :reason-id="reasonId"
      :reason-name="reasonName || data?.reason?.name || ''"
      @close="showLink = false"
      @linked="afterLink"
    />
  </section>
</template>
