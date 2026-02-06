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
const nodemailer = require("nodemailer");
const venom = require("venom-bot"); // BIBLIOTECA DO WHATSAPP

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES ---

// 1. Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// 2. Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 3. E-mail (Gmail)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 4. INICIALIZAÇÃO DO ROBÔ WHATSAPP
let whatsappClient = null;

// Inicia o Venom-bot
venom
  .create(
    "sessao-cabana", // Nome da sessão
    (base64Qr, asciiQR) => {
      // Callback para mostrar o QR Code no terminal
      console.log("\n📷 ESCANEIE O QR CODE ABAIXO PARA CONECTAR O WHATSAPP:\n");
      console.log(asciiQR); // Imprime o QR Code no terminal
    },
    (statusSession, session) => {
      console.log("Status Sessão WhatsApp:", statusSession);
    },
    {
      headless: "new", // Executa sem abrir janela (ideal para servidor)
      useChrome: false, // Tenta usar o Chromium baixado automaticamente
      logQR: false, // Desabilitamos o log nativo para controlar acima
      browserArgs: ["--no-sandbox", "--disable-setuid-sandbox"], // Necessário para rodar em servidores Linux/Docker
    }
  )
  .then((client) => {
    console.log("✅ Robô do WhatsApp conectado com sucesso!");
    whatsappClient = client;
  })
  .catch((erro) => {
    console.error("Erro ao iniciar o WhatsApp:", erro);
  });

const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Banco de Dados
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

// --- FUNÇÕES AUXILIARES ---

async function criarLinkMP(titulo, valor, pedidoId) {
  try {
    const preference = new Preference(mpClient);

    let domain = process.env.DOMAIN || `localhost:${PORT}`;
    domain = domain.replace(/\/$/, "");
    if (!domain.startsWith("http")) {
      domain = `https://${domain}`;
    }

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

async function enviarEmailConfirmacao(nome, email, valor) {
  if (!email) return;
  const mailOptions = {
    from: `"Cabana de Brincar" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "🎉 Pagamento Confirmado! - Cabana de Brincar",
    html: `
            <div style="font-family: Arial, sans-serif; color: #333;">
                <h1 style="color: #e91e63;">Olá, ${nome}!</h1>
                <p>Recebemos a confirmação do seu pagamento de <strong>R$ ${valor}</strong>.</p>
                <p>Sua data está oficialmente reservada! ⛺✨</p>
                <hr>
                <p>Em breve entraremos em contato para finalizar os detalhes.</p>
            </div>
        `,
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 E-mail enviado para ${email}`);
  } catch (error) {
    console.error("Erro ao enviar e-mail:", error);
  }
}

// --- FUNÇÃO DO ROBÔ GRATUITO ---
async function enviarWhatsapp(nome, telefone, valor) {
  if (!whatsappClient) {
    console.log("⚠️ WhatsApp ainda não conectado. Mensagem não enviada.");
    return;
  }

  // Tratamento do número para o formato internacional (DDI + DDD + Numero)
  // Ex: 5521999999999@c.us
  let numeroLimpo = telefone.replace(/\D/g, "");

  // Se o número não tiver DDI (55), adicionamos
  if (numeroLimpo.length <= 11) {
    numeroLimpo = `55${numeroLimpo}`;
  }

  // O sufixo @c.us é obrigatório para enviar para pessoas (não grupos)
  const chatId = `${numeroLimpo}@c.us`;

  const mensagem = `Olá *${nome}*! ⛺✨\n\nRecebemos a confirmação do seu pagamento de *R$ ${valor}* na Cabana de Brincar.\n\nSua reserva está garantida! 🎉\nEm breve entraremos em contato para combinar os detalhes.`;

  try {
    await whatsappClient.sendText(chatId, mensagem);
    console.log(`📱 Mensagem WhatsApp enviada para ${numeroLimpo}`);
  } catch (error) {
    console.error("Erro ao enviar WhatsApp:", error);
  }
}

// --- WEBHOOK ---

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
        }
      );

      if (response.ok) {
        const paymentData = await response.json();

        if (paymentData.status === "approved") {
          const pedidoId = paymentData.external_reference;
          const valorPago = paymentData.transaction_amount;

          console.log(`✅ Pagamento Aprovado! Pedido: ${pedidoId}`);

          db.query(
            "UPDATE orcamentos SET status_pagamento = 'pago' WHERE id = ?",
            [pedidoId],
            (err) => {
              if (err) return console.error("Erro DB Update:", err);

              db.query(
                "SELECT nome, email, whatsapp FROM orcamentos WHERE id = ?",
                [pedidoId],
                (err, results) => {
                  if (!err && results.length > 0) {
                    const cliente = results[0];
                    
                    // Dispara E-mail
                    enviarEmailConfirmacao(
                      cliente.nome,
                      cliente.email,
                      valorPago
                    );
                    
                    // Dispara WhatsApp (Robô Gratuito)
                    enviarWhatsapp(
                      cliente.nome,
                      cliente.whatsapp,
                      valorPago
                    );
                  }
                }
              );
            }
          );
        }
      }
    } catch (e) {
      console.error("Erro processando Webhook:", e.message);
    }
  }
});

