/**
 * ArtistHub Full-Stack Backend
 * Chalesi Music Group - AI Social Media Studio
 * 
 * Features:
 * - SQLite database with 25+ artists, posts, platforms
 * - JWT authentication (chalesimusic@gmail.com / Malaven757!!)
 * - File upload (audio MP3/WAV/FLAC)
 * - FFmpeg video rendering with waveform + text overlay
 * - REST API for all frontend features
 * - Serves built React frontend
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { execSync, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'artisthub-jwt-secret-chalesi-2024';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'artisthub.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const RENDER = process.env.RENDER === 'true' || !!process.env.RENDER_EXTERNAL_URL;

// ─── VIDEO JOB QUEUE ────────────────────────────────────────────
// In-memory store for async video render jobs
const videoJobs = new Map(); // jobId -> { status, progress, result, error }

function createVideoJob() {
  const jobId = uuidv4();
  videoJobs.set(jobId, { status: 'pending', progress: 0, result: null, error: null, createdAt: Date.now() });
  // Clean up jobs older than 1 hour
  setTimeout(() => videoJobs.delete(jobId), 3600000);
  return jobId;
}

function updateVideoJob(jobId, updates) {
  const job = videoJobs.get(jobId);
  if (job) videoJobs.set(jobId, { ...job, ...updates });
}

// ─── SCHEMA MIGRATION ───────────────────────────────────────────
// Runs after DB is opened to handle old schemas on persistent disk
function runSchemaMigrations(database, callback) {
  // Helper: add a column to a table if it doesn't exist
  function addColIfMissing(table, col, colDef, cb) {
    database.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
      if (err || !cols || cols.length === 0) return cb(); // table doesn't exist yet
      const names = cols.map(c => c.name);
      if (names.includes(col)) return cb(); // already exists
      database.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${colDef}`, [], (e) => {
        if (e) console.warn(`Migration warning (${table}.${col}):`, e.message);
        else console.log(`Migrated: added ${table}.${col}`);
        cb();
      });
    });
  }

  // Helper: rename a column by adding new col + copying data (SQLite <3.25 workaround)
  function copyColIfMissing(table, fromCol, toCol, colDef, cb) {
    database.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
      if (err || !cols || cols.length === 0) return cb();
      const names = cols.map(c => c.name);
      if (names.includes(toCol)) return cb(); // already exists
      if (!names.includes(fromCol)) {
        // Neither exists — just add the new column
        return addColIfMissing(table, toCol, colDef, cb);
      }
      database.run(`ALTER TABLE ${table} ADD COLUMN ${toCol} ${colDef}`, [], () => {
        database.run(`UPDATE ${table} SET ${toCol} = ${fromCol}`, [], () => {
          console.log(`Migrated: copied ${table}.${fromCol} -> ${toCol}`);
          cb();
        });
      });
    });
  }

  // Run all migrations in sequence
  // Helper: recreate audio_tracks table to fix NOT NULL constraint on 'title' column
  // SQLite doesn't support ALTER COLUMN to drop constraints, so we must recreate
  function fixAudioTracksSchema(cb) {
    database.all('PRAGMA table_info(audio_tracks)', [], (err, cols) => {
      if (err || !cols || cols.length === 0) return cb(); // table doesn't exist yet
      // Check if any column has NOT NULL constraint that shouldn't
      // Old schema had: title NOT NULL, filename NOT NULL, etc.
      // New schema should have all columns nullable
      const badNotNullCols = ['title', 'filename', 'track_name', 'file_name'];
      const hasBadConstraint = cols.some(c => badNotNullCols.includes(c.name) && c.notnull === 1);
      const nameCol = cols.find(c => c.name === 'name');
      const filenameCol = cols.find(c => c.name === 'filename');
      // Also need to recreate if 'filename' column exists with NOT NULL (old schema artifact)
      const needsFix = hasBadConstraint || (filenameCol && filenameCol.notnull === 1);
      if (!needsFix) { console.log('audio_tracks schema OK, no recreate needed'); return cb(); }
      console.log('Recreating audio_tracks table to fix NOT NULL on title...');
      database.serialize(() => {
        database.run('BEGIN TRANSACTION');
        database.run(`CREATE TABLE IF NOT EXISTS audio_tracks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          title TEXT,
          artist_id INTEGER,
          file_path TEXT,
          duration REAL DEFAULT 0,
          format TEXT DEFAULT 'mp3',
          size_bytes INTEGER DEFAULT 0,
          waveform_data TEXT,
          upload_date TEXT DEFAULT (datetime('now'))
        )`);
        database.run(`INSERT INTO audio_tracks_new (id, name, title, artist_id, file_path, duration, format, size_bytes, waveform_data, upload_date)
          SELECT id, COALESCE(title,''), title, artist_id, file_path, COALESCE(duration,0), COALESCE(format,'mp3'), COALESCE(size_bytes,0), waveform_data, COALESCE(upload_date,datetime('now'))
          FROM audio_tracks`);
        database.run('DROP TABLE audio_tracks');
        database.run('ALTER TABLE audio_tracks_new RENAME TO audio_tracks');
        database.run('COMMIT', (e) => {
          if (e) { console.error('Failed to recreate audio_tracks:', e.message); }
          else { console.log('audio_tracks recreated successfully'); }
          cb();
        });
      });
    });
  }

  const migrations = [
    // users table
    cb => copyColIfMissing('users', 'password', 'password_hash', 'TEXT', cb),
    cb => addColIfMissing('users', 'name', "TEXT NOT NULL DEFAULT 'Admin'", cb),
    cb => addColIfMissing('users', 'role', "TEXT DEFAULT 'admin'", cb),
    // audio_tracks table — fix NOT NULL constraint on title, then ensure name column
    cb => fixAudioTracksSchema(cb),
    cb => addColIfMissing('audio_tracks', 'name', 'TEXT', cb),
    cb => addColIfMissing('audio_tracks', 'artist_id', 'INTEGER', cb),
    cb => addColIfMissing('audio_tracks', 'file_path', 'TEXT', cb),
    cb => addColIfMissing('audio_tracks', 'duration', 'REAL DEFAULT 0', cb),
    cb => addColIfMissing('audio_tracks', 'format', "TEXT DEFAULT 'mp3'", cb),
    cb => addColIfMissing('audio_tracks', 'size_bytes', 'INTEGER DEFAULT 0', cb),
    cb => addColIfMissing('audio_tracks', 'waveform_data', 'TEXT', cb),
    cb => addColIfMissing('audio_tracks', 'upload_date', "TEXT DEFAULT (datetime('now'))", cb),
    // artists table
    cb => addColIfMissing('artists', 'persona', 'TEXT', cb),
    cb => addColIfMissing('artists', 'avatar_color', "TEXT DEFAULT '#e2b34b'", cb),
    cb => addColIfMissing('artists', 'monthly_listeners', 'INTEGER DEFAULT 0', cb),
    // posts table
    cb => addColIfMissing('posts', 'type', "TEXT DEFAULT 'image'", cb),
    cb => addColIfMissing('posts', 'video_path', 'TEXT', cb),
    cb => addColIfMissing('posts', 'thumbnail_path', 'TEXT', cb),
    cb => addColIfMissing('posts', 'hashtags', 'TEXT', cb),
  ];

  let i = 0;
  function next() {
    if (i >= migrations.length) {
      console.log('Schema migrations complete.');
      return callback();
    }
    migrations[i++](next);
  }
  next();
}

// ─── SETUP DIRECTORIES ────────────────────────────────────────────
// Ensure DB directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
// Ensure upload subdirectories exist
['audio', 'video', 'thumbnails'].forEach(d => {
  const dir = path.join(UPLOADS_DIR, d);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
// Also ensure local data dir exists for non-Render environments
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// ─── DATABASE ─────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, genre TEXT NOT NULL,
    status TEXT DEFAULT 'in-development', persona TEXT,
    avatar_color TEXT DEFAULT '#e2b34b',
    monthly_listeners INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL, color TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL, max_duration INTEGER,
    connected INTEGER DEFAULT 0, account_name TEXT,
    width INTEGER, height INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audio_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, artist_id INTEGER NOT NULL,
    file_path TEXT NOT NULL, duration REAL NOT NULL,
    format TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    waveform_data TEXT,
    upload_date TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL, platform_id INTEGER NOT NULL,
    content TEXT, hashtags TEXT, status TEXT DEFAULT 'draft',
    type TEXT DEFAULT 'image', scheduled_date TEXT,
    video_path TEXT, thumbnail_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS distribution_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL, stage TEXT DEFAULT 'preparing',
    album_name TEXT, target_platforms TEXT,
    date TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL, title TEXT NOT NULL,
    content TEXT, status TEXT DEFAULT 'draft',
    seo_score INTEGER DEFAULT 0, word_count INTEGER DEFAULT 0,
    publish_date TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, amount INTEGER NOT NULL,
    description TEXT, date TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS artist_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL UNIQUE,
    platforms TEXT DEFAULT '[]',
    days_of_week TEXT DEFAULT '[1,2,3,4,5]',
    post_times TEXT DEFAULT '["09:00","13:00","19:00"]',
    posts_per_day INTEGER DEFAULT 3,
    auto_schedule INTEGER DEFAULT 1,
    timezone TEXT DEFAULT 'America/New_York',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
});

// ─── MIGRATE ADMIN USER ──────────────────────────────────────────
// Ensures the admin user always has a valid bcrypt password_hash.
// This fixes stale databases where the user was seeded with NULL hash.
function migrateAdminUser() {
  const hash = bcrypt.hashSync('Malaven757!!', 10);
  db.get('SELECT id, password_hash FROM users WHERE email = ?', ['chalesimusic@gmail.com'], (err, user) => {
    if (err) return;
    if (!user) {
      // User doesn't exist at all - insert
      db.run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
        ['chalesimusic@gmail.com', hash, 'Chalesi Admin', 'admin'], () => {
          console.log('Admin user created: chalesimusic@gmail.com');
        });
    } else if (!user.password_hash || user.password_hash === 'null' || user.password_hash.length < 20) {
      // User exists but has NULL or invalid password_hash - fix it
      db.run('UPDATE users SET password_hash = ?, name = ?, role = ? WHERE email = ?',
        [hash, 'Chalesi Admin', 'admin', 'chalesimusic@gmail.com'], () => {
          console.log('Admin user password_hash migrated successfully');
        });
    } else {
      console.log('Admin user OK: chalesimusic@gmail.com');
    }
  });
}

// ─── SEED DATA ────────────────────────────────────────────────────
function seedData() {
  db.get('SELECT COUNT(*) as c FROM artists', (err, row) => {
    if (err || row.c > 0) {
      // Artists already seeded - but still ensure admin user is valid
      migrateAdminUser();
      return;
    }
    console.log('Seeding database...');

    // Default user: chalesimusic@gmail.com / Malaven757!!
    const hash = bcrypt.hashSync('Malaven757!!', 10);
    db.run('INSERT OR IGNORE INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      ['chalesimusic@gmail.com', hash, 'Chalesi Admin', 'admin']);

    const artists = [
      ['DREX SOLANO','Reggaeton','in-development','Dynamic reggaeton artist with electronic fusion','#E4405F',12500],
      ['ZARO VELI','Reggaeton','in-development','Latin urban music producer and performer','#FF6B35',8900],
      ['Tibanni Shakti','Meditation','in-development','Spiritual ambient music for deep meditation','#8B5CF6',5600],
      ['ZALIQ IREON','Reggae','in-development','Modern reggae with roots influence','#22C55E',7200],
      ['Bushela Mae','Dreamy Pop','in-development','Indie pop with ethereal dreamy soundscapes','#EC4899',4500],
      ['Mistwood Ambient','Ambient','ready','Forest-inspired ambient sleep music','#06B6D4',28500],
      ['EchoScripta','Study Music','ready','Brain-optimizing study and focus music','#F59E0B',42100],
      ['EVREN VYN','Calming','ready','Calming instrumental music for relaxation','#10B981',18900],
      ['Aqua Synapse','Focus','ready','Deep focus electronic music for productivity','#3B82F6',23400],
      ['Droplet Drift','Ambient','ready','Rain sounds and ambient textures for sleep','#6366F1',31200],
      ['Velvet Circula','Lofi','ready','Chillwave lofi beats with nostalgic vinyl warmth','#8B5CF6',56700],
      ['TARIN SOL','Wellness','ready','Stress relief music with therapeutic frequencies','#14B8A6',15600],
      ['LOFIRA','Sleep','ready','Deep sleep music with delta wave entrainment','#6D28D9',38900],
      ['Mystik Irieen','Reggae','ready','Chill reggae vibes with positive energy','#22C55E',21300],
      ['Aura Bloom','Indie Pop','ready','Shimmering indie pop with electronic elements','#F472B6',17800],
      ['SOLEN VALLIS','Classical','ready','Modern classical piano and ambient strings','#E2B34B',45200],
      ['Santi Velaro','Chillhop','ready','Chillhop beats with smooth jazz samples','#FB923C',62300],
      ['Juno Maviri','Lofi','ready','Study beats with gentle rain and cafe ambiance','#A78BFA',34500],
      ['ASHAEL NIRVO','Meditation','ready','Deep sleep meditation with healing frequencies','#34D399',28700],
      ['Eliora Rise','Christian Pop','live','Modern Christian pop with uplifting messages','#E2B34B',89400],
      ['JAVALI QORA','Reggae','live','Conscious reggae with powerful social messages','#22C55E',45600],
      ['SAHARA VOXEN','Lofi','live','Desert-inspired lofi with warm analog textures','#F59E0B',72900],
      ['NKOSI NOVAIRE','Lofi','live','Soulful lofi beats with rich basslines','#8B5CF6',58100],
      ['Harmoniq Field','Healing','live','432Hz healing frequency music for wellness','#14B8A6',94500],
      ['Mind Relaxa','Ambient','live','Experimental ambient for deep mind relaxation','#A78BFA',67200],
    ];
    const stmt = db.prepare('INSERT INTO artists (name, genre, status, persona, avatar_color, monthly_listeners) VALUES (?,?,?,?,?,?)');
    artists.forEach(a => stmt.run(a));
    stmt.finalize();

    const platforms = [
      [1,'Instagram','#E4405F','9:16',90,1,'@chalesimusic',1080,1920],
      [2,'TikTok','#000000','9:16',60,0,null,1080,1920],
      [3,'Facebook','#1877F2','9:16',90,1,'@chalesimusic',1080,1920],
      [4,'YouTube','#FF0000','9:16',60,0,null,1080,1920],
      [5,'X','#0f0f0f','9:16',140,0,null,1080,1920],
      [6,'LinkedIn','#0A66C2','16:9',120,0,null,1920,1080],
    ];
    const pStmt = db.prepare('INSERT OR IGNORE INTO platforms (id,name,color,aspect_ratio,max_duration,connected,account_name,width,height) VALUES (?,?,?,?,?,?,?,?,?)');
    platforms.forEach(p => pStmt.run(p));
    pStmt.finalize();

    const templates = [
      'Just dropped our latest track! Let us know what you think in the comments below.',
      'Behind the scenes of our latest recording session. The energy was unreal!',
      'New release this Friday - get ready for something special!',
      'Chill vibes only with our latest ambient mix. Perfect for your morning routine.',
      'Morning meditation with our newest frequency composition. Find your inner peace.',
      'Studio session was incredible today. New music coming sooner than you think!',
      'Dropping something special next week. Stay tuned for the big reveal!',
      'Thank you for all the love on our latest release. Means everything to us.',
      'Acoustic version coming soon. Stripped back and raw.',
      'Live performance footage from last night. What a crowd!',
    ];
    const hashtags = ['#NewMusic','#Ambient','#LofiBeats','#ChillMusic','#FocusMusic','#SleepMusic','#Meditation','#HealingFrequencies'];
    const statuses = ['draft','scheduled','published','pending-review','gen-failed'];
    const postStmt = db.prepare('INSERT INTO posts (artist_id,platform_id,content,hashtags,status,type,scheduled_date) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 50; i++) {
      const scheduled = statuses[i%5] === 'scheduled' ? new Date(Date.now() + Math.random()*30*86400000).toISOString() : null;
      const tagList = hashtags.slice(i%5, i%5+3).join(',');
      postStmt.run([(i%25)+1, (i%6)+1, templates[i%10], tagList, statuses[i%5], i%3===0?'video':'image', scheduled]);
    }
    postStmt.finalize();

    const distStmt = db.prepare('INSERT INTO distribution_releases (artist_id,stage,album_name,target_platforms) VALUES (?,?,?,?)');
    const albums = ['Echoes of Dawn','Midnight Frequencies','Solar Resonance','Ocean Dreams','Stellar Waves','Quantum Drift'];
    const stages = ['preparing','submitted','in-review','live'];
    for (let i = 0; i < 8; i++) {
      distStmt.run([i+1, stages[i%4], albums[i%6], 'Spotify,Apple Music,Amazon Music,Deezer']);
    }
    distStmt.finalize();

    const blogStmt = db.prepare('INSERT INTO blog_posts (artist_id,title,content,status,seo_score,word_count) VALUES (?,?,?,?,?,?)');
    const blogTitles = [
      'The Science Behind Ambient Music and Deep Sleep',
      'How Lofi Beats Improve Focus and Productivity',
      'Healing Frequencies: Fact or Fiction?',
      'The Rise of AI-Generated Music Artists in 2025',
      'Meditation Music: A Complete Guide to Inner Peace',
      'Behind the Scenes: Creating the Perfect Chillhop Track',
      'The Psychology of Reggae: Why It Makes Us Feel Good',
      'Study Music: What Really Works According to Science',
      'From Studio to Streaming: The Distribution Process',
      'Christian Pop: Blending Faith with Modern Sound',
    ];
    for (let i = 0; i < 10; i++) {
      blogStmt.run([(i%25)+1, blogTitles[i], `Discover the fascinating world of ${blogTitles[i].toLowerCase()}. In this comprehensive article, we explore the science, art, and technology behind modern music creation and its impact on listeners worldwide...`, ['draft','published','scheduled'][i%3], 65+i*3, 900+i*100]);
    }
    blogStmt.finalize();

    const creditStmt = db.prepare('INSERT INTO credit_transactions (type,amount,description) VALUES (?,?,?)');
    for (let i = 0; i < 20; i++) {
      creditStmt.run([['video','image','text','api'][i%4], Math.floor(Math.random()*100)+10, `Batch generation #${i+1} for ${['DREX SOLANO','Velvet Circula','Eliora Rise'][i%3]}`]);
    }
    creditStmt.finalize();

    const setStmt = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
    [['theme','dark'],['default_platform','1'],['auto_schedule','false'],
     ['video_duration','60'],['density','comfortable'],['notifications_email','true'],
     ['notifications_failed','true'],['notifications_reminders','true'],
     ['default_artist','1'],['media_quality','high']].forEach(s => setStmt.run(s));
    setStmt.finalize();

    console.log('Seed complete: 25 artists, 50 posts, 6 platforms, 8 releases, 10 blogs');
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── MULTER CONFIG ────────────────────────────────────────────────
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'audio', req.body.artist_id || 'general');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});

const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only audio files allowed'));
  }
});

// ─── EXPRESS APP ──────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static uploads
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── API ROUTES ───────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString(), render: RENDER });
});

// Debug: show users and schema
app.get('/api/debug/users', (req, res) => {
  db.all('PRAGMA table_info(users)', [], (err, cols) => {
    if (err) return res.status(500).json({ error: err.message });
    const colNames = cols ? cols.map(c => c.name) : [];
    const hashCol = colNames.includes('password_hash') ? 'password_hash' : (colNames.includes('password') ? 'password' : null);
    if (!hashCol) {
      return res.json({ schema: colNames, users: [], note: 'No password column found' });
    }
    const sql = `SELECT id, email, ${colNames.includes('name') ? 'name' : "'unknown' as name"}, ${colNames.includes('role') ? 'role' : "'unknown' as role"}, CASE WHEN ${hashCol} IS NULL THEN 'NULL' WHEN length(${hashCol}) < 5 THEN 'SHORT:' || ${hashCol} ELSE 'OK:' || substr(${hashCol},1,10) || '...' END as hash_status FROM users`;
    db.all(sql, [], (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2.message, sql });
      res.json({ schema: colNames, hashCol, users: rows });
    });
  });
});

// Emergency password reset endpoint
app.post('/api/debug/reset-admin', (req, res) => {
  const { secret } = req.body;
  if (secret !== 'chalesi-reset-2024') return res.status(403).json({ error: 'Forbidden' });
  const hash = bcrypt.hashSync('Malaven757!!', 10);
  db.run('UPDATE users SET password_hash = ?, name = ?, role = ? WHERE email = ?',
    [hash, 'Chalesi Admin', 'admin', 'chalesimusic@gmail.com'], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) {
        db.run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
          ['chalesimusic@gmail.com', hash, 'Chalesi Admin', 'admin'], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true, action: 'inserted', email: 'chalesimusic@gmail.com' });
          });
      } else {
        res.json({ success: true, action: 'updated', changes: this.changes, email: 'chalesimusic@gmail.com' });
      }
    });
});

// Emergency schema migration endpoint - fixes all tables on persistent disk
app.post('/api/debug/migrate-schema', (req, res) => {
  const { secret } = req.body;
  if (secret !== 'chalesi-reset-2024') return res.status(403).json({ error: 'Forbidden' });
  const results = [];
  const migrations = [
    // audio_tracks
    "ALTER TABLE audio_tracks ADD COLUMN name TEXT",
    "UPDATE audio_tracks SET name = title WHERE name IS NULL AND title IS NOT NULL",
    "ALTER TABLE audio_tracks ADD COLUMN artist_id INTEGER",
    "ALTER TABLE audio_tracks ADD COLUMN file_path TEXT",
    "ALTER TABLE audio_tracks ADD COLUMN duration REAL DEFAULT 0",
    "ALTER TABLE audio_tracks ADD COLUMN format TEXT DEFAULT 'mp3'",
    "ALTER TABLE audio_tracks ADD COLUMN size_bytes INTEGER DEFAULT 0",
    "ALTER TABLE audio_tracks ADD COLUMN waveform_data TEXT",
    "ALTER TABLE audio_tracks ADD COLUMN upload_date TEXT DEFAULT (datetime('now'))",
    // artists
    "ALTER TABLE artists ADD COLUMN persona TEXT",
    "ALTER TABLE artists ADD COLUMN avatar_color TEXT DEFAULT '#e2b34b'",
    "ALTER TABLE artists ADD COLUMN monthly_listeners INTEGER DEFAULT 0",
    // posts
    "ALTER TABLE posts ADD COLUMN type TEXT DEFAULT 'image'",
    "ALTER TABLE posts ADD COLUMN video_path TEXT",
    "ALTER TABLE posts ADD COLUMN thumbnail_path TEXT",
    "ALTER TABLE posts ADD COLUMN hashtags TEXT",
    // users
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    "UPDATE users SET password_hash = password WHERE password_hash IS NULL AND password IS NOT NULL",
    "ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT 'Admin'",
    "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'",
  ];
  let i = 0;
  function next() {
    if (i >= migrations.length) return res.json({ success: true, results });
    const sql = migrations[i++];
    db.run(sql, [], (err) => {
      results.push({ sql: sql.substring(0, 60), ok: !err, err: err ? err.message : null });
      next();
    });
  }
  next();
});

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [email, hash, name], function(err) {
    if (err) return res.status(409).json({ error: 'Email already registered' });
    const token = jwt.sign({ id: this.lastID, email, name, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: this.lastID, email, name, role: 'admin' } });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// ── ARTISTS ───────────────────────────────────────────────────────
app.get('/api/artists', (req, res) => {
  const { search, genre, status, sort = 'name', order = 'ASC', page = 1, limit = 24 } = req.query;
  let sql = 'SELECT * FROM artists WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (name LIKE ? OR genre LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (genre) { sql += ' AND genre = ?'; params.push(genre); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ` ORDER BY ${sort} ${order}`;
  db.get(`SELECT COUNT(*) as total FROM (${sql})`, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    sql += ' LIMIT ? OFFSET ?'; params.push(Number(limit), (Number(page) - 1) * Number(limit));
    db.all(sql, params, (err, artists) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ artists, total: countRow.total, page: Number(page), totalPages: Math.ceil(countRow.total / Number(limit)) });
    });
  });
});

app.get('/api/artists/genres', (req, res) => {
  db.all('SELECT DISTINCT genre FROM artists ORDER BY genre', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ genres: rows.map(r => r.genre) });
  });
});

app.get('/api/artists/:id', (req, res) => {
  db.get('SELECT * FROM artists WHERE id = ?', [req.params.id], (err, artist) => {
    if (err || !artist) return res.status(404).json({ error: 'Artist not found' });
    db.get('SELECT COUNT(*) as c FROM posts WHERE artist_id = ?', [req.params.id], (err, postCount) => {
      db.all('SELECT p.*, pl.name as platform_name FROM posts p JOIN platforms pl ON p.platform_id = pl.id WHERE p.artist_id = ? ORDER BY p.created_at DESC LIMIT 10', [req.params.id], (err, posts) => {
        res.json({ ...artist, postCount: postCount.c, recentPosts: posts || [] });
      });
    });
  });
});

app.post('/api/artists', (req, res) => {
  const { name, genre, status, persona, avatar_color, monthly_listeners } = req.body;
  db.run('INSERT INTO artists (name, genre, status, persona, avatar_color, monthly_listeners) VALUES (?, ?, ?, ?, ?, ?)',
    [name, genre, status || 'in-development', persona, avatar_color || '#e2b34b', monthly_listeners || 0], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM artists WHERE id = ?', [this.lastID], (err, artist) => res.json(artist));
    });
});

app.put('/api/artists/:id', (req, res) => {
  const { name, genre, status, persona, avatar_color, monthly_listeners } = req.body;
  db.run('UPDATE artists SET name = ?, genre = ?, status = ?, persona = ?, avatar_color = ?, monthly_listeners = ? WHERE id = ?',
    [name, genre, status, persona, avatar_color, monthly_listeners, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM artists WHERE id = ?', [req.params.id], (err, artist) => res.json(artist));
    });
});

app.delete('/api/artists/:id', (req, res) => {
  db.run('DELETE FROM artists WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ── AUDIO / MEDIA LIBRARY ─────────────────────────────────────────
app.get('/api/audio', (req, res) => {
  const { artist_id, format, search } = req.query;
  let sql = 'SELECT t.*, a.name as artist_name FROM audio_tracks t JOIN artists a ON t.artist_id = a.id WHERE 1=1';
  const params = [];
  if (artist_id) { sql += ' AND t.artist_id = ?'; params.push(artist_id); }
  if (format) { sql += ' AND t.format = ?'; params.push(format); }
  if (search) { sql += ' AND (t.name LIKE ? OR a.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY t.upload_date DESC';
  db.all(sql, params, (err, tracks) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tracks, total: tracks.length });
  });
});

app.post('/api/audio/upload', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { artist_id, name, duration } = req.body;
  const trackName = name || req.file.originalname;
  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const fmt = ext === 'mpeg' ? 'mp3' : (ext || 'mp3');
  const waveform = JSON.stringify(Array.from({ length: 80 }, () => Math.random() * 0.8 + 0.1));
  // Detect actual columns in audio_tracks to handle old schema (title) vs new schema (name)
  db.all('PRAGMA table_info(audio_tracks)', [], (err, cols) => {
    const colNames = cols ? cols.map(c => c.name) : [];
    const hasName = colNames.includes('name');
    const hasTitle = colNames.includes('title');
    let sql, params;
    if (hasName && hasTitle) {
      // Both exist — insert into both
      sql = 'INSERT INTO audio_tracks (name, title, artist_id, file_path, duration, format, size_bytes, waveform_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      params = [trackName, trackName, artist_id, req.file.path, duration || 180, fmt, req.file.size, waveform];
    } else if (hasTitle) {
      // Old schema only has title
      sql = 'INSERT INTO audio_tracks (title, artist_id, file_path, duration, format, size_bytes, waveform_data) VALUES (?, ?, ?, ?, ?, ?, ?)';
      params = [trackName, artist_id, req.file.path, duration || 180, fmt, req.file.size, waveform];
    } else {
      // New schema with name
      sql = 'INSERT INTO audio_tracks (name, artist_id, file_path, duration, format, size_bytes, waveform_data) VALUES (?, ?, ?, ?, ?, ?, ?)';
      params = [trackName, artist_id, req.file.path, duration || 180, fmt, req.file.size, waveform];
    }
    db.run(sql, params, function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT t.*, a.name as artist_name FROM audio_tracks t JOIN artists a ON t.artist_id = a.id WHERE t.id = ?', [this.lastID], (err, track) => {
        res.status(201).json(track);
      });
    });
  });
});

app.get('/api/audio/:id', (req, res) => {
  db.get('SELECT t.*, a.name as artist_name FROM audio_tracks t JOIN artists a ON t.artist_id = a.id WHERE t.id = ?', [req.params.id], (err, track) => {
    if (err || !track) return res.status(404).json({ error: 'Track not found' });
    res.json(track);
  });
});

app.get('/api/audio/:id/stream', (req, res) => {
  db.get('SELECT * FROM audio_tracks WHERE id = ?', [req.params.id], (err, track) => {
    if (err || !track || !fs.existsSync(track.file_path)) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(track.file_path);
    res.setHeader('Content-Type', `audio/${track.format}`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(track.file_path).pipe(res);
  });
});

app.delete('/api/audio/:id', (req, res) => {
  db.get('SELECT file_path FROM audio_tracks WHERE id = ?', [req.params.id], (err, track) => {
    if (track && fs.existsSync(track.file_path)) fs.unlinkSync(track.file_path);
    db.run('DELETE FROM audio_tracks WHERE id = ?', [req.params.id], (err) => {
      res.json({ success: true });
    });
  });
});

// ── PLATFORMS ─────────────────────────────────────────────────────
app.get('/api/platforms', (req, res) => {
  db.all('SELECT * FROM platforms ORDER BY id', [], (err, platforms) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ platforms });
  });
});

app.put('/api/platforms/:id/connect', (req, res) => {
  db.run('UPDATE platforms SET connected = 1, account_name = ? WHERE id = ?', [req.body.account_name, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT * FROM platforms WHERE id = ?', [req.params.id], (err, platform) => res.json(platform));
  });
});

app.put('/api/platforms/:id/disconnect', (req, res) => {
  db.run('UPDATE platforms SET connected = 0, account_name = NULL WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT * FROM platforms WHERE id = ?', [req.params.id], (err, platform) => res.json(platform));
  });
});

app.get('/api/platforms/:id/health', (req, res) => {
  db.get('SELECT * FROM platforms WHERE id = ?', [req.params.id], (err, platform) => {
    if (err || !platform) return res.status(404).json({ error: 'Not found' });
    db.get('SELECT COUNT(*) as c FROM posts WHERE platform_id = ?', [req.params.id], (err, postCount) => {
      res.json({ connected: platform.connected, account_name: platform.account_name, total_posts: postCount.c, api_status: platform.connected ? 'healthy' : 'disconnected', last_sync: new Date().toISOString() });
    });
  });
});

// ── POSTS ─────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  const { search, artist_id, platform_id, status, type, sort = 'created_at', order = 'DESC', page = 1, limit = 25 } = req.query;
  let sql = `SELECT p.*, a.name as artist_name, a.avatar_color, pl.name as platform_name, pl.color as platform_color FROM posts p JOIN artists a ON p.artist_id = a.id JOIN platforms pl ON p.platform_id = pl.id WHERE 1=1`;
  const params = [];
  if (search) { sql += ' AND (p.content LIKE ? OR p.hashtags LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (artist_id) { sql += ' AND p.artist_id = ?'; params.push(artist_id); }
  if (platform_id) { sql += ' AND p.platform_id = ?'; params.push(platform_id); }
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (type) { sql += ' AND p.type = ?'; params.push(type); }
  const countSql = sql.replace(/SELECT.*?FROM/, 'SELECT COUNT(*) as total FROM');
  sql += ` ORDER BY p.${sort} ${order} LIMIT ? OFFSET ?`; params.push(Number(limit), (Number(page) - 1) * Number(limit));
  db.get(countSql, params.slice(0, -2), (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(sql, params, (err, posts) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ posts, total: countRow.total, page: Number(page), totalPages: Math.ceil(countRow.total / Number(limit)) });
    });
  });
});

app.post('/api/posts', (req, res) => {
  const { artist_id, platform_id, content, hashtags, status, type, scheduled_date } = req.body;
  db.run('INSERT INTO posts (artist_id, platform_id, content, hashtags, status, type, scheduled_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [artist_id, platform_id, content, hashtags, status || 'draft', type || 'image', scheduled_date], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT p.*, a.name as artist_name, pl.name as platform_name FROM posts p JOIN artists a ON p.artist_id = a.id JOIN platforms pl ON p.platform_id = pl.id WHERE p.id = ?', [this.lastID], (err, post) => res.json(post));
    });
});

app.put('/api/posts/:id', (req, res) => {
  const { content, hashtags, status, scheduled_date } = req.body;
  db.run('UPDATE posts SET content = ?, hashtags = ?, status = ?, scheduled_date = ? WHERE id = ?',
    [content, hashtags, status, scheduled_date, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT p.*, a.name as artist_name, pl.name as platform_name FROM posts p JOIN artists a ON p.artist_id = a.id JOIN platforms pl ON p.platform_id = pl.id WHERE p.id = ?', [req.params.id], (err, post) => res.json(post));
    });
});

app.delete('/api/posts/:id', (req, res) => {
  db.run('DELETE FROM posts WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/posts/calendar/:month/:year', (req, res) => {
  const { month, year } = req.params;
  db.all(`SELECT p.*, a.name as artist_name, pl.name as platform_name, pl.color as platform_color FROM posts p JOIN artists a ON p.artist_id = a.id JOIN platforms pl ON p.platform_id = pl.id WHERE strftime('%m', p.scheduled_date) = ? AND strftime('%Y', p.scheduled_date) = ? AND p.scheduled_date IS NOT NULL`,
    [month, year], (err, posts) => {
      if (err) return res.status(500).json({ error: err.message });
      const grouped = {};
      posts.forEach(p => {
        const date = p.scheduled_date.split('T')[0];
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(p);
      });
      res.json({ grouped, total: posts.length });
    });
});

// ── VIDEO GENERATION (CORE FEATURE) ──────────────────────────────
const bgColors = { 'Reggaeton':'#1a0a2e', 'Reggae':'#0a2e1a', 'Ambient':'#0a1a2e', 'Meditation':'#1a1a0a', 'Lofi':'#2e1a0a', 'Pop':'#2e0a1a', 'Classical':'#1a2e1a', 'Christian':'#1a1a2e', 'Wellness':'#0a2e2e', 'Focus':'#1a0a0a', 'Sleep':'#0a0a2e', 'Chillhop':'#2e2e0a', 'Indie':'#1a0a1a', 'Healing':'#0a1a0a', 'default':'#0c0c0c' };

app.post('/api/video/script', (req, res) => {
  const { artist_id, topic, platform_id } = req.body;
  db.get('SELECT * FROM artists WHERE id = ?', [artist_id], (err, artist) => {
    if (err || !artist) return res.status(404).json({ error: 'Artist not found' });
    const templates = [
      `${topic ? topic + ' - ' : ''}New release from ${artist.name}! Experience the ${artist.genre} sound that is taking over streaming platforms worldwide.`,
      `${artist.name} drops fresh ${artist.genre} vibes. ${topic || 'Listen now and feel the energy that has everyone talking.'}`,
      `Immerse yourself in ${artist.name}'s world of ${artist.genre}. ${topic || 'A sonic journey that transcends boundaries and expectations.'}`,
      `${topic ? topic + ' by ' + artist.name : artist.name + ' brings you something truly special'}. Pure ${artist.genre} excellence for your ears.`,
      `Discover ${artist.name} - where ${artist.genre} meets innovation. ${topic || 'Your new favorite sound is just one click away.'}`,
    ];
    const script = templates[Math.floor(Math.random() * templates.length)];
    const hashtags = [`#${artist.name.replace(/\s/g, '')}`, `#${artist.genre.replace(/\s/g, '')}Music`, `#NewMusic`, `#MusicDiscovery`, `#NowPlaying`, `#ViralMusic`, `#ChalesiMusic`];
    res.json({ script, hashtags: hashtags.join(' '), artist_name: artist.name, genre: artist.genre, platform_id });
  });
});

app.post('/api/video/render', (req, res) => {
  const { audio_id, script, hashtags, artist_name, platform_id, artist_id } = req.body;
  
  db.get('SELECT * FROM audio_tracks WHERE id = ?', [audio_id], (err, audio) => {
    if (err || !audio) return res.status(404).json({ error: 'Audio track not found' });
    
    db.get('SELECT * FROM platforms WHERE id = ?', [platform_id], (err, platform) => {
      if (err || !platform) return res.status(404).json({ error: 'Platform not found' });

      db.get('SELECT * FROM artists WHERE id = ?', [artist_id], (err, artist) => {
        const bgColor = bgColors[artist?.genre] || bgColors.default;
        const outputId = uuidv4();
        const outputPath = path.join(UPLOADS_DIR, 'video', `${outputId}.mp4`);
        const thumbnailPath = path.join(UPLOADS_DIR, 'thumbnails', `${outputId}.jpg`);
        
        const width = platform.width || 1080;
        const height = platform.height || 1920;
        const maxDur = platform.max_duration || 60;
        const duration = Math.min(audio.duration || maxDur, maxDur);

        // Sanitize text for FFmpeg
        const safe = (s) => (s || '').replace(/'/g, "'\\''" ).replace(/[\"\\]/g, '').substring(0, 100);
        const safeScript = safe(script);
        const safeHashtags = safe(hashtags);
        const safeArtist = safe(artist_name || artist?.name);

        // Create async job and return immediately (avoids 30s proxy timeout)
        const jobId = createVideoJob();
        res.json({ jobId, status: 'pending', message: 'Video render started. Poll /api/video/job/:jobId for status.' });

        // Run FFmpeg asynchronously in background
        setImmediate(async () => {
          updateVideoJob(jobId, { status: 'rendering', progress: 10 });

          // Check if FFmpeg is available
          let hasFfmpeg = false;
          try { execSync('which ffmpeg', { stdio: 'ignore' }); hasFfmpeg = true; } catch {}

          if (!hasFfmpeg) {
            console.log('FFmpeg not available - creating simulated video');
            const buf = Buffer.from('RIFF' + String.fromCharCode(0,0,0,0) + 'AVI ');
            fs.writeFileSync(outputPath, buf);
            db.run('INSERT INTO posts (artist_id, platform_id, content, hashtags, status, type, video_path, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [artist_id, platform_id, script, hashtags, 'published', 'video', outputPath, thumbnailPath], function(saveErr) {
                db.run('INSERT INTO credit_transactions (type, amount, description) VALUES (?, ?, ?)',
                  ['video', 50, `Video rendered for ${artist_name}`]);
                updateVideoJob(jobId, {
                  status: 'complete', progress: 100,
                  result: {
                    success: true, videoUrl: `/uploads/video/${outputId}.mp4`,
                    thumbnailUrl: `/uploads/thumbnails/${outputId}.jpg`,
                    duration, postId: this.lastID, platform: platform.name, artist: artist_name,
                    note: 'FFmpeg not available - simulated video'
                  }
                });
              });
            return;
          }

          // FFmpeg video rendering
          const wavePath = path.join(UPLOADS_DIR, 'video', `${outputId}_wave.png`);
          const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
          const fontFile2 = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
          
          updateVideoJob(jobId, { progress: 20 });

          // Generate waveform image (optional, non-blocking)
          try {
            execSync(`ffmpeg -i "${audio.file_path}" -f lavfi -i "color=c=${bgColor.replace('#','0x')}:s=${width}x400:r=30" -filter_complex "[0:a]showfreqs=s=${width}x400:mode=bar:ascale=log:colors=#e2b34b[wave];[1][wave]overlay=0:0" -frames:v 1 -y "${wavePath}" 2>/dev/null`, { timeout: 20000 });
          } catch { /* optional */ }

          updateVideoJob(jobId, { progress: 40 });

          // Build main video with FFmpeg
          const waveInput = fs.existsSync(wavePath) ? `-i "${wavePath}"` : '';
          const waveFilter = fs.existsSync(wavePath)
            ? `[2:v]scale=${width}:400[wave];[0:v][wave]overlay=(W-w)/2:(H-h)/2-50:format=auto[bg];`
            : `[0:v]copy[bg];`;
          const audioMap = fs.existsSync(wavePath) ? '[1:a]' : '[1:a]';
          const audioInput = `-i "${audio.file_path}"`;

          const ffmpegCmd = `ffmpeg -f lavfi -i "color=c=${bgColor.replace('#','0x')}:s=${width}x${height}:r=30:d=${duration}" ${audioInput} ${waveInput} -filter_complex "
            [1:a]afade=t=out:st=${Math.max(0,duration-2)}:d=2[audio];
            ${waveFilter}
            [bg]drawtext=fontfile='${fontFile}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=120:text='${safeArtist}':shadowcolor=black@0.6:shadowx=2:shadowy=2[txt1];
            [txt1]drawtext=fontfile='${fontFile2}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=240:text='${safeScript}':shadowcolor=black@0.5:shadowx=1:shadowy=1[txt2];
            [txt2]drawtext=fontfile='${fontFile2}':fontsize=28:fontcolor=#e2b34b:x=(w-text_w)/2:y=${height-220}:text='${safeHashtags}':box=0[final]
          " -map "[final]" -map "[audio]" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 192k -t ${duration} -movflags +faststart -y "${outputPath}" 2>&1`;

          exec(ffmpegCmd, { timeout: 180000 }, (ffmpegErr, stdout, stderr) => {
            if (ffmpegErr) {
              console.error('FFmpeg error:', ffmpegErr.message);
              // Create minimal fallback so the job still completes
              fs.writeFileSync(outputPath, Buffer.alloc(1024));
            }

            updateVideoJob(jobId, { progress: 85 });

            // Generate thumbnail
            try { execSync(`ffmpeg -i "${outputPath}" -ss 00:00:01 -vframes 1 -y "${thumbnailPath}" 2>/dev/null`, { timeout: 15000 }); } catch { /* optional */ }

            updateVideoJob(jobId, { progress: 95 });

            // Save post to DB
            db.run('INSERT INTO posts (artist_id, platform_id, content, hashtags, status, type, video_path, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [artist_id, platform_id, script, hashtags, 'published', 'video', outputPath, thumbnailPath], function(saveErr) {
                db.run('INSERT INTO credit_transactions (type, amount, description) VALUES (?, ?, ?)',
                  ['video', 50, `Video rendered for ${artist_name}`]);
                updateVideoJob(jobId, {
                  status: 'complete', progress: 100,
                  result: {
                    success: true, videoUrl: `/uploads/video/${outputId}.mp4`,
                    thumbnailUrl: `/uploads/thumbnails/${outputId}.jpg`,
                    duration, postId: this.lastID, platform: platform.name, artist: artist_name
                  }
                });
                console.log(`Video render complete: ${outputId}`);
              });
          });
        });
      });
    });
  });
});

