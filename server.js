require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','PATCH'] } });
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'chat.sqlite'));

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  visitor_name TEXT DEFAULT '',
  visitor_contact TEXT DEFAULT '',
  visitor_account TEXT DEFAULT '',
  visitor_online INTEGER DEFAULT 0,
  visitor_last_seen TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  assigned_to TEXT DEFAULT '',
  note TEXT DEFAULT '',
  last_agent TEXT DEFAULT '',
  source_site TEXT DEFAULT '',
  source_title TEXT DEFAULT '',
  source_campaign TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  source_referrer TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT DEFAULT '',
  body TEXT NOT NULL,
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
  ['last_agent', "TEXT DEFAULT ''"],
  ['source_site', "TEXT DEFAULT ''"],
  ['source_title', "TEXT DEFAULT ''"],
  ['source_campaign', "TEXT DEFAULT ''"],
  ['source_url', "TEXT DEFAULT ''"],
  ['source_referrer', "TEXT DEFAULT ''"],
  ['utm_source', "TEXT DEFAULT ''"],
  ['utm_medium', "TEXT DEFAULT ''"],
  ['utm_campaign', "TEXT DEFAULT ''"]
].forEach(([col, def]) => ensureColumn('conversations', col, def));

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

/*
  預設設定：
  support_status 第一次安裝時會寫入。
*/
setDefault('support_status', process.env.SUPPORT_STATUS || 'online');

setDefault('quick_replies', JSON.stringify([
  '您好，请问您的会员账号是多少？',
  '请问您目前遇到什么问题？',
  '请稍等，我帮您查询一下。',
  '目前活动优惠已收到，我帮您确认适合的方案。'
]));

/*
  文案版本控制：
  如果 Railway 已經有舊的 chat.sqlite，
  這段會強制把舊標題 / 舊招呼語更新成新版。
  之後如果還要再改文案，把 COPY_VERSION 改成新的字串即可。
*/
const COPY_VERSION = 'f1top-10usdt-copy-v1';
const currentCopyVersion = db.prepare('SELECT value FROM settings WHERE key=?').get('copy_version');

if (!currentCopyVersion || currentCopyVersion.value !== COPY_VERSION) {
  forceSetting('widget_title', process.env.WIDGET_TITLE || '领取10USDT窗口');
  forceSetting('online_greeting', process.env.WIDGET_GREETING || '你好,领取10U体验金吗？');
  forceSetting('offline_greeting', process.env.OFFLINE_GREETING || '目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。');
  forceSetting('copy_version', COPY_VERSION);
}

const rawUsers = process.env.ADMIN_USERS || 'admin:123456';
const adminUsers = rawUsers.split(',').map(x => x.trim()).filter(Boolean).map(pair => {
  const [username, ...rest] = pair.split(':');
  const password = rest.join(':') || '123456';
  return { username, passwordHash: bcrypt.hashSync(password, 8) };
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function nowIso(){ return new Date().toISOString(); }
function clean(v, n=500){ return String(v || '').slice(0, n); }
function touchConversation(id){ db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(nowIso(), id); }
function setting(key){ const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? row.value : ''; }
function setSetting(key, value){ db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value || '')); }

function publicConfig(){
  let quickReplies = [];
  try { quickReplies = JSON.parse(setting('quick_replies') || '[]'); } catch (_) {}

  return {
    title: setting('widget_title') || '领取10USDT窗口',
    support_status: setting('support_status') || 'online',
    online_greeting: setting('online_greeting') || '你好,领取10U体验金吗？',
    offline_greeting: setting('offline_greeting') || '目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。请提供TG联系方式。或是等工作时间10-22点在来讯息请记住网址。',
    quick_replies: quickReplies
  };
}

function convoById(id){ return db.prepare('SELECT * FROM conversations WHERE id=?').get(id); }

app.get('/', (req,res)=> res.redirect('/admin/login.html'));

app.get('/widget.js', (req,res)=> {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

app.get('/config', (req,res)=> res.json(publicConfig()));

app.post('/api/login', (req,res)=> {
  const { username, password } = req.body;
  const user = adminUsers.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) return res.status(401).json({ error:'帳號或密碼錯誤' });
  req.session.user = { username };
  res.json({ ok:true, user:{ username } });
});

app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ok:true})));

app.get('/api/me', requireLogin, (req,res)=> res.json({ user:req.session.user }));

app.get('/api/settings', requireLogin, (req,res)=> res.json(publicConfig()));