// --- ROTAS PÚBLICAS ---

app.get("/api/itens-disponiveis", (req, res) => {
  db.query(
    "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') AND disponivel = TRUE ORDER BY categoria, descricao",
    (err, results) => {
      if (err) return res.status(500).json([]);
      res.json(results);
    }
  );
});

app.post("/api/orcamento", (req, res) => {
  const data = req.body;
  const sql = `INSERT INTO orcamentos (nome, whatsapp, email, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias, status_pagamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`;
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
    }
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
            [orcamentoId, nomeCliente, texto.substring(0, 350), nota]
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
                [depoimentoId, uploadRes.secure_url]
              );
            fs.unlinkSync(file.path);
          }
        }
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: "Erro ao processar" });
      }
    }
  );
});

app.get("/api/galeria_fotos", (req, res) => {
  const directoryPath = path.join(__dirname, "public/fotos");
  if (!fs.existsSync(directoryPath)) return res.json([]);
  fs.readdir(directoryPath, (err, files) => {
    if (err) return res.status(500).send("Erro ao ler diretório");
    const fotos = files
      .filter((file) => /\.(jpg|jpeg|png|webp|gif)$/i.test(file))
      .map((file) => `/fotos/${file}`);
    res.json(fotos);
  });
});

// --- ROTAS ADMIN ---

app.get("/api/admin/agenda", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos WHERE status_agenda = 'agendado' ORDER BY data_festa ASC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    }
  );
});

app.put("/api/admin/agenda/aprovar/:id", checkAuth, (req, res) => {
  db.query(
    "UPDATE orcamentos SET status_agenda = 'agendado', status = 'aprovado' WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    }
  );
});

app.put("/api/admin/agenda/concluir/:id", checkAuth, (req, res) => {
  const { valor_final } = req.body;
  let sql = "UPDATE orcamentos SET status_agenda = 'concluido' WHERE id = ?";
  let params = [req.params.id];
  if (valor_final !== undefined && valor_final !== null) {
    sql =
      "UPDATE orcamentos SET status_agenda = 'concluido', valor_final = ? WHERE id = ?";
    params = [valor_final, req.params.id];
  }
  db.query(sql, params, (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

app.get("/api/admin/pedidos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM orcamentos ORDER BY data_pedido DESC",
    (err, results) => {
      if (err) return res.status(500).json(err);
      res.json(results);
    }
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
    }
  );
});

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
        req.params.id
      );
      const linkIntegral = await criarLinkMP(
        `Total (5% desc) - ${results[0].nome}`,
        (vTotal * 0.95).toFixed(2),
        req.params.id
      );

      res.json({
        reserva: (vTotal * 0.4).toFixed(2),
        linkReserva,
        integral: (vTotal * 0.95).toFixed(2),
        linkIntegral,
        restante: (vTotal * 0.6).toFixed(2),
      });
    }
  );
});

app.delete("/api/admin/pedidos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: "Erro ao excluir" });
    res.json({ success: true });
  });
});

// --- FINANCEIRO ---

app.post("/api/admin/financeiro/festa/:id", checkAuth, (req, res) => {
  const { descricao, valor } = req.body;
  db.query(
    "INSERT INTO custos_festa (orcamento_id, descricao, valor) VALUES (?, ?, ?)",
    [req.params.id, descricao, valor],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    }
  );
});