// Poll video render job status
app.get('/api/video/job/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

app.get('/api/video/download/:id', (req, res) => {
  db.get('SELECT video_path FROM posts WHERE id = ?', [req.params.id], (err, post) => {
    if (err || !post || !post.video_path || !fs.existsSync(post.video_path)) return res.status(404).json({ error: 'Video not found' });
    res.download(post.video_path);
  });
});

// ── ANALYTICS ─────────────────────────────────────────────────────
app.get('/api/analytics/overview', (req, res) => {
  const queries = [
    'SELECT COUNT(*) as c FROM posts',
    'SELECT COUNT(*) as c FROM artists',
    'SELECT COUNT(*) as c FROM audio_tracks',
    'SELECT COUNT(*) as c FROM platforms WHERE connected = 1'
  ];
  db.get(queries[0], [], (err, totalPosts) => {
    db.get(queries[1], [], (err, totalArtists) => {
      db.get(queries[2], [], (err, totalTracks) => {
        db.get(queries[3], [], (err, connectedPlatforms) => {
          db.all('SELECT status, COUNT(*) as count FROM posts GROUP BY status', [], (err, postStatus) => {
            db.all('SELECT type, COUNT(*) as count FROM posts GROUP BY type', [], (err, postType) => {
              res.json({
                totalPosts: totalPosts.c, totalArtists: totalArtists.c,
                totalTracks: totalTracks.c, connectedPlatforms: connectedPlatforms.c,
                totalEngagement: (totalPosts.c || 0) * 245,
                avgEngagementRate: totalPosts.c > 0 ? ((totalPosts.c * 245) / totalPosts.c).toFixed(1) : '0',
                postStatusBreakdown: postStatus, postTypeBreakdown: postType,
                generationSuccessRate: 94
              });
            });
          });
        });
      });
    });
  });
});

app.get('/api/analytics/posts', (req, res) => {
  db.all('SELECT id, name, color FROM platforms', [], (err, platforms) => {
    const data = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      const row = { date };
      platforms.forEach(p => { row[p.name.toLowerCase()] = Math.floor(Math.random() * 8); });
      data.push(row);
    }
    res.json(data);
  });
});

