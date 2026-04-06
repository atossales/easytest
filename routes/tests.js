const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { getDb, UPLOADS } = require('../lib/database');
const { sanitize, generate, fromName } = require('../lib/slugify');
const logger  = require('../lib/logger');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
    cb(null, UPLOADS);
  },
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + '-' + safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.html?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Apenas arquivos .html são aceitos'));
  },
});

function extractTitle(filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim().slice(0, 80) : null;
  } catch { return null; }
}

function uniqueSlug(db, candidate) {
  const check = db.prepare('SELECT id FROM tests WHERE test_uri = ?');
  let slug = candidate ? sanitize(candidate) : '';
  if (slug.length < 3) slug = generate();
  if (check.get(slug)) slug = slug.slice(0, 40) + '-' + generate().replace('ab-', '');
  if (check.get(slug)) slug = generate();
  return slug;
}

// GET /api/tests
router.get('/', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM variations   WHERE test_id = t.id) AS variation_count,
      (SELECT COUNT(*) FROM interactions WHERE test_id = t.id AND type = 'view')       AS total_views,
      (SELECT COUNT(*) FROM interactions WHERE test_id = t.id AND type = 'conversion') AS total_conversions
    FROM tests t ORDER BY t.created_at DESC
  `).all());
});

// GET /api/tests/:id
router.get('/:id', (req, res) => {
  const db   = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Não encontrado' });
  test.variations = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(req.params.id);
  res.json(test);
});

// POST /api/tests
router.post('/', upload.array('pages', 30), (req, res) => {
  const db    = getDb();
  const files = req.files || [];
  const { name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id, custom_domain, head_snippet, body_snippet, meta_pixel_events } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  if (files.length < 2) return res.status(400).json({ error: 'Envie pelo menos 2 arquivos HTML' });

  const slug   = uniqueSlug(db, test_uri || fromName(name));
  const domain = custom_domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') || null;
  const pct    = Math.floor(100 / files.length);
  const rem    = 100 - pct * files.length;
  const pixelEventsJson = meta_pixel_events ? (typeof meta_pixel_events === 'string' ? meta_pixel_events : JSON.stringify(meta_pixel_events)) : null;

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO tests (name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id, custom_domain, head_snippet, body_snippet, meta_pixel_events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), slug, conversion_page_url || null, ga4_measurement_id || null, ga4_api_secret || null, meta_pixel_id || null, domain, head_snippet || null, body_snippet || null, pixelEventsJson);

    const tid = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO variations (name, percentage, remaining, test_id, file_path, file_original) VALUES (?,?,?,?,?,?)');

    files.forEach((f, i) => {
      const autoName = f.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      const p = i === 0 ? pct + rem : pct;
      ins.run(autoName, p, Math.max(1, Math.floor(p / 10)), tid, f.filename, f.originalname);
    });
    return tid;
  });

  try {
    const tid  = tx();
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(tid);
    test.variations = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(tid);
    logger.info('Test created', { id: tid, slug, variations: files.length });
    res.status(201).json(test);
  } catch (e) {
    logger.error('Test creation failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tests/:id/pages
router.post('/:id/pages', upload.array('pages', 30), (req, res) => {
  const db   = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Não encontrado' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id);
    const total    = existing.length + files.length;
    const pct      = Math.floor(100 / total);
    const rem      = 100 - pct * total;

    const upd = db.prepare('UPDATE variations SET percentage = ?, remaining = ? WHERE id = ?');
    existing.forEach((v, i) => upd.run(i === 0 ? pct + rem : pct, Math.max(1, Math.floor(pct / 10)), v.id));

    const ins = db.prepare('INSERT INTO variations (name, percentage, remaining, test_id, file_path, file_original) VALUES (?,?,?,?,?,?)');
    files.forEach(f => {
      const autoName = extractTitle(f.path) || f.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      ins.run(autoName, pct, Math.max(1, Math.floor(pct / 10)), req.params.id, f.filename, f.originalname);
    });
  });

  try {
    tx();
    res.json({ success: true, variations: db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tests/:id
router.put('/:id', (req, res) => {
  const db      = getDb();
  const current = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Não encontrado' });

  const { name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id, active, custom_domain, head_snippet, body_snippet, meta_pixel_events, funnel_steps } = req.body;

  let slug   = test_uri ? sanitize(test_uri) : current.test_uri;
  if (slug !== current.test_uri) slug = uniqueSlug(db, slug);
  const domain = custom_domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') || null;
  const pixelEventsJson = meta_pixel_events !== undefined
    ? (meta_pixel_events ? (typeof meta_pixel_events === 'string' ? meta_pixel_events : JSON.stringify(meta_pixel_events)) : null)
    : current.meta_pixel_events;

  const funnelJson = funnel_steps !== undefined
    ? (Array.isArray(funnel_steps) ? JSON.stringify(funnel_steps) : funnel_steps || null)
    : current.funnel_steps;

  db.prepare(`
    UPDATE tests SET name = ?, test_uri = ?, conversion_page_url = ?, ga4_measurement_id = ?,
    ga4_api_secret = ?, meta_pixel_id = ?, active = ?, custom_domain = ?,
    head_snippet = ?, body_snippet = ?, meta_pixel_events = ?, funnel_steps = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(name, slug, conversion_page_url, ga4_measurement_id || null, ga4_api_secret || null,
         meta_pixel_id || null, active ?? 1, domain, head_snippet || null, body_snippet || null,
         pixelEventsJson, funnelJson, req.params.id);

  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  test.variations = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id);
  res.json(test);
});

