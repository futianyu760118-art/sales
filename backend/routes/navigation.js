/**
 * 导航迁移状态接口（PAND-90）
 * ------------------------------------------------------------------
 * GET /api/navigation/menu
 *   返回当前发布版本下，场景化视图与原菜单入口的并存/过渡状态，
 *   供前端 permission-check.js 渲染「新旧入口并存」的侧边栏。
 *
 * 该接口只返回导航元数据（标签、路径、状态、数据源），不含任何业务数据；
 * 这些元数据本已随公开静态资源 permission-check.js 下发，故不额外设权限门，
 * 避免「取菜单需要权限、判权限需要菜单」的循环依赖。业务数据接口仍各自鉴权。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const menuTransition = require('../lib/menu-transition');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const ROUTES_INDEX = path.join(__dirname, 'index.js');

/**
 * 已挂载的 API 前缀，如 ['/api/reports', '/api/sop', ...]（按 app.use('/api', routes) 还原）。
 * 直接读挂载表 routes/index.js，保证「注册表声明的数据源」与「真实挂载」一致。
 */
function mountedApiPrefixes() {
  let source = '';
  try {
    source = fs.readFileSync(ROUTES_INDEX, 'utf8');
  } catch (e) {
    return [];
  }
  const prefixes = [];
  const re = /router\.use\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) prefixes.push('/api' + m[1]);
  return prefixes;
}

/** 页面是否已落地（静态目录下存在该文件） */
function pageExists(href) {
  if (!href || href.indexOf('..') !== -1 || href.indexOf('/') !== -1) return false;
  try {
    return fs.existsSync(path.join(FRONTEND_DIR, href));
  } catch (e) {
    return false;
  }
}

router.get('/menu', function (req, res) {
  try {
    const requested = parseInt(req.query.release, 10);
    const release = Number.isFinite(requested) && requested > 0 ? requested : menuTransition.CURRENT_RELEASE;
    const menu = menuTransition.buildMenu({ release: release, isAvailable: pageExists });
    res.json(menu);
  } catch (e) {
    res.status(500).json({ error: '导航状态生成失败' });
  }
});

/** 注册表自检：数据源未挂载 / 过渡期不足 / 实际上线与计划不符（运维排查用） */
router.get('/menu/self-check', function (req, res) {
  const errors = menuTransition.validateRegistry(mountedApiPrefixes());
  const warnings = menuTransition.checkShipConsistency(menuTransition.CURRENT_RELEASE, pageExists);
  res.json({ ok: errors.length === 0, release: menuTransition.CURRENT_RELEASE, errors: errors, warnings: warnings });
});

module.exports = router;
