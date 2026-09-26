# AEOS V7.2 — EBMS Domain Boundary V1

状态：P0 架构冻结草案  
目标模块：M03 EBMS 企业经营管理与决策系统

## 1. M03 唯一定位
EBMS 是管理者的 RESULT / EXCEPTION / DECISION / ACTION / EVIDENCE 主工作面，不是超级 ERP。

## 2. EBMS 应保留
- 企业目标与经营计划
- 管理驾驶舱与经营结果
- 重大异常与风险
- 管理决策记录
- 决策后的行动跟踪
- 结果验证与证据查看
- 跨中心经营态势与 M03A 产销协同入口

## 3. EBMS 不再新增的专业能力
以下专业业务继续运行可作为迁移期 Legacy，但禁止在 M03 内继续横向扩张：
- 销售：询价、客户、报价、商务流程
- 研发：产品、项目、BOM、样品、技术转移
- 交付：物料、采购、供应商、计划执行
- 财经：成本、费用、毛利专业核算
- Kernel：身份、组织、角色、权限、Agent/Skill/Memory
- Data：主数据、事件、证据、审计、跨域数据服务
- Integration：外部连接器与同步
- DevSecOps：测试、发布、可观测性

## 4. 一级红线
1. 禁止 EBMS 继续新增跨领域专业 CRUD。
2. 禁止 EBMS 成为销售/研发/交付/财经专业事实源。
3. 禁止新增跨域直接写表。
4. 管理指标优先消费专业中心提供的 Result，不重复定义专业算法。
5. 所有正式经营闭环逐步对齐：Fact → Event → Decision → Action → Result → Evidence。
6. AI 不得绕过权限直接写入重大正式数据。

## 5. 迁移原则
先逻辑拆分 → 契约拆分 → API/Event 拆分 → Data Ownership 拆分 → 最后物理拆分。
当前 Node/Express/JSON/Docker 可继续作为 Light/MVP 运行基线。