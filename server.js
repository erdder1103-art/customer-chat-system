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
const webpush = require('web-push');
const archiver = require('archiver');

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
  internal_only INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_login TEXT DEFAULT '',
  target_type TEXT DEFAULT '',
  target_value TEXT DEFAULT '',
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  matched_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  ['offline_auto_reply_key', "TEXT DEFAULT ''"],
  ['push_status', "TEXT DEFAULT 'none'"],
  ['push_updated_at', "TEXT DEFAULT ''"]
].forEach(([col, def]) => ensureColumn('conversations', col, def));

ensureColumn('messages', 'sender_login', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_url', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_name', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_type', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_mime', "TEXT DEFAULT ''");
ensureColumn('messages', 'attachment_size', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'internal_only', 'INTEGER DEFAULT 0');

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
setDefault('greeting_rules', JSON.stringify([
  { group: '', title: '全部-在線招呼語', online: true, offline: false, content: '你好,领取10U体验金吗？' },
  { group: '', title: '全部-離線招呼語', online: false, offline: true, content: '小编在线时间10-22点，目前非工作时间,请留下TG联系方式我们会与你联系协助你领取体验金。如没TG请留下你的通讯方式。' }
]));
setDefault('max_image_mb', process.env.MAX_IMAGE_MB || '5');
setDefault('max_video_mb', process.env.MAX_VIDEO_MB || '30');
setDefault('max_file_mb', process.env.MAX_FILE_MB || '20');
setDefault('unreplied_minutes', process.env.UNREPLIED_MINUTES || '10');

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

function publicUploadUrl(req, filename) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  if (!host) return `/uploads/${filename}`;
  return `${proto}://${host}/uploads/${filename}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, safeFileName(file.originalname))
  }),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_SIZE || 500 * 1024 * 1024)
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

function settingNumber(key, fallback, min, max) {
  const n = Number(setting(key));
  const val = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, val));
}

function uploadLimitMbForType(type) {
  if (type === 'image') return settingNumber('max_image_mb', 5, 1, 100);
  if (type === 'video') return settingNumber('max_video_mb', 30, 1, 500);
  return settingNumber('max_file_mb', 20, 1, 200);
}

function uploadLimitBytesForType(type) {
  return uploadLimitMbForType(type) * 1024 * 1024;
}

function unrepliedMinutesValue(raw) {
  const n = Number(raw !== undefined && raw !== null && raw !== '' ? raw : setting('unreplied_minutes'));
  if (!Number.isFinite(n)) return 10;
  return Math.max(0, Math.min(1440, Math.floor(n)));
}

function addUnrepliedWhere(whereParts, params, minutes) {
  whereParts.push("(SELECT sender_type FROM messages WHERE conversation_id=c.id AND internal_only=0 ORDER BY id DESC LIMIT 1)='visitor'");
  const m = unrepliedMinutesValue(minutes);
  if (m > 0) {
    const cutoff = new Date(Date.now() - m * 60 * 1000).toISOString();
    whereParts.push("(SELECT created_at FROM messages WHERE conversation_id=c.id AND internal_only=0 ORDER BY id DESC LIMIT 1) <= ?");
    params.push(cutoff);
  }
}


function groupAliases(value) {
  const v = String(value || '').trim();
  if (!v) return [];
  if (v === '__adA__' || v === '廣告A' || v === '广告A' || v === '官方-广告' || v === '-官方-广告' || v === '官方-廣告' || v === '-官方-廣告') {
    return ['廣告A', '广告A', '官方-广告', '-官方-广告', '官方-廣告', '-官方-廣告', '__adA__'];
  }
  if (v === '__adB__' || v === '廣告B' || v === '广告B' || v === '华-广告' || v === '-华-广告' || v === '華-廣告' || v === '-華-廣告' || v === '华-廣告' || v === '-华-廣告') {
    return ['廣告B', '广告B', '华-广告', '-华-广告', '華-廣告', '-華-廣告', '华-廣告', '-华-廣告', '__adB__'];
  }
  return [v];
}

function normalizeGroupLabel(value) {
  const v = String(value || '').trim();
  if (['廣告A','广告A','官方-广告','-官方-广告','官方-廣告','-官方-廣告','__adA__'].includes(v)) return '官方-广告';
  if (['廣告B','广告B','华-广告','-华-广告','華-廣告','-華-廣告','华-廣告','-华-廣告','__adB__'].includes(v)) return '华-广告';
  return v || '未分類';
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

function getVapidKeys() {
  let publicKey = setting('vapid_public_key');
  let privateKey = setting('vapid_private_key');

  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    setSetting('vapid_public_key', publicKey);
    setSetting('vapid_private_key', privateKey);
    console.log('Generated VAPID keys and saved to SQLite settings');
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);

  return { publicKey, privateKey, subject };
}

const VAPID_KEYS = getVapidKeys();

function notificationUrlForConversation(convo) {
  const raw = String(convo && convo.source_url ? convo.source_url : '').trim();

  try {
    const u = raw ? new URL(raw) : null;
    if (u) {
      u.searchParams.set('ccs_open', '1');
      return u.toString();
    }
  } catch (_) {}

  return '/';
}

function updateConversationPushStatus(conversationId) {
  const active = db.prepare(`
    SELECT COUNT(*) AS n
    FROM push_subscriptions
    WHERE conversation_id=? AND status='active'
  `).get(conversationId);

  const any = db.prepare(`
    SELECT status
    FROM push_subscriptions
    WHERE conversation_id=?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(conversationId);

  const status = active && active.n > 0 ? 'enabled' : (any ? any.status : 'none');

  db.prepare(`
    UPDATE conversations
    SET push_status=?, push_updated_at=?
    WHERE id=?
  `).run(status, nowIso(), conversationId);

  emitConversation(conversationId);

  return status;
}

