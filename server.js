require("dotenv").config();
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-troque-em-producao";

// ---- banco ----
const db = new Database(path.join(__dirname, "casa.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS itens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    room       TEXT DEFAULT 'Geral',
    price      REAL,
    url        TEXT,
    image      TEXT,
    bought     INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const q = {
  userByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  insertUser:     db.prepare("INSERT INTO users (id,username,password_hash,created_at) VALUES (@id,@username,@password_hash,@created_at)"),
  all:    db.prepare("SELECT * FROM itens WHERE user_id = ? ORDER BY created_at DESC"),
  insert: db.prepare("INSERT INTO itens (id,user_id,name,room,price,url,image,bought,created_at) VALUES (@id,@user_id,@name,@room,@price,@url,@image,@bought,@created_at)"),
  update: db.prepare("UPDATE itens SET name=@name, room=@room, price=@price, url=@url, image=@image, bought=@bought WHERE id=@id AND user_id=@user_id"),
  get:    db.prepare("SELECT * FROM itens WHERE id=? AND user_id=?"),
  del:    db.prepare("DELETE FROM itens WHERE id=? AND user_id=?"),
};

app.use(express.json());

// ---- auth middleware ----
function auth(req, res, next) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ erro: "Não autorizado" });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch {
    res.status(401).json({ erro: "Token inválido ou expirado" });
  }
}

// ---- rotas de auth ----
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ erro: "Usuário e senha obrigatórios" });
  if (username.trim().length < 3) return res.status(400).json({ erro: "Usuário deve ter ao menos 3 caracteres" });
  if (password.length < 6) return res.status(400).json({ erro: "Senha deve ter ao menos 6 caracteres" });

  const existing = q.userByUsername.get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ erro: "Usuário já existe" });

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uid(), username: username.trim().toLowerCase(), password_hash: hash, created_at: Date.now() };
  q.insertUser.run(user);

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, username: user.username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ erro: "Usuário e senha obrigatórios" });

  const user = q.userByUsername.get(username.trim().toLowerCase());
  if (!user) return res.status(401).json({ erro: "Usuário ou senha incorretos" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ erro: "Usuário ou senha incorretos" });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, username: user.username });
});

// ---- API da lista (protegida por JWT) ----
app.get("/api/items", auth, (req, res) => {
  res.json(q.all.all(req.userId).map((i) => ({ ...i, bought: !!i.bought })));
});

app.post("/api/items", auth, (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ erro: "Nome obrigatório" });
  const item = {
    id: uid(),
    user_id: req.userId,
    name: b.name.trim(),
    room: b.room || "Geral",
    price: b.price ?? null,
    url: b.url || "",
    image: b.image || "",
    bought: 0,
    created_at: Date.now(),
  };
  q.insert.run(item);
  res.json({ ...item, bought: false });
});

app.put("/api/items/:id", auth, (req, res) => {
  const cur = q.get.get(req.params.id, req.userId);
  if (!cur) return res.status(404).json({ erro: "Não encontrado" });
  const b = req.body || {};
  const next = {
    id: cur.id,
    user_id: req.userId,
    name: (b.name ?? cur.name).trim() || cur.name,
    room: b.room ?? cur.room,
    price: b.price !== undefined ? b.price : cur.price,
    url: b.url ?? cur.url,
    image: b.image ?? cur.image,
    bought: b.bought !== undefined ? (b.bought ? 1 : 0) : cur.bought,
  };
  q.update.run(next);
  res.json({ ...next, bought: !!next.bought });
});

app.delete("/api/items/:id", auth, (req, res) => {
  q.del.run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- front ----
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Casa Lista rodando na porta ${PORT}`));
