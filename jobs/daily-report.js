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

async function buildReportText(period) {
  const db = getDb();

  // Load custom message template (or use default)
  const template = getSetting('wa_message_template') || null;

  const tests = db.prepare(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view'       AND created_at >= datetime('now','-1 day')) AS views_today,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion' AND created_at >= datetime('now','-1 day')) AS conv_today,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view')       AS views_total,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion') AS conv_total,
      (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=t.id AND type='conversion' AND created_at >= datetime('now','-1 day')) AS rev_today,
      (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=t.id AND type='conversion') AS rev_total
    FROM tests t WHERE t.active = 1
  `).all();

  const totalViewsToday = tests.reduce((s, t) => s + t.views_today, 0);
  const totalConvToday  = tests.reduce((s, t) => s + t.conv_today, 0);
  const totalRevToday   = tests.reduce((s, t) => s + t.rev_today, 0);
  const totalRevAll     = tests.reduce((s, t) => s + t.rev_total, 0);

  const crToday = totalViewsToday > 0 ? (totalConvToday / totalViewsToday * 100).toFixed(2) : '0.00';
  const now     = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  // Per-test variation breakdown
  const variationLines = tests.map(t => {
    const vars = db.prepare(`
      SELECT v.name,
        (SELECT COUNT(*) FROM interactions WHERE test_id=? AND variation_id=v.id AND type='view') AS views,
        (SELECT COUNT(*) FROM interactions WHERE test_id=? AND variation_id=v.id AND type='conversion') AS conv,
        (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=? AND variation_id=v.id AND type='conversion') AS rev
      FROM variations v WHERE v.test_id=? AND COALESCE(v.active,1)=1 ORDER BY conv DESC
    `).all(t.id, t.id, t.id, t.id);

    const varText = vars.map(v => {
      const cr  = v.views > 0 ? (v.conv / v.views * 100).toFixed(1) : '0.0';
      const rev = v.rev > 0 ? ` | R$ ${(v.rev / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '';
      return `  • ${v.name}: ${v.views} vis → ${v.conv} conv (${cr}%)${rev}`;
    }).join('\n');

    const crT = t.views_total > 0 ? (t.conv_total / t.views_total * 100).toFixed(1) : '0.0';
    return `📊 *${t.name}*\n  Taxa geral: ${crT}% | Hoje: ${t.conv_today} conv\n${varText}`;
  }).join('\n\n');

  // If custom template exists, use it directly (no AI)
  if (template && !template.includes('{{AI}}')) {
    return template
      .replace(/\{\{data\}\}/g, now)
      .replace(/\{\{periodo\}\}/g, period)
      .replace(/\{\{views_hoje\}\}/g, totalViewsToday)
      .replace(/\{\{conv_hoje\}\}/g, totalConvToday)
      .replace(/\{\{cr_hoje\}\}/g, crToday)
      .replace(/\{\{receita_hoje\}\}/g, `R$ ${(totalRevToday / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
      .replace(/\{\{receita_total\}\}/g, `R$ ${(totalRevAll / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
      .replace(/\{\{testes\}\}/g, variationLines);
  }

  // Otherwise build structured summary + optionally call Gemini for insights
  const summary = [
    `📈 *Relatório EasyTest — ${period === 'morning' ? '🌅 Manhã' : '🌙 Noite'} de ${now}*`,
    '',
    `👁 Views hoje: *${totalViewsToday}*`,
    `✅ Conversões hoje: *${totalConvToday}*`,
    `📊 Taxa hoje: *${crToday}%*`,
    `💰 Receita hoje: *R$ ${(totalRevToday / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}*`,
    `💎 Receita total: *R$ ${(totalRevAll / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}*`,
    '',
    variationLines,
  ].join('\n');

  // If template contains {{AI}}, call Gemini for a short insight paragraph
  if (template && template.includes('{{AI}}') && process.env.GEMINI_API_KEY) {
    try {
      const aiPrompt = `Dados do relatório A/B:\n${summary}\n\nDê um parágrafo curto (3-4 frases, tom direto) com o principal insight do dia e a próxima ação recomendada. Responda em português brasileiro, sem formatação markdown.`;
      const insight  = await callGemini(aiPrompt);
      return template
        .replace(/\{\{resumo\}\}/g, summary)
        .replace(/\{\{AI\}\}/g, insight);
    } catch (e) {
      logger.warn('Gemini insight failed for WhatsApp report', { msg: e.message });
    }
  }

  return summary;
}

// ── Send to all configured numbers ────────────────────────────────────────

async function sendDailyReport(period) {
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
    text = await buildReportText(period);
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