async function sendPushToConversation(conversationId, payload) {
  const convo = convoById(conversationId);
  if (!convo) return { sent: 0, failed: 0 };

  const rows = db.prepare(`
    SELECT *
    FROM push_subscriptions
    WHERE conversation_id=? AND status='active'
  `).all(conversationId);

  if (!rows.length) return { sent: 0, failed: 0 };

  const title = payload.title || publicConfig().title || '客服訊息通知';
  const body = payload.body || '你有新訊息通知';
  const url = payload.url || notificationUrlForConversation(convo);

  let sent = 0;
  let failed = 0;

  await Promise.all(rows.map(async row => {
    const subscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    };

    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title,
        body,
        url,
        conversation_id: conversationId,
        icon: '/icon-192.png',
        badge: '/icon-192.png'
      }));
      sent += 1;
      db.prepare(`
        UPDATE push_subscriptions
        SET status='active', error='', updated_at=?
        WHERE id=?
      `).run(nowIso(), row.id);
    } catch (e) {
      failed += 1;
      const expired = e && (e.statusCode === 404 || e.statusCode === 410);
      db.prepare(`
        UPDATE push_subscriptions
        SET status=?, error=?, updated_at=?
        WHERE id=?
      `).run(expired ? 'expired' : 'failed', String(e && e.message ? e.message : e).slice(0, 300), nowIso(), row.id);
    }
  }));

  updateConversationPushStatus(conversationId);

  return { sent, failed };
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


function normalizeGreetingRules(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else {
    try { list = JSON.parse(String(value || '[]')); } catch (_) { list = []; }
  }
  return list.map(x => {
    if (!x || typeof x !== 'object') return null;
    const group = clean(x.group || x.source_group || '', 100).trim();
    const content = clean(x.content || x.body || x.text || '', 2000).trim();
    const title = clean(x.title || '', 120).trim() || (group || '全部') + '-' + (x.offline ? '離線招呼語' : '在線招呼語');
    const online = !!x.online;
    const offline = !!x.offline;
    if (!content || (!online && !offline)) return null;
    return { group, title, online, offline, content };
  }).filter(Boolean);
}

