'use strict';

function getDeviceType(ua = '') {
  if (!ua) return 'unknown';
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function parseUtm(url = '') {
  try {
    const u = new URL(url.startsWith('http') ? url : 'http://x.com' + url);
    return {
      utm_source:   u.searchParams.get('utm_source')   || null,
      utm_medium:   u.searchParams.get('utm_medium')   || null,
      utm_campaign: u.searchParams.get('utm_campaign') || null,
      utm_term:     u.searchParams.get('utm_term')     || null,
      utm_content:  u.searchParams.get('utm_content')  || null,
    };
  } catch { return {}; }
}

function normalizeUrl(url = '') {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('?')[0].toLowerCase();
  }
}

function hashIp(ip = '') {
  const crypto = require('crypto');
  return ip ? crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'et-salt')).digest('hex').slice(0, 16) : null;
}

module.exports = { getDeviceType, parseUtm, normalizeUrl, hashIp };