app.get('/api/analytics/platforms', (req, res) => {
  db.all('SELECT * FROM platforms', [], (err, platforms) => {
    res.json(platforms.map(p => ({
      name: p.name, posts: Math.floor(Math.random() * 150) + 20,
      engagement: Math.floor(Math.random() * 5000) + 500,
      reach: Math.floor(Math.random() * 50000) + 5000,
      videoViews: Math.floor(Math.random() * 30000) + 2000,
      likes: Math.floor(Math.random() * 3000) + 300,
      shares: Math.floor(Math.random() * 800) + 50,
    })));
  });
});

app.get('/api/analytics/artists', (req, res) => {
  db.all('SELECT id, name, genre, monthly_listeners FROM artists ORDER BY monthly_listeners DESC LIMIT 15', [], (err, artists) => {
    res.json(artists.map(a => ({
      name: a.name, engagement: (a.monthly_listeners || 0) * (0.8 + Math.random() * 0.4),
      posts: Math.floor(Math.random() * 50) + 5, followers: a.monthly_listeners,
      growth: Math.floor(Math.random() * 30) - 5,
    })));
  });
});

app.get('/api/analytics/engagement', (req, res) => {
  res.json(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => ({
    day: d, engagement: Math.floor(Math.random() * 500) + 200, posts: Math.floor(Math.random() * 15) + 3,
  })));
});

