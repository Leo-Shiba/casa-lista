require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const express = require("express");
const { DatabaseSync } = require("node:sqlite"); // SQLite embutido no Node (sem compilação)
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = "dev-secret-troque-em-producao";
  console.warn("[aviso] JWT_SECRET não definido — usando chave de desenvolvimento. Defina em produção!");
}

// =====================================================================
// Banco
// =====================================================================
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "casa.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
// transação: tx(fn) devolve uma função que roda fn dentro de BEGIN/COMMIT
db.transaction = (fn) => (...args) => {
  db.exec("BEGIN");
  try { const r = fn(...args); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    email           TEXT,
    email_pending   TEXT,
    email_token     TEXT,
    reset_token     TEXT,
    reset_expires   INTEGER,
    active_house_id TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS houses (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS house_members (
    house_id  TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (house_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    house_id   TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    house_id   TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    room       TEXT NOT NULL DEFAULT 'Geral',
    qty        INTEGER NOT NULL DEFAULT 1,
    price      REAL,
    url        TEXT DEFAULT '',
    image      TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    priority   INTEGER NOT NULL DEFAULT 0,
    bought     INTEGER NOT NULL DEFAULT 0,
    bought_at  INTEGER,
    bought_by  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS historico (
    id          TEXT PRIMARY KEY,
    house_id    TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    nome        TEXT NOT NULL,
    room        TEXT,
    qty         INTEGER DEFAULT 1,
    preco       REAL,
    data_compra INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id   TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    user_id    TEXT,
    username   TEXT NOT NULL,
    action     TEXT NOT NULL,
    item_name  TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL,
    loja       TEXT NOT NULL,
    preco      REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_house    ON items(house_id);
  CREATE INDEX IF NOT EXISTS idx_hist_house     ON historico(house_id);
  CREATE INDEX IF NOT EXISTS idx_activity_house ON activity(house_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_members_user   ON house_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_price_item     ON price_history(item_id, created_at);
`);

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const now = () => Date.now();
const DEFAULT_ROOMS = ["Sala", "Cozinha", "Quarto", "Banheiro", "Área de serviço", "Geral"];

function newInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)];
    if (!db.prepare("SELECT 1 FROM houses WHERE invite_code=?").get(c)) return c;
  }
}

const createHouse = db.transaction((userId, name) => {
  const id = uid();
  db.prepare("INSERT INTO houses (id,name,invite_code,created_by,created_at) VALUES (?,?,?,?,?)")
    .run(id, name, newInviteCode(), userId, now());
  db.prepare("INSERT INTO house_members (house_id,user_id,role,joined_at) VALUES (?,?,'admin',?)")
    .run(id, userId, now());
  const ins = db.prepare("INSERT INTO rooms (id,house_id,name,sort_order) VALUES (?,?,?,?)");
  DEFAULT_ROOMS.forEach((r, i) => ins.run(uid(), id, r, i));
  db.prepare("UPDATE users SET active_house_id=? WHERE id=?").run(id, userId);
  return id;
});

const membership = (houseId, userId) =>
  db.prepare("SELECT * FROM house_members WHERE house_id=? AND user_id=?").get(houseId, userId);

function itemOut(r) {
  return {
    id: r.id, name: r.name, room: r.room, qty: r.qty, price: r.price,
    url: r.url || "", image: r.image || "", notes: r.notes || "",
    priority: !!r.priority, bought: !!r.bought, bought_at: r.bought_at,
    sort_order: r.sort_order, created_at: r.created_at,
  };
}

function logActivity(req, action, itemName) {
  db.prepare("INSERT INTO activity (house_id,user_id,username,action,item_name,created_at) VALUES (?,?,?,?,?,?)")
    .run(req.houseId, req.userId, req.username, action, itemName || null, now());
}

// =====================================================================
// Tempo real (SSE)
// =====================================================================
const sseClients = new Map(); // houseId -> Set<res>
function broadcast(houseId, origin) {
  const set = sseClients.get(houseId);
  if (!set) return;
  const msg = `event: change\ndata: ${JSON.stringify({ origin: origin || null })}\n\n`;
  for (const res of set) res.write(msg);
}
setInterval(() => {
  for (const set of sseClients.values()) for (const res of set) res.write(": ping\n\n");
}, 25000);

// =====================================================================
// Email (opcional — só funciona com SMTP configurado)
// =====================================================================
let mailer = null;
if (process.env.SMTP_HOST) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } catch (e) { console.warn("[aviso] nodemailer indisponível:", e.message); }
}
async function sendMail(to, subject, html) {
  if (!mailer) throw Object.assign(new Error("Envio de email não está configurado no servidor."), { status: 503 });
  await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
}
const baseUrl = (req) => APP_URL || `${req.protocol}://${req.get("host")}`;
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

// =====================================================================
// Middlewares
// =====================================================================
app.set("trust proxy", 1);
const jsonSmall = express.json({ limit: "3mb" });  // fotos em base64
const jsonBig = express.json({ limit: "25mb" });   // importação de backup
app.use((req, res, next) => (req.path === "/api/backup/import" ? jsonBig : jsonSmall)(req, res, next)); // fotos em base64

const sign = (user, houseId) =>
  jwt.sign({ id: user.id, username: user.username, houseId }, JWT_SECRET, { expiresIn: "90d" });

function auth(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ erro: "Não autorizado" });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ erro: "Sessão expirada, entre de novo" }); }
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(payload.id);
  if (!user) return res.status(401).json({ erro: "Usuário não existe mais" });
  let houseId = payload.houseId;
  if (!houseId || !membership(houseId, user.id)) {
    // removido da casa ou token antigo: cai na casa ativa / primeira casa / cria uma
    houseId = user.active_house_id && membership(user.active_house_id, user.id)
      ? user.active_house_id
      : db.prepare("SELECT house_id FROM house_members WHERE user_id=? ORDER BY joined_at LIMIT 1").get(user.id)?.house_id
        || createHouse(user.id, "Minha casa");
    res.set("X-New-Token", sign(user, houseId));
  }
  req.user = user; req.userId = user.id; req.username = user.username; req.houseId = houseId;
  next();
}

// limitador simples para login/cadastro/recuperação
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ erro: "Muitas tentativas. Espere um pouco." });
    arr.push(t); hits.set(key, arr);
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ erro: e.status ? e.message : "Erro no servidor" });
});
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// =====================================================================
// Auth
// =====================================================================
app.post("/api/register", rateLimit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!/^[\w.\-]{3,30}$/.test(username)) throw bad("Usuário deve ter 3–30 letras, números, ponto ou traço.");
  if (password.length < 6) throw bad("A senha precisa ter ao menos 6 caracteres.");
  if (email && !validEmail(email)) throw bad("Email inválido.");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw bad("Esse usuário já existe.", 409);
  if (email && db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw bad("Esse email já está em uso.", 409);
  const user = { id: uid(), username };
  db.prepare("INSERT INTO users (id,username,password_hash,email,created_at) VALUES (?,?,?,?,?)")
    .run(user.id, username, await bcrypt.hash(password, 10), email || null, now());
  const houseId = createHouse(user.id, "Minha casa");
  res.json({ token: sign(user, houseId), username, userId: user.id });
}));

