require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','PATCH','DELETE'] } });
const PORT = process.env.PORT || 3000;

/*
  Railway Volume 儲存保護

  你的 Volume Mount Path 是：
  /app/data

  這段會讓 chat.sqlite 存在：
  /app/data/chat.sqlite

  之後重新部署，只要 Volume 沒刪除，資料就會保留。
*/
const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const OLD_DB_PATH = path.join(__dirname, 'chat.sqlite');
const DB_PATH = path.join(DATA_DIR, 'chat.sqlite');

if (!fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) {
  fs.copyFileSync(OLD_DB_PATH, DB_PATH);
  console.log('Migrated old SQLite database to:', DB_PATH);
}

console.log('SQLite database path:', DB_PATH);

const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  visitor_name TEXT DEFAULT '',
  visitor_contact TEXT DEFAULT '',
  visitor_account TEXT DEFAULT '',
  visitor_online INTEGER DEFAULT 0,
  visitor_last_seen TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  folder TEXT DEFAULT 'inbox',
  unread_count INTEGER DEFAULT 0,
  archived_at TEXT DEFAULT '',
  deleted_at TEXT DEFAULT '',
  assigned_to TEXT DEFAULT '',
  note TEXT DEFAULT '',
  last_agent TEXT DEFAULT '',
  last_agent_display TEXT DEFAULT '',
  source_site TEXT DEFAULT '',
  source_title TEXT DEFAULT '',
  source_campaign TEXT DEFAULT '',
  source_group TEXT DEFAULT '',
  source_label TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  source_referrer TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  visitor_code TEXT DEFAULT '',
  device_type TEXT DEFAULT '',
  device_model TEXT DEFAULT '',
  device_os TEXT DEFAULT '',
  browser TEXT DEFAULT '',
  screen_size TEXT DEFAULT '',
  language TEXT DEFAULT '',
  timezone TEXT DEFAULT '',
  network_type TEXT DEFAULT '',
  network_effective_type TEXT DEFAULT '',
  network_downlink TEXT DEFAULT '',
  network_rtt TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT DEFAULT '',
  sender_login TEXT DEFAULT '',
  body TEXT NOT NULL,
  attachment_url TEXT DEFAULT '',
  attachment_name TEXT DEFAULT '',
  attachment_type TEXT DEFAULT '',
  attachment_mime TEXT DEFAULT '',
  attachment_size INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

[
  ['visitor_account', "TEXT DEFAULT ''"],
  ['visitor_online', 'INTEGER DEFAULT 0'],
  ['visitor_last_seen', "TEXT DEFAULT ''"],
  ['status', "TEXT DEFAULT 'open'"],
  ['folder', "TEXT DEFAULT 'inbox'"],
  ['unread_count', 'INTEGER DEFAULT 0'],
  ['archived_at', "TEXT DEFAULT ''"],
  ['deleted_at', "TEXT DEFAULT ''"],
  ['assigned_to', "TEXT DEFAULT ''"],
  ['note', "TEXT DEFAULT ''"],
  ['last_agent', "TEXT DEFAULT ''"],
  ['last_agent_display', "TEXT DEFAULT ''"],
  ['source_site', "TEXT DEFAULT ''"],
  ['source_title', "TEXT DEFAULT ''"],
  ['source_campaign', "TEXT DEFAULT ''"],
  ['source_group', "TEXT DEFAULT ''"],
  ['source_label', "TEXT DEFAULT ''"],
  ['source_url', "TEXT DEFAULT ''"],
  ['source_referrer', "TEXT DEFAULT ''"],
  ['utm_source', "TEXT DEFAULT ''"],
  ['utm_medium', "TEXT DEFAULT ''"],
  ['utm_campaign', "TEXT DEFAULT ''"],
  ['visitor_code', "TEXT DEFAULT ''"],
  ['device_type', "TEXT DEFAULT ''"],
  ['device_model', "TEXT DEFAULT ''"],
  ['device_os', "TEXT DEFAULT ''"],
  ['browser', "TEXT DEFAULT ''"],
  ['screen_size', "TEXT DEFAULT ''"],
  ['language', "TEXT DEFAULT ''"],
  ['timezone', "TEXT DEFAULT ''"],
  ['network_type', "TEXT DEFAULT ''"],
  ['network_effective_type', "TEXT DEFAULT ''"],
  ['network_downlink', "TEXT DEFAULT ''"],
  ['network_rtt', "TEXT DEFAULT ''"],
  ['platform', "TEXT DEFAULT ''"],
  ['user_agent', "TEXT DEFAULT ''"],
  ['offline_auto_reply_key', "TEXT DEFAULT ''"]
].forEach(([col, def]) => ensureColumn('conversations', col, def));

