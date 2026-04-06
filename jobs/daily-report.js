/**
 * Daily WhatsApp report job.
 * Runs twice a day (morning + evening) — times configurable via settings.
 * Uses node-cron if available, otherwise falls back to setInterval polling.
 *
 * Triggered by server.js on startup.
 */

const { getDb, getSetting } = require('../lib/database');
const { sendMessage }       = require('../lib/whatsapp');
const { callGemini }        = require('./report-builder');
const logger                = require('../lib/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function nowBR() {
  // Offset for America/Sao_Paulo (UTC-3, no DST awareness — good enough for cron)
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function parseTime(str) {
  // "08:00" → { h: 8, m: 0 }
  const [h, m] = (str || '').split(':').map(Number);
  return { h: isNaN(h) ? null : h, m: isNaN(m) ? 0 : m };
}

// ── Core report builder ────────────────────────────────────────────────────

// days: 'yesterday' = ontem, 1 = hoje, 3/7/30 = últimos N dias
async function buildReportText(period, days) {
  const db = getDb();
  const template = getSetting('wa_message_template') || null;

  const isYesterday = String(days) === 'yesterday';
  const d = isYesterday ? 1 : (parseInt(days) || 1);

  // Date filter in BRT (UTC-3)
  let dateFilter;
  if (isYesterday) {
    dateFilter = `DATE(datetime(created_at,'-3 hours')) = DATE(datetime('now','-3 hours','-1 day'))`;
  } else if (d === 1) {
    dateFilter = `DATE(datetime(created_at,'-3 hours')) = DATE(datetime('now','-3 hours'))`;
  } else {
    dateFilter = `datetime(created_at,'-3 hours') >= datetime('now','-3 hours','-${d} days')`;
  }
  const varDateFilter = dateFilter;

  const tests = db.prepare(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view'
        AND ${dateFilter}) AS views_period,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion'
        AND ${dateFilter}) AS conv_period,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view')       AS views_total,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion') AS conv_total,
      (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=t.id AND type='conversion'
        AND ${dateFilter}) AS rev_period,
      (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=t.id AND type='conversion') AS rev_total
    FROM tests t WHERE t.active = 1
  `).all();

  const totalViewsPeriod = tests.reduce((s, t) => s + t.views_period, 0);
  const totalConvPeriod  = tests.reduce((s, t) => s + t.conv_period, 0);
  const totalRevPeriod   = tests.reduce((s, t) => s + t.rev_period, 0);
  const totalRevAll      = tests.reduce((s, t) => s + t.rev_total, 0);

  const crPeriod = totalViewsPeriod > 0 ? (totalConvPeriod / totalViewsPeriod * 100).toFixed(2) : '0.00';

  // Date in BRT — avoid toLocaleDateString (unreliable ICU in Node without full locale data)
  const _brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const _dd  = String(_brtNow.getUTCDate()).padStart(2, '0');
  const _mm  = String(_brtNow.getUTCMonth() + 1).padStart(2, '0');
  const now  = `${_dd}/${_mm}`;

  const periodLabel = isYesterday ? 'Ontem' : d === 1 ? 'Hoje' : `Últimos ${d} dias`;
  const medals = ['🥇', '🥈', '🥉'];

  // Per-test: top 3 variations ranked by CR in the selected period
  const variationLines = tests.map(t => {
    const vars = db.prepare(`
      SELECT v.name,
        (SELECT COUNT(*) FROM interactions WHERE test_id=? AND variation_id=v.id AND type='view'
          AND ${varDateFilter}) AS views,
        (SELECT COUNT(*) FROM interactions WHERE test_id=? AND variation_id=v.id AND type='conversion'
          AND ${varDateFilter}) AS conv
      FROM variations v WHERE v.test_id=? AND COALESCE(v.active,1)=1
    `).all(t.id, t.id, t.id);

    vars.sort((a, b) => {
      const crA = a.views > 0 ? a.conv / a.views : 0;
      const crB = b.views > 0 ? b.conv / b.views : 0;
      return crB - crA;
    });

    const top3 = vars.slice(0, 3).map((v, i) => {
      const cr = v.views > 0 ? (v.conv / v.views * 100).toFixed(1) : '0.0';
      return `${medals[i]} *${v.name}*: *${cr}% CR* (${v.conv} conv / ${v.views} vis)`;
    }).join('\n');

    const crT = t.views_period > 0 ? (t.conv_period / t.views_period * 100).toFixed(1) : '0.0';
    return `🔬 *${t.name}* — CR: *${crT}%*\n${top3}`;
  }).join('\n\n');

  const fmtBRL = cents => `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

  // Custom template
  if (template && !template.includes('{{AI}}')) {
    return template
      .replace(/\{\{data\}\}/g, now)
      .replace(/\{\{periodo\}\}/g, periodLabel)
      .replace(/\{\{views_hoje\}\}/g, totalViewsPeriod)
      .replace(/\{\{conv_hoje\}\}/g, totalConvPeriod)
      .replace(/\{\{cr_hoje\}\}/g, crPeriod)
      .replace(/\{\{receita_hoje\}\}/g, fmtBRL(totalRevPeriod))
      .replace(/\{\{receita_total\}\}/g, fmtBRL(totalRevAll))
      .replace(/\{\{testes\}\}/g, variationLines);
  }

  const divider = '━━━━━━━━━━━━━━━';
  const timeLabel = period === 'morning' ? '🌅 Manhã' : period === 'evening' ? '🌙 Noite' : '📊';

  const revPeriodStr = totalRevPeriod > 0 ? `\n💰 Receita (${periodLabel.toLowerCase()}): *${fmtBRL(totalRevPeriod)}*` : '';
  const revTotalStr  = totalRevAll   > 0 ? `\n💎 Receita total:   *${fmtBRL(totalRevAll)}*` : '';

  const summary = [
    `📈 *Relatório EasyTest*`,
    `${timeLabel} ${now} — ${periodLabel}`,
    divider,
    `👁  Visitas:     *${totalViewsPeriod}*`,
    `✅  Conversões: *${totalConvPeriod}*`,
    `📊  Taxa CR:    *${crPeriod}%*` + revPeriodStr + revTotalStr,
    divider,
    variationLines,
    divider,
  ].join('\n');

  if (template && template.includes('{{AI}}') && process.env.GEMINI_API_KEY) {
    try {
      const aiPrompt = `Dados do relatório A/B (${periodLabel}):\n${summary}\n\nDê um parágrafo curto (3-4 frases, tom direto) com o principal insight e a próxima ação recomendada. Responda em português brasileiro, sem formatação markdown.`;
      const insight  = await callGemini(aiPrompt);
      return template.replace(/\{\{resumo\}\}/g, summary).replace(/\{\{AI\}\}/g, insight);
    } catch (e) {
      logger.warn('Gemini insight failed for WhatsApp report', { msg: e.message });
    }
  }

  return summary;
}

