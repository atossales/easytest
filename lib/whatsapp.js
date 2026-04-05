/**
 * WhatsApp sender — suporta Evolution API (self-hosted) e Z-API.
 * Configurado pelas env vars:
 *   WA_PROVIDER   = 'evolution' | 'zapi'
 *   WA_URL        = URL base da API (ex: https://evo.meusite.com)
 *   WA_INSTANCE   = nome da instância (Evolution) ou instance ID (Z-API)
 *   WA_TOKEN      = API key / token
 */

const https = require('https');
const http  = require('http');
const logger = require('./logger');

function doRequest(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u      = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib    = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request({
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send a text message via WhatsApp.
 * @param {string} to   Phone in E.164 without + (e.g. "5511999999999")
 * @param {string} text Message text
 */
async function sendMessage(to, text) {
  const provider = (process.env.WA_PROVIDER || 'evolution').toLowerCase();
  const baseUrl  = process.env.WA_URL;
  const instance = process.env.WA_INSTANCE;
  const token    = process.env.WA_TOKEN;

  if (!baseUrl || !instance || !token) {
    logger.warn('WhatsApp não configurado — WA_URL, WA_INSTANCE ou WA_TOKEN ausente');
    return { ok: false, reason: 'not_configured' };
  }

  // Normalize number — remove + and spaces
  const phone = to.replace(/\D/g, '');

  try {
    let url, body, headers;

    if (provider === 'zapi') {
      // Z-API: POST /instances/{instance}/token/{token}/send-text
      url     = `${baseUrl}/instances/${instance}/token/${token}/send-text`;
      body    = { phone, message: text };
      headers = {};
    } else {
      // Evolution API (default): POST /message/sendText/{instance}
      url     = `${baseUrl}/message/sendText/${instance}`;
      body    = { number: phone, text };
      headers = { apikey: token };
    }

    const resp = await doRequest(url, body, headers);

    if (resp.status >= 200 && resp.status < 300) {
      logger.info('WhatsApp message sent', { to: phone.slice(0, 6) + '****', provider });
      return { ok: true };
    } else {
      logger.warn('WhatsApp send failed', { status: resp.status, body: JSON.stringify(resp.body).slice(0, 200) });
      return { ok: false, status: resp.status, detail: resp.body };
    }
  } catch (e) {
    logger.error('WhatsApp error', { msg: e.message });
    return { ok: false, reason: e.message };
  }
}

module.exports = { sendMessage };
