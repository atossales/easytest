const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const DB_DIR = path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DB_DIR, 'easytest.db');
const UPLOADS = path.join(DB_DIR, 'uploads');
let db;

function getDb() {
  if (!db) {
    [DB_DIR, UPLOADS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    init();
  }
  return db;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      active INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      test_uri TEXT,
      conversion_page_url TEXT,
      ga4_measurement_id TEXT,
      ga4_api_secret TEXT,
      meta_pixel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS variations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      percentage INTEGER NOT NULL DEFAULT 50,
      remaining INTEGER NOT NULL DEFAULT 0,
      test_id INTEGER NOT NULL,
      file_path TEXT,
      file_original TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      type TEXT DEFAULT 'view',
      test_id INTEGER NOT NULL,
      variation_id INTEGER NOT NULL,
      referrer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
      FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ix_test ON interactions(test_id);
    CREATE INDEX IF NOT EXISTS idx_ix_var ON interactions(variation_id);
    CREATE INDEX IF NOT EXISTS idx_ix_client ON interactions(client_id);
    CREATE INDEX IF NOT EXISTS idx_ix_type ON interactions(type);
    CREATE INDEX IF NOT EXISTS idx_ix_date ON interactions(created_at);
  `);
}

function getSetting(key) {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = { getDb, UPLOADS, getSetting, setSetting };
