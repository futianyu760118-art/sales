'use strict';

// 四视图对象类型 —— F11 交叉跳转的唯一取值来源。
// 口径对齐 PAND-96 重核结论：四视图 = REPORT(=Result) / TODO(=Action) / Decision / Evidence。
// 与数据库 view_object_type 枚举、前端 view-nav.js 的类型表保持一致。
//
// table      ：该类型对象的锚点表（由 PAND-85/86/87 以 ALTER TABLE 追加完整字段）
// landingPath：该类型对象在前端的落点路由（「跳转落点正确」的判定依据）
// titleField / subtitleField：列表与落点展示所用的可读字段

const VIEW_OBJECT_TYPES = Object.freeze({
  report: Object.freeze({
    code: 'report',
    label: 'REPORT',
    fullLabel: '报告',
    table: 'reports',
    landingPath: '/report',
    titleField: 'title',
    subtitleField: 'conclusion',
  }),
  todo: Object.freeze({
    code: 'todo',
    label: 'TODO',
    fullLabel: '待办事项',
    table: 'todos',
    landingPath: '/todo',
    titleField: 'title',
    subtitleField: 'status',
  }),
  decision: Object.freeze({
    code: 'decision',
    label: 'Decision',
    fullLabel: '决策',
    table: 'decisions',
    landingPath: '/decision',
    titleField: 'title',
    subtitleField: 'conclusion',
  }),
  evidence: Object.freeze({
    code: 'evidence',
    label: 'Evidence',
    fullLabel: '证据',
    table: 'evidences',
    landingPath: '/evidence',
    titleField: 'title',
    subtitleField: 'owner',
  }),
});

const VIEW_OBJECT_TYPE_CODES = Object.freeze(Object.keys(VIEW_OBJECT_TYPES));

function isValidViewObjectType(code) {
  return Object.prototype.hasOwnProperty.call(VIEW_OBJECT_TYPES, code);
}

function getViewObjectType(code) {
  return VIEW_OBJECT_TYPES[code] || null;
}

function labelOf(code) {
  return VIEW_OBJECT_TYPES[code] ? VIEW_OBJECT_TYPES[code].label : null;
}

/** 除 currentType 外的其余三类 —— 交叉跳转的入口集合（REPORT/TODO/Decision/Evidence 两两可达）。 */
function otherViewObjectTypes(currentType) {
  return VIEW_OBJECT_TYPE_CODES.filter((code) => code !== currentType).map(
    (code) => VIEW_OBJECT_TYPES[code]
  );
}

/** 供接口返回的类型清单（前端入口渲染与测试判定均取自此）。 */
function listViewObjectTypes() {
  return VIEW_OBJECT_TYPE_CODES.map((code) => {
    const type = VIEW_OBJECT_TYPES[code];
    return {
      code: type.code,
      label: type.label,
      fullLabel: type.fullLabel,
      landingPath: type.landingPath,
    };
  });
}

/** 前端落点地址：/report/<id> —— 跳转后由该视图页解析并渲染对应对象。 */
function landingHref(typeCode, objectId) {
  const type = VIEW_OBJECT_TYPES[typeCode];
  if (!type) return null;
  return `${type.landingPath}/${objectId}`;
}

module.exports = {
  VIEW_OBJECT_TYPES,
  VIEW_OBJECT_TYPE_CODES,
  isValidViewObjectType,
  getViewObjectType,
  labelOf,
  otherViewObjectTypes,
  listViewObjectTypes,
  landingHref,
};
