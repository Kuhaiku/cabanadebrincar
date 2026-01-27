require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// --- CONEXÃO (POOL) ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  enableKeepAlive: true,
  testOnBorrow: true,
});

setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) console.error(err);
  });
}, 30000);

function checkAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== process.env.ADMIN_PASS)
    return res.status(401).json({ message: "Senha incorreta!" });
  next();
}

// --- ROTAS PÚBLICAS ---

app.get("/api/fotos", (req, res) => {
  const dir = path.join(__dirname, "public", "fotos");
  if (!fs.existsSync(dir)) return res.json([]);
  fs.readdir(dir, (err, files) => {
    if (err) return res.json([]);
    const fotos = files.filter((f) =>
      [".jpg", ".jpeg", ".png", ".webp"].includes(
        path.extname(f).toLowerCase(),
      ),
    );
    res.json(fotos.map((f) => `fotos/${f}`));
  });
});

// NOVA ROTA PÚBLICA: Carregar itens para o formulário do cliente
app.get("/api/itens-disponiveis", (req, res) => {
  // Pega tudo que não é configuração interna do sistema (preços base)
  db.query(
    "SELECT descricao, categoria FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao')",
    (err, results) => {
      if (err) return res.status(500).json([]);
      res.json(results);
    },
  );
});

app.post("/api/orcamento", (req, res) => {
  const d = req.body;
  const sql = `INSERT INTO orcamentos (nome, whatsapp, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const v = [
    d.nome,
    d.whatsapp,
    d.endereco,
    d.qtd_criancas,
    d.faixa_etaria,
    d.modelo_barraca,
    d.qtd_barracas,
    d.cores,
    d.tema,
    JSON.stringify(d.itens_padrao),
    d.itens_adicionais,
    d.data_festa,
    d.horario,
    JSON.stringify(d.alimentacao),
    d.alergias,
  ];
  db.query(sql, v, (err) => {
    if (err) return res.status(500).json({ error: err });
    res.status(201).json({ success: true });
  });
});

// --- ROTAS ADMIN ---

app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query("SELECT * FROM orcamentos ORDER BY data_pedido DESC", (err, r) => {
    if (err) return res.status(500).json({});
    res.json(r);
  });
});

app.put("/api/admin/pedidos/:id/status", checkAuth, (req, res) => {
  const { status, valor_final, valor_itens_extras, descricao_itens_extras } =
    req.body;
  let sql = "UPDATE orcamentos SET status = ? WHERE id = ?";
  let params = [status, req.params.id];
  if (status === "concluido" && valor_final !== undefined) {
    sql =
      "UPDATE orcamentos SET status = ?, valor_final = ?, valor_itens_extras = ?, descricao_itens_extras = ? WHERE id = ?";
    params = [
      status,
      valor_final,
      valor_itens_extras,
      descricao_itens_extras,
      req.params.id,
    ];
  }
  db.query(sql, params, (err) => {
    if (err) return res.status(500).json({});
    res.json({ success: true });
  });
});

app.put("/api/admin/pedidos/:id/financeiro", checkAuth, (req, res) => {
  const { valor_final, custos, valor_itens_extras, descricao_itens_extras } =
    req.body;
  db.query(
    "UPDATE orcamentos SET valor_final = ?, custos = ?, valor_itens_extras = ?, descricao_itens_extras = ? WHERE id = ?",
    [
      valor_final,
      custos,
      valor_itens_extras,
      descricao_itens_extras,
      req.params.id,
    ],
    (err) => {
      if (err) return res.status(500).json({});
      res.json({ success: true });
    },
  );
});

app.delete("/api/admin/pedidos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({});
    res.json({ success: true });
  });
});

// --- GERENCIAMENTO DE PREÇOS (CRUD COMPLETO) ---

app.get("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (err, r) => {
      if (err) return res.status(500).json({});
      res.json(r);
    },
  );
});

// Atualizar valor existente
app.put("/api/admin/precos/:id", checkAuth, (req, res) => {
  const { valor } = req.body;
  db.query(
    "UPDATE tabela_precos SET valor = ? WHERE id = ?",
    [valor, req.params.id],
    (err) => {
      if (err) return res.status(500).json({});
      res.json({ success: true });
    },
  );
});

// Criar NOVO item
app.post("/api/admin/precos", checkAuth, (req, res) => {
  const { descricao, valor, categoria } = req.body;
  // Gera uma chave única simples baseada no nome
  const item_chave = "custom_" + Date.now();
  db.query(
    "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)",
    [item_chave, descricao, valor, categoria],
    (err) => {
      if (err) return res.status(500).json({});
      res.json({ success: true });
    },
  );
});

// Deletar item
app.delete("/api/admin/precos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({});
    res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`✅ Server: http://localhost:${PORT}`));
