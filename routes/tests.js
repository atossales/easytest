const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, UPLOADS } = require('../lib/database');

const storage = multer.diskStorage({
  destination: (req, file, cb) => { if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true }); cb(null, UPLOADS); },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E6) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (r, f, cb) => cb(null, /\.html?$/i.test(f.originalname)) });

function extractTitle(filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// GET all tests
router.get('/', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM variations WHERE test_id=t.id) as variation_count,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view') as total_views,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion') as total_conversions
    FROM tests t ORDER BY t.created_at DESC
  `).all());
});

// GET one test
router.get('/:id', (req, res) => {
  const db = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id=?').get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  test.variations = db.prepare('SELECT * FROM variations WHERE test_id=? ORDER BY id').all(req.params.id);
  res.json(test);
});

// POST create test with file uploads
router.post('/', upload.array('pages', 30), (req, res) => {
  const db = getDb();
  const { name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id } = req.body;
  const files = req.files || [];

  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  if (files.length < 2) return res.status(400).json({ error: 'Envie pelo menos 2 HTMLs' });

  const pct = Math.floor(100 / files.length);
  const rem = 100 - pct * files.length;

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO tests (name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id)
      VALUES (?,?,?,?,?,?)`).run(name, test_uri || null, conversion_page_url || null, ga4_measurement_id || null, ga4_api_secret || null, meta_pixel_id || null);
    const tid = r.lastInsertRowid;

    const ins = db.prepare('INSERT INTO variations (name, percentage, remaining, test_id, file_path, file_original) VALUES (?,?,?,?,?,?)');
    files.forEach((f, i) => {
      const autoName = extractTitle(f.path) || f.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      const p = i === 0 ? pct + rem : pct;
      ins.run(autoName, p, Math.max(1, Math.floor(p / 10)), tid, f.filename, f.originalname);
    });
    return tid;
  });

  try {
    const tid = tx();
    const test = db.prepare('SELECT * FROM tests WHERE id=?').get(tid);
    test.variations = db.prepare('SELECT * FROM variations WHERE test_id=?').all(tid);
    res.status(201).json(test);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add more pages to existing test
router.post('/:id/pages', upload.array('pages', 30), (req, res) => {
  const db = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id=?').get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Nenhum arquivo' });

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM variations WHERE test_id=?').all(req.params.id);
    const total = existing.length + files.length;
    const pct = Math.floor(100 / total);
    const rem = 100 - pct * total;

    const upd = db.prepare('UPDATE variations SET percentage=?, remaining=? WHERE id=?');
    existing.forEach((v, i) => upd.run(i === 0 ? pct + rem : pct, Math.max(1, Math.floor(pct / 10)), v.id));

    const ins = db.prepare('INSERT INTO variations (name, percentage, remaining, test_id, file_path, file_original) VALUES (?,?,?,?,?,?)');
    files.forEach(f => {
      const autoName = extractTitle(f.path) || f.originalname.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      ins.run(autoName, pct, Math.max(1, Math.floor(pct / 10)), req.params.id, f.filename, f.originalname);
    });
  });

  try { tx(); res.json({ success: true, variations: db.prepare('SELECT * FROM variations WHERE test_id=?').all(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update test settings
router.put('/:id', (req, res) => {
  const db = getDb();
  const { name, test_uri, conversion_page_url, ga4_measurement_id, ga4_api_secret, meta_pixel_id, active } = req.body;
  db.prepare(`UPDATE tests SET name=?, test_uri=?, conversion_page_url=?, ga4_measurement_id=?, ga4_api_secret=?,
    meta_pixel_id=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, test_uri, conversion_page_url, ga4_measurement_id || null, ga4_api_secret || null, meta_pixel_id || null, active ?? 1, req.params.id);
  const test = db.prepare('SELECT * FROM tests WHERE id=?').get(req.params.id);
  test.variations = db.prepare('SELECT * FROM variations WHERE test_id=?').all(req.params.id);
  res.json(test);
});

// PUT update variation percentage
router.put('/:id/variations/:vid', (req, res) => {
  const db = getDb();
  const { percentage, name } = req.body;
  if (percentage !== undefined) db.prepare('UPDATE variations SET percentage=?, remaining=? WHERE id=? AND test_id=?').run(percentage, Math.max(1, Math.floor(percentage / 10)), req.params.vid, req.params.id);
  if (name) db.prepare('UPDATE variations SET name=? WHERE id=? AND test_id=?').run(name, req.params.vid, req.params.id);
  res.json({ success: true });
});

// DELETE test
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('SELECT * FROM variations WHERE test_id=?').all(req.params.id).forEach(v => {
    if (v.file_path) { const fp = path.join(UPLOADS, v.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  });
  db.prepare('DELETE FROM interactions WHERE test_id=?').run(req.params.id);
  db.prepare('DELETE FROM variations WHERE test_id=?').run(req.params.id);
  db.prepare('DELETE FROM tests WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// DELETE variation
router.delete('/:id/variations/:vid', (req, res) => {
  const db = getDb();
  const v = db.prepare('SELECT * FROM variations WHERE id=? AND test_id=?').get(req.params.vid, req.params.id);
  if (v?.file_path) { const fp = path.join(UPLOADS, v.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM variations WHERE id=? AND test_id=?').run(req.params.vid, req.params.id);
  // Redistribute
  const rest = db.prepare('SELECT * FROM variations WHERE test_id=?').all(req.params.id);
  if (rest.length) {
    const p = Math.floor(100 / rest.length), rm = 100 - p * rest.length;
    rest.forEach((v, i) => db.prepare('UPDATE variations SET percentage=? WHERE id=?').run(i === 0 ? p + rm : p, v.id));
  }
  res.json({ success: true });
});

module.exports = router;
