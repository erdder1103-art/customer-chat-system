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
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'chat.sqlite'));

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  visitor_name TEXT DEFAULT '',
  visitor_contact TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  assigned_to TEXT DEFAULT '',
  note TEXT DEFAULT '',
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
`);

const rawUsers = process.env.ADMIN_USERS || 'admin:123456';
const adminUsers = rawUsers.split(',').map(x => x.trim()).filter(Boolean).map(pair => {
  const [username, password] = pair.split(':');
  return { username, passwordHash: bcrypt.hashSync(password || '123456', 8) };
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function nowIso(){ return new Date().toISOString(); }
function touchConversation(id){ db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(nowIso(), id); }

app.get('/', (req,res)=> res.redirect('/admin/login.html'));
app.get('/widget.js', (req,res)=> {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});
app.get('/config', (req,res)=> res.json({
  title: process.env.WIDGET_TITLE || 'Suporte Online',
  greeting: process.env.WIDGET_GREETING || 'Ola! Como podemos ajudar?'
}));

app.post('/api/login', (req,res)=> {
  const { username, password } = req.body;
  const user = adminUsers.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) return res.status(401).json({ error:'帳號或密碼錯誤' });
  req.session.user = { username };
  res.json({ ok:true, user:{ username } });
});
app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me', requireLogin, (req,res)=> res.json({ user:req.session.user }));

app.get('/api/conversations', requireLogin, (req,res)=> {
  const rows = db.prepare(`SELECT c.*, (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message FROM conversations c ORDER BY updated_at DESC`).all();
  res.json(rows);
});
app.get('/api/conversations/:id', requireLogin, (req,res)=> {
  const convo = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!convo) return res.status(404).json({ error:'not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC').all(req.params.id);
  res.json({ conversation: convo, messages });
});
app.patch('/api/conversations/:id', requireLogin, (req,res)=> {
  const { status, assigned_to, note, visitor_name, visitor_contact } = req.body;
  const old = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error:'not found' });
  db.prepare(`UPDATE conversations SET status=?, assigned_to=?, note=?, visitor_name=?, visitor_contact=?, updated_at=? WHERE id=?`).run(
    status ?? old.status, assigned_to ?? old.assigned_to, note ?? old.note, visitor_name ?? old.visitor_name, visitor_contact ?? old.visitor_contact, nowIso(), req.params.id
  );
  io.emit('conversation_updated', db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id));
  res.json({ ok:true });
});

app.post('/api/widget/conversations', (req,res)=> {
  const id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.prepare('INSERT INTO conversations (id, visitor_name, visitor_contact, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, req.body.visitor_name || '', req.body.visitor_contact || '', nowIso(), nowIso());
  io.emit('new_conversation', { id });
  res.json({ id });
});
app.get('/api/widget/conversations/:id/messages', (req,res)=> {
  const messages = db.prepare('SELECT sender_type, sender_name, body, created_at FROM messages WHERE conversation_id=? ORDER BY id ASC').all(req.params.id);
  res.json(messages);
});
app.post('/api/widget/conversations/:id/messages', (req,res)=> {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error:'empty message' });
  const exists = db.prepare('SELECT id FROM conversations WHERE id=?').get(req.params.id);
  if (!exists) return res.status(404).json({ error:'conversation not found' });
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_type, sender_name, body, created_at) VALUES (?,?,?,?,?)').run(req.params.id, 'visitor', 'visitor', body, nowIso());
  touchConversation(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
  io.to(req.params.id).emit('message', msg);
  io.emit('conversation_updated', { id:req.params.id });
  res.json(msg);
});
app.post('/api/conversations/:id/messages', requireLogin, (req,res)=> {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error:'empty message' });
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_type, sender_name, body, created_at) VALUES (?,?,?,?,?)').run(req.params.id, 'agent', req.session.user.username, body, nowIso());
  touchConversation(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
  io.to(req.params.id).emit('message', msg);
  io.emit('conversation_updated', { id:req.params.id });
  res.json(msg);
});

io.on('connection', socket => {
  socket.on('join', conversationId => socket.join(conversationId));
});

server.listen(PORT, ()=> console.log(`Customer chat system running on ${PORT}`));