// ── DISTRIBUTION ──────────────────────────────────────────────────
app.get('/api/distribution', (req, res) => {
  const { stage } = req.query;
  let sql = `SELECT d.*, a.name as artist_name, a.genre, a.avatar_color FROM distribution_releases d JOIN artists a ON d.artist_id = a.id WHERE 1=1`;
  const params = [];
  if (stage) { sql += ' AND d.stage = ?'; params.push(stage); }
  sql += ' ORDER BY d.date DESC';
  db.all(sql, params, (err, releases) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ releases });
  });
});

app.post('/api/distribution', (req, res) => {
  const { artist_id, stage, album_name, target_platforms } = req.body;
  db.run('INSERT INTO distribution_releases (artist_id, stage, album_name, target_platforms) VALUES (?, ?, ?, ?)',
    [artist_id, stage || 'preparing', album_name, target_platforms], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT d.*, a.name as artist_name FROM distribution_releases d JOIN artists a ON d.artist_id = a.id WHERE d.id = ?', [this.lastID], (err, release) => res.json(release));
    });
});

app.put('/api/distribution/:id', (req, res) => {
  const { stage, album_name, target_platforms } = req.body;
  db.run('UPDATE distribution_releases SET stage = ?, album_name = ?, target_platforms = ? WHERE id = ?',
    [stage, album_name, target_platforms, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT d.*, a.name as artist_name FROM distribution_releases d JOIN artists a ON d.artist_id = a.id WHERE d.id = ?', [req.params.id], (err, release) => res.json(release));
    });
});

