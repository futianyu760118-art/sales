# AEOS V7.2 — EBMS Architecture Guardrails V1

状态：P0 执行门禁

## PR 必检
任何新增/修改进入 EBMS 前必须回答：
1. 这是 M03 的管理者 Result/Exception/Decision/Action/Evidence 能力吗？
2. 是否重复建设 M01/M02/M04/M05/M06/M09/M11/M12 专业能力？
3. 是否新增跨域直接写表？
4. 是否新增第二套业务事实源？
5. 专业指标是否由 Owner 模块提供 calculation_version 与 evidence_ids？
6. 是否能归入 Fact → Event → Decision → Action → Result → Evidence 闭环？
7. 是否有可验证 Evidence，而不只是“页面已完成/代码已合并”？

任一 2/3/4 为“是”，PR 默认不应合并，必须先登记迁移理由、Owner 和到期日。

## P0 完成标准
- [x] M03 Domain Boundary
- [x] Current → Target Mapping
- [x] Data Ownership 初版
- [x] Contract 目录与示例
- [ ] 指定 Accountable Owner
- [ ] 当前路由逐项打 Target Module 标签
- [ ] 跨域直读清单
- [ ] 重复事实源清单
- [ ] frontend/frontend 重复目录确认与处理

## P1 完成标准
- [ ] Result Contract 可被 dashboard 消费
- [ ] Exception Contract 可进入管理待办
- [ ] Decision → Action 可追踪
- [ ] Evidence 可关联 Result/Decision/Action
- [ ] 经营指标至少 1 个从专业模块接口供给，不由 EBMS 重算
- [ ] AI 学习仅在 Result/Evidence 验证后进入正式 Learning
- [ ] 测试/UAT/Evidence 作为 Done 必要条件

## 迁移策略
不要求本轮物理拆仓。现有功能允许以 Legacy 方式继续运行，但禁止继续扩大专业域耦合。