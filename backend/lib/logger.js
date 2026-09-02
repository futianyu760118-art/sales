// 分级日志：统一入口，支持 LOG_LEVEL 环境变量过滤。
// 级别从低到高：debug < info < warn < error
// 默认显示 info 及以上；LOG_LEVEL=debug 显示全部；LOG_LEVEL=error 只显示 error。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function emit(level, args) {
  if (LEVELS[level] < THRESHOLD) return;
  const fn = level === 'info' ? 'log' : level;
  console[fn](timestamp(), '[' + level + ']', ...args);
}

module.exports = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args)
};