function greetingsFor(status, sourceGroup) {
  const group = String(sourceGroup || '').trim();
  const rules = normalizeGreetingRules(setting('greeting_rules'));
  const isOffline = status === 'offline';
  const aliases = groupAliases(group).map(x => normalizeGroupLabel(x));

  const typeOk = r => isOffline ? r.offline : r.online;
  const ruleGroupLabel = r => normalizeGroupLabel(String(r.group || '').trim());

  // 先找與來源相符的招呼語。這裡同時支援：廣告B / 华-广告 / 華-廣告 / __adB__ 等別名。
  const sourceMatches = rules.filter(r => {
    const rg = String(r.group || '').trim();
    if (!rg || !typeOk(r)) return false;
    return aliases.includes(ruleGroupLabel(r)) || groupAliases(rg).map(x => normalizeGroupLabel(x)).includes(normalizeGroupLabel(group));
  });

  // 如果該來源沒有專屬招呼語，才使用「全部」招呼語。
  const fallbackMatches = rules.filter(r => !String(r.group || '').trim() && typeOk(r));
  const picked = sourceMatches.length ? sourceMatches : fallbackMatches;

  if (picked.length) {
    // 保留使用者排序，並去掉完全重複的內容。
    const seen = new Set();
    return picked.map(r => String(r.content || '').trim()).filter(Boolean).filter(x => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  }

  return [isOffline
    ? (setting('offline_greeting') || '目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。')
    : (setting('online_greeting') || '你好,领取10U体验金吗？')].filter(Boolean);
}

function greetingFor(status, sourceGroup) {
  return greetingsFor(status, sourceGroup)[0] || '';
}

function offlineReplyKeyFor(sourceGroup) {
  return crypto
    .createHash('sha1')
    .update(`${setting('support_status')}|${sourceGroup || ''}|${greetingsFor('offline', sourceGroup).join('\n---\n')}`)
    .digest('hex');
}

function offlineReplyKey() {
  return offlineReplyKeyFor('');
}

function insertSystemMessage(conversationId, body, options = {}) {
  const text = String(body || '').trim();
  const internalOnly = options && options.internalOnly ? 1 : 0;

  if (!text) return null;

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, internal_only, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    conversationId,
    'agent',
    '',
    'system',
    text,
    '', '', '', '', 0,
    internalOnly,
    nowIso()
  );

  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

function insertAgentTextMessage(conversationId, body, agentLogin) {
  const text = String(body || '').trim();
  if (!text) return null;
  const login = String(agentLogin || '').trim() || 'system';
  const displayName = login === 'system' ? '系统公告' : agentDisplayName(login);
  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, internal_only, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    conversationId,
    'agent',
    displayName,
    login,
    text,
    '', '', '', '', 0,
    0,
    nowIso()
  );
  db.prepare(`
    UPDATE conversations
    SET last_agent=?, last_agent_display=?, updated_at=?
    WHERE id=?
  `).run(login, displayName, nowIso(), conversationId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

function insertInitialGreeting(conversationId) {
  const status = setting('support_status') || 'online';
  const convo = convoById(conversationId);
  const group = convo ? (convo.source_group || '') : '';
  const bodies = greetingsFor(status, group);
  const messages = bodies.map(body => insertSystemMessage(conversationId, body)).filter(Boolean);

  if (status === 'offline') {
    db.prepare(`
      UPDATE conversations
      SET offline_auto_reply_key=?
      WHERE id=?
    `).run(offlineReplyKeyFor(group), conversationId);
  }

  return messages;
}

function maybeInsertOfflineAutoReply(conversationId) {
  if ((setting('support_status') || 'online') !== 'offline') return [];

  const convo = convoById(conversationId);

  if (!convo) return [];

  const group = convo.source_group || '';
  const key = offlineReplyKeyFor(group);

  if (convo.offline_auto_reply_key === key) return [];

  const messages = greetingsFor('offline', group).map(body => insertSystemMessage(conversationId, body)).filter(Boolean);

  db.prepare(`
    UPDATE conversations
    SET offline_auto_reply_key=?, updated_at=?
    WHERE id=?
  `).run(key, nowIso(), conversationId);

  return messages;
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
    greeting_rules: normalizeGreetingRules(setting('greeting_rules')),
    agent_display_names: setting('agent_display_names') || '',
    agent_display_names_text: setting('agent_display_names') || '',
    vapid_public_key: VAPID_KEYS.publicKey,
    max_image_mb: uploadLimitMbForType('image'),
    max_video_mb: uploadLimitMbForType('video'),
    max_file_mb: uploadLimitMbForType('file'),
    unreplied_minutes: unrepliedMinutesValue()
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

app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/notify.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'notify.html'));
});