app.post("/api/login", rateLimit(15, 15 * 60 * 1000), wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const user = db.prepare("SELECT * FROM users WHERE username=? OR email=?").get(username, username.toLowerCase());
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash)))
    throw bad("Usuário ou senha incorretos.", 401);
  let houseId = user.active_house_id && membership(user.active_house_id, user.id) ? user.active_house_id : null;
  if (!houseId) houseId = db.prepare("SELECT house_id FROM house_members WHERE user_id=? ORDER BY joined_at LIMIT 1").get(user.id)?.house_id
    || createHouse(user.id, "Minha casa");
  res.json({ token: sign(user, houseId), username: user.username, userId: user.id });
}));

app.post("/api/auth/forgot", rateLimit(5, 15 * 60 * 1000), wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!validEmail(email)) throw bad("Email inválido.");
  if (!mailer) throw bad("Recuperação por email ainda não está configurada. Fale com quem administra o app.", 503);
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (user) {
    const token = crypto.randomBytes(24).toString("hex");
    db.prepare("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?").run(token, now() + 60 * 60 * 1000, user.id);
    const link = `${baseUrl(req)}/?reset=${token}`;
    await sendMail(email, "Casa Lista — redefinir senha",
      `<p>Oi, ${user.username}!</p><p>Clique para criar uma nova senha (vale 1 hora):</p><p><a href="${link}">${link}</a></p>`);
  }
  res.json({ ok: true }); // não revela se o email existe
}));

app.post("/api/auth/reset", rateLimit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const token = String(req.body.token || "");
  const password = String(req.body.password || "");
  if (password.length < 6) throw bad("A senha precisa ter ao menos 6 caracteres.");
  const user = token && db.prepare("SELECT * FROM users WHERE reset_token=?").get(token);
  if (!user || user.reset_expires < now()) throw bad("Link inválido ou expirado.");
  db.prepare("UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?")
    .run(await bcrypt.hash(password, 10), user.id);
  res.json({ ok: true });
}));

app.post("/api/auth/confirm-email", wrap(async (req, res) => {
  const token = String(req.body.token || "");
  const user = token && db.prepare("SELECT * FROM users WHERE email_token=?").get(token);
  if (!user || !user.email_pending) throw bad("Link inválido ou já usado.");
  if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(user.email_pending, user.id)) throw bad("Esse email já está em uso.", 409);
  db.prepare("UPDATE users SET email=email_pending, email_pending=NULL, email_token=NULL WHERE id=?").run(user.id);
  res.json({ ok: true });
}));