app.patch('/api/settings', requireLogin, (req,res)=> {
  const allowed = ['support_status','widget_title','online_greeting','offline_greeting','quick_replies'];

  allowed.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) {
      if (k === 'support_status') {
        setSetting(k, req.body[k] === 'offline' ? 'offline' : 'online');
      } else if (k === 'quick_replies') {
        const list = Array.isArray(req.body[k]) ? req.body[k].map(x => clean(x, 300)).filter(Boolean) : [];
        setSetting(k, JSON.stringify(list));
      } else {
        setSetting(k, clean(req.body[k], 2000));
      }
    }
  });

  io.emit('settings_updated', publicConfig());
  res.json({ ok:true, settings: publicConfig() });
});

app.get('/api/conversations', requireLogin, (req,res)=> {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT sender_type FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_sender_type
    FROM conversations c
    ORDER BY updated_at DESC
  `).all();

  res.json(rows);
});

app.get('/api/conversations/:id', requireLogin, (req,res)=> {
  const convo = convoById(req.params.id);
  if (!convo) return res.status(404).json({ error:'not found' });

  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC').all(req.params.id);
  res.json({ conversation: convo, messages });
});

app.patch('/api/conversations/:id', requireLogin, (req,res)=> {
  const { status, assigned_to, note, visitor_name, visitor_contact, visitor_account } = req.body;
  const old = convoById(req.params.id);
  if (!old) return res.status(404).json({ error:'not found' });

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

  io.emit('conversation_updated', convoById(req.params.id));
  res.json({ ok:true });
});

app.post('/api/widget/conversations', (req,res)=> {
  const id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  db.prepare(`
    INSERT INTO conversations (
      id, visitor_name, visitor_contact, visitor_account, visitor_online, visitor_last_seen,
      source_site, source_title, source_campaign, source_url, source_referrer,
      utm_source, utm_medium, utm_campaign, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    clean(req.body.visitor_name, 120),
    clean(req.body.visitor_contact, 180),
    clean(req.body.visitor_account, 180),
    1,
    nowIso(),
    clean(req.body.source_site),
    clean(req.body.source_title),
    clean(req.body.source_campaign),
    clean(req.body.source_url, 1000),
    clean(req.body.source_referrer, 1000),
    clean(req.body.utm_source),
    clean(req.body.utm_medium),
    clean(req.body.utm_campaign),
    nowIso(),
    nowIso()
  );

  io.emit('new_conversation', convoById(id));
  res.json({ id });
});

app.patch('/api/widget/conversations/:id/profile', (req,res)=> {
  const old = convoById(req.params.id);
  if (!old) return res.status(404).json({ error:'conversation not found' });

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

  io.emit('conversation_updated', convoById(req.params.id));
  res.json({ ok:true });
});

app.get('/api/widget/conversations/:id/messages', (req,res)=> {
  const messages = db.prepare(`
    SELECT sender_type, sender_name, body, created_at
    FROM messages
    WHERE conversation_id=?
    ORDER BY id ASC
  `).all(req.params.id);

  res.json(messages);
});

app.post('/api/widget/conversations/:id/messages', (req,res)=> {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error:'empty message' });

  const exists = convoById(req.params.id);
  if (!exists) return res.status(404).json({ error:'conversation not found' });

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, body, created_at)
    VALUES (?,?,?,?,?)
  `).run(
    req.params.id,
    'visitor',
    exists.visitor_name || '訪客',
    body,
    nowIso()
  );

  db.prepare(`
    UPDATE conversations
    SET visitor_online=1, visitor_last_seen=?, updated_at=?
    WHERE id=?
  `).run(nowIso(), nowIso(), req.params.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);

  io.to(req.params.id).emit('message', msg);
  io.emit('conversation_updated', convoById(req.params.id));

  res.json(msg);
});

app.post('/api/conversations/:id/messages', requireLogin, (req,res)=> {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error:'empty message' });

  const exists = convoById(req.params.id);
  if (!exists) return res.status(404).json({ error:'conversation not found' });

  const agent = req.session.user.username;

  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_type, sender_name, body, created_at)
    VALUES (?,?,?,?,?)
  `).run(
    req.params.id,
    'agent',
    agent,
    body,
    nowIso()
  );

  db.prepare(`
    UPDATE conversations
    SET last_agent=?, updated_at=?
    WHERE id=?
  `).run(agent, nowIso(), req.params.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);

  io.to(req.params.id).emit('message', msg);
  io.emit('conversation_updated', convoById(req.params.id));

  res.json(msg);
});

io.on('connection', socket => {
  socket.on('join', conversationId => socket.join(conversationId));

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

      io.emit('conversation_updated', convoById(conversationId));
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

      io.emit('conversation_updated', convoById(id));
    }
  });
});

server.listen(PORT, ()=> console.log(`Customer chat system running on ${PORT}`));
