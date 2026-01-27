// ARQUIVO: server.js
// 1. Carrega as variáveis de ambiente
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações do Express
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public")); // Serve os arquivos do site

// --- CONEXÃO BLINDADA COM O BANCO MYSQL (POOL) ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5, // Limite conservador para não sobrecarregar
  queueLimit: 0,
  enableKeepAlive: true, // Mantém a conexão viva
  keepAliveInitialDelay: 0,
  testOnBorrow: true, // Testa se a conexão está ativa antes de usar
});

// Sistema de "Ping" para evitar que o banco remoto derrube a conexão por inatividade
setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) console.error("⚠️ Keep-Alive Error:", err.code);
  });
}, 30000); // Executa a cada 30 segundos

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
function checkAuth(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (password !== process.env.ADMIN_PASS) {
    return res.status(401).json({ message: "Senha incorreta!" });
  }
  next();
}

// ==========================================
//              ROTAS PÚBLICAS
// ==========================================

// 1. Listar Fotos da Galeria
app.get("/api/fotos", (req, res) => {
  const directoryPath = path.join(__dirname, "public", "fotos");

  if (!fs.existsSync(directoryPath)) return res.json([]);

  fs.readdir(directoryPath, (err, files) => {
    if (err) return res.json([]);
    const fotos = files.filter((file) =>
      [".jpg", ".jpeg", ".png", ".webp"].includes(
        path.extname(file).toLowerCase(),
      ),
    );
    res.json(fotos.map((foto) => `fotos/${foto}`));
  });
});

// 2. Listar Itens Disponíveis (Para preencher o formulário do site)
app.get("/api/itens-disponiveis", (req, res) => {
  // Busca categorias relevantes para o cliente final
  const sql =
    "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') ORDER BY categoria, descricao";

  db.query(sql, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json([]);
    }
    res.json(results);
  });
});

// 3. Salvar Novo Pedido de Orçamento
app.post("/api/orcamento", (req, res) => {
  const data = req.body;

  const sql = `
        INSERT INTO orcamentos (
            nome, whatsapp, endereco, qtd_criancas, faixa_etaria,
            modelo_barraca, qtd_barracas, cores, tema, 
            itens_padrao, itens_adicionais, data_festa, horario, 
            alimentacao, alergias
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

  const values = [
    data.nome,
    data.whatsapp,
    data.endereco,
    data.qtd_criancas,
    data.faixa_etaria,
    data.modelo_barraca,
    data.qtd_barracas,
    data.cores,
    data.tema,
    JSON.stringify(data.itens_padrao), // Array -> JSON String
    data.itens_adicionais,
    data.data_festa,
    data.horario,
    JSON.stringify(data.alimentacao), // Array -> JSON String
    data.alergias,
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("Erro ao salvar pedido:", err);
      return res.status(500).json({ error: err });
    }
    res.status(201).json({ success: true });
  });
});

// ==========================================
//           ROTAS DO PAINEL (ADMIN)
// ==========================================

// 4. Listar Todos os Pedidos
app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos ORDER BY data_pedido DESC",
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      res.json(results);
    },
  );
});

// 5. Alterar Status (Pendente/Concluido) + Salvar valores finais se concluir
app.put("/api/admin/pedidos/:id/status", checkAuth, (req, res) => {
  const { status, valor_final, valor_itens_extras, descricao_itens_extras } =
    req.body;
  const id = req.params.id;

  let sql = "UPDATE orcamentos SET status = ? WHERE id = ?";
  let params = [status, id];

  // Se estiver concluindo e enviou valores, atualiza tudo junto
  if (status === "concluido" && valor_final !== undefined) {
    sql = `
            UPDATE orcamentos 
            SET status = ?, valor_final = ?, valor_itens_extras = ?, descricao_itens_extras = ? 
            WHERE id = ?
        `;
    params = [
      status,
      valor_final,
      valor_itens_extras,
      descricao_itens_extras,
      id,
    ];
  }

  db.query(sql, params, (err) => {
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  });
});

// 6. Atualizar Dados Financeiros (Botão Salvar do Painel)
app.put("/api/admin/pedidos/:id/financeiro", checkAuth, (req, res) => {
  const { valor_final, custos, valor_itens_extras, descricao_itens_extras } =
    req.body;
  const id = req.params.id;

  const sql = `
        UPDATE orcamentos 
        SET valor_final = ?, custos = ?, valor_itens_extras = ?, descricao_itens_extras = ? 
        WHERE id = ?
    `;

  db.query(
    sql,
    [valor_final, custos, valor_itens_extras, descricao_itens_extras, id],
    (err) => {
      if (err) return res.status(500).json({ error: err });
      res.json({ success: true });
    },
  );
});

// 7. Deletar Pedido
app.delete("/api/admin/pedidos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  });
});

// ==========================================
//        ROTAS DE PREÇOS (CRUD COMPLETO)
// ==========================================

// 8. Listar Todos os Preços
app.get("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      res.json(results);
    },
  );
});

// 9. Atualizar Valor de um Item Existente
app.put("/api/admin/precos/:id", checkAuth, (req, res) => {
  const { valor } = req.body;
  const id = req.params.id;

  db.query(
    "UPDATE tabela_precos SET valor = ? WHERE id = ?",
    [valor, id],
    (err) => {
      if (err) return res.status(500).json({ error: err });
      res.json({ success: true });
    },
  );
});

// 10. Criar Novo Item de Preço
app.post("/api/admin/precos", checkAuth, (req, res) => {
  const { descricao, valor, categoria } = req.body;
  // Gera uma chave única baseada no tempo para uso interno
  const item_chave = "custom_" + Date.now();

  const sql =
    "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)";

  db.query(sql, [item_chave, descricao, valor, categoria], (err) => {
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  });
});

// 11. Deletar Item de Preço
app.delete("/api/admin/precos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  });
});

// Inicia o Servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