// =====================================================================
// Minha conta
// =====================================================================
app.get("/api/me", auth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, email: u.email, email_pending: u.email_pending, houseId: req.houseId });
});

app.put("/api/me/username", auth, wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  if (!/^[\w.\-]{3,30}$/.test(username)) throw bad("Usuário deve ter 3–30 letras, números, ponto ou traço.");
  if (db.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").get(username, req.userId)) throw bad("Esse usuário já existe.", 409);
  db.prepare("UPDATE users SET username=? WHERE id=?").run(username, req.userId);
  res.json({ username, token: sign({ id: req.userId, username }, req.houseId) });
}));

app.put("/api/me/password", auth, wrap(async (req, res) => {
  const { current, password } = req.body || {};
  if (!(await bcrypt.compare(String(current || ""), req.user.password_hash))) throw bad("Senha atual incorreta.");
  if (String(password || "").length < 6) throw bad("A senha precisa ter ao menos 6 caracteres.");
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await bcrypt.hash(String(password), 10), req.userId);
  res.json({ ok: true });
}));

app.put("/api/me/email", auth, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!validEmail(email)) throw bad("Email inválido.");
  if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(email, req.userId)) throw bad("Esse email já está em uso.", 409);
  if (!mailer) {
    // sem SMTP não dá pra confirmar: salva direto
    db.prepare("UPDATE users SET email=?, email_pending=NULL, email_token=NULL WHERE id=?").run(email, req.userId);
    return res.json({ ok: true, confirmed: true });
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET email_pending=?, email_token=? WHERE id=?").run(email, token, req.userId);
  const link = `${baseUrl(req)}/?confirm-email=${token}`;
  await sendMail(email, "Casa Lista — confirme seu email",
    `<p>Oi, ${req.username}!</p><p>Clique para confirmar este email:</p><p><a href="${link}">${link}</a></p>`);
  res.json({ ok: true, confirmed: false });
}));

// =====================================================================
// Casa
// =====================================================================
function houseOut(houseId, userId) {
  const h = db.prepare("SELECT * FROM houses WHERE id=?").get(houseId);
  const members = db.prepare(`SELECT u.id, u.username, m.role FROM house_members m JOIN users u ON u.id=m.user_id
    WHERE m.house_id=? ORDER BY m.joined_at`).all(houseId);
  const me = members.find((m) => m.id === userId);
  return { id: h.id, name: h.name, invite_code: h.invite_code, created_by: h.created_by, is_admin: me?.role === "admin", members };
}

app.get("/api/house", auth, (req, res) => res.json(houseOut(req.houseId, req.userId)));

app.put("/api/house", auth, wrap(async (req, res) => {
  if (membership(req.houseId, req.userId)?.role !== "admin") throw bad("Só o administrador pode renomear.", 403);
  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) throw bad("Nome vazio.");
  db.prepare("UPDATE houses SET name=? WHERE id=?").run(name, req.houseId);
  broadcast(req.houseId);
  res.json({ ok: true });
}));

app.get("/api/houses", auth, (req, res) => {
  const rows = db.prepare(`SELECT h.id, h.name, h.created_by,
      (SELECT COUNT(*) FROM house_members WHERE house_id=h.id) AS member_count,
      (SELECT COUNT(*) FROM items WHERE house_id=h.id AND bought=0) AS pending_count
    FROM house_members m JOIN houses h ON h.id=m.house_id WHERE m.user_id=? ORDER BY m.joined_at`).all(req.userId);
  res.json(rows.map((r) => ({ ...r, active: r.id === req.houseId })));
});

function switchTo(req, res, houseId) {
  db.prepare("UPDATE users SET active_house_id=? WHERE id=?").run(houseId, req.userId);
  const h = db.prepare("SELECT name FROM houses WHERE id=?").get(houseId);
  res.json({ token: sign(req.user, houseId), houseId, houseName: h.name });
}

app.post("/api/house/switch", auth, wrap(async (req, res) => {
  const houseId = String(req.body.houseId || "");
  if (!membership(houseId, req.userId)) throw bad("Você não faz parte dessa casa.", 403);
  switchTo(req, res, houseId);
}));

app.post("/api/house/join", auth, rateLimit(20, 15 * 60 * 1000), wrap(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const h = db.prepare("SELECT * FROM houses WHERE invite_code=?").get(code);
  if (!h) throw bad("Código não encontrado.", 404);
  if (!membership(h.id, req.userId)) {
    db.prepare("INSERT INTO house_members (house_id,user_id,role,joined_at) VALUES (?,?,'member',?)").run(h.id, req.userId, now());
    db.prepare("INSERT INTO activity (house_id,user_id,username,action,item_name,created_at) VALUES (?,?,?,?,?,?)")
      .run(h.id, req.userId, req.username, "entrou na casa", null, now());
    broadcast(h.id);
  }
  switchTo(req, res, h.id);
}));

