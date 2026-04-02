const express = require('express');
const router = express.Router();
const { getDb } = require('../lib/database');
const { v4: uuidv4 } = require('uuid');

router.post('/conversion', (req, res) => {
  const db = getDb();
  const { page_url } = req.body;
  const cid = req.cookies?.cp_uid;
  if (!cid) return res.json({ converted: 0 });
  let converted = 0;
  db.prepare('SELECT * FROM tests WHERE active=1').all().forEach(t => {
    const cu = t.conversion_page_url;
    if (!cu) return;
    const a = cu.replace(/\/+$/, '').toLowerCase(), b = (page_url || '').replace(/\/+$/, '').toLowerCase();
    if (b.includes(a) || a.includes(b)) {
      const ix = db.prepare("SELECT * FROM interactions WHERE test_id=? AND client_id=? AND type='view'").get(t.id, cid);
      if (ix) { db.prepare("UPDATE interactions SET type='conversion' WHERE test_id=? AND client_id=?").run(t.id, cid); converted++; }
    }
  });
  res.json({ converted });
});

module.exports = router;