app.get('/api/push/public-key', (req, res) => {
  res.json({ ok: true, publicKey: VAPID_KEYS.publicKey });
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
    'greeting_rules',
    'agent_display_names',
    'max_image_mb',
    'max_video_mb',
    'max_file_mb',
    'unreplied_minutes'
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
      } else if (k === 'greeting_rules') {
        const list = normalizeGreetingRules(req.body[k]);
        setSetting(k, JSON.stringify(list));
        db.prepare("UPDATE conversations SET offline_auto_reply_key='' WHERE folder!='trash'").run();
      } else if (['max_image_mb','max_video_mb','max_file_mb'].includes(k)) {
        const fallback = k === 'max_video_mb' ? 30 : (k === 'max_image_mb' ? 5 : 20);
        const max = k === 'max_video_mb' ? 500 : (k === 'max_image_mb' ? 100 : 200);
        setSetting(k, String(settingNumber(k, Number(req.body[k]) || fallback, 1, max)));
      } else if (k === 'unreplied_minutes') {
        setSetting(k, String(unrepliedMinutesValue(req.body[k])));
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



app.get('/api/backup/database', requireLogin, (req, res) => {
  const filename = `chat-backup-${new Date().toISOString().slice(0,10)}.sqlite`;
  res.download(DB_PATH, filename);
});

app.get('/api/backup/uploads.zip', requireLogin, (req, res) => {
  const filename = `uploads-backup-${new Date().toISOString().slice(0,10)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    console.error('Upload backup zip failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'backup failed' });
    else res.end();
  });
  archive.pipe(res);
  if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, false);
  archive.finalize();
});

app.get('/api/push/broadcasts', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM push_broadcasts
    ORDER BY id DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

app.post('/api/push/broadcast', requireLogin, async (req, res) => {
  const targetType = ['all','source_group','unreplied','conversation'].includes(req.body.target_type)
    ? req.body.target_type
    : 'all';
  const targetValue = clean(req.body.target_value || '', 120);
  const title = clean(req.body.title || publicConfig().title || '客服訊息通知', 120).trim();
  const body = clean(req.body.body || '', 500).trim();
  const ids = Array.isArray(req.body.conversation_ids) ? req.body.conversation_ids.map(x => clean(x, 120)).filter(Boolean) : [];

  if (!body) return res.status(400).json({ ok: false, error: '請輸入群發內容' });

  const whereParts = ["c.folder!='trash'"];
  const params = [];

  if (targetType === 'source_group') {
    const aliases = groupAliases(targetValue);
    whereParts.push(`c.source_group IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  } else if (targetType === 'unreplied') {
    addUnrepliedWhere(whereParts, params, req.body.unreplied_minutes);
  } else if (targetType === 'conversation') {
    if (!ids.length) return res.status(400).json({ ok: false, error: '沒有選擇客戶' });
    whereParts.push(`c.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  const rows = db.prepare(`
    SELECT c.*
    FROM conversations c
    WHERE ${whereParts.join(' AND ')}
    ORDER BY c.updated_at DESC
  `).all(...params);

  let sent = 0;
  let failed = 0;
  let pushEnabled = 0;

  const senderLogin = req.session.user && req.session.user.username ? req.session.user.username : 'system';

  for (const c of rows) {
    const result = await sendPushToConversation(c.id, {
      title,
      body,
      url: notificationUrlForConversation(c)
    });
    if (result.sent > 0) {
      pushEnabled += 1;
      const broadcastMsg = insertAgentTextMessage(c.id, body, senderLogin);
      if (broadcastMsg) io.to(c.id).emit('message', broadcastMsg);
      emitConversation(c.id);
    }
    sent += result.sent;
    failed += result.failed;
  }

  db.prepare(`
    INSERT INTO push_broadcasts (sender_login, target_type, target_value, title, body, matched_count, sent_count, failed_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.session.user.username, targetType, targetValue, title, body, rows.length, sent, failed, nowIso());

  res.json({ ok: true, matched: rows.length, push_enabled: pushEnabled, sent, failed });
});


app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      return res.status(400).json({ error: err.message || 'upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no file' });
    }
    const type = attachmentType(req.file.mimetype);
    const maxBytes = uploadLimitBytesForType(type);
    const maxMb = uploadLimitMbForType(type);
    if (req.file.size > maxBytes) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: `${type === 'image' ? '圖片' : type === 'video' ? '影片' : '檔案'}大小超過限制，最大 ${maxMb}MB` });
    }
    const data = {
      attachment_url: publicUploadUrl(req, req.file.filename),
      attachment_name: req.file.originalname || req.file.filename,
      attachment_type: type,
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
  const unrepliedOnly = String(req.query.unreplied || '') === '1';
  const unrepliedMinutes = unrepliedMinutesValue(req.query.unreplied_minutes);

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
      const aliases = groupAliases(sourceGroup);
      whereParts.push(`c.source_group IN (${aliases.map(() => '?').join(',')})`);
      params.push(...aliases);
    }
  }

  if (readStatus === 'unread') {
    whereParts.push('c.unread_count > 0');
  } else if (readStatus === 'read') {
    whereParts.push('(c.unread_count IS NULL OR c.unread_count = 0)');
  }

  if (unrepliedOnly) {
    addUnrepliedWhere(whereParts, params, unrepliedMinutes);
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

  db.prepare('UPDATE conversations SET unread_count=0, updated_at=? WHERE id=?').run(nowIso(), req.params.id);

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



app.post('/api/conversations/batch', requireLogin, (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map(x => clean(x, 120)).filter(Boolean)
    : [];
  const action = String(req.body.action || '').trim();

  if (!ids.length) {
    return res.status(400).json({ ok: false, error: '沒有選擇對話' });
  }

  const now = nowIso();

  try {
    const tx = db.transaction((list) => {
      if (action === 'archive') {
        const stmt = db.prepare("UPDATE conversations SET folder='archive', archived_at=?, updated_at=? WHERE id=?");
        list.forEach(id => stmt.run(now, now, id));
      } else if (action === 'trash') {
        const stmt = db.prepare("UPDATE conversations SET folder='trash', deleted_at=?, updated_at=? WHERE id=?");
        list.forEach(id => stmt.run(now, now, id));
      } else if (action === 'restore') {
        const stmt = db.prepare("UPDATE conversations SET folder='inbox', archived_at='', deleted_at='', updated_at=? WHERE id=?");
        list.forEach(id => stmt.run(now, id));
      } else if (action === 'read') {
        const stmt = db.prepare('UPDATE conversations SET unread_count=0, updated_at=? WHERE id=?');
        list.forEach(id => stmt.run(now, id));
      } else if (action === 'unread') {
        const stmt = db.prepare('UPDATE conversations SET unread_count=CASE WHEN unread_count > 0 THEN unread_count ELSE 1 END, updated_at=? WHERE id=?');
        list.forEach(id => stmt.run(now, id));
      } else if (action === 'delete') {
        const delMsg = db.prepare('DELETE FROM messages WHERE conversation_id=?');
        const delConv = db.prepare('DELETE FROM conversations WHERE id=?');
        list.forEach(id => {
          delMsg.run(id);
          delConv.run(id);
        });
      } else {
        throw new Error('未知操作');
      }
    });

    tx(ids);

    if (action === 'delete') {
      ids.forEach(id => io.emit('conversation_deleted', { id }));
    } else {
      ids.forEach(id => emitConversation(id));
    }

    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error('Batch operation failed:', e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : '批量操作失敗' });
  }
});

