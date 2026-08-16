const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = levels[level] ?? levels.info;
  const log = (name, message, details) => {
    if (levels[name] < threshold) return;
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console[name === 'debug' ? 'log' : name](`${new Date().toISOString()} ${name.toUpperCase()} ${message}${suffix}`);
  };
  return {
    debug: (message, details) => log('debug', message, details),
    info: (message, details) => log('info', message, details),
    warn: (message, details) => log('warn', message, details),
    error: (message, details) => log('error', message, details),
  };
}
