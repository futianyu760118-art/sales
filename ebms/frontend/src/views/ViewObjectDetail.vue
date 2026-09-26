<script setup>
// F11（PAND-89）：任一视图对象的落地页 + 交叉跳转入口。
// 四类视图共用本组件：类型差异由后端下发的 label/landingPath 与对象字段决定。
import { computed, ref, watch } from 'vue';
import { api } from '../api/client';
import { buildNavModel, NO_LINK_HINT } from '../view-nav';
import ViewNavBar from '../components/ViewNavBar.vue';

const props = defineProps({
  objectType: { type: String, required: true },
  objectId: { type: String, required: true },
});
const emit = defineEmits(['navigate']);

const object = ref(null);
const nav = ref(null);
const loading = ref(false);
const error = ref('');

const model = computed(() => buildNavModel(nav.value));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [detail, navigation] = await Promise.all([
      api.viewObject(props.objectType, props.objectId),
      api.viewNavigation(props.objectType, props.objectId),
    ]);
    object.value = detail;
    nav.value = navigation;
  } catch (err) {
    object.value = null;
    nav.value = null;
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.objectType, props.objectId], load, { immediate: true });
</script>

<template>
  <div class="view">
    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="error" class="alert alert-error">{{ error }}</p>

    <template v-else-if="object">
      <header class="view-header">
        <div>
          <span class="badge">{{ object.typeLabel }}</span>
          <h2 class="view-title">{{ object.title }}</h2>
          <p class="muted">
            <code>{{ object.code }}</code>
            <span v-if="object.owner"> · {{ object.owner }}</span>
          </p>
        </div>
      </header>

      <p v-if="object.subtitle" class="content-text">{{ object.subtitle }}</p>

      <ViewNavBar :model="model" @navigate="(href) => emit('navigate', href)" />

      <p v-if="model.total === 0" class="alert alert-info">
        该对象暂无关联对象，三个跳转入口均已置灰（{{ NO_LINK_HINT }}）。
      </p>
    </template>

    <p v-else class="muted">未找到该对象。</p>
  </div>
</template>
