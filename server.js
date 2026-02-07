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
const venom = require("venom-bot");

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURAÇÕES ---

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

// Mantém o banco vivo
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

// --- 2. INICIALIZAÇÃO DO ROBÔ WHATSAPP (CORRIGIDO) ---

// >>> LIMPEZA DE SESSÃO ANTIGA (Evita erro SingletonLock) <<<
const sessionDir = path.resolve(__dirname, 'tokens');
if (fs.existsSync(sessionDir)) {
    console.log("🧹 Limpando sessão antiga do WhatsApp para evitar conflitos...");
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) {
        console.log("⚠️ Aviso: Não foi possível limpar a pasta tokens (pode estar em uso).");
    }
}
// ------------------------------------------------------------

let whatsappClient = null;

venom
  .create(
    "sessao-cabana",
    (base64Qr, asciiQR) => {
      console.log("\n📷 ESCANEIE O QR CODE ABAIXO:\n");
      console.log(asciiQR);
    },
    (statusSession, session) => {
      console.log("Status Sessão WhatsApp:", statusSession);
    },
    {
      headless: "new",
      useChrome: false,
      logQR: false,
      disableWelcome: true,
      disableSpins: true,
      updatesLog: false,
      autoClose: false,
      browserArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  )
  .then((client) => {
    console.log("✅ Robô do WhatsApp conectado e PRONTO!");
    whatsappClient = client;
  })
  .catch((erro) => {
    console.error("❌ Erro fatal ao iniciar o WhatsApp:", erro);
  });

// --- 3. FUNÇÕES AUXILIARES ---

async function criarLinkMP(titulo, valor, pedidoId) {
  try {
    const preference = new Preference(mpClient);

    let domain = process.env.DOMAIN || `localhost:${PORT}`;
    domain = domain.replace(/\/$/, "");
    if (!domain.startsWith("http")) domain = `https://${domain}`;

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
        external_reference: String(pedidoId),
        back_urls: {
          success: `${domain}/sucesso.html`,
          failure: `${domain}/index.html`,
        },
        auto_return: "approved",
        notification_url: `${domain}/api/webhook`,
      },
    });
    return result.init_point;
  } catch (err) {
    console.error("Erro MP:", err);
    return null;
  }
}

async function enviarWhatsappViaRobo(nome, telefone, valor, tentativa = 1) {
  if (!whatsappClient) {
    if (tentativa > 20) {
      console.log("❌ Robô demorou demais (>1min) para conectar. Desisti.");
      return;
    }
    console.log(
      `⏳ Robô carregando... Tentativa ${tentativa}/20 em 3 segundos.`,
    );
    setTimeout(() => {
      enviarWhatsappViaRobo(nome, telefone, valor, tentativa + 1);
    }, 3000);
    return;
  }

  let numeroLimpo = telefone.replace(/\D/g, "");
  if (numeroLimpo.length <= 11) numeroLimpo = `55${numeroLimpo}`;
  const chatId = `${numeroLimpo}@c.us`;

  const mensagem = `Olá *${nome}*! ⛺✨\n\nRecebemos a confirmação do seu pagamento de *R$ ${valor}* na Cabana de Brincar.\n\nSua reserva está garantida! 🎉\nEm breve entraremos em contato para combinar os detalhes.`;

  try {
    await whatsappClient.sendText(chatId, mensagem);
    console.log(`📱 Mensagem WhatsApp enviada para ${numeroLimpo}`);
  } catch (error) {
    console.error("Erro ao enviar WhatsApp:", error);
  }
}

// --- 4. WEBHOOK ---