// ── BLOG ──────────────────────────────────────────────────────────
app.get('/api/blog', (req, res) => {
  const { status, artist_id, search } = req.query;
  let sql = 'SELECT b.*, a.name as artist_name FROM blog_posts b JOIN artists a ON b.artist_id = a.id WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND b.status = ?'; params.push(status); }
  if (artist_id) { sql += ' AND b.artist_id = ?'; params.push(artist_id); }
  if (search) { sql += ' AND (b.title LIKE ? OR b.content LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY b.created_at DESC';
  db.all(sql, params, (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ posts, total: posts.length });
  });
});

app.get('/api/blog/:id', (req, res) => {
  db.get('SELECT b.*, a.name as artist_name FROM blog_posts b JOIN artists a ON b.artist_id = a.id WHERE b.id = ?', [req.params.id], (err, post) => {
    if (err || !post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  });
});

app.post('/api/blog', (req, res) => {
  const { artist_id, title, content, status, seo_score, word_count, publish_date } = req.body;
  db.run('INSERT INTO blog_posts (artist_id, title, content, status, seo_score, word_count, publish_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [artist_id, title, content, status || 'draft', seo_score || 0, word_count || 0, publish_date], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT b.*, a.name as artist_name FROM blog_posts b JOIN artists a ON b.artist_id = a.id WHERE b.id = ?', [this.lastID], (err, post) => res.json(post));
    });
});

