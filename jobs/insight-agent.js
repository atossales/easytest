/**
 * Insight Agent — Agente de CRO automático por teste.
 *
 * Roda a cada 4 horas. Para cada teste ativo, busca os dados dos últimos 7 dias,
 * chama o Gemini e salva o insight no banco (tabela test_insights).
 *
 * Também expõe generateInsight(testId) para chamada manual via endpoint.
 */

const { getDb }      = require('../lib/database');
const { callGemini } = require('./report-builder');
const logger         = require('../lib/logger');

// ── System prompt do agente de CRO ────────────────────────────────────────────

const INSIGHT_PROMPT = `Você é um especialista sênior em Conversion Rate Optimization (CRO) para infoprodutos brasileiros. Analise os dados do teste A/B abaixo e escreva um feedback direto, humano e acionável.

REGRAS ABSOLUTAS:
- Máximo 200 palavras
- Zero markdown: proibido #, ##, **, *, ---, colchetes
- Use emojis para separar seções visualmente
- Fale como consultor experiente, não como robô
- Use os números reais — nunca invente dados
- Identifique o diagnóstico principal: é problema de tráfego, de oferta, de copy ou de landing?

ESTRUTURA OBRIGATÓRIA (use exatamente esses emojis como separadores):

📊 O que está acontecendo
[1-2 frases sobre o volume de tráfego e taxa de conversão — contextualize se está bem ou mal]

🏆 Variação em destaque
[Diga qual variação está na frente e o que ela tem de diferente — seja específico]

⚠️ Alerta principal
[O maior problema que você identificou — seja direto e corajoso]

🚀 3 ações para subir a conversão agora
1. [ação concreta — não genérica]
2. [ação concreta — não genérica]
3. [ação concreta — não genérica]`;

// ── Coleta dados do teste para o prompt ───────────────────────────────────────

function collectTestData(db, testId) {
  const NO_BOT = "AND COALESCE(is_bot,0)=0";
  const RANGE  = "datetime(created_at,'-3 hours') >= datetime('now','-3 hours','-7 days')";

  const test = db.prepare('SELECT * FROM tests WHERE id = ? AND active = 1').get(testId);
  if (!test) return null;

  const vars = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(testId);

  const totalViews = db.prepare(
    `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='view' AND ${RANGE} ${NO_BOT}`
  ).get(testId).c || 0;

  const totalConv = db.prepare(
    `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='conversion' AND ${RANGE} ${NO_BOT}`
  ).get(testId).c || 0;

  const totalRev = db.prepare(
    `SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND type='conversion' AND ${RANGE} ${NO_BOT}`
  ).get(testId).r || 0;

  const variations = vars.map(v => {
    const views = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? AND type='view' AND ${RANGE} ${NO_BOT}`
    ).get(testId, v.id).c || 0;
    const conv = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' AND ${RANGE} ${NO_BOT}`
    ).get(testId, v.id).c || 0;
    const rev = db.prepare(
      `SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' AND ${RANGE} ${NO_BOT}`
    ).get(testId, v.id).r || 0;
    return {
      name: v.name,
      views,
      conversions: conv,
      cr: views > 0 ? (conv / views * 100).toFixed(2) : '0.00',
      revenue: (rev / 100).toFixed(2),
    };
  });

  return {
    test,
    totalViews,
    totalConv,
    cr: totalViews > 0 ? (totalConv / totalViews * 100).toFixed(2) : '0.00',
    totalRev: (totalRev / 100).toFixed(2),
    variations,
  };
}

// ── Monta o prompt completo ───────────────────────────────────────────────────

function buildInsightPrompt(data) {
  const varLines = data.variations.map(v =>
    `  • ${v.name}: ${v.views} visitas, ${v.conversions} conversões, ${v.cr}% CR, R$ ${v.revenue} receita`
  ).join('\n');

  // Contexto de benchmarks para o modelo calibrar a avaliação
  const crNum = parseFloat(data.cr);
  const benchmark = crNum === 0   ? 'sem dados ainda'
    : crNum < 0.5  ? 'CRÍTICO — muito abaixo do mercado (média infoprodutos: 1–3%)'
    : crNum < 1    ? 'abaixo da média do mercado'
    : crNum < 3    ? 'dentro da média de mercado para infoprodutos'
    : crNum < 5    ? 'boa conversão — acima da média'
    : 'excelente — top de mercado';

  return `${INSIGHT_PROMPT}

---
DADOS DO TESTE (últimos 7 dias):
Nome: ${data.test.name}
Total de visitas: ${data.totalViews}
Total de conversões: ${data.totalConv}
Taxa de conversão geral: ${data.cr}% (contexto: ${benchmark})
Receita total: R$ ${data.totalRev}

Variações:
${varLines}
`;
}

// ── Gera e salva o insight de um teste ───────────────────────────────────────

async function generateInsight(testId) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  const db   = getDb();
  const data = collectTestData(db, testId);
  if (!data) throw new Error('Teste não encontrado ou inativo');

  // Só gera se tiver pelo menos 10 visitas — evita análise sem dados
  if (data.totalViews < 10) {
    throw new Error('Dados insuficientes — aguarde pelo menos 10 visitas para gerar insight');
  }

  const prompt  = buildInsightPrompt(data);
  const insight = await callGemini(prompt);

  db.prepare(`
    INSERT INTO test_insights (test_id, insight_text, views_snap, conv_snap, cr_snap, generated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(test_id) DO UPDATE SET
      insight_text = excluded.insight_text,
      views_snap   = excluded.views_snap,
      conv_snap    = excluded.conv_snap,
      cr_snap      = excluded.cr_snap,
      generated_at = excluded.generated_at
  `).run(testId, insight, data.totalViews, data.totalConv, data.cr);

  logger.info('Insight generated', { testId, views: data.totalViews, cr: data.cr });
  return insight;
}

// ── Roda para todos os testes ativos ─────────────────────────────────────────

async function runAllInsights() {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('Insight agent: GEMINI_API_KEY não configurada, pulando');
    return;
  }

  const db    = getDb();
  const tests = db.prepare('SELECT id FROM tests WHERE active = 1').all();

  logger.info('Insight agent: starting run', { tests: tests.length });

  for (const { id } of tests) {
    try {
      await generateInsight(id);
      // Pequeno delay entre chamadas para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      // Dados insuficientes é esperado — não loga como erro
      if (e.message.includes('insuficientes') || e.message.includes('inativo')) {
        logger.info('Insight skipped', { testId: id, reason: e.message });
      } else {
        logger.error('Insight generation failed', { testId: id, msg: e.message });
      }
    }
  }

  logger.info('Insight agent: run complete');
}

// ── Scheduler — a cada 4 horas ────────────────────────────────────────────────

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function startInsightScheduler() {
  logger.info('Insight agent scheduler started (every 4h)');

  // Primeira execução 2 minutos após o boot (deixa o servidor estabilizar)
  setTimeout(() => {
    runAllInsights().catch(e => logger.error('Insight agent initial run error', { msg: e.message }));
  }, 2 * 60 * 1000);

  // Execuções subsequentes a cada 4 horas
  setInterval(() => {
    runAllInsights().catch(e => logger.error('Insight agent scheduled run error', { msg: e.message }));
  }, FOUR_HOURS);
}

module.exports = { startInsightScheduler, generateInsight, runAllInsights };
