const express = require('express');
const router = express.Router();

// 路由 Target Module 标签（P0 架构冻结，对齐 AEOS V7.2 System Registry M00–M12）。
// 标签语义：[目标模块] 处置；Legacy=冻结下沉、保留=管理闭环化、迁移=共享内核化、连接器化=M11。
// 完整登记表见 docs/AEOS_V7.2_ACCOUNTABLE_OWNERS_V1.md，跨域直读见 docs/CROSS_DOMAIN_READS.md。
// 注意：挂载顺序保持不变，标签仅为架构归属标注，不改变路由匹配行为。

router.use('/inquiries', require('./inquiry'));            // [M05 销售自治] Legacy
router.use('/products', require('./product'));             // [M04 研发自治] Legacy
router.use('/customers', require('./customer'));           // [M05 销售自治] Legacy
router.use('/materials', require('./material'));           // [M06/M02] Legacy 主数据 Owner 化
router.use('/material-costs', require('./material-costs')); // [M06/M09] Legacy
router.use('/materials-ext', require('./material-ext'));   // [M06/M02] Legacy
router.use('/procurement', require('./procurement'));      // [M06 交付自治] Legacy
router.use('/suppliers', require('./supplier'));           // [M06 交付自治] Legacy
router.use('/external-api', require('./external-api'));    // [M11 集成] 连接器化
router.use('/orders', require('./order'));                 // [M05/M06] Legacy 拆分商务/交付
router.use('/samples', require('./sample'));               // [M04 研发自治] Legacy
router.use('/projects', require('./project'));             // [M04 研发自治] Legacy
router.use('/annual-plan', require('./annual-plan'));      // [M03 EBMS] 保留 目标/行动闭环化
router.use('/amiba', require('./amiba'));                  // [M09 财经自治] Legacy 阿米巴核算下沉
router.use('/products/bom-types', require('./bom-type'));  // [M04 研发自治] Legacy
router.use('/products/bom-issues', require('./bom-issue'));// [M04/M08] Legacy
router.use('/pricing', require('./pricing'));              // [M05/M09] Legacy 拆分商务报价/成本
router.use('/quote', require('./quote').router);           // [M05 销售自治] Legacy
router.use('/users', require('./user'));                   // [M01 Kernel] 迁移共享身份
router.use('/reports', require('./report'));               // [M03 EBMS] 保留 跨域读数下沉
router.use('/import', require('./import'));                // [M04 研发自治] Legacy 导入工具
router.use('/permissions', require('./permission'));       // [M01 Kernel] 迁移共享权限
router.use('/feedback', require('./feedback'));            // [M10 POMS] 个人反馈入口
router.use('/settings', require('./settings'));            // [M02 Data & Evidence] 下沉
// 测试端点仅开发环境暴露，生产环境不挂载（P0-3）
if (process.env.NODE_ENV !== 'production') {
  router.use('/test', require('./test'));                  // [M12 DevSecOps/QA]
}
router.use('/compliance', require('./compliance'));        // [M08 品控自治] Legacy
router.use('/configs', require('./config'));               // [M04 研发自治] Legacy
router.use('/chat', require('./chat'));                    // [M01+M03] 会话拆分
router.use('/rules', require('./rules'));                  // [M01 Guard/M05 规则] Legacy 下沉
router.use('/spec-library', require('./spec-library'));    // [M04 研发自治] Legacy
router.use('/data-clean', require('./data-clean'));        // [M02 Data & Evidence] 下沉
router.use('/ai-assistant', require('./ai-assistant'));    // [M01+M03] Agent/Skill/Memory 下沉
router.use('/bom', require('./bom'));                      // [M04 研发自治] Legacy
router.use('/external-sync', require('./external-sync'));  // [M11 集成] 连接器化
router.use('/external', require('./external-service'));    // [M11 集成] 连接器化
router.use('/tech', require('./tech-transfer'));           // [M04 研发自治] Legacy 技术转移
router.use('/organization', require('./organization'));    // [M01 Kernel] 迁移共享组织
router.use('/data-scope', require('./data-scope'));        // [M01 Kernel] 数据权限
router.use('/material-check', require('./material-check'));// [M06/M08] Legacy 来料检验
router.use('/expenses', require('./expense'));             // [M09 财经自治] Legacy
router.use('/labor', require('./labor'));                  // [M09 财经自治] Legacy
router.use('/product-labor-rate', require('./product-labor-rate')); // [M09 财经自治] Legacy
router.use('/material-issues', require('./material-issue'));// [M06/M08] Legacy 异常
router.use('/order-analysis', require('./order-analysis'));// [M03/M03A] 只保留管理分析 专业算法下沉

router.use('/order-check', require('./order-check'));      // [M06/M08] Legacy 交付能力验证

router.use('/sop', require('./sop'));                      // [M03A 产销自治] 逻辑隔离 后续独立服务
router.use('/im', require('./im'));                        // [M01 Kernel] 协作/消息下沉

module.exports = router;
