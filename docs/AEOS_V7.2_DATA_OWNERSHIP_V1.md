# AEOS V7.2 — EBMS Data Ownership V1

## 原则
EBMS 可读经营结果，但不是所有业务数据的 Owner。跨域数据不得因“查询方便”就复制成新的事实源。

| Business Object / Metric | Accountable Owner | EBMS 权限 |
|---|---|---|
| Customer / Inquiry / Quote | M05 销售自治 | Read Result / Exception |
| Sales Order 商务状态 | M05 | Read |
| Delivery Order / Schedule | M06 交付自治 | Read Result / Exception |
| Product / Project / BOM / ECO | M04 研发自治 | Read Result / Exception |
| Material / Supplier / Procurement | M06；主数据规则由 M02 管理 | Read |
| Revenue / Cost / Gross Margin / Cash / AR/AP | M09 财经自治 | Read Result only |
| Identity / Org / Role / Permission | M01 Kernel | Consume |
| Business Object Registry / Event / Evidence / Audit | M02 | Consume / append according to contract |
| Connector / External Sync | M11 | Consume |
| Management Goal / Decision / Action / Review | M03 EBMS | Own |

## 临时规则
现有 JSON 表暂不强制搬迁，但新增字段和新逻辑必须先标注 Owner。
跨域直读属于迁移期技术债，不得继续扩大。
专业指标必须记录 calculation_version 与 evidence_ids，避免多个系统出现多个答案。