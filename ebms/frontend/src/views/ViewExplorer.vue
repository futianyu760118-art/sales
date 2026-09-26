<script setup>
// F11（PAND-89）：四视图浏览与交叉跳转的外壳。
// 负责：类型切换、对象清单、hash 路由（#/report/<id> …），使跳转落点可直达、可回退。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api/client';
import { hashFor, parseHash } from '../view-nav';
import ViewObjectDetail from './ViewObjectDetail.vue';

const types = ref([]);
const activeType = ref('');
const objects = ref([]);
const selectedId = ref('');
const loading = ref(false);
const error = ref('');

const activeTypeMeta = computed(() => types.value.find((t) => t.code === activeType.value) || null);

async function loadTypes() {
  types.value = await api.viewObjectTypes();
  if (!activeType.value && types.value.length) activeType.value = types.value[0].code;
}

async function loadObjects() {
  if (!activeType.value) return;
  loading.value = true;
  error.value = '';
  try {
    objects.value = await api.viewObjects(activeType.value);
    const stillThere = objects.value.some((o) => o.id === selectedId.value);
    if (!stillThere) selectedId.value = objects.value[0]?.id || '';
  } catch (err) {
    error.value = err.message;
    objects.value = [];
    selectedId.value = '';
  } finally {
    loading.value = false;
  }
}

/** 跳转：写入 hash，由 hashchange 统一驱动选中项（含浏览器回退）。 */
function navigate(landingHref) {
  const next = hashFor(landingHref);
  if (location.hash === next) applyRoute();
  else location.hash = next;
}

function applyRoute() {
  const route = parseHash(location.hash);
  if (!route || !types.value.some((t) => t.code === route.type)) return false;
  activeType.value = route.type;
  selectedId.value = route.id;
  return true;
}

async function onHashChange() {
  const previousType = activeType.value;
  if (!applyRoute()) return;
  // 同类型内的跳转只需切换选中项，无需重新拉取清单
  if (activeType.value !== previousType) await loadObjects();
}

function selectType(code) {
  if (code === activeType.value) return;
  activeType.value = code;
  selectedId.value = '';
  loadObjects();
}

function selectObject(id) {
  selectedId.value = id;
  const meta = activeTypeMeta.value;
  if (meta) location.hash = hashFor(`${meta.landingPath}/${id}`);
}

onMounted(async () => {
  try {
    await loadTypes();
    // 支持直达链接（#/report/<id>）：先按 hash 定位，否则落在该类型首个对象。
    applyRoute();
    await loadObjects();
  } catch (err) {
    error.value = err.message;
  }
  window.addEventListener('hashchange', onHashChange);
});

onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange));
</script>

<template>
  <aside class="rail">
    <h2 class="rail-title">{{ activeTypeMeta?.fullLabel || '视图对象' }}</h2>

    <div class="type-tabs">
      <button
        v-for="t in types"
        :key="t.code"
        type="button"
        class="btn btn-ghost btn-sm"
        :class="{ active: t.code === activeType }"
        @click="selectType(t.code)"
      >
        {{ t.label }}
      </button>
    </div>

    <p v-if="loading" class="muted">加载中…</p>
    <ul v-else class="rail-list">
      <li v-for="o in objects" :key="o.id">
        <button
          type="button"
          class="rail-item"
          :class="{ active: o.id === selectedId }"
          @click="selectObject(o.id)"
        >
          <span class="rail-name">{{ o.title }}</span>
          <span class="rail-count">{{ o.code }}</span>
        </button>
      </li>
    </ul>
    <p v-if="!loading && objects.length === 0" class="muted">该视图暂无对象。</p>
  </aside>

  <section class="content">
    <p v-if="error" class="alert alert-error">{{ error }}</p>
    <ViewObjectDetail
      v-if="activeType && selectedId"
      :key="`${activeType}:${selectedId}`"
      :object-type="activeType"
      :object-id="selectedId"
      @navigate="navigate"
    />
    <p v-else class="muted">请选择左侧视图对象。</p>
  </section>
</template>