app.delete("/api/house/member/:userId", auth, wrap(async (req, res) => {
  if (membership(req.houseId, req.userId)?.role !== "admin") throw bad("Só o administrador pode remover membros.", 403);
  const h = db.prepare("SELECT created_by FROM houses WHERE id=?").get(req.houseId);
  if (req.params.userId === h.created_by || req.params.userId === req.userId) throw bad("Esse membro não pode ser removido.");
  db.prepare("DELETE FROM house_members WHERE house_id=? AND user_id=?").run(req.houseId, req.params.userId);
  broadcast(req.houseId);
  res.json({ ok: true });
}));

app.delete("/api/house/leave", auth, wrap(async (req, res) => {
  const houseId = String(req.body?.houseId || req.houseId);
  if (!membership(houseId, req.userId)) throw bad("Você não faz parte dessa casa.");
  const h = db.prepare("SELECT * FROM houses WHERE id=?").get(houseId);
  const count = db.prepare("SELECT COUNT(*) c FROM house_members WHERE house_id=?").get(houseId).c;
  if (h.created_by === req.userId && count > 1) throw bad("Você criou esta casa e ainda há membros nela.");
  db.transaction(() => {
    db.prepare("DELETE FROM house_members WHERE house_id=? AND user_id=?").run(houseId, req.userId);
    if (count <= 1) db.prepare("DELETE FROM houses WHERE id=?").run(houseId); // casa vazia some
  })();
  broadcast(houseId);
  if (houseId !== req.houseId) return res.json({ ok: true });
  const next = db.prepare("SELECT house_id FROM house_members WHERE user_id=? ORDER BY joined_at LIMIT 1").get(req.userId)?.house_id
    || createHouse(req.userId, "Minha casa");
  db.prepare("UPDATE users SET active_house_id=? WHERE id=?").run(next, req.userId);
  res.json({ ok: true, token: sign(req.user, next) });
}));

// =====================================================================
// Cômodos
// =====================================================================
app.get("/api/rooms", auth, (req, res) => {
  res.json(db.prepare("SELECT id, name FROM rooms WHERE house_id=? ORDER BY sort_order, rowid").all(req.houseId));
});

app.post("/api/rooms", auth, wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) throw bad("Nome vazio.");
  if (db.prepare("SELECT 1 FROM rooms WHERE house_id=? AND name=? COLLATE NOCASE").get(req.houseId, name)) throw bad("Esse cômodo já existe.");
  const max = db.prepare("SELECT COALESCE(MAX(sort_order),-1) m FROM rooms WHERE house_id=?").get(req.houseId).m;
  const room = { id: uid(), name };
  db.prepare("INSERT INTO rooms (id,house_id,name,sort_order) VALUES (?,?,?,?)").run(room.id, req.houseId, name, max + 1);
  broadcast(req.houseId);
  res.json(room);
}));

app.delete("/api/rooms/:id", auth, (req, res) => {
  db.prepare("DELETE FROM rooms WHERE id=? AND house_id=?").run(req.params.id, req.houseId);
  broadcast(req.houseId);
  res.json({ ok: true });
});

// =====================================================================
// Itens
// =====================================================================
const cleanItem = (b, partial) => {
  const o = {};
  const str = (v, n) => String(v ?? "").trim().slice(0, n);
  if (!partial || b.name !== undefined) { o.name = str(b.name, 120); if (!o.name) throw bad("Nome vazio."); }
  if (!partial || b.room !== undefined) o.room = str(b.room, 40) || "Geral";
  if (!partial || b.qty !== undefined) o.qty = Math.max(1, Math.min(999, parseInt(b.qty) || 1));
  if (!partial || b.price !== undefined) { const p = b.price === null || b.price === "" ? null : Number(b.price); o.price = Number.isFinite(p) && p >= 0 ? p : null; }
  if (!partial || b.url !== undefined) o.url = str(b.url, 1000);
  if (!partial || b.image !== undefined) {
    o.image = String(b.image ?? "").trim();
    if (o.image.length > 2_500_000) throw bad("Imagem muito grande.");
    if (o.image && !/^(https?:\/\/|data:image\/)/i.test(o.image)) o.image = "";
  }
  if (!partial || b.notes !== undefined) o.notes = str(b.notes, 1000);
  if (!partial || b.priority !== undefined) o.priority = b.priority ? 1 : 0;
  if (partial && b.bought !== undefined) o.bought = b.bought ? 1 : 0;
  return o;
};

