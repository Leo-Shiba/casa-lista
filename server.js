require("dotenv").config();
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const CASA_CODE = process.env.CASA_CODE || "nossacasa";

// ---- banco ----
const db = new Database(path.join(__dirname, "casa.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS itens (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    room       TEXT DEFAULT 'Geral',
    price      REAL,
    url        TEXT,
    image      TEXT,
    bought     INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);

const q = {
  all: db.prepare("SELECT * FROM itens ORDER BY created_at DESC"),
  insert: db.prepare(
    "INSERT INTO itens (id,name,room,price,url,image,bought,created_at) VALUES (@id,@name,@room,@price,@url,@image,@bought,@created_at)"
  ),
  update: db.prepare(
    "UPDATE itens SET name=@name, room=@room, price=@price, url=@url, image=@image, bought=@bought WHERE id=@id"
  ),
  get: db.prepare("SELECT * FROM itens WHERE id=?"),
  del: db.prepare("DELETE FROM itens WHERE id=?"),
};

app.use(express.json());

// ---- auth simples por código da casa ----
function auth(req, res, next) {
  const code = req.get("x-casa-code");
  if (code !== CASA_CODE) return res.status(401).json({ erro: "Código incorreto" });
  next();
}

// valida o código (usado pela tela de entrada)
app.post("/api/login", (req, res) => {
  if (req.body?.codigo === CASA_CODE) return res.json({ ok: true });
  res.status(401).json({ erro: "Código incorreto" });
});

// ---- API da lista (tudo protegido) ----
app.get("/api/items", auth, (req, res) => {
  res.json(q.all.all().map((i) => ({ ...i, bought: !!i.bought })));
});

app.post("/api/items", auth, (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ erro: "Nome obrigatório" });
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
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
  const cur = q.get.get(req.params.id);
  if (!cur) return res.status(404).json({ erro: "Não encontrado" });
  const b = req.body || {};
  const next = {
    id: cur.id,
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
  q.del.run(req.params.id);
  res.json({ ok: true });
});

// ---- front ----
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Casa Lista rodando na porta ${PORT}`));
