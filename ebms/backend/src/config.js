// 运行配置一律取自环境变量，不落库、不写死任何密钥。
function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * 专业中心接入配置：base URL / app key / 签名密钥一律取自环境变量（不落库、不写死）。
 * 未配置 base URL 的域自动退化为「人工录入 / 文件导入」兜底（架构方案 3.2.1 关键约定）。
 */
function centerConfig(prefix) {
  const baseUrl = process.env[`EBMS_${prefix}_BASE_URL`] ?? null;
  return {
    mode: baseUrl ? 'http' : 'manual',
    baseUrl,
    appKey: process.env[`EBMS_${prefix}_APP_KEY`] ?? null,
    secret: process.env[`EBMS_${prefix}_SECRET`] ?? null,
    timeoutMs: int(process.env[`EBMS_${prefix}_TIMEOUT_MS`], 5000),
  };
}

export const config = {
  port: int(process.env.PORT, 4100),
  enforceAuth: bool(process.env.EBMS_ENFORCE_AUTH, false),
  centers: {
    sales: centerConfig('SALES'),
    production: centerConfig('PRODUCTION'),
    finance: centerConfig('FINANCE'),
    supply_chain: centerConfig('SUPPLY_CHAIN'),
  },
  database: {
    host: process.env.PGHOST ?? 'localhost',
    port: int(process.env.PGPORT, 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? 'ebms',
    // 结论接入与归因写入以事务为主，连接池保持小规模即可（EBMS 负载为周期批量）
    max: int(process.env.PGPOOL_MAX, 10),
    idleTimeoutMillis: int(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
  },
};