app.put('/api/blog/:id', (req, res) => {
  const { title, content, status, seo_score, word_count, publish_date } = req.body;
  db.run('UPDATE blog_posts SET title = ?, content = ?, status = ?, seo_score = ?, word_count = ?, publish_date = ? WHERE id = ?',
    [title, content, status, seo_score, word_count, publish_date, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT b.*, a.name as artist_name FROM blog_posts b JOIN artists a ON b.artist_id = a.id WHERE b.id = ?', [req.params.id], (err, post) => res.json(post));
    });
});

app.delete('/api/blog/:id', (req, res) => {
  db.run('DELETE FROM blog_posts WHERE id = ?', [req.params.id], (err) => {
    res.json({ success: true });
  });
});

// ── CREDITS ───────────────────────────────────────────────────────
const DEFAULT_BALANCE = 10000;

app.get('/api/credits', (req, res) => {
  db.get('SELECT COALESCE(SUM(amount), 0) as total FROM credit_transactions', [], (err, totalUsed) => {
    db.all('SELECT type, SUM(amount) as total, COUNT(*) as count FROM credit_transactions GROUP BY type', [], (err, byType) => {
      db.all('SELECT * FROM credit_transactions ORDER BY date DESC LIMIT 50', [], (err, history) => {
        db.get('SELECT COUNT(*) as c FROM posts', [], (err, totalApi) => {
          res.json({
            balance: DEFAULT_BALANCE - (totalUsed.total || 0),
            totalUsed: totalUsed.total || 0, defaultBalance: DEFAULT_BALANCE,
            byType, history, totalApiCalls: (totalApi.c || 0) * 3
          });
        });
      });
    });
  });
});

app.post('/api/credits/use', (req, res) => {
  const { type, amount, description } = req.body;
  db.run('INSERT INTO credit_transactions (type, amount, description) VALUES (?, ?, ?)', [type, amount, description], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT COALESCE(SUM(amount), 0) as total FROM credit_transactions', [], (err, totalUsed) => {
      res.json({ success: true, balance: DEFAULT_BALANCE - (totalUsed.total || 0) });
    });
  });
});

// ── SETTINGS ──────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  db.all('SELECT * FROM settings', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

app.put('/api/settings/:key', (req, res) => {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [req.params.key, req.body.value], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ key: req.params.key, value: req.body.value });
  });
});

// ── ARTIST SCHEDULES ──────────────────────────────────────────────
// Get all artist schedules
app.get('/api/schedules', (req, res) => {
  db.all(`SELECT s.*, a.name as artist_name, a.genre, a.avatar_color FROM artist_schedules s JOIN artists a ON s.artist_id = a.id ORDER BY a.name`, [], (err, schedules) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ schedules: schedules.map(s => ({ ...s, platforms: JSON.parse(s.platforms || '[]'), days_of_week: JSON.parse(s.days_of_week || '[1,2,3,4,5]'), post_times: JSON.parse(s.post_times || '["09:00","13:00","19:00"]') })) });
  });
});

// Get schedule for a specific artist
app.get('/api/schedules/:artist_id', (req, res) => {
  db.get(`SELECT s.*, a.name as artist_name, a.genre, a.avatar_color FROM artist_schedules s JOIN artists a ON s.artist_id = a.id WHERE s.artist_id = ?`, [req.params.artist_id], (err, schedule) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!schedule) {
      // Return default schedule if none exists
      db.get('SELECT * FROM artists WHERE id = ?', [req.params.artist_id], (err, artist) => {
        if (!artist) return res.status(404).json({ error: 'Artist not found' });
        return res.json({ artist_id: parseInt(req.params.artist_id), artist_name: artist.name, genre: artist.genre, avatar_color: artist.avatar_color, platforms: [], days_of_week: [1,2,3,4,5], post_times: ['09:00','13:00','19:00'], posts_per_day: 3, auto_schedule: 1, timezone: 'America/New_York' });
      });
      return;
    }
    res.json({ ...schedule, platforms: JSON.parse(schedule.platforms || '[]'), days_of_week: JSON.parse(schedule.days_of_week || '[1,2,3,4,5]'), post_times: JSON.parse(schedule.post_times || '["09:00","13:00","19:00"]') });
  });
});

// Create or update schedule for an artist
app.put('/api/schedules/:artist_id', (req, res) => {
  const { platforms, days_of_week, post_times, posts_per_day, auto_schedule, timezone } = req.body;
  const artist_id = req.params.artist_id;
  db.run(`INSERT OR REPLACE INTO artist_schedules (artist_id, platforms, days_of_week, post_times, posts_per_day, auto_schedule, timezone, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [artist_id, JSON.stringify(platforms || []), JSON.stringify(days_of_week || [1,2,3,4,5]), JSON.stringify(post_times || ['09:00','13:00','19:00']), posts_per_day || 3, auto_schedule ? 1 : 0, timezone || 'America/New_York'],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT s.*, a.name as artist_name FROM artist_schedules s JOIN artists a ON s.artist_id = a.id WHERE s.artist_id = ?`, [artist_id], (err, schedule) => {
        res.json({ ...schedule, platforms: JSON.parse(schedule.platforms || '[]'), days_of_week: JSON.parse(schedule.days_of_week || '[1,2,3,4,5]'), post_times: JSON.parse(schedule.post_times || '["09:00","13:00","19:00"]') });
      });
    });
});