app.post('/api/conversations/:id/push-test', requireLogin, async (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({ error: 'not found' });
  }

  try {
    const result = await sendPushToConversation(req.params.id, {
      title: publicConfig().title || '客服訊息通知',
      body: '你有新訊息通知',
      url: notificationUrlForConversation(convo)
    });

    if (result.sent > 0) {
      insertSystemMessage(req.params.id, '【系統】已發送測試推播通知。', { internalOnly: true });
      emitConversation(req.params.id);
    }

    res.json({ ok: true, ...result, status: updateConversationPushStatus(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
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

  const greetingMsgs = insertInitialGreeting(id);

  io.emit('new_conversation', convoListRow(id));

  if (Array.isArray(greetingMsgs)) {
    greetingMsgs.forEach(m => io.to(id).emit('message', m));
  }

  res.json({ id });
});


app.get('/api/widget/conversations/:id/push-status', (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const count = db.prepare(`
    SELECT COUNT(*) AS n
    FROM push_subscriptions
    WHERE conversation_id=? AND status='active'
  `).get(req.params.id);

  const status = count && count.n > 0 ? 'enabled' : (convo.push_status || 'none');

  res.json({ ok: true, status, enabled: status === 'enabled' });
});

app.post('/api/widget/conversations/:id/push-status', (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const status = ['none','enabled','denied','unsupported','expired','failed'].includes(req.body.status)
    ? req.body.status
    : 'none';

  db.prepare(`
    UPDATE conversations
    SET push_status=?, push_updated_at=?
    WHERE id=?
  `).run(status, nowIso(), req.params.id);

  emitConversation(req.params.id);

  res.json({ ok: true, status });
});

app.post('/api/widget/conversations/:id/push-subscription', (req, res) => {
  const convo = convoById(req.params.id);

  if (!convo) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const sub = req.body.subscription || req.body;
  const endpoint = clean(sub.endpoint, 1200);
  const keys = sub.keys || {};
  const p256dh = clean(keys.p256dh, 500);
  const auth = clean(keys.auth, 500);

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  db.prepare(`
    INSERT INTO push_subscriptions (conversation_id, endpoint, p256dh, auth, user_agent, status, error, created_at, updated_at)
    VALUES (?,?,?,?,?,'active','',?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      conversation_id=excluded.conversation_id,
      p256dh=excluded.p256dh,
      auth=excluded.auth,
      user_agent=excluded.user_agent,
      status='active',
      error='',
      updated_at=excluded.updated_at
  `).run(
    req.params.id,
    endpoint,
    p256dh,
    auth,
    clean(req.headers['user-agent'], 1000),
    nowIso(),
    nowIso()
  );

  updateConversationPushStatus(req.params.id);

  res.json({ ok: true, status: 'enabled' });
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
    WHERE conversation_id=? AND (internal_only IS NULL OR internal_only=0)
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
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, internal_only, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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
    0,
    nowIso()
  );

  db.prepare(`
    UPDATE conversations
    SET visitor_online=1,
        visitor_last_seen=?,
        unread_count=COALESCE(unread_count,0)+1,
        folder=CASE WHEN folder='trash' THEN 'trash' ELSE 'inbox' END,
        updated_at=?
    WHERE id=?
  `).run(nowIso(), nowIso(), req.params.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);

  io.to(req.params.id).emit('message', msg);

  const autoReplies = maybeInsertOfflineAutoReply(req.params.id);

  if (Array.isArray(autoReplies)) {
    autoReplies.forEach(m => io.to(req.params.id).emit('message', m));
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
    INSERT INTO messages (conversation_id, sender_type, sender_name, sender_login, body, attachment_url, attachment_name, attachment_type, attachment_mime, attachment_size, internal_only, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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
    0,
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

  const pushText = body || (attachment.attachment_url ? '你有新附件通知' : '你有新訊息通知');
  sendPushToConversation(req.params.id, {
    title: publicConfig().title || '客服訊息通知',
    body: `${displayName}：${pushText}`.slice(0, 180)
  }).catch(e => console.error('push send failed:', e && e.message ? e.message : e));

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