app.get("/api/items", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM items WHERE house_id=? ORDER BY sort_order, created_at DESC").all(req.houseId).map(itemOut));
});

app.post("/api/items", auth, wrap(async (req, res) => {
  const o = cleanItem(req.body || {}, false);
  const id = uid();
  const min = db.prepare("SELECT COALESCE(MIN(sort_order),1) m FROM items WHERE house_id=? AND room=?").get(req.houseId, o.room).m;
  db.prepare(`INSERT INTO items (id,house_id,name,room,qty,price,url,image,notes,priority,sort_order,created_by,created_at)
    VALUES (@id,@house_id,@name,@room,@qty,@price,@url,@image,@notes,@priority,@sort_order,@created_by,@created_at)`)
    .run({ ...o, id, house_id: req.houseId, sort_order: min - 1, created_by: req.userId, created_at: now() });
  logActivity(req, "add", o.name);
  broadcast(req.houseId, req.get("X-Client-Id"));
  res.json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(id)));
}));

// rotas fixas antes de /:id
app.put("/api/items/reorder", auth, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const upd = db.prepare("UPDATE items SET sort_order=? WHERE id=? AND house_id=?");
  db.transaction(() => ids.forEach((id, i) => upd.run(i, String(id), req.houseId)))();
  broadcast(req.houseId, req.get("X-Client-Id"));
  res.json({ ok: true });
}));

app.delete("/api/items/bought", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE house_id=? AND bought=1").all(req.houseId);
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO historico (id,house_id,nome,room,qty,preco,data_compra) VALUES (?,?,?,?,?,?,?)");
    rows.forEach((r) => ins.run(uid(), req.houseId, r.name, r.room, r.qty, r.price, r.bought_at || now()));
    db.prepare("DELETE FROM items WHERE house_id=? AND bought=1").run(req.houseId);
  })();
  if (rows.length) logActivity(req, "clear", `${rows.length} item(ns)`);
  broadcast(req.houseId, req.get("X-Client-Id"));
  res.json({ ok: true, removed: rows.length });
});

app.put("/api/items/:id", auth, wrap(async (req, res) => {
  const cur = db.prepare("SELECT * FROM items WHERE id=? AND house_id=?").get(req.params.id, req.houseId);
  if (!cur) throw bad("Item não encontrado.", 404);
  const o = cleanItem(req.body || {}, true);
  if (o.bought !== undefined && o.bought !== cur.bought) {
    o.bought_at = o.bought ? now() : null;
    o.bought_by = o.bought ? req.userId : null;
    logActivity(req, o.bought ? "bought" : "unbought", cur.name);
  }
  const keys = Object.keys(o);
  if (keys.length) {
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k}=@${k}`).join(",")} WHERE id=@id AND house_id=@house_id`)
      .run({ ...o, id: cur.id, house_id: req.houseId });
  }
  broadcast(req.houseId, req.get("X-Client-Id"));
  res.json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(cur.id)));
}));

app.delete("/api/items/:id", auth, (req, res) => {
  const cur = db.prepare("SELECT name FROM items WHERE id=? AND house_id=?").get(req.params.id, req.houseId);
  if (cur) {
    db.prepare("DELETE FROM items WHERE id=? AND house_id=?").run(req.params.id, req.houseId);
    logActivity(req, "delete", cur.name);
    broadcast(req.houseId, req.get("X-Client-Id"));
  }
  res.json({ ok: true });
});

// =====================================================================
// Histórico, estatísticas, atividade
// =====================================================================
app.get("/api/historico", auth, (req, res) => {
  res.json(db.prepare("SELECT nome, room, qty, preco, data_compra FROM historico WHERE house_id=? ORDER BY data_compra DESC LIMIT 500").all(req.houseId));
});

app.get("/api/stats", auth, (req, res) => {
  // compras = itens marcados (ainda na lista) + histórico (já limpos)
  const compras = db.prepare(`
    SELECT name AS nome, room, qty, price AS preco, bought_at AS data FROM items WHERE house_id=? AND bought=1 AND bought_at IS NOT NULL
    UNION ALL
    SELECT nome, room, qty, preco, data_compra AS data FROM historico WHERE house_id=?`).all(req.houseId, req.houseId);
  const d = new Date();
  const ym = (t) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
  const thisM = ym(d);
  const lastM = ym(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const total = (c) => (c.preco || 0) * (c.qty || 1);
  const byMonth = {}, byRoom = {}, top = {};
  for (const c of compras) {
    const m = ym(c.data);
    byMonth[m] = (byMonth[m] || 0) + total(c);
    byRoom[c.room || "Geral"] = (byRoom[c.room || "Geral"] || 0) + total(c);
    const k = c.nome.trim().toLowerCase();
    top[k] = top[k] || { nome: c.nome, vezes: 0 };
    top[k].vezes += 1;
  }
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  res.json({
    thisMonthTotal: byMonth[thisM] || 0,
    lastMonthTotal: byMonth[lastM] || 0,
    topItems: Object.values(top).sort((a, b) => b.vezes - a.vezes).slice(0, 8),
    byRoom: Object.entries(byRoom).map(([room, t]) => ({ room, total: t })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total),
    byMonth: Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6)
      .map(([m, t]) => ({ mes: `${MES[Number(m.slice(5)) - 1]}/${m.slice(2, 4)}`, total: t })),
  });
});

