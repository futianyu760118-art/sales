<script setup>
import { formatBytes, formatDateTimeLong } from '../format';

const props = defineProps({
  evidence: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

function previewUrl(attachment) {
  return attachment.url;
}
function downloadUrl(attachment) {
  return `${attachment.url}?download=1`;
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog detail-panel" role="dialog" aria-modal="true" aria-label="证据详情">
      <header class="dialog-header">
        <h2>证据详情</h2>
        <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <div v-if="!evidence" class="muted">加载中…</div>

      <div v-else class="detail-body">
        <dl class="detail-grid">
          <dt>证据类型</dt>
          <dd><span class="tag">{{ evidence.typeLabel }}</span></dd>

          <dt>标题</dt>
          <dd class="strong">{{ evidence.title }}</dd>

          <dt>形成时间</dt>
          <dd>{{ formatDateTimeLong(evidence.formedAt) }}</dd>

          <dt>责任人</dt>
          <dd>{{ evidence.owner }}</dd>

          <dt>录入人 / 录入时间</dt>
          <dd>{{ evidence.createdBy }} · {{ formatDateTimeLong(evidence.createdAt) }}</dd>

          <dt v-if="evidence.linkedAt">关联时间</dt>
          <dd v-if="evidence.linkedAt">{{ formatDateTimeLong(evidence.linkedAt) }}</dd>
        </dl>

        <section class="detail-section">
          <h3>文本说明</h3>
          <p v-if="evidence.hasContent" class="content-text">{{ evidence.content }}</p>
          <p v-else class="warn-inline">
            {{ evidence.contentNotice || '本条证据无文本说明内容。' }}
          </p>
        </section>

        <section class="detail-section">
          <h3>附件（{{ evidence.attachmentCount }}）</h3>
          <p v-if="evidence.attachmentCount === 0" class="muted">无附件。</p>
          <ul v-else class="attachment-list">
            <li v-for="a in evidence.attachments" :key="a.index">
              <span class="attachment-name">{{ a.filename }}</span>
              <span class="muted">{{ formatBytes(a.sizeBytes) }}</span>
              <a class="btn btn-sm" :href="previewUrl(a)" target="_blank" rel="noopener">预览</a>
              <a class="btn btn-sm" :href="downloadUrl(a)">下载</a>
            </li>
          </ul>
        </section>
      </div>
    </section>
  </div>
</template>