ensureColumn('messages', 'sender_login', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_url', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_name', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_type', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_mime', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_size', 'INTEGER DEFAULT 0');

db.prepare("UPDATE conversations SET folder='inbox' WHERE folder IS NULL OR folder='' OR folder NOT IN ('inbox','archive','trash')").run();
db.prepare("UPDATE conversations SET unread_count=0 WHERE unread_count IS NULL").run();

function setDefault(key, value) {
  const exists = db.prepare('SELECT key FROM settings WHERE key=?').get(key);
  if (!exists) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, value);
}

function forceSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key,value)
    VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value || ''));
}

setDefault('support_status', process.env.SUPPORT_STATUS || 'online');

setDefault('quick_replies', JSON.stringify([
  { title: '詢問會員帳號', content: '您好，请问您的会员账号是多少？' },
  { title: '詢問問題', content: '请问您目前遇到什么问题？' },
  { title: '稍等查詢', content: '请稍等，我帮您查询一下。' },
  { title: '確認優惠', content: '目前活动优惠已收到，我帮您确认适合的方案。' }
]));

setDefault('agent_display_names', 'admin=小编小雅\nadmin1=小编朵朵\nadmin2=小编小葵');

const COPY_VERSION = 'f1top-v10-1-sop-title-content';
const currentCopyVersion = db.prepare('SELECT value FROM settings WHERE key=?').get('copy_version');

if (!currentCopyVersion || currentCopyVersion.value !== COPY_VERSION) {
  forceSetting('widget_title', process.env.WIDGET_TITLE || '领取10USDT窗口');
  forceSetting('online_greeting', process.env.WIDGET_GREETING || '你好,领取10U体验金吗？');
  forceSetting(
    'offline_greeting',
    process.env.OFFLINE_GREETING ||
    '小编在线时间10-22点，目前非工作时间,请留下TG联系方式我们会与你联系协助你领取体验金。如没TG请留下你的通讯方式。'
  );
  forceSetting('agent_display_names', process.env.AGENT_DISPLAY_NAMES || 'admin=小编小雅\nadmin1=小编朵朵\nadmin2=小编小葵');
  forceSetting('copy_version', COPY_VERSION);
}

const rawUsers = process.env.ADMIN_USERS || 'admin:123456';

const adminUsers = rawUsers
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)
  .map(pair => {
    const [username, ...rest] = pair.split(':');
    const password = rest.join(':') || '123456';
    return { username, passwordHash: bcrypt.hashSync(password, 8) };
  });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false
}));

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: res => res.set('Cache-Control', 'public, max-age=31536000, immutable')
}));

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function nowIso() {
  return new Date().toISOString();
}

function clean(v, n = 500) {
  return String(v || '').slice(0, n);
}