app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");

  const notification = req.body || {};
  const query = req.query || {};
  const topic =
    notification.topic || notification.type || query.topic || query.type;
  const id =
    notification.data?.id || notification.id || query.id || query["data.id"];

  if (topic === "payment" && id) {
    try {
      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${id}`,
        {
          headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
        },
      );

      if (response.ok) {
        const paymentData = await response.json();

        if (paymentData.status === "approved") {
          const pedidoId = paymentData.external_reference;
          const valorPago = paymentData.transaction_amount;

          const dataPagamento = new Date(paymentData.date_approved);
          const dia = dataPagamento.getDate().toString().padStart(2, "0");
          const mes = (dataPagamento.getMonth() + 1)
            .toString()
            .padStart(2, "0");
          const hora = dataPagamento.getHours().toString().padStart(2, "0");
          const min = dataPagamento.getMinutes().toString().padStart(2, "0");

          db.query(
            "SELECT nome, whatsapp FROM orcamentos WHERE id = ?",
            [pedidoId],
            (err, results) => {
              if (!err && results.length > 0) {
                const cliente = results[0];

                console.log("\n");
                console.log("🟢 === PAGAMENTO CONFIRMADO! ===");
                console.log(`👤 Nome: ${cliente.nome}`);
                console.log(`📱 WhatsApp: ${cliente.whatsapp}`);
                console.log(`📅 Data: ${dia}/${mes} às ${hora}:${min}`);
                console.log("================================\n");

                db.query(
                  "UPDATE orcamentos SET status_pagamento = 'pago' WHERE id = ?",
                  [pedidoId],
                );

                enviarWhatsappViaRobo(
                  cliente.nome,
                  cliente.whatsapp,
                  valorPago,
                );
              }
            },
          );
        }
      }
    } catch (e) {
      console.error("Erro no Webhook:", e.message);
    }
  }
});

// --- 5. ROTAS DE API ---

app.get("/api/itens-disponiveis", (req, res) => {
  db.query(
    "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') AND disponivel = TRUE ORDER BY categoria, descricao",
    (err, r) => res.json(r || []),
  );
});

// >>> ROTA CORRIGIDA (EVITA ERRO 500) <<<
app.post("/api/orcamento", (req, res) => {
  const data = req.body;
  const sql = `INSERT INTO orcamentos (nome, whatsapp, email, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias, status_pagamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`;
  
  // Array de valores com proteções (JSON.stringify e valores padrão)
  const values = [
    data.nome,
    data.whatsapp,
    data.email || "",
    data.endereco,
    data.qtd_criancas,
    data.faixa_etaria,
    data.modelo_barraca,
    data.qtd_barracas,
    data.cores,
    data.tema,
    JSON.stringify(data.itens_padrao || []),     // Proteção 1
    JSON.stringify(data.itens_adicionais || []), // Proteção 2 (Correção Principal)
    data.data_festa,
    data.horario,
    JSON.stringify(data.alimentacao || []),      // Proteção 3
    data.alergias || "",
  ];

  db.query(sql, values, (err) => {
    if (err) {
        // Log detalhado para você ver o erro real no terminal
        console.error("🔴 ERRO AO SALVAR ORÇAMENTO (SQL):", err);
        return res.status(500).json({ error: "Erro interno ao salvar no banco. Verifique os logs." });
    }
    res.status(201).json({ success: true });
  });
});

app.get("/api/depoimentos/publicos", (req, res) => {
  const sql = `SELECT d.*, GROUP_CONCAT(f.url_foto) as fotos FROM depoimentos d LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id WHERE d.aprovado = TRUE GROUP BY d.id ORDER BY d.data_criacao DESC LIMIT 10`;
  db.query(sql, (err, r) =>
    res.json(
      err
        ? []
        : r.map((i) => ({ ...i, fotos: i.fotos ? i.fotos.split(",") : [] })),
    ),
  );
});

app.get("/api/feedback/:token", (req, res) => {
  db.query(
    "SELECT id, nome FROM orcamentos WHERE token_avaliacao = ?",
    [req.params.token],
    (err, r) => {
      if (err || r.length === 0)
        return res.status(404).json({ error: "Token inválido" });
      res.json(r[0]);
    },
  );
});

app.post("/api/feedback/:token", upload.array("fotos", 6), async (req, res) => {
  db.query(
    "SELECT id, nome FROM orcamentos WHERE token_avaliacao = ?",
    [req.params.token],
    async (err, r) => {
      if (err || r.length === 0)
        return res.status(404).json({ error: "Token inválido" });
      const orcamentoId = r[0].id;
      try {
        const insert = await db
          .promise()
          .query(
            "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota, aprovado) VALUES (?, ?, ?, ?, 0)",
            [
              orcamentoId,
              r[0].nome,
              req.body.texto.substring(0, 350),
              req.body.nota,
            ],
          );
        const depId = insert[0].insertId;
        if (req.files) {
          for (const f of req.files) {
            const up = await cloudinary.uploader.upload(f.path, {
              folder: "cabana/fotos",
            });
            await db
              .promise()
              .query(
                "INSERT INTO fotos_depoimento (depoimento_id, url_foto) VALUES (?, ?)",
                [depId, up.secure_url],
              );
            fs.unlinkSync(f.path);
          }
        }
        res.json({ success: true });
      } catch (e) {
        console.error("Erro feedback:", e);
        res.status(500).json({ error: "Erro" });
      }
    },
  );
});

app.get("/api/galeria_fotos", (req, res) => {
  const dir = path.join(__dirname, "public/fotos");
  if (!fs.existsSync(dir)) return res.json([]);
  fs.readdir(dir, (err, f) =>
    res.json(
      f.filter((i) => /\.(jpg|png|webp)$/i.test(i)).map((i) => `/fotos/${i}`),
    ),
  );
});

// --- ROTAS ADMIN ---

app.get("/api/admin/agenda", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos WHERE status_agenda = 'agendado' ORDER BY data_festa ASC",
    (err, r) => res.json(r || []),
  );
});
app.put("/api/admin/agenda/aprovar/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE orcamentos SET status_agenda = 'agendado', status = 'aprovado' WHERE id = ?",
    [req.params.id],
    (e) => res.json({ success: !e }),
  );
});
app.put("/api/admin/agenda/concluir/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE orcamentos SET status_agenda = 'concluido' WHERE id = ?",
    [req.params.id],
    (e) => res.json({ success: !e }),
  );
});
app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query("SELECT * FROM orcamentos ORDER BY data_pedido DESC", (err, r) =>
    res.json(r || []),
  );
});
app.put("/api/admin/pedidos/:id/financeiro", checkAuth, (req, res) => {
  const { valor_final, valor_itens_extras, descricao_itens_extras } = req.body;
  db.query(
    "UPDATE orcamentos SET valor_final = ?, valor_itens_extras = ?, descricao_itens_extras = ? WHERE id = ?",
    [valor_final, valor_itens_extras, descricao_itens_extras, req.params.id],
    (e) => res.json({ success: !e }),
  );
});
app.post("/api/admin/gerar-links-mp/:id", checkAuth, (req, res) => {
  db.query(
    "SELECT valor_final, nome FROM orcamentos WHERE id = ?",
    [req.params.id],
    async (err, r) => {
      if (err || r.length === 0) return res.status(404).json({ error: "Erro" });
      const vTotal = parseFloat(r[0].valor_final || 0);
      const linkReserva = await criarLinkMP(
        `Reserva - ${r[0].nome}`,
        (vTotal * 0.4).toFixed(2),
        req.params.id,
      );
      const linkIntegral = await criarLinkMP(
        `Total - ${r[0].nome}`,
        (vTotal * 0.95).toFixed(2),
        req.params.id,
      );
      res.json({
        reserva: (vTotal * 0.4).toFixed(2),
        linkReserva,
        integral: (vTotal * 0.95).toFixed(2),
        linkIntegral,
      });
    },
  );
});
app.delete("/api/admin/pedidos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: !e }),
  );
});

// FINANCEIRO & PREÇOS & AVALIAÇÕES
app.post("/api/admin/financeiro/festa/:id", checkAuth, (req, res) =>
  db.query(
    "INSERT INTO custos_festa (orcamento_id, descricao, valor) VALUES (?, ?, ?)",
    [req.params.id, req.body.descricao, req.body.valor],
    (e) => res.json({ success: !e }),
  ),
);
app.delete("/api/admin/financeiro/festa/:id", checkAuth, (req, res) =>
  db.query("DELETE FROM custos_festa WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: !e }),
  ),
);
app.post("/api/admin/financeiro/geral", checkAuth, (req, res) =>
  db.query(
    "INSERT INTO custos_gerais (titulo, tipo, valor, data_registro) VALUES (?, ?, ?, ?)",
    [
      req.body.titulo,
      req.body.tipo,
      req.body.valor,
      req.body.data || new Date(),
    ],
    (e, r) => res.json({ success: !e, id: r?.insertId }),
  ),
);
app.delete("/api/admin/financeiro/geral/:id", checkAuth, (req, res) =>
  db.query("DELETE FROM custos_gerais WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: !e }),
  ),
);
app.get("/api/admin/financeiro/relatorio", checkAuth, async (req, res) => {
  try {
    const [g] = await db.promise().query("SELECT * FROM custos_gerais ORDER BY data_registro DESC");
    const [f] = await db.promise().query("SELECT cf.*, o.nome as nome_cliente, o.data_festa FROM custos_festa cf JOIN orcamentos o ON cf.orcamento_id = o.id");
    const [fat] = await db.promise().query("SELECT id, nome, valor_final, data_festa FROM orcamentos WHERE status_agenda = 'concluido'");
    res.json({ gerais: g, festas: f, faturamento: fat });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/admin/precos", checkAuth, (req, res) =>
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (e, r) => res.json(r || []),
  ),
);
app.post("/api/admin/precos", checkAuth, (req, res) =>
  db.query(
    "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)",
    ["c_" + Date.now(), req.body.descricao, req.body.valor, req.body.categoria],
    (e) => res.json({ success: !e }),
  ),
);
app.put("/api/admin/precos/:id", checkAuth, (req, res) => {
  const { valor } = req.body;
  db.query(
    "UPDATE tabela_precos SET valor = ? WHERE id = ?",
    [valor, req.params.id],
    (e) => res.json({ success: !e }),
  )
});

app.delete("/api/admin/precos/:id", checkAuth, (req, res) =>
  db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: !e }),
  ),
);
app.post("/api/admin/gerar-token/:id", checkAuth, (req, res) => {
  const t = uuidv4();
  db.query(
    "UPDATE orcamentos SET token_avaliacao = ? WHERE id = ?",
    [t, req.params.id],
    (e) =>
      res.json({
        token: t,
        link: `${req.protocol}://${req.get("host")}/feedback.html?t=${t}`,
      }),
  );
});
app.get("/api/admin/avaliacoes", checkAuth, (req, res) => {
  db.query(
    `SELECT d.*, o.data_festa, GROUP_CONCAT(f.url_foto) as fotos FROM depoimentos d LEFT JOIN orcamentos o ON d.orcamento_id = o.id LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id GROUP BY d.id ORDER BY d.data_criacao DESC`,
    (e, r) =>
      res.json(
        r
          ? r.map((i) => ({ ...i, fotos: i.fotos ? i.fotos.split(",") : [] }))
          : [],
      ),
  );
});
app.put("/api/admin/avaliacoes/:id", checkAuth, (req, res) =>
  db.query(
    "UPDATE depoimentos SET aprovado = ? WHERE id = ?",
    [req.body.aprovado, req.params.id],
    (e) => res.json({ success: !e }),
  ),
);
app.delete("/api/admin/avaliacoes/:id", checkAuth, (req, res) =>
  db.query("DELETE FROM depoimentos WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: !e }),
  ),
);

app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));