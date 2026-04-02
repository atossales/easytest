const isProd = process.env.NODE_ENV === 'production';

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  if (isProd) {
    return JSON.stringify({ ts, level, msg, ...meta });
  }
  const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[35m' }[level] || '';
  const reset = '\x1b[0m';
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${color}[${level.toUpperCase()}]${reset} ${ts} ${msg}${metaStr}`;
}

const logger = {
  info:  (msg, meta = {}) => console.log(fmt('info', msg, meta)),
  warn:  (msg, meta = {}) => console.warn(fmt('warn', msg, meta)),
  error: (msg, meta = {}) => console.error(fmt('error', msg, meta)),
  debug: (msg, meta = {}) => { if (!isProd) console.log(fmt('debug', msg, meta)); },
};

module.exports = logger;
