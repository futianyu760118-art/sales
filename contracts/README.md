# AEOS Contract Baseline

本目录用于把当前 EBMS 从“页面/表驱动”升级为 AEOS 契约驱动。

统一契约族：
- Object
- Event
- Result
- Exception
- Decision
- Action
- Evidence

## 最小闭环
Fact → Event → Decision → Action → Result → Evidence

## 通用字段
所有跨模块正式消息至少包含：
- contract_version
- id
- source_system
- object_type
- object_id
- occurred_at
- status
- trace_id
- evidence_ids（适用时）

不得把任意路由的临时 JSON 返回直接当成跨域正式契约。