function safeFileName(name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`;
}

function attachmentType(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, safeFileName(file.originalname))
  }),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_SIZE || 25 * 1024 * 1024)
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
      'video/mp4','video/webm','video/quicktime',
      'audio/mpeg','audio/wav','audio/webm','audio/ogg',
      'application/pdf','text/plain','text/csv','application/zip',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('不支援的檔案類型'));
  }
});

function normalizeAttachment(input) {
  const a = input && typeof input === 'object' ? input : {};
  return {
    attachment_url: clean(a.attachment_url || a.url || '', 1000),
    attachment_name: clean(a.attachment_name || a.name || '', 240),
    attachment_type: clean(a.attachment_type || a.type || '', 40),
    attachment_mime: clean(a.attachment_mime || a.mime || '', 120),
    attachment_size: Number(a.attachment_size || a.size || 0) || 0
  };
}

function setting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key,value)
    VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value || ''));
}

function normalizeAgentDisplayNames(value) {
  if (Array.isArray(value)) {
    return value.map(x => String(x || '').trim()).filter(Boolean).join('\n');
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${String(k).trim()}=${String(v || '').trim()}`)
      .filter(line => line.includes('='))
      .join('\n');
  }

  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function offlineReplyKey() {
  return crypto
    .createHash('sha1')
    .update(`${setting('support_status')}|${setting('offline_greeting')}`)
    .digest('hex');
}

function insertSystemMessage(conversationId, body) {
  const text = String(body || '').trim();

  if (!text) return null;

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    conversationId,
    'agent',
    '',
    'system',
    text,
    '', '', '', '', 0,
    nowIso()
  );

  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

function insertInitialGreeting(conversationId) {
  const status = setting('support_status') || 'online';
  const body = status === 'offline' ? setting('offline_greeting') : setting('online_greeting');

  const msg = insertSystemMessage(conversationId, body);

  if (status === 'offline') {
    db.prepare(`
      UPDATE conversations
      SET offline_auto_reply_key=?
      WHERE id=?
    `).run(offlineReplyKey(), conversationId);
  }

  return msg;
}

function maybeInsertOfflineAutoReply(conversationId) {
  if ((setting('support_status') || 'online') !== 'offline') return null;

  const convo = convoById(conversationId);

  if (!convo) return null;

  const key = offlineReplyKey();

  if (convo.offline_auto_reply_key === key) return null;

  const msg = insertSystemMessage(conversationId, setting('offline_greeting'));

  db.prepare(`
    UPDATE conversations
    SET offline_auto_reply_key=?, updated_at=?
    WHERE id=?
  `).run(key, nowIso(), conversationId);

  return msg;
}

function parseAgentDisplayNames() {
  const raw = setting('agent_display_names') || '';
  const map = {};

  raw.split(/\r?\n/).forEach(line => {
    const t = String(line || '').trim();

    if (!t || !t.includes('=')) return;

    const idx = t.indexOf('=');
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();

    if (key && val) map[key] = val;
  });

  return map;
}

function agentDisplayName(login) {
  const map = parseAgentDisplayNames();
  return map[login] || login;
}

function publicConfig() {
  let quickReplies = [];

  try {
    quickReplies = JSON.parse(setting('quick_replies') || '[]');
  } catch (_) {}

  return {
    title: setting('widget_title') || '领取10USDT窗口',
    support_status: setting('support_status') || 'online',
    online_greeting: setting('online_greeting') || '你好,领取10U体验金吗？',
    offline_greeting:
      setting('offline_greeting') ||
      '目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。',
    quick_replies: quickReplies,
    agent_display_names: setting('agent_display_names') || '',
    agent_display_names_text: setting('agent_display_names') || ''
  };
}

function convoById(id) {
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
}