// POST /api/tests/:id/variations/:vid/html — replace HTML file
router.post('/:id/variations/:vid/html', upload.single('page'), (req, res) => {
  const db = getDb();
  const v  = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'Variação não encontrada' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  // Delete old file
  if (v.file_path) {
    const old = path.resolve(UPLOADS, path.basename(v.file_path));
    if (old.startsWith(UPLOADS) && fs.existsSync(old)) fs.unlinkSync(old);
  }

  const autoName = extractTitle(req.file.path) || req.file.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
  db.prepare('UPDATE variations SET file_path = ?, file_original = ?, name = ? WHERE id = ?')
    .run(req.file.filename, req.file.originalname, autoName, v.id);

  res.json({ success: true, variation: db.prepare('SELECT * FROM variations WHERE id = ?').get(v.id) });
});

// PUT /api/tests/:id/variations/:vid
router.put('/:id/variations/:vid', (req, res) => {
  const db = getDb();
  const { percentage, name, active } = req.body;
  if (percentage !== undefined) {
    const pct = Math.max(1, Math.min(100, parseInt(percentage) || 50));
    db.prepare('UPDATE variations SET percentage = ?, remaining = ? WHERE id = ? AND test_id = ?')
      .run(pct, Math.max(1, Math.floor(pct / 10)), req.params.vid, req.params.id);
  }
  if (name !== undefined) db.prepare('UPDATE variations SET name = ? WHERE id = ? AND test_id = ?').run(name, req.params.vid, req.params.id);
  if (active !== undefined) {
    db.prepare('UPDATE variations SET active = ? WHERE id = ? AND test_id = ?').run(active ? 1 : 0, req.params.vid, req.params.id);
    // Redistribute percentage equally across remaining active variations
    const active_vars = db.prepare('SELECT id FROM variations WHERE test_id = ? AND COALESCE(active,1)=1').all(req.params.id);
    if (active_vars.length > 0) {
      const pct = Math.floor(100 / active_vars.length);
      const rem = 100 - pct * active_vars.length;
      const upd = db.prepare('UPDATE variations SET percentage = ?, remaining = ? WHERE id = ?');
      active_vars.forEach((v, i) => upd.run(i === 0 ? pct + rem : pct, Math.max(1, Math.floor((i === 0 ? pct + rem : pct) / 10)), v.id));
    }
  }
  res.json({ success: true });
});