app.get("/api/activity", auth, (req, res) => {
  res.json(db.prepare("SELECT username, action, item_name, created_at FROM activity WHERE house_id=? ORDER BY created_at DESC LIMIT 80").all(req.houseId));
});

// =====================================================================
// Tempo real
// =====================================================================
app.get("/api/events", auth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  if (!sseClients.has(req.houseId)) sseClients.set(req.houseId, new Set());
  sseClients.get(req.houseId).add(res);
  req.on("close", () => sseClients.get(req.houseId)?.delete(res));
});

// =====================================================================
// Utilitários externos: foto do link e busca de preço
// =====================================================================
function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return privateIp(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function safeFetch(rawUrl, opts = {}, hops = 0) {
  let u;
  try { u = new URL(rawUrl); } catch { throw bad("Link inválido."); }
  if (!/^https?:$/.test(u.protocol)) throw bad("Link inválido.");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw bad("Endereço não permitido.");
  const r = await fetch(u, { ...opts, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (r.status >= 300 && r.status < 400 && r.headers.get("location") && hops < 4)
    return safeFetch(new URL(r.headers.get("location"), u).toString(), opts, hops + 1);
  return r;
}
const UA = { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36", "Accept-Language": "pt-BR,pt;q=0.9" };

const { parsePreview } = require("./lib/preview");

async function readHtml(r, max = 1_500_000) {
  const reader = r.body.getReader();
  let html = "";
  while (html.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    html += Buffer.from(value).toString("utf8");
  }
  reader.cancel().catch(() => {});
  return html;
}

// páginas de login/verificação que algumas lojas devolvem para servidores
const BLOCK_URL = /account-verification|\/gz\/|\/login|signin|captcha|challenge|\/blocked/i;
const BLOCK_TITLE = /^(mercado ?li[bv]re( brasil)?|amazon(\.com\.br)?|shopee( brasil)?|magazine luiza|just a moment.*|access denied|acesso negado|attention required.*|are you a robot.*|verifica[cç][aã]o.*|login|entrar|error|erro)$/i;
const PREVIEW_HEADERS = { "User-Agent": "CasaLista/1.0 (previa de link)", "Accept-Language": "pt-BR,pt;q=0.9", Accept: "text/html,application/xhtml+xml" };

// lê a página do link e extrai nome, foto e preço; se a loja barrar, devolve vazio com o link original
async function linkPreview(rawUrl) {
  const original = String(rawUrl || "").trim();
  const vazio = { nome: null, imagem: null, preco: null, url: original };
  let url = original, out = null;
  for (let hop = 0; hop < 3; hop++) {
    const r = await safeFetch(url, { headers: PREVIEW_HEADERS });
    const finalUrl = r.url || url;
    if (!r.ok || BLOCK_URL.test(finalUrl)) { console.log(`[preview] loja não liberou a página (${r.status})`); return vazio; }
    const p = parsePreview(await readHtml(r), finalUrl);
    out = { nome: p.nome, imagem: p.imagem, preco: p.preco, url: finalUrl };
    if (p.nome && (p.imagem || p.preco != null)) break;
    if (!p.refresh) break;
    try { url = new URL(p.refresh, finalUrl).toString(); } catch { break; }
  }
  if (!out || !out.nome || BLOCK_TITLE.test(out.nome.trim())) return vazio;
  return out;
}

// código do anúncio (MLB123...) dentro de um link do Mercado Livre
function mlIdFrom(url) {
  const m = String(url || "").match(/\bwid=(MLB\d+)/i) || String(url || "").match(/\b(MLB)-?(\d{6,})/i);
  return m ? (m[2] ? m[1] + m[2] : m[1]).toUpperCase() : null;
}
const httpsImg = (u) => (u || "").replace(/^http:/, "https:") || null;
// consulta a API oficial: primeiro como anúncio, depois como produto de catálogo
async function mlLookup(id, log) {
  const token = await getMlToken();
  if (!token) { if (log) console.log("[ml] sem credenciais"); return null; }
  const get = async (path) => {
    const r = await fetch("https://api.mercadolibre.com" + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (log) console.log(`[ml] ${path} -> ${r.status}`);
    return r.ok ? r.json() : null;
  };
  const it = await get(`/items/${id}`);
  if (it && it.title) return { nome: it.title, preco: it.price ?? null, url: it.permalink || null, imagem: httpsImg(it.pictures?.[0]?.secure_url || it.pictures?.[0]?.url || it.thumbnail) };
  const pr = await get(`/products/${id}`);
  if (pr && pr.name) return { nome: pr.name, preco: pr.buy_box_winner?.price ?? null, url: pr.permalink || null, imagem: httpsImg(pr.pictures?.[0]?.url) };
  return null;
}
// autoteste opcional ao iniciar: ML_SELFTEST=MLB123 escreve no log se a API respondeu (sem mostrar chaves)
if (process.env.ML_SELFTEST) setTimeout(() => mlLookup(process.env.ML_SELFTEST, true)
  .then((o) => console.log("[ml] autoteste:", o ? JSON.stringify({ nome: o.nome, preco: o.preco, foto: !!o.imagem }) : "sem dados"))
  .catch((e) => console.log("[ml] autoteste falhou:", e.message)), 4000);


app.get("/api/link-preview", auth, wrap(async (req, res) => {
  const raw = String(req.query.url || "");
  let out = { nome: null, imagem: null, preco: null, url: raw };
  try { out = await linkPreview(raw); } catch (e) { if (e.status === 400) throw e; }
  // Mercado Livre: a página costuma ser barrada; com credenciais, usa a API pelo código do anúncio
  const mlId = mlIdFrom(raw) || mlIdFrom(out.url);
  if (!out.nome && mlId) {
    const viaApi = await mlLookup(mlId).catch(() => null);
    if (viaApi) out = { ...viaApi, url: viaApi.url || raw.split("#")[0] };
  }
  res.json(out);
}));

app.get("/api/extract-image", auth, wrap(async (req, res) => {
  const out = await linkPreview(req.query.url).catch(() => ({}));
  res.json({ imagem: out.imagem || null });
}));

// Mercado Livre — exige credenciais (ML_CLIENT_ID/ML_CLIENT_SECRET) desde 2025
let mlToken = { value: null, exp: 0 };
async function getMlToken() {
  if (mlToken.value && mlToken.exp > now()) return mlToken.value;
  const { ML_CLIENT_ID: id, ML_CLIENT_SECRET: secret, ML_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret) return null;
  const body = new URLSearchParams(refresh
    ? { grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: refresh }
    : { grant_type: "client_credentials", client_id: id, client_secret: secret });
  const r = await fetch("https://api.mercadolibre.com/oauth/token", { method: "POST", body, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!r.ok) throw bad("Falha ao autenticar no Mercado Livre.", 502);
  mlToken = { value: j.access_token, exp: now() + (j.expires_in - 60) * 1000 };
  return mlToken.value;
}

app.get("/api/preco", auth, wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 120);
  const itemId = String(req.query.item_id || "");
  if (!q) throw bad("Busca vazia.");
  if (itemId && !db.prepare("SELECT 1 FROM items WHERE id=? AND house_id=?").get(itemId, req.houseId)) throw bad("Item não encontrado.", 404);
  const token = await getMlToken();
  if (!token) throw bad("Busca de preço ainda não configurada (Mercado Livre).", 503);
  const r = await fetch(`https://api.mercadolibre.com/sites/MLB/search?limit=8&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw bad("Mercado Livre não respondeu.", 502);
  const j = await r.json();
  const ofertas = (j.results || [])
    .filter((x) => x.price)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5)
    .map((x) => ({
      loja: x.official_store_name || x.seller?.nickname || "Mercado Livre",
      titulo: x.title,
      preco: x.price,
      precoTexto: x.price.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      link: x.permalink,
      imagem: (x.thumbnail || "").replace(/^http:/, "https:").replace(/-I\.jpg$/, "-O.jpg"),
    }));
  if (itemId) {
    const ins = db.prepare("INSERT INTO price_history (item_id,loja,preco,created_at) VALUES (?,?,?,?)");
    db.transaction(() => ofertas.forEach((o) => ins.run(itemId, o.loja, o.preco, now())))();
  }
  const historico = itemId
    ? db.prepare("SELECT loja, preco, created_at AS data FROM price_history WHERE item_id=? ORDER BY created_at DESC LIMIT 60").all(itemId)
    : [];
  res.json({ ofertas, historico });
}));


// =====================================================================
// Backup
// =====================================================================
const fs = require("fs");
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "casa.sqlite");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), "backups");
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;

// cópia diária do banco inteiro em backups/casa-AAAA-MM-DD.sqlite (guarda as últimas 14)
function dailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `casa-${new Date().toISOString().slice(0, 10)}.sqlite`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log("[backup] salvo", path.basename(file));
    }
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^casa-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse().slice(BACKUP_KEEP);
    old.forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error("[backup] falhou:", e.message); }
}
setTimeout(dailyBackup, 10_000);
setInterval(dailyBackup, 60 * 60 * 1000); // confere de hora em hora; grava 1 por dia

// exportar a casa ativa em JSON (pra guardar fora do servidor)
app.get("/api/backup/export", auth, (req, res) => {
  const house = db.prepare("SELECT name FROM houses WHERE id=?").get(req.houseId);
  const data = {
    app: "casa-lista", version: 1, exported_at: new Date().toISOString(),
    house: { name: house.name },
    rooms: db.prepare("SELECT name, sort_order FROM rooms WHERE house_id=? ORDER BY sort_order").all(req.houseId),
    items: db.prepare(`SELECT name, room, qty, price, url, image, notes, priority, bought, bought_at, sort_order, created_at
      FROM items WHERE house_id=? ORDER BY sort_order`).all(req.houseId),
    historico: db.prepare("SELECT nome, room, qty, preco, data_compra FROM historico WHERE house_id=?").all(req.houseId),
  };
  const nome = house.name.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "casa";
  res.set("Content-Disposition", `attachment; filename="backup-${nome}-${data.exported_at.slice(0, 10)}.json"`);
  res.json(data);
});

// importar um JSON exportado: soma à casa ativa (não apaga nada; pula itens idênticos)
app.post("/api/backup/import", auth, wrap(async (req, res) => {
  const d = req.body || {};
  if (d.app !== "casa-lista" || !Array.isArray(d.items)) throw bad("Arquivo de backup inválido.");
  let rooms = 0, items = 0, hist = 0;
  db.transaction(() => {
    const hasRoom = db.prepare("SELECT 1 FROM rooms WHERE house_id=? AND name=? COLLATE NOCASE");
    let order = db.prepare("SELECT COALESCE(MAX(sort_order),-1) m FROM rooms WHERE house_id=?").get(req.houseId).m;
    const addRoom = db.prepare("INSERT INTO rooms (id,house_id,name,sort_order) VALUES (?,?,?,?)");
    const roomNames = [...(d.rooms || []).map((r) => r.name), ...d.items.map((i) => i.room)];
    for (const n of roomNames) {
      const name = String(n || "").trim().slice(0, 40);
      if (name && !hasRoom.get(req.houseId, name)) { addRoom.run(uid(), req.houseId, name, ++order); rooms++; }
    }
    const dup = db.prepare("SELECT 1 FROM items WHERE house_id=? AND name=? AND room=? AND bought=?");
    const addItem = db.prepare(`INSERT INTO items (id,house_id,name,room,qty,price,url,image,notes,priority,bought,bought_at,sort_order,created_by,created_at)
      VALUES (@id,@house_id,@name,@room,@qty,@price,@url,@image,@notes,@priority,@bought,@bought_at,@sort_order,@created_by,@created_at)`);
    for (const raw of d.items) {
      const o = cleanItem(raw, false);
      const bought = raw.bought ? 1 : 0;
      if (dup.get(req.houseId, o.name, o.room, bought)) continue;
      addItem.run({ ...o, id: uid(), house_id: req.houseId, bought, bought_at: bought ? Number(raw.bought_at) || now() : null,
        sort_order: Number(raw.sort_order) || 0, created_by: req.userId, created_at: Number(raw.created_at) || now() });
      items++;
    }
    const addHist = db.prepare("INSERT INTO historico (id,house_id,nome,room,qty,preco,data_compra) VALUES (?,?,?,?,?,?,?)");
    const dupHist = db.prepare("SELECT 1 FROM historico WHERE house_id=? AND nome=? AND data_compra=?");
    for (const h of d.historico || []) {
      const nome = String(h.nome || "").trim().slice(0, 120);
      const data = Number(h.data_compra) || now();
      if (!nome || dupHist.get(req.houseId, nome, data)) continue;
      const preco = Number(h.preco);
      addHist.run(uid(), req.houseId, nome, String(h.room || "Geral").slice(0, 40), Math.max(1, parseInt(h.qty) || 1), Number.isFinite(preco) ? preco : null, data);
      hist++;
    }
  })();
  logActivity(req, "importou backup", `${items} item(ns)`);
  broadcast(req.houseId);
  res.json({ ok: true, rooms, items, historico: hist });
}));

// =====================================================================
// Front
// =====================================================================
app.get("/demo", (req, res) => res.sendFile(path.join(__dirname, "public", "demo.html")));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, p) => { if (/\.(html|js)$/.test(p) || p.endsWith("manifest.json")) res.set("Cache-Control", "no-cache"); },
}));
app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada" }));

app.listen(PORT, () => console.log(`Casa Lista rodando na porta ${PORT}`));