function convoListRow(id) {
  return db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT sender_type FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_sender_type
    FROM conversations c
    WHERE c.id=?
  `).get(id);
}

function emitConversation(id) {
  const row = convoListRow(id);
  if (row) io.emit('conversation_updated', row);
}

app.get('/', (req, res) => res.redirect('/admin/login.html'));

app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

app.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(publicConfig());
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = adminUsers.find(u => u.username === username);

  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  req.session.user = { username };

  res.json({ ok: true, user: { username } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.session.user });
});

app.get('/api/settings', requireLogin, (req, res) => {
  res.json(publicConfig());
});

app.patch('/api/settings', requireLogin, (req, res) => {
  const allowed = [
    'support_status',
    'widget_title',
    'online_greeting',
    'offline_greeting',
    'quick_replies',
    'agent_display_names'
  ];

  allowed.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) {
      if (k === 'support_status') {
        const oldStatus = setting('support_status') || 'online';
        const nextStatus = req.body[k] === 'offline' ? 'offline' : 'online';

        setSetting(k, nextStatus);

        if (oldStatus !== nextStatus) {
          db.prepare("UPDATE conversations SET offline_auto_reply_key='' WHERE folder!='trash'").run();
        }
      } else if (k === 'quick_replies') {
        const list = Array.isArray(req.body[k])
          ? req.body[k].map(x => {
              if (typeof x === 'string') {
                const content = clean(x, 1000).trim();
                return content ? { title: content.slice(0, 18), content } : null;
              }

              if (x && typeof x === 'object') {
                const content = clean(x.content || x.body || x.text || '', 1500).trim();
                const title = clean(x.title || x.name || '', 80).trim() || content.slice(0, 18) || '圖片話術';
                const att = normalizeAttachment(x);
                if (!content && !att.attachment_url) return null;
                return { title, content, ...att };
              }

              return null;
            }).filter(Boolean)
          : [];

        setSetting(k, JSON.stringify(list));
      } else if (k === 'agent_display_names') {
        setSetting(k, clean(normalizeAgentDisplayNames(req.body[k]), 5000));
      } else if (k === 'offline_greeting') {
        const oldVal = setting('offline_greeting') || '';

        setSetting(k, clean(req.body[k], 2000));

        if (oldVal !== String(req.body[k] || '')) {
          db.prepare("UPDATE conversations SET offline_auto_reply_key='' WHERE folder!='trash'").run();
        }
      } else {
        setSetting(k, clean(req.body[k], 2000));
      }
    }
  });

  io.emit('settings_updated', publicConfig());

  res.json({ ok: true, settings: publicConfig() });
});



app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      return res.status(400).json({ error: err.message || 'upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no file' });
    }
    const data = {
      attachment_url: `/uploads/${req.file.filename}`,
      attachment_name: req.file.originalname || req.file.filename,
      attachment_type: attachmentType(req.file.mimetype),
      attachment_mime: req.file.mimetype || '',
      attachment_size: req.file.size || 0
    };
    res.json({ ok: true, ...data });
  });
});

app.get('/api/conversations', requireLogin, (req, res) => {
  const box = ['inbox','archive','trash','all'].includes(req.query.box)
    ? req.query.box
    : 'inbox';

  const sourceGroup = clean(req.query.source_group || '', 100);
  const readStatus = ['all','unread','read'].includes(req.query.read_status)
    ? req.query.read_status
    : 'all';

  const whereParts = [];
  const params = [];

  if (box !== 'all') {
    whereParts.push('c.folder=?');
    params.push(box);
  }

  if (sourceGroup) {
    if (sourceGroup === '__uncategorized__') {
      whereParts.push("(c.source_group IS NULL OR c.source_group='')");
    } else {
      whereParts.push('c.source_group=?');
      params.push(sourceGroup);
    }
  }

  if (readStatus === 'unread') {
    whereParts.push('c.unread_count > 0');
  } else if (readStatus === 'read') {
    whereParts.push('(c.unread_count IS NULL OR c.unread_count = 0)');
  }

  const where = whereParts.length ? whereParts.join(' AND ') : '1=1';

  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT sender_type FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_sender_type
    FROM conversations c
    WHERE ${where}
    ORDER BY
      CASE WHEN c.unread_count > 0 THEN 0 ELSE 1 END,
      c.updated_at DESC
  `).all(...params);

  res.json(rows);
});

app.get('/api/conversations/:id', requireLogin, (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({ error: 'not found' });
  }

  const messages = db.prepare(`
    SELECT *
    FROM messages
    WHERE conversation_id=?
    ORDER BY id ASC
  `).all(req.params.id);

  res.json({ conversation: convo, messages });
});

app.patch('/api/conversations/:id', requireLogin, (req, res) => {
  const { status, assigned_to, note, visitor_name, visitor_contact, visitor_account } = req.body;
  const old = convoById(req.params.id);

  if (!old) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare(`
    UPDATE conversations
    SET status=?, assigned_to=?, note=?, visitor_name=?, visitor_contact=?, visitor_account=?, updated_at=?
    WHERE id=?
  `).run(
    status ?? old.status,
    assigned_to ?? old.assigned_to,
    note ?? old.note,
    visitor_name ?? old.visitor_name,
    visitor_contact ?? old.visitor_contact,
    visitor_account ?? old.visitor_account,
    nowIso(),
    req.params.id
  );

  emitConversation(req.params.id);

  res.json({ ok: true, conversation: convoById(req.params.id) });
});

