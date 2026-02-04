require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { randomUUID: uuidv4 } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configuração do Multer (Upload temporário)
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
});

setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) console.error("Ping Error:", err.code);
  });
}, 30000);

function checkAuth(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (password !== process.env.ADMIN_PASS)
    return res.status(401).json({ message: "Senha incorreta!" });
  next();
}

// --- ROTAS PÚBLICAS ---

// Listar Depoimentos Aprovados (Para o Index)
app.get("/api/depoimentos/publicos", (req, res) => {
  const sql = `
        SELECT d.*, GROUP_CONCAT(f.url_foto) as fotos 
        FROM depoimentos d 
        LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id 
        WHERE d.aprovado = TRUE 
        GROUP BY d.id 
        ORDER BY d.data_criacao DESC LIMIT 10`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json(err);
    const formatado = results.map((r) => ({
      ...r,
      fotos: r.fotos ? r.fotos.split(",") : [],
    }));
    res.json(formatado);
  });
});

// Receber Avaliação do Cliente
app.post("/api/feedback/:token", upload.array("fotos", 5), async (req, res) => {
  const token = req.params.token;
  const { nota, texto } = req.body;

  // Validar token e pegar ID do orçamento
  db.query(
    "SELECT id, nome FROM orcamentos WHERE token_avaliacao = ?",
    [token],
    async (err, result) => {
      if (err || result.length === 0)
        return res.status(404).json({ error: "Token inválido" });

      const orcamentoId = result[0].id;
      const nomeCliente = result[0].nome;

      try {
        // 1. Salvar Depoimento
        const insertDep = await db
          .promise()
          .query(
            "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota) VALUES (?, ?, ?, ?)",
            [orcamentoId, nomeCliente, texto.substring(0, 350), nota],
          );
        const depoimentoId = insertDep[0].insertId;

        // 2. Upload Fotos para Cloudinary
        if (req.files && req.files.length > 0) {
          for (const file of req.files) {
            const uploadRes = await cloudinary.uploader.upload(file.path, {
              folder: "cabana_de_brincar/fotos_depoimento",
            });
            await db
              .promise()
              .query(
                "INSERT INTO fotos_depoimento (depoimento_id, url_foto) VALUES (?, ?)",
                [depoimentoId, uploadRes.secure_url],
              );
            fs.unlinkSync(file.path); // Limpa temp
          }
        }

        // Invalida o token para não usar de novo (opcional)
        // await db.promise().query("UPDATE orcamentos SET token_avaliacao = NULL WHERE id = ?", [orcamentoId]);

        res.json({ success: true });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erro ao processar" });
      }
    },
  );
});

// --- ROTAS ADMIN ---

// Gerar Token de Avaliação
app.post("/api/admin/gerar-token/:id", checkAuth, (req, res) => {
  const token = uuidv4();
  db.query(
    "UPDATE orcamentos SET token_avaliacao = ? WHERE id = ?",
    [token, req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({
        token,
        link: `${req.protocol}://${req.get("host")}/feedback.html?t=${token}`,
      });
    },
  );
});

// Mover para Agenda (Aprovar Orçamento)
app.put("/api/admin/agenda/aprovar/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE orcamentos SET status_agenda = 'agendado', status = 'aprovado' WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

// Concluir Serviço (Lançar para Serviços Concluídos)
app.put("/api/admin/agenda/concluir/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE orcamentos SET status_agenda = 'concluido' WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

// Salvar Custos da Festa
app.post("/api/admin/financeiro/festa/:id", checkAuth, (req, res) => {
  const { descricao, valor } = req.body;
  db.query(
    "INSERT INTO custos_festa (orcamento_id, descricao, valor) VALUES (?, ?, ?)",
    [req.params.id, descricao, valor],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

// Salvar Custo Geral (Financeiro)
app.post("/api/admin/financeiro/geral", checkAuth, (req, res) => {
  const { titulo, tipo, valor } = req.body;
  db.query(
    "INSERT INTO custos_gerais (titulo, tipo, valor) VALUES (?, ?, ?)",
    [titulo, tipo, valor],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

// Listar Agenda
app.get("/api/admin/agenda", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos WHERE status_agenda = 'agendado' ORDER BY data_festa ASC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    },
  );
});

// Listar Financeiro Completo
app.get("/api/admin/financeiro/relatorio", checkAuth, async (req, res) => {
  try {
    const [gerais] = await db
      .promise()
      .query("SELECT * FROM custos_gerais ORDER BY data_registro DESC");
    const [festas] = await db.promise().query(`
            SELECT cf.*, o.nome as nome_cliente, o.data_festa 
            FROM custos_festa cf 
            JOIN orcamentos o ON cf.orcamento_id = o.id
        `);
    const [faturamento] = await db
      .promise()
      .query(
        "SELECT id, nome, valor_final, data_festa FROM orcamentos WHERE status_agenda = 'concluido'",
      );

    res.json({ gerais, festas, faturamento });
  } catch (e) {
    res.status(500).json(e);
  }
});

// Listar Avaliações Admin
app.get("/api/admin/avaliacoes", checkAuth, (req, res) => {
  const sql = `
        SELECT d.*, o.data_festa 
        FROM depoimentos d 
        LEFT JOIN orcamentos o ON d.orcamento_id = o.id 
        ORDER BY d.data_criacao DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// Moderar Avaliação (Editar/Excluir/Ocultar)
app.put("/api/admin/avaliacoes/:id", checkAuth, (req, res) => {
  const { texto, aprovado } = req.body;
  db.query(
    "UPDATE depoimentos SET texto = ?, aprovado = ? WHERE id = ?",
    [texto, aprovado, req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

app.delete("/api/admin/avaliacoes/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM depoimentos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

// Rotas Antigas Essenciais (Mantidas)
app.get("/api/itens-disponiveis", (req, res) => {
  db.query(
    "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') ORDER BY categoria, descricao",
    (err, results) => {
      if (err) return res.status(500).json([]);
      res.json(results);
    },
  );
});

app.post("/api/orcamento", (req, res) => {
  const data = req.body;
  const sql = `INSERT INTO orcamentos (nome, whatsapp, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
    JSON.stringify(data.itens_padrao),
    data.itens_adicionais,
    data.data_festa,
    data.horario,
    JSON.stringify(data.alimentacao),
    data.alergias,
  ];
  db.query(sql, values, (err) => {
    if (err) return res.status(500).json({ error: err });
    res.status(201).json({ success: true });
  });
});

app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos ORDER BY data_pedido DESC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    },
  );
});

app.put("/api/admin/pedidos/:id/financeiro", checkAuth, (req, res) => {
  const { valor_final, valor_itens_extras, descricao_itens_extras } = req.body;
  db.query(
    "UPDATE orcamentos SET valor_final = ?, valor_itens_extras = ?, descricao_itens_extras = ? WHERE id = ?",
    [valor_final, valor_itens_extras, descricao_itens_extras, req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    },
  );
});

app.get("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (err, r) => res.json(r),
  );
});
app.post("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)",
    [
      "custom_" + Date.now(),
      req.body.descricao,
      req.body.valor,
      req.body.categoria,
    ],
    (e) => res.json({ success: true }),
  );
});
app.put("/api/admin/precos/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE tabela_precos SET valor = ? WHERE id = ?",
    [req.body.valor, req.params.id],
    (e) => res.json({ success: true }),
  );
});
app.delete("/api/admin/precos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: true }),
  );
});

app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));