app.delete("/api/admin/financeiro/festa/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM custos_festa WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

app.post("/api/admin/financeiro/geral", checkAuth, (req, res) => {
  const { titulo, tipo, valor, data } = req.body;
  const sql =
    "INSERT INTO custos_gerais (titulo, tipo, valor, data_registro) VALUES (?, ?, ?, ?)";
  db.query(sql, [titulo, tipo, valor, data || new Date()], (err, result) => {
    if (err)
      return res.status(500).json({ error: "Erro", details: err.message });
    res.json({ success: true, id: result.insertId });
  });
});

app.delete("/api/admin/financeiro/geral/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM custos_gerais WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true });
  });
});

app.get("/api/admin/financeiro/relatorio", checkAuth, async (req, res) => {
  try {
    const [gerais] = await db
      .promise()
      .query("SELECT * FROM custos_gerais ORDER BY data_registro DESC");
    const [custos_festas] = await db
      .promise()
      .query(
        "SELECT cf.*, o.nome as nome_cliente, o.data_festa FROM custos_festa cf JOIN orcamentos o ON cf.orcamento_id = o.id"
      );
    const [faturamento] = await db
      .promise()
      .query(
        "SELECT id, nome, valor_final, data_festa FROM orcamentos WHERE status_agenda = 'concluido'"
      );
    res.json({ gerais, festas: custos_festas, faturamento });
  } catch (e) {
    res.status(500).json(e);
  }
});

// --- PREÇOS ---

app.get("/api/admin/precos", checkAuth, (req, res) => {
  db.query(
    "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    (err, r) => res.json(r)
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
    (e) => res.json({ success: true })
  );
});

app.put("/api/admin/precos/:id", checkAuth, (req, res) => {
  const { valor, categoria, descricao, disponivel } = req.body;
  let campos = [],
    valores = [];
  if (valor !== undefined) {
    campos.push("valor = ?");
    valores.push(valor);
  }
  if (categoria !== undefined) {
    campos.push("categoria = ?");
    valores.push(categoria);
  }
  if (descricao !== undefined) {
    campos.push("descricao = ?");
    valores.push(descricao);
  }
  if (disponivel !== undefined) {
    campos.push("disponivel = ?");
    valores.push(disponivel);
  }
  if (campos.length === 0) return res.json({ success: true });
  valores.push(req.params.id);
  db.query(
    `UPDATE tabela_precos SET ${campos.join(", ")} WHERE id = ?`,
    valores,
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    }
  );
});

app.delete("/api/admin/precos/:id", checkAuth, (req, res) => {
  db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id], (e) =>
    res.json({ success: true })
  );
});

// --- AVALIAÇÕES & TOKEN ---

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
    }
  );
});

app.get("/api/admin/avaliacoes", checkAuth, (req, res) => {
  const sql = `SELECT d.*, o.data_festa, GROUP_CONCAT(f.url_foto) as fotos FROM depoimentos d LEFT JOIN orcamentos o ON d.orcamento_id = o.id LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id GROUP BY d.id ORDER BY d.data_criacao DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(
      results.map((r) => ({ ...r, fotos: r.fotos ? r.fotos.split(",") : [] }))
    );
  });
});

app.put("/api/admin/avaliacoes/:id", checkAuth, (req, res) => {
  const { texto, aprovado } = req.body;
  db.query(
    "UPDATE depoimentos SET texto = ?, aprovado = ? WHERE id = ?",
    [texto, aprovado, req.params.id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    }
  );
});

app.delete("/api/admin/avaliacoes/:id", checkAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const [photos] = await db
      .promise()
      .query("SELECT url_foto FROM fotos_depoimento WHERE depoimento_id = ?", [
        id,
      ]);
    if (photos.length > 0) {
      await Promise.all(
        photos.map((p) => {
          const matches = p.url_foto.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
          return matches
            ? cloudinary.uploader.destroy(matches[1])
            : Promise.resolve();
        })
      );
    }
    await db
      .promise()
      .query("DELETE FROM fotos_depoimento WHERE depoimento_id = ?", [id]);
    await db.promise().query("DELETE FROM depoimentos WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao excluir" });
  }
});

app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));