// ── Send to all configured numbers ────────────────────────────────────────

async function sendDailyReport(period, days) {
  const nums = [
    getSetting('wa_number_1'),
    getSetting('wa_number_2'),
  ].filter(Boolean);

  if (!nums.length) {
    logger.info('Daily report: no WhatsApp numbers configured, skipping');
    return;
  }

  let text;
  try {
    text = await buildReportText(period, days || 1);
  } catch (e) {
    logger.error('Daily report: failed to build text', { msg: e.message });
    return;
  }

  for (const num of nums) {
    const r = await sendMessage(num, text);
    logger.info('Daily report sent', { num: num.slice(0, 4) + '****', period, ok: r.ok });
  }
}

// ── Scheduler (setInterval polling — no external dep) ─────────────────────

let _lastMorning = null;
let _lastEvening = null;

function startScheduler() {
  logger.info('Daily report scheduler started');

  setInterval(async () => {
    const waEnabled = getSetting('wa_enabled');
    if (waEnabled !== '1') return;

    const morningTime = parseTime(getSetting('wa_morning_time') || '08:00');
    const eveningTime = parseTime(getSetting('wa_evening_time') || '20:00');
    const { h, m }    = nowBR();
    const today       = new Date().toISOString().slice(0, 10);

    if (morningTime.h !== null && h === morningTime.h && m === morningTime.m && _lastMorning !== today) {
      _lastMorning = today;
      logger.info('Firing morning report');
      sendDailyReport('morning').catch(e => logger.error('Morning report error', { msg: e.message }));
    }

    if (eveningTime.h !== null && h === eveningTime.h && m === eveningTime.m && _lastEvening !== today) {
      _lastEvening = today;
      logger.info('Firing evening report');
      sendDailyReport('evening').catch(e => logger.error('Evening report error', { msg: e.message }));
    }
  }, 60 * 1000); // check every minute
}

module.exports = { startScheduler, sendDailyReport, buildReportText };