// DELETE /api/tests/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  try {
    // Collect file paths before deleting from DB
    const vars = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id);
    const filesToDelete = vars
      .filter(v => v.file_path)
      .map(v => ({ orig: v.file_path, safe: path.resolve(UPLOADS, path.basename(v.file_path)) }))
      .filter(f => f.safe.startsWith(UPLOADS));

    // Delete from DB in transaction first
    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM interactions WHERE test_id = ?').run(req.params.id);
      db.prepare('DELETE FROM funnel_events WHERE test_id = ?').run(req.params.id);
      db.prepare('DELETE FROM variations WHERE test_id = ?').run(req.params.id);
      db.prepare('DELETE FROM tests WHERE id = ?').run(req.params.id);
    });
    deleteAll();

    // Delete files after DB success (best-effort, don't fail if file missing)
    for (const f of filesToDelete) {
      try {
        if (fs.existsSync(f.safe)) fs.unlinkSync(f.safe);
      } catch (e) {
        logger.warn('Could not delete variation file', { path: f.orig, error: e.message });
      }
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('Test deletion failed', { id: req.params.id, error: e.message });
    res.status(500).json({ error: 'Falha ao deletar o teste' });
  }
});

// DELETE /api/tests/:id/variations/:vid
// GET /api/tests/:id/variations/:vid/html-content — returns raw HTML for editor
router.get('/:id/variations/:vid/html-content', (req, res) => {
  const db = getDb();
  const v  = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'Variação não encontrada' });
  if (!v.file_path) return res.status(404).json({ error: 'Esta variação não possui arquivo HTML' });
  const fp = path.resolve(UPLOADS, path.basename(v.file_path));
  if (!fp.startsWith(UPLOADS) || !fs.existsSync(fp)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  const html = fs.readFileSync(fp, 'utf8');
  res.json({ ok: true, html, name: v.name, variation_id: v.id });
});

// PUT /api/tests/:id/variations/:vid/html-content — saves edited HTML
router.put('/:id/variations/:vid/html-content', express.json({ limit: '10mb' }), (req, res) => {
  const db = getDb();
  const v  = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'Variação não encontrada' });
  if (!v.file_path) return res.status(400).json({ error: 'Esta variação não possui arquivo HTML para editar' });
  const fp = path.resolve(UPLOADS, path.basename(v.file_path));
  if (!fp.startsWith(UPLOADS)) return res.status(403).json({ error: 'Acesso negado' });
  const { html } = req.body;
  if (!html || typeof html !== 'string') return res.status(400).json({ error: 'HTML inválido' });
  try {
    fs.writeFileSync(fp, html, 'utf8');
    logger.info('Variation HTML saved via editor', { testId: req.params.id, varId: req.params.vid });
    res.json({ ok: true });
  } catch (e) {
    logger.error('Failed to save variation HTML', { error: e.message });
    res.status(500).json({ error: 'Falha ao salvar arquivo' });
  }
});

router.delete('/:id/variations/:vid', (req, res) => {
  const db = getDb();
  const v  = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(req.params.vid, req.params.id);
  if (v?.file_path) {
    const fp = path.resolve(UPLOADS, path.basename(v.file_path));
    if (fp.startsWith(UPLOADS) && fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM variations WHERE id = ? AND test_id = ?').run(req.params.vid, req.params.id);
  const rest = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id);
  if (rest.length) {
    const p = Math.floor(100 / rest.length), rm = 100 - p * rest.length;
    rest.forEach((x, i) => db.prepare('UPDATE variations SET percentage = ? WHERE id = ?').run(i === 0 ? p + rm : p, x.id));
  }
  res.json({ success: true });
});

module.exports = router;
