require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { randomUUID: uuidv4 } = require("crypto");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

// Manter a conexão ativa
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

// --- AUXILIAR MERCADO PAGO ---
async function criarLinkMP(titulo, valor, pedidoId) {
  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: titulo,
            unit_price: Number(valor),
            quantity: 1,
            currency_id: "BRL",
          },
        ],
        external_reference: String(pedidoId), // ID para o Webhook identificar o pedido
        payment_methods: {
          excluded_payment_types: [],
          installments: 12,
        },
        back_urls: {
          success: `https://${process.env.DOMAIN}/sucesso.html`,
          failure: `https://${process.env.DOMAIN}/erro.html`,
        },
        auto_return: "approved",
        notification_url: `https://${process.env.DOMAIN}/api/webhook`, // URL de notificação do Webhook
      },
    });
    return result.init_point;
  } catch (err) {
    console.error("Erro MP:", err);
    return null;
  }
}

// --- WEBHOOK MERCADO PAGO ---
app.post("/api/webhook", async (req, res) => {
  const { query } = req;
  if (query.type === "payment" || query.topic === "payment") {
    const paymentId = query.id || query["data.id"];
    try {
      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
        },
      );
      const paymentData = await response.json();

      if (paymentData.status === "approved") {
        const pedidoId = paymentData.external_reference;
        // Atualiza o status_pagamento para 'pago'
        db.query(
          "UPDATE orcamentos SET status_pagamento = 'pago' WHERE id = ?",
          [pedidoId],
        );
      }
    } catch (e) {
      console.error("Webhook Error:", e);
    }
  }
  res.sendStatus(200);
});

// --- ROTAS PÚBLICAS ---

app.get("/api/itens-disponiveis", (req, res) => {
  db.query(
    "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') AND disponivel = TRUE ORDER BY categoria, descricao",
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

app.get("/api/depoimentos/publicos", (req, res) => {
  const sql = `SELECT d.*, GROUP_CONCAT(f.url_foto) as fotos FROM depoimentos d LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id WHERE d.aprovado = TRUE GROUP BY d.id ORDER BY d.data_criacao DESC LIMIT 10`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json(err);
    const formatado = results.map((r) => ({
      ...r,
      fotos: r.fotos ? r.fotos.split(",") : [],
    }));
    res.json(formatado);
  });
});

app.get("/api/feedback/:token", (req, res) => {
  const token = req.params.token;
  db.query(
    "SELECT id, nome FROM orcamentos WHERE token_avaliacao = ?",
    [token],
    (err, results) => {
      if (err) return res.status(500).json({ error: "Erro interno" });
      if (results.length === 0)
        return res.status(404).json({ error: "Token inválido ou expirado" });
      res.json(results[0]);
    },
  );
});

app.post("/api/feedback/:token", upload.array("fotos", 6), async (req, res) => {
  const token = req.params.token;
  const { nota, texto } = req.body;
  db.query(
    "SELECT id, nome FROM orcamentos WHERE token_avaliacao = ?",
    [token],
    async (err, result) => {
      if (err || result.length === 0)
        return res.status(404).json({ error: "Token inválido" });
      const orcamentoId = result[0].id;
      const nomeCliente = result[0].nome;
      try {
        const insertDep = await db
          .promise()
          .query(
            "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota, aprovado) VALUES (?, ?, ?, ?, 0)",
            [orcamentoId, nomeCliente, texto.substring(0, 350), nota],
          );
        const depoimentoId = insertDep[0].insertId;
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
            fs.unlinkSync(file.path);
          }
        }
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: "Erro ao processar" });
      }
    },
  );
});

// --- ROTAS ADMIN ---

app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos ORDER BY data_pedido DESC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    },
  );
});

// Geração de links Mercado Pago
app.post("/api/admin/gerar-links-mp/:id", checkAuth, (req, res) => {
  db.query(
    "SELECT valor_final, nome FROM orcamentos WHERE id = ?",
    [req.params.id],
    async (err, results) => {
      if (err || results.length === 0)
        return res.status(404).json({ error: "Pedido não encontrado" });
      const vTotal = parseFloat(results[0].valor_final || 0);
      if (vTotal <= 0)
        return res
          .status(400)
          .json({ error: "Defina o valor final antes de gerar links" });

      const linkReserva = await criarLinkMP(
        `Reserva (40%) - ${results[0].nome}`,
        (vTotal * 0.4).toFixed(2),
        req.params.id,
      );
      const linkIntegral = await criarLinkMP(
        `Total (5% desc) - ${results[0].nome}`,
        (vTotal * 0.95).toFixed(2),
        req.params.id,
      );

      res.json({
        reserva: (vTotal * 0.4).toFixed(2),
        linkReserva,
        integral: (vTotal * 0.95).toFixed(2),
        linkIntegral,
        restante: (vTotal * 0.6).toFixed(2),
      });
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

app.get("/api/admin/agenda", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos WHERE status_agenda = 'agendado' ORDER BY data_festa ASC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    },
  );
});

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

app.delete("/api/admin/pedidos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: "Erro ao excluir" });
    res.json({ success: true });
  });
});

// --- GESTÃO DE PREÇOS ---

app.get("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (err, r) => res.json(r),
  );
});

app.post("/api/admin/precos", checkAuth, (req, res) => {
  const { descricao, valor, categoria } = req.body;
  db.query(
    "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)",
    ["custom_" + Date.now(), descricao, valor, categoria],
    (e) => res.json({ success: true }),
  );
});

app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));