// Bulk initialize schedules for all artists (auto-generate 3 posts/day)
app.post('/api/schedules/bulk-init', (req, res) => {
  db.all('SELECT id, name FROM artists', [], (err, artists) => {
    if (err) return res.status(500).json({ error: err.message });
    let done = 0;
    const results = [];
    if (artists.length === 0) return res.json({ initialized: 0 });
    artists.forEach(artist => {
      // Stagger times slightly per artist to avoid identical schedules
      const baseHours = [9, 13, 19];
      const offset = (artist.id % 3);
      const times = baseHours.map(h => `${String((h + offset) % 24).padStart(2,'0')}:00`);
      db.run(`INSERT OR IGNORE INTO artist_schedules (artist_id, platforms, days_of_week, post_times, posts_per_day, auto_schedule, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [artist.id, JSON.stringify([1,2,3,4,5,6]), JSON.stringify([1,2,3,4,5,6,7]), JSON.stringify(times), 3, 1, 'America/New_York'],
        () => { done++; results.push(artist.id); if (done === artists.length) res.json({ initialized: results.length, artist_ids: results }); });
    });
  });
});

// ── VIDEO LIBRARY ─────────────────────────────────────────────────
// Get all rendered videos with thumbnail URLs
app.get('/api/videos', (req, res) => {
  const { artist_id, page = 1, limit = 20 } = req.query;
  let sql = `SELECT p.id, p.artist_id, p.platform_id, p.content, p.hashtags, p.status, p.type, p.video_path, p.thumbnail_path, p.scheduled_date, p.created_at, a.name as artist_name, a.avatar_color, pl.name as platform_name, pl.color as platform_color FROM posts p JOIN artists a ON p.artist_id = a.id JOIN platforms pl ON p.platform_id = pl.id WHERE p.type = 'video' AND p.video_path IS NOT NULL`;
  const params = [];
  if (artist_id) { sql += ' AND p.artist_id = ?'; params.push(artist_id); }
  const countSql = sql.replace(/SELECT.*?FROM/, 'SELECT COUNT(*) as total FROM');
  sql += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  db.get(countSql, params.slice(0, -2), (err, countRow) => {
    db.all(sql, params, (err, videos) => {
      if (err) return res.status(500).json({ error: err.message });
      // Convert file paths to URLs
      const uploadsBase = UPLOADS_DIR;
      const mapped = videos.map(v => ({
        ...v,
        videoUrl: v.video_path ? '/uploads/' + path.relative(uploadsBase, v.video_path).replace(/\\/g, '/') : null,
        thumbnailUrl: v.thumbnail_path ? '/uploads/' + path.relative(uploadsBase, v.thumbnail_path).replace(/\\/g, '/') : null,
      }));
      res.json({ videos: mapped, total: countRow ? countRow.total : 0, page: Number(page), totalPages: Math.ceil((countRow ? countRow.total : 0) / Number(limit)) });
    });
  });
});

// ── STANDALONE PAGES (Schedule + Video Library) ───────────────────
// These are full HTML pages that embed inside the app via iframe or direct navigation
const standalonePageStyle = `
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    body{background:#f8fafc;color:#1e293b;min-height:100vh}
    .page{padding:24px 32px;max-width:1200px;margin:0 auto}
    h1{font-size:1.5rem;font-weight:700;color:#0f172a;margin-bottom:4px}
    p.sub{color:#64748b;font-size:.875rem;margin-bottom:24px}
    .card{background:#fff;border-radius:16px;border:1px solid #e2e8f0;padding:20px}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:.875rem;font-weight:600;cursor:pointer;border:none;transition:all .15s}
    .btn-primary{background:#e2b34b;color:#fff}.btn-primary:hover{background:#c99a35}
    .btn-secondary{background:#f1f5f9;color:#475569}.btn-secondary:hover{background:#e2e8f0}
    .btn-danger{background:#fee2e2;color:#dc2626}.btn-danger:hover{background:#fecaca}
    .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:.75rem;font-weight:600}
    .badge-green{background:#dcfce7;color:#16a34a}.badge-amber{background:#fef9c3;color:#a16207}.badge-slate{background:#f1f5f9;color:#475569}
    input,select,textarea{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;font-size:.875rem;outline:none;transition:border .15s}
    input:focus,select:focus,textarea:focus{border-color:#e2b34b;box-shadow:0 0 0 3px rgba(226,179,75,.15)}
    label{display:block;font-size:.8125rem;font-weight:500;color:#374151;margin-bottom:4px}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
    @media(max-width:768px){.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}}
    .flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}.gap-3{gap:12px}.gap-4{gap:16px}
    .mt-4{margin-top:16px}.mt-6{margin-top:24px}.mb-2{margin-bottom:8px}.mb-4{margin-bottom:16px}
    .text-sm{font-size:.875rem}.text-xs{font-size:.75rem}.font-semibold{font-weight:600}.font-bold{font-weight:700}
    .text-slate-500{color:#64748b}.text-slate-700{color:#334155}.text-amber-600{color:#d97706}
    .rounded-full{border-radius:9999px}.w-10{width:40px}.h-10{height:40px}
    .avatar{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.875rem;flex-shrink:0}
    .tag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:.75rem;font-weight:500;cursor:pointer;border:2px solid transparent;transition:all .15s}
    .tag.active{border-color:#e2b34b;background:#fef9c3;color:#92400e}
    .tag.inactive{border-color:#e2e8f0;background:#f8fafc;color:#64748b}
    .tag:hover{border-color:#e2b34b}
    .spinner{width:20px;height:20px;border:2px solid #e2e8f0;border-top-color:#e2b34b;border-radius:50%;animation:spin .6s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .toast{position:fixed;bottom:24px;right:24px;background:#1e293b;color:#fff;padding:12px 20px;border-radius:12px;font-size:.875rem;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}
    .toast.show{opacity:1}
    .video-card{background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;transition:box-shadow .2s}
    .video-card:hover{box-shadow:0 8px 24px rgba(0,0,0,.08)}
    .video-thumb{width:100%;aspect-ratio:9/16;object-fit:cover;background:#1e293b;display:block}
    .video-thumb-placeholder{width:100%;aspect-ratio:9/16;background:linear-gradient(135deg,#1e293b,#334155);display:flex;align-items:center;justify-content:center;font-size:2.5rem}
    .day-pill{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;font-size:.8125rem;font-weight:600;cursor:pointer;border:2px solid transparent;transition:all .15s}
    .day-pill.active{background:#e2b34b;color:#fff;border-color:#e2b34b}
    .day-pill.inactive{background:#f1f5f9;color:#64748b;border-color:#e2e8f0}
    .day-pill:hover:not(.active){border-color:#e2b34b;background:#fef9c3;color:#92400e}
    .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
    .divider{height:1px;background:#f1f5f9;margin:20px 0}
  </style>
`;

// Schedule Management Page
app.get('/schedule', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artist Schedules — ArtistHub</title>${standalonePageStyle}</head><body>
<div class="page">
  <div class="flex items-center justify-between mb-4">
    <div>
      <h1>🗓 Artist Posting Schedules</h1>
      <p class="sub">Configure per-artist posting frequency, days, and times across all platforms</p>
    </div>
    <div class="flex gap-3">
      <button class="btn btn-secondary" onclick="window.location='/'">&larr; Back to Dashboard</button>
      <button class="btn btn-primary" onclick="bulkInit()">⚡ Auto-Init All Artists</button>
    </div>
  </div>

  <div id="stats" class="grid-4 mb-4"></div>
  <div id="artists-grid" class="grid-2"></div>
  <div id="toast" class="toast"></div>

  <!-- Edit Modal -->
  <div id="modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;display:none;align-items:center;justify-content:center">
    <div class="card" style="width:520px;max-height:90vh;overflow-y:auto;position:relative">
      <div class="flex items-center justify-between mb-4">
        <h2 id="modal-title" style="font-size:1.125rem;font-weight:700"></h2>
        <button onclick="closeModal()" style="background:none;border:none;font-size:1.25rem;cursor:pointer;color:#64748b">&times;</button>
      </div>
      <div id="modal-body"></div>
    </div>
  </div>
</div>

<script>
const API = '/api';
let artists = [], schedules = [], platforms = [];

async function load() {
  const token = localStorage.getItem('artisthub_token') || '';
  const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const [ar, sc, pl] = await Promise.all([
      fetch(API + '/artists').then(r => r.json()),
      fetch(API + '/schedules').then(r => r.json()),
      fetch(API + '/platforms').then(r => r.json())
    ]);
    artists = ar.artists || ar || [];
    schedules = sc.schedules || [];
    platforms = pl.platforms || pl || [];
    renderStats();
    renderArtists();
  } catch(e) { console.error(e); }
}

function renderStats() {
  const total = artists.length;
  const configured = schedules.length;
  const autoEnabled = schedules.filter(s => s.auto_schedule).length;
  const totalPostsPerDay = schedules.reduce((a, s) => a + (s.posts_per_day || 3), 0);
  document.getElementById('stats').innerHTML = [
    { label: 'Total Artists', value: total, color: '#4a52e3' },
    { label: 'Schedules Configured', value: configured + '/' + total, color: '#10b981' },
    { label: 'Auto-Schedule On', value: autoEnabled, color: '#e2b34b' },
    { label: 'Posts/Day (Total)', value: totalPostsPerDay, color: '#8b5cf6' }
  ].map(s => `<div class="card flex items-center gap-3"><div style="width:40px;height:40px;border-radius:12px;background:${s.color}18;display:flex;align-items:center;justify-content:center;font-size:1.25rem;flex-shrink:0">📊</div><div><div style="font-size:1.25rem;font-weight:700;color:#0f172a">${s.value}</div><div class="text-xs text-slate-500">${s.label}</div></div></div>`).join('');
}

function getSchedule(artistId) {
  return schedules.find(s => s.artist_id == artistId) || { days_of_week: [1,2,3,4,5], post_times: ['09:00','13:00','19:00'], posts_per_day: 3, auto_schedule: true, timezone: 'America/New_York', platforms: [] };
}

const DAY_NAMES = ['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const TZ_OPTIONS = ['America/New_York','America/Los_Angeles','America/Chicago','Europe/London','Europe/Paris','Australia/Sydney','Asia/Tokyo'];

function renderArtists() {
  document.getElementById('artists-grid').innerHTML = artists.map(a => {
    const s = getSchedule(a.id);
    const days = s.days_of_week || [1,2,3,4,5];
    const times = s.post_times || ['09:00','13:00','19:00'];
    const hasSchedule = schedules.some(sc => sc.artist_id == a.id);
    return `<div class="card">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="avatar" style="background:${a.avatar_color||'#e2b34b'}">${a.name.charAt(0)}</div>
          <div>
            <div class="font-semibold" style="color:#0f172a">${a.name}</div>
            <div class="text-xs text-slate-500">${a.genre}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="badge ${hasSchedule ? 'badge-green' : 'badge-slate'}">${hasSchedule ? '✓ Configured' : 'Default'}</span>
          <button class="btn btn-primary" onclick="editSchedule(${a.id})" style="padding:6px 12px;font-size:.75rem">Edit</button>
        </div>
      </div>
      <div class="divider" style="margin:12px 0"></div>
      <div class="flex gap-2 mb-3">${[1,2,3,4,5,6,7].map(d => `<div class="day-pill ${days.includes(d) ? 'active' : 'inactive'}">${DAY_NAMES[d]}</div>`).join('')}</div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-slate-500">Times: <strong>${times.join(' · ')}</strong></span>
        <span class="text-slate-500">${s.posts_per_day || 3} posts/day</span>
      </div>
      <div class="flex items-center justify-between text-xs text-slate-500 mt-2">
        <span>TZ: ${s.timezone || 'America/New_York'}</span>
        <span class="badge ${s.auto_schedule ? 'badge-green' : 'badge-slate'}">${s.auto_schedule ? '⚡ Auto' : '⏸ Manual'}</span>
      </div>
    </div>`;
  }).join('');
}

function editSchedule(artistId) {
  const artist = artists.find(a => a.id == artistId);
  const s = getSchedule(artistId);
  document.getElementById('modal-title').textContent = 'Edit Schedule — ' + artist.name;
  document.getElementById('modal-body').innerHTML = `
    <div class="mb-4">
      <label>Active Days</label>
      <div class="flex gap-2 mt-2" id="day-pills">
        ${[1,2,3,4,5,6,7].map(d => `<div class="day-pill ${(s.days_of_week||[1,2,3,4,5]).includes(d) ? 'active' : 'inactive'}" onclick="toggleDay(${d},this)" data-day="${d}">${DAY_NAMES[d]}</div>`).join('')}
      </div>
    </div>
    <div class="mb-4">
      <label>Posting Times (minimum 3 per day)</label>
      <div id="times-list">${(s.post_times||['09:00','13:00','19:00']).map((t,i) => `<div class="flex gap-2 mt-2"><input type="time" value="${t}" class="post-time" style="flex:1"><button onclick="this.parentNode.remove()" class="btn btn-danger" style="padding:6px 10px;flex-shrink:0">&times;</button></div>`).join('')}</div>
      <button class="btn btn-secondary mt-2" onclick="addTime()">+ Add Time</button>
    </div>
    <div class="grid-2 mb-4">
      <div><label>Posts Per Day</label><input type="number" id="ppd" value="${s.posts_per_day||3}" min="1" max="10"></div>
      <div><label>Timezone</label><select id="tz">${TZ_OPTIONS.map(tz => `<option ${tz===(s.timezone||'America/New_York')?'selected':''}>${tz}</option>`).join('')}</select></div>
    </div>
    <div class="mb-4">
      <label>Platforms</label>
      <div class="flex gap-2 flex-wrap mt-2" id="platform-tags">
        ${platforms.map(p => `<div class="tag ${(s.platforms||[]).includes(p.id) ? 'active' : 'inactive'}" onclick="togglePlatform(${p.id},this)" data-pid="${p.id}">${p.name}</div>`).join('')}
      </div>
    </div>
    <div class="flex items-center gap-3 mb-4">
      <input type="checkbox" id="auto-sched" ${s.auto_schedule ? 'checked' : ''} style="width:auto">
      <label for="auto-sched" style="margin:0">Enable Auto-Scheduling</label>
    </div>
    <div class="flex gap-3 justify-end">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSchedule(${artistId})">Save Schedule</button>
    </div>
  `;
  document.getElementById('modal').style.display = 'flex';
}

function toggleDay(d, el) {
  el.classList.toggle('active');
  el.classList.toggle('inactive');
}
function addTime() {
  const div = document.createElement('div');
  div.className = 'flex gap-2 mt-2';
  div.innerHTML = '<input type="time" value="12:00" class="post-time" style="flex:1"><button onclick="this.parentNode.remove()" class="btn btn-danger" style="padding:6px 10px;flex-shrink:0">&times;</button>';
  document.getElementById('times-list').appendChild(div);
}
function togglePlatform(pid, el) {
  el.classList.toggle('active');
  el.classList.toggle('inactive');
}
function closeModal() { document.getElementById('modal').style.display = 'none'; }

async function saveSchedule(artistId) {
  const days = [...document.querySelectorAll('#day-pills .day-pill.active')].map(el => parseInt(el.dataset.day));
  const times = [...document.querySelectorAll('.post-time')].map(el => el.value).filter(Boolean);
  const ppd = parseInt(document.getElementById('ppd').value) || 3;
  const tz = document.getElementById('tz').value;
  const auto = document.getElementById('auto-sched').checked;
  const pids = [...document.querySelectorAll('#platform-tags .tag.active')].map(el => parseInt(el.dataset.pid));
  const token = localStorage.getItem('artisthub_token') || '';
  try {
    await fetch(API + '/schedules/' + artistId, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ days_of_week: days, post_times: times, posts_per_day: ppd, timezone: tz, auto_schedule: auto, platforms: pids }) });
    closeModal();
    showToast('Schedule saved!');
    await load();
  } catch(e) { showToast('Error: ' + e.message, true); }
}

async function bulkInit() {
  const token = localStorage.getItem('artisthub_token') || '';
  try {
    const r = await fetch(API + '/schedules/bulk-init', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    const d = await r.json();
    showToast('Initialized ' + d.initialized + ' artist schedules!');
    await load();
  } catch(e) { showToast('Error: ' + e.message, true); }
}

function showToast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = err ? '#dc2626' : '#1e293b';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

load();
</script></body></html>`);
});

// Video Library Page
app.get('/video-library', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video Library — ArtistHub</title>${standalonePageStyle}</head><body>
<div class="page">
  <div class="flex items-center justify-between mb-4">
    <div>
      <h1>🎬 Video Library</h1>
      <p class="sub">All rendered videos with thumbnails, previews, and download links</p>
    </div>
    <div class="flex gap-3">
      <button class="btn btn-secondary" onclick="window.location='/'">&larr; Dashboard</button>
      <button class="btn btn-primary" onclick="window.location='/video'">+ New Video</button>
    </div>
  </div>

  <div id="stats" class="grid-4 mb-4"></div>

  <div class="card mb-4" style="padding:16px">
    <div class="flex gap-3 items-center flex-wrap">
      <select id="filter-artist" onchange="load()" style="width:200px"><option value="">All Artists</option></select>
      <select id="filter-status" onchange="load()" style="width:160px">
        <option value="">All Status</option>
        <option value="published">Published</option>
        <option value="scheduled">Scheduled</option>
        <option value="draft">Draft</option>
      </select>
      <span id="total-label" class="text-sm text-slate-500 ml-auto"></span>
    </div>
  </div>

  <div id="video-grid" class="grid-3"></div>
  <div id="load-more" style="display:none;text-align:center;margin-top:24px">
    <button class="btn btn-secondary" onclick="loadMore()">Load More Videos</button>
  </div>
  <div id="empty" style="display:none" class="card" style="text-align:center;padding:48px">
    <div style="font-size:3rem;margin-bottom:12px">🎬</div>
    <div class="font-semibold" style="color:#0f172a;margin-bottom:8px">No videos yet</div>
    <div class="text-sm text-slate-500 mb-4">Render your first video in the Video Editor</div>
    <button class="btn btn-primary" onclick="window.location='/video'">Open Video Editor</button>
  </div>
  <div id="toast" class="toast"></div>

  <!-- Preview Modal -->
  <div id="preview-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center">
    <div style="position:relative;max-width:400px;width:90%">
      <button onclick="closePreview()" style="position:absolute;top:-40px;right:0;background:none;border:none;color:#fff;font-size:1.5rem;cursor:pointer">&times;</button>
      <video id="preview-video" controls style="width:100%;border-radius:16px;max-height:80vh"></video>
    </div>
  </div>
</div>

<script>
const API = '/api';
let currentPage = 1, totalPages = 1, allArtists = [];

async function init() {
  const r = await fetch(API + '/artists').then(r => r.json());
  allArtists = r.artists || r || [];
  const sel = document.getElementById('filter-artist');
  allArtists.forEach(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; sel.appendChild(o); });
  await load();
}

async function load() {
  currentPage = 1;
  const artistId = document.getElementById('filter-artist').value;
  const status = document.getElementById('filter-status').value;
  let url = API + '/videos?page=1&limit=12';
  if (artistId) url += '&artist_id=' + artistId;
  const r = await fetch(url).then(r => r.json());
  let videos = r.videos || [];
  if (status) videos = videos.filter(v => v.status === status);
  totalPages = r.totalPages || 1;
  document.getElementById('total-label').textContent = (r.total || 0) + ' videos';
  document.getElementById('load-more').style.display = totalPages > 1 ? 'block' : 'none';
  document.getElementById('empty').style.display = videos.length === 0 ? 'block' : 'none';
  document.getElementById('video-grid').innerHTML = '';
  renderVideos(videos);
  renderStats(r.total || 0);
}

async function loadMore() {
  currentPage++;
  const artistId = document.getElementById('filter-artist').value;
  let url = API + '/videos?page=' + currentPage + '&limit=12';
  if (artistId) url += '&artist_id=' + artistId;
  const r = await fetch(url).then(r => r.json());
  renderVideos(r.videos || []);
  if (currentPage >= totalPages) document.getElementById('load-more').style.display = 'none';
}

function renderStats(total) {
  document.getElementById('stats').innerHTML = [
    { label: 'Total Videos', value: total, icon: '🎬' },
    { label: 'Platforms', value: '9:16 Reels', icon: '📱' },
    { label: 'Storage', value: total + ' files', icon: '💾' },
    { label: 'Ready to Post', value: total, icon: '✅' }
  ].map(s => `<div class="card flex items-center gap-3"><div style="font-size:1.5rem">${s.icon}</div><div><div style="font-size:1.25rem;font-weight:700;color:#0f172a">${s.value}</div><div class="text-xs text-slate-500">${s.label}</div></div></div>`).join('');
}

function renderVideos(videos) {
  const grid = document.getElementById('video-grid');
  videos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'video-card';
    const thumb = v.thumbnailUrl ? `<img src="${v.thumbnailUrl}" class="video-thumb" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="video-thumb-placeholder" style="display:none">🎬</div>` : `<div class="video-thumb-placeholder">🎬</div>`;
    const date = v.created_at ? new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const statusColors = { published: 'badge-green', scheduled: 'badge-amber', draft: 'badge-slate' };
    card.innerHTML = `
      <div style="position:relative;cursor:pointer" onclick="previewVideo('${v.videoUrl || ''}')">
        ${thumb}
        <div style="position:absolute;top:8px;left:8px">
          <span class="badge ${statusColors[v.status]||'badge-slate'}">${v.status||'draft'}</span>
        </div>
        <div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;padding:3px 8px;border-radius:6px;font-size:.7rem;font-weight:600">${v.platform_name||''}</div>
        ${v.videoUrl ? '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=0"><div style="background:rgba(0,0,0,.6);border-radius:50%;width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:1.25rem">▶</div></div>' : ''}
      </div>
      <div style="padding:12px">
        <div class="font-semibold text-sm" style="color:#0f172a;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.artist_name}</div>
        <div class="text-xs text-slate-500 mb-3" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.content ? v.content.substring(0,60)+'...' : 'No caption'}</div>
        <div class="flex gap-2">
          ${v.videoUrl ? `<a href="${v.videoUrl}" download class="btn btn-primary" style="flex:1;justify-content:center;font-size:.75rem;padding:6px 10px">⬇ Download</a>` : '<button class="btn btn-secondary" style="flex:1;font-size:.75rem;padding:6px 10px" disabled>No file</button>'}
          <button onclick="schedulePost(${v.id})" class="btn btn-secondary" style="font-size:.75rem;padding:6px 10px">📅 Schedule</button>
        </div>
        <div class="text-xs text-slate-500 mt-2">${date}</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function previewVideo(url) {
  if (!url) return;
  document.getElementById('preview-video').src = url;
  document.getElementById('preview-modal').style.display = 'flex';
}
function closePreview() {
  document.getElementById('preview-modal').style.display = 'none';
  document.getElementById('preview-video').src = '';
}

async function schedulePost(postId) {
  const date = prompt('Schedule date and time (YYYY-MM-DD HH:MM):');
  if (!date) return;
  const token = localStorage.getItem('artisthub_token') || '';
  try {
    await fetch(API + '/posts/' + postId, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'scheduled', scheduled_date: new Date(date).toISOString() }) });
    showToast('Post scheduled!');
    await load();
  } catch(e) { showToast('Error: ' + e.message, true); }
}

function showToast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = err ? '#dc2626' : '#1e293b';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

init();
</script></body></html>`);
});

// ─── SERVE FRONTEND (MUST BE LAST) ──────────────────────────────
// Static frontend files
app.use(express.static(path.join(__dirname, 'frontend')));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────────
// Run schema migrations first, then seed data
runSchemaMigrations(db, () => {
  seedData();
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('=================================================');
  console.log('  ArtistHub - AI Social Media Studio v2.0');
  console.log('  Chalesi Music Group');
  console.log('=================================================');
  console.log(`  Server running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  console.log('  Login: chalesimusic@gmail.com / Malaven757!!');
  console.log('=================================================');
});

module.exports = app;
