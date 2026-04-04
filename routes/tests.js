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

  const { name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id, active, custom_domain, head_snippet, body_snippet, meta_pixel_events } = req.body;

  let slug   = test_uri ? sanitize(test_uri) : current.test_uri;
  if (slug !== current.test_uri) slug = uniqueSlug(db, slug);
  const domain = custom_domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') || null;
  const pixelEventsJson = meta_pixel_events !== undefined
    ? (meta_pixel_events ? (typeof meta_pixel_events === 'string' ? meta_pixel_events : JSON.stringify(meta_pixel_events)) : null)
    : current.meta_pixel_events;

  db.prepare(`
    UPDATE tests SET name = ?, test_uri = ?, conversion_page_url = ?, ga4_measurement_id = ?,
    ga4_api_secret = ?, meta_pixel_id = ?, active = ?, custom_domain = ?,
    head_snippet = ?, body_snippet = ?, meta_pixel_events = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(name, slug, conversion_page_url, ga4_measurement_id || null, ga4_api_secret || null,
         meta_pixel_id || null, active ?? 1, domain, head_snippet || null, body_snippet || null, pixelEventsJson, req.params.id);

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
  const { percentage, name } = req.body;
  if (percentage !== undefined) {
    db.prepare('UPDATE variations SET percentage = ?, remaining = ? WHERE id = ? AND test_id = ?')
      .run(percentage, Math.max(1, Math.floor(percentage / 10)), req.params.vid, req.params.id);
  }
  if (name) db.prepare('UPDATE variations SET name = ? WHERE id = ? AND test_id = ?').run(name, req.params.vid, req.params.id);
  res.json({ success: true });
});

// DELETE /api/tests/:id
router.delete('/:id', (req, res) => {
  const db   = getDb();
  const vars = db.prepare('SELECT * FROM variations WHERE test_id = ?').all(req.params.id);
  vars.forEach(v => {
    if (v.file_path) {
      const fp = path.resolve(UPLOADS, path.basename(v.file_path));
      if (fp.startsWith(UPLOADS) && fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  });
  db.prepare('DELETE FROM interactions WHERE test_id = ?').run(req.params.id);
  db.prepare('DELETE FROM variations WHERE test_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tests WHERE id = ?').run(req.params.id);
  logger.info('Test deleted', { id: req.params.id });
  res.json({ success: true });
});

// DELETE /api/tests/:id/variations/:vid
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
