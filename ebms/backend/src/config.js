/**
 * 运行配置。密钥/凭据一律不落代码，只从环境变量注入（架构方案安全约束）。
 */

const DEFAULTS = {
  port: 4100,
  dbFile: ':memory:',
  corsOrigin: '*',
};

function readPort() {
  const raw = Number(process.env.EBMS_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULTS.port;
}

export function loadConfig(overrides = {}) {
  return {
    port: overrides.port ?? readPort(),
    dbFile: overrides.dbFile ?? process.env.EBMS_DB_FILE ?? DEFAULTS.dbFile,
    corsOrigin: overrides.corsOrigin ?? process.env.EBMS_CORS_ORIGIN ?? DEFAULTS.corsOrigin,
    // 本模块不提供认证/权限体系：角色与可见范围消费 M01 Kernel（PAND-93 红线）
    identityProvider: 'M01-Kernel',
  };
}