app.post('/api/conversations/:id/read', requireLogin, (req, res) => {
  if (!convoById(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare('UPDATE conversations SET unread_count=0 WHERE id=?').run(req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.post('/api/conversations/:id/unread', requireLogin, (req, res) => {
  if (!convoById(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare('UPDATE conversations SET unread_count=CASE WHEN unread_count > 0 THEN unread_count ELSE 1 END, updated_at=? WHERE id=?').run(nowIso(), req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.post('/api/conversations/:id/archive', requireLogin, (req, res) => {
  if (!convoById(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare(`
    UPDATE conversations
    SET folder='archive', archived_at=?, updated_at=?
    WHERE id=?
  `).run(nowIso(), nowIso(), req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.post('/api/conversations/:id/trash', requireLogin, (req, res) => {
  if (!convoById(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare(`
    UPDATE conversations
    SET folder='trash', deleted_at=?, updated_at=?
    WHERE id=?
  `).run(nowIso(), nowIso(), req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.post('/api/conversations/:id/restore', requireLogin, (req, res) => {
  if (!convoById(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }

  db.prepare(`
    UPDATE conversations
    SET folder='inbox', archived_at='', deleted_at='', updated_at=?
    WHERE id=?
  `).run(nowIso(), req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireLogin, (req, res) => {
  const tx = db.transaction(id => {
    db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    db.prepare('DELETE FROM conversations WHERE id=?').run(id);
  });

  tx(req.params.id);

  io.emit('conversation_deleted', { id: req.params.id });

  res.json({ ok: true });
});

app.post('/api/widget/conversations', (req, res) => {
  const id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  db.prepare(`
    INSERT INTO conversations (
      id, visitor_name, visitor_contact, visitor_account, visitor_online, visitor_last_seen,
      source_site, source_title, source_campaign, source_group, source_label, source_url, source_referrer, utm_source, utm_medium, utm_campaign,
      visitor_code, device_type, device_model, device_os, browser, screen_size, language, timezone, network_type,
      network_effective_type, network_downlink, network_rtt, platform, user_agent, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    clean(req.body.visitor_name, 120) || '訪客',
    clean(req.body.visitor_contact, 180),
    clean(req.body.visitor_account, 180),
    1,
    nowIso(),

    clean(req.body.source_site),
    clean(req.body.source_title),
    clean(req.body.source_campaign),
    clean(req.body.source_group || req.body.sourceGroup || req.body.source_campaign || '', 100),
    clean(req.body.source_label || req.body.sourceLabel || req.body.source_title || req.body.source_group || req.body.source_campaign || '', 120),
    clean(req.body.source_url, 1000),
    clean(req.body.source_referrer, 1000),
    clean(req.body.utm_source),
    clean(req.body.utm_medium),
    clean(req.body.utm_campaign),

    clean(req.body.visitor_code, 40),
    clean(req.body.device_type, 80),
    clean(req.body.device_model, 160),
    clean(req.body.device_os, 80),
    clean(req.body.browser, 80),
    clean(req.body.screen_size, 80),
    clean(req.body.language, 80),
    clean(req.body.timezone, 120),
    clean(req.body.network_type, 80),
    clean(req.body.network_effective_type, 80),
    clean(req.body.network_downlink, 80),
    clean(req.body.network_rtt, 80),
    clean(req.body.platform, 120),
    clean(req.body.user_agent, 1000),

    nowIso(),
    nowIso()
  );

  const greetingMsg = insertInitialGreeting(id);

  io.emit('new_conversation', convoListRow(id));

  if (greetingMsg) {
    io.to(id).emit('message', greetingMsg);
  }

  res.json({ id });
});

app.patch('/api/widget/conversations/:id/profile', (req, res) => {
  const old = convoById(req.params.id);

  if (!old) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  db.prepare(`
    UPDATE conversations
    SET visitor_name=?, visitor_contact=?, visitor_account=?, visitor_last_seen=?, updated_at=?
    WHERE id=?
  `).run(
    clean(req.body.visitor_name || old.visitor_name, 120),
    clean(req.body.visitor_contact || old.visitor_contact, 180),
    clean(req.body.visitor_account || old.visitor_account, 180),
    nowIso(),
    nowIso(),
    req.params.id
  );

  emitConversation(req.params.id);

  res.json({ ok: true });
});

app.get('/api/widget/conversations/:id/messages', (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({
      error: 'conversation not found'
    });
  }

  const messages = db.prepare(`
    SELECT id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, created_at
    FROM messages
    WHERE conversation_id=?
    ORDER BY id ASC
  `).all(req.params.id);

  res.json(messages);
});

app.post('/api/widget/conversations/:id/messages', (req, res) => {
  const body = String(req.body.body || '').trim();
  const attachment = normalizeAttachment(req.body.attachment || req.body);

  if (!body && !attachment.attachment_url) {
    return res.status(400).json({ error: 'empty message' });
  }

  const exists = convoById(req.params.id);

  if (!exists) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.params.id,
    'visitor',
    exists.visitor_name || '訪客',
    '',
    body,
    attachment.attachment_url,
    attachment.attachment_name,
    attachment.attachment_type,
    attachment.attachment_mime,
    attachment.attachment_size,
    nowIso()
  );

  db.prepare(`
    UPDATE conversations
    SET visitor_online=1,
        visitor_last_seen=?,
        unread_count=unread_count+1,
        folder=CASE WHEN folder='trash' THEN 'trash' ELSE 'inbox' END,
        updated_at=?
    WHERE id=?
  `).run(nowIso(), nowIso(), req.params.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);

  io.to(req.params.id).emit('message', msg);

  const autoReply = maybeInsertOfflineAutoReply(req.params.id);

  if (autoReply) {
    io.to(req.params.id).emit('message', autoReply);
  }

  emitConversation(req.params.id);

  res.json(msg);
});

app.post('/api/conversations/:id/messages', requireLogin, (req, res) => {
  const body = String(req.body.body || '').trim();
  const attachment = normalizeAttachment(req.body.attachment || req.body);

  if (!body && !attachment.attachment_url) {
    return res.status(400).json({ error: 'empty message' });
  }

  const exists = convoById(req.params.id);

  if (!exists) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const agent = req.session.user.username;
  const displayName = agentDisplayName(agent);

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.params.id,
    'agent',
    displayName,
    agent,
    body,
    attachment.attachment_url,
    attachment.attachment_name,
    attachment.attachment_type,
    attachment.attachment_mime,
    attachment.attachment_size,
    nowIso()
  );

  db.prepare(`
    UPDATE conversations
    SET last_agent=?, last_agent_display=?, unread_count=0, updated_at=?
    WHERE id=?
  `).run(agent, displayName, nowIso(), req.params.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);

  io.to(req.params.id).emit('message', msg);

  emitConversation(req.params.id);

  res.json(msg);
});

io.on('connection', socket => {
  socket.on('join', conversationId => {
    socket.join(conversationId);
  });

  socket.on('visitor_join', conversationId => {
    socket.data.conversationId = conversationId;
    socket.join(conversationId);

    const exists = convoById(conversationId);

    if (exists) {
      db.prepare(`
        UPDATE conversations
        SET visitor_online=1, visitor_last_seen=?
        WHERE id=?
      `).run(nowIso(), conversationId);

      emitConversation(conversationId);
    }
  });

  socket.on('disconnect', () => {
    const id = socket.data.conversationId;

    if (id && convoById(id)) {
      db.prepare(`
        UPDATE conversations
        SET visitor_online=0, visitor_last_seen=?
        WHERE id=?
      `).run(nowIso(), id);

      emitConversation(id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Customer chat system running on ${PORT}`);
});