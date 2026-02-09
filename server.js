require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { MercadoPagoConfig, Preference } = require("mercadopago");
const nodemailer = require("nodemailer");
const { randomUUID: uuidv4 } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURAÇÕES & OTIMIZAÇÃO ---

// Cache de imagens estáticas (1 dia) para resolver lentidão no carregamento
const oneDay = 1000 * 60 * 60 * 24;
app.use(express.static("public", { maxAge: oneDay }));

app.use(cors());
app.use(bodyParser.json());

// Nodemailer (Envio de E-mails)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Cloudinary (Upload de Fotos)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: "uploads/" });

// --- 2. BANCO DE DADOS (POOL PROMISE) ---
// A solução definitiva para os erros de conexão e "Internal Server Error"
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
});

const db = pool.promise();

// Mantém o banco vivo (Ping a cada 30s)
setInterval(async () => {
  try {
    await db.query("SELECT 1");
  } catch (e) {
    console.error("Ping DB falhou", e.code);
  }
}, 30000);

// Middleware de Autenticação Admin
function checkAuth(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (password !== process.env.ADMIN_PASS)
    return res.status(401).json({ message: "Senha incorreta!" });
  next();
}

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

async function enviarEmailConfirmacao(
  email,
  nome,
  valorPago,
  valorTotal,
  linkRestante,
) {
  if (!email || email.length < 5) return;
  const saldoDevedor = valorTotal - valorPago;
  const isQuitado = saldoDevedor <= 1.0;

  let assunto = "Pagamento Confirmado - Cabana de Brincar ⛺";
  let corpoHtml = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
      <h2 style="color: #6C63FF;">Olá, ${nome}! 🎉</h2>
      <p>Recebemos a confirmação do seu pagamento de <strong>R$ ${Number(valorPago).toFixed(2)}</strong>.</p>
  `;

  if (isQuitado) {
    corpoHtml += `<p style="color: green; font-weight: bold;">✅ Sua reserva está 100% quitada!</p>
                  <p>Agora é só aguardar o dia da festa!</p>`;
  } else {
    corpoHtml += `
      <p style="color: orange; font-weight: bold;">✅ Reserva Garantida (Sinal)!</p>
      <p>Restante a Pagar: <strong>R$ ${Number(saldoDevedor).toFixed(2)}</strong></p>
      <p>Para pagar o restante, use o botão abaixo quando desejar:</p>
      <a href="${linkRestante}" style="background: #ff6b6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Pagar Restante</a>
    `;
  }

  corpoHtml += `<br><br><hr><small>Cabana de Brincar - Tornando sonhos reais.</small></div>`;

  try {
    await transporter.sendMail({
      from: `"Cabana de Brincar" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: assunto,
      html: corpoHtml,
    });
    console.log(`📧 E-mail enviado para ${email}`);
  } catch (err) {
    console.error("Erro email:", err.message);
  }
}

// --- 4. WEBHOOK (MERCADO PAGO) ---

app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");
  const id = req.body?.data?.id || req.body?.id || req.query.id;

  if ((req.body?.type === "payment" || req.query.topic === "payment") && id) {
    try {
      const resp = await fetch(
        `https://api.mercadopago.com/v1/payments/${id}`,
        {
          headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
        },
      );

      if (resp.ok) {
        const payment = await resp.json();
        if (payment.status === "approved") {
          const pedidoId = payment.external_reference;
          const valorPago = parseFloat(payment.transaction_amount);

          const [rows] = await db.query(
            "SELECT * FROM orcamentos WHERE id = ?",
            [pedidoId],
          );
          if (rows.length > 0) {
            const pedido = rows[0];
            await db.query(
              "UPDATE orcamentos SET status_pagamento = 'pago' WHERE id = ?",
              [pedidoId],
            );

            // Calcula links para e-mail
            const valorTotal = parseFloat(pedido.valor_final || 0);
            const saldo = valorTotal - valorPago;
            let link = "#";
            if (valorTotal > 0 && saldo > 5) {
              link = await criarLinkMP(
                `Restante - ${pedido.nome}`,
                saldo.toFixed(2),
                pedidoId,
              );
            }

            if (pedido.email)
              enviarEmailConfirmacao(
                pedido.email,
                pedido.nome,
                valorPago,
                valorTotal,
                link,
              );
          }
        }
      }
    } catch (e) {
      console.error("Webhook Error:", e.message);
    }
  }
});

// --- 5. ROTAS PÚBLICAS (APP) ---

// Salvar Orçamento
app.post("/api/orcamento", async (req, res) => {
  const data = req.body;

  // Tratamento de Inteiros (Evita erro SQL '' is not integer)
  const qtdCriancas = parseInt(data.qtd_criancas) || 0;
  const qtdBarracas = parseInt(data.qtd_barracas) || 0;

  const sql = `INSERT INTO orcamentos (nome, whatsapp, email, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias, status_pagamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`;

  const values = [
    data.nome,
    data.whatsapp,
    data.email || null,
    data.endereco,
    qtdCriancas,
    data.faixa_etaria,
    data.modelo_barraca,
    qtdBarracas,
    data.cores,
    data.tema,
    JSON.stringify(data.itens_padrao || []),
    JSON.stringify(data.itens_adicionais || []),
    data.data_festa,
    data.horario,
    JSON.stringify(data.alimentacao || []),
    data.alergias || "",
  ];

  try {
    await db.query(sql, values);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error("ERRO SQL:", err.message);
    res.status(500).json({ error: "Erro ao salvar no banco." });
  }
});

// Listar Itens Disponíveis
app.get("/api/itens-disponiveis", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'alimentacao', 'tendas') AND disponivel = TRUE ORDER BY categoria, descricao",
    );
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

// Listar Depoimentos Aprovados (Com Fotos)
app.get("/api/depoimentos/publicos", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT d.*, GROUP_CONCAT(f.url_foto) as fotos FROM depoimentos d LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id WHERE d.aprovado = TRUE GROUP BY d.id ORDER BY d.data_criacao DESC LIMIT 15",
    );
    res.json(
      rows.map((i) => ({ ...i, fotos: i.fotos ? i.fotos.split(",") : [] })),
    );
  } catch (e) {
    res.json([]);
  }
});

// Galeria de Fotos (Local)
app.get("/api/galeria_fotos", (req, res) => {
  const dir = path.join(__dirname, "public/fotos");
  if (!fs.existsSync(dir)) return res.json([]);
  fs.readdir(dir, (err, f) => {
    if (err) return res.json([]);
    res.json(
      f.filter((i) => /\.(jpg|png|webp)$/i.test(i)).map((i) => `/fotos/${i}`),
    );
  });
});

// --- 6. ROTAS DO ADMIN (PAINEL) ---

app.get("/api/admin/agenda", checkAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM orcamentos WHERE status_agenda = 'agendado' ORDER BY data_festa ASC",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/pedidos", checkAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM orcamentos ORDER BY data_pedido DESC",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Financeiro
app.get("/api/admin/financeiro/relatorio", checkAuth, async (req, res) => {
  try {
    const [gerais] = await db.query(
      "SELECT * FROM custos_gerais ORDER BY data_registro DESC",
    );
    const [festas] = await db.query(
      "SELECT cf.*, o.nome as nome_cliente, o.data_festa FROM custos_festa cf JOIN orcamentos o ON cf.orcamento_id = o.id",
    );
    const [faturamento] = await db.query(
      "SELECT id, nome, valor_final, data_festa FROM orcamentos WHERE status_agenda = 'concluido'",
    );
    res.json({ gerais, festas, faturamento });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/financeiro/geral", checkAuth, async (req, res) => {
  try {
    const [r] = await db.query(
      "INSERT INTO custos_gerais (titulo, tipo, valor, data_registro) VALUES (?, ?, ?, ?)",
      [
        req.body.titulo,
        req.body.tipo,
        req.body.valor,
        req.body.data || new Date(),
      ],
    );
    res.json({ success: true, id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/financeiro/festa/:id", checkAuth, async (req, res) => {
  try {
    await db.query(
      "INSERT INTO custos_festa (orcamento_id, descricao, valor) VALUES (?, ?, ?)",
      [req.params.id, req.body.descricao, req.body.valor],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/financeiro/geral/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM custos_gerais WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

app.delete("/api/admin/financeiro/festa/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM custos_festa WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

// Ações de Pedidos
app.put("/api/admin/agenda/aprovar/:id", checkAuth, async (req, res) => {
  try {
    await db.query(
      "UPDATE orcamentos SET status_agenda = 'agendado', status = 'aprovado' WHERE id = ?",
      [req.params.id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

app.put("/api/admin/agenda/concluir/:id", checkAuth, async (req, res) => {
  try {
    await db.query(
      "UPDATE orcamentos SET status_agenda = 'concluido' WHERE id = ?",
      [req.params.id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

app.put("/api/admin/pedidos/:id/financeiro", checkAuth, async (req, res) => {
  try {
    await db.query(
      "UPDATE orcamentos SET valor_final = ?, valor_itens_extras = ?, descricao_itens_extras = ? WHERE id = ?",
      [
        req.body.valor_final,
        req.body.valor_itens_extras,
        req.body.descricao_itens_extras,
        req.params.id,
      ],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

app.delete("/api/admin/pedidos/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM orcamentos WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

// Preços
app.get("/api/admin/precos", checkAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM tabela_precos ORDER BY categoria, descricao",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/precos", checkAuth, async (req, res) => {
  try {
    await db.query(
      "INSERT INTO tabela_precos (item_chave, descricao, valor, categoria) VALUES (?, ?, ?, ?)",
      [
        "c_" + Date.now(),
        req.body.descricao,
        req.body.valor,
        req.body.categoria,
      ],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

app.put("/api/admin/precos/:id", checkAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;
    
    // Lista de colunas permitidas para edição
    const allowedColumns = ['descricao', 'valor', 'categoria', 'disponivel'];

    // Encontra qual campo foi enviado no JSON (ex: 'descricao', 'valor', etc)
    const column = Object.keys(data).find(key => allowedColumns.includes(key));

    if (!column) {
      return res.status(400).json({ error: "Campo inválido ou não permitido." });
    }

    const value = data[column];

    // Atualiza dinamicamente a coluna correta no banco
    // Nota: Como 'column' foi validado na lista 'allowedColumns', é seguro interpolar
    await db.query(`UPDATE tabela_precos SET ${column} = ? WHERE id = ?`, [
      value,
      id,
    ]);

    res.json({ success: true });
  } catch (e) {
    console.error("Erro ao atualizar item:", e);
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/admin/precos/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM tabela_precos WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e });
  }
});

// Gerar Links Mercado Pago (Com correção do Restante)
app.post("/api/admin/gerar-links-mp/:id", checkAuth, async (req, res) => {
  try {
    const [r] = await db.query(
      "SELECT valor_final, nome FROM orcamentos WHERE id = ?",
      [req.params.id],
    );
    if (r.length === 0) return res.status(404).json({ error: "Erro" });

    const vTotal = parseFloat(r[0].valor_final || 0);

    const linkReserva = await criarLinkMP(
      `Reserva - ${r[0].nome}`,
      (vTotal * 0.4).toFixed(2),
      req.params.id,
    );
    const linkRestante = await criarLinkMP(
      `Restante - ${r[0].nome}`,
      (vTotal * 0.6).toFixed(2),
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
      restante: (vTotal * 0.6).toFixed(2),
      linkRestante,
      integral: (vTotal * 0.95).toFixed(2),
      linkIntegral,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 7. GESTÃO COMPLETA DE AVALIAÇÕES ---

// Listar (com concatenação de fotos)
app.get("/api/admin/avaliacoes", checkAuth, async (req, res) => {
  try {
    const sql = `SELECT d.*, o.data_festa, 
                 GROUP_CONCAT(CONCAT(f.id, '::', f.url_foto) SEPARATOR '||') as fotos_info 
                 FROM depoimentos d 
                 LEFT JOIN orcamentos o ON d.orcamento_id = o.id 
                 LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id 
                 GROUP BY d.id 
                 ORDER BY d.data_criacao DESC`;
    const [rows] = await db.query(sql);

    const dados = rows.map((i) => {
      let listaFotos = [];
      if (i.fotos_info) {
        listaFotos = i.fotos_info.split("||").map((f) => {
          const [id, url] = f.split("::");
          return { id, url };
        });
      }
      return { ...i, fotos: listaFotos };
    });
    res.json(dados);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Atualizar (Texto, Nota, Status)
app.put("/api/admin/avaliacoes/:id", checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { aprovado, texto, nota, nome_cliente } = req.body;
    const [atuais] = await db.query("SELECT * FROM depoimentos WHERE id = ?", [
      id,
    ]);
    if (atuais.length === 0)
      return res.status(404).json({ error: "Não encontrado" });
    const atual = atuais[0];

    const novoAprovado = aprovado !== undefined ? aprovado : atual.aprovado;
    const novoTexto = texto !== undefined ? texto : atual.texto;
    const novaNota = nota !== undefined ? nota : atual.nota;
    const novoNome =
      nome_cliente !== undefined ? nome_cliente : atual.nome_cliente;

    await db.query(
      "UPDATE depoimentos SET aprovado = ?, texto = ?, nota = ?, nome_cliente = ? WHERE id = ?",
      [novoAprovado, novoTexto, novaNota, novoNome, id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Excluir Avaliação
app.delete("/api/admin/avaliacoes/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM depoimentos WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Adicionar Foto em Avaliação Existente
app.post(
  "/api/admin/avaliacoes/:id/foto",
  checkAuth,
  upload.single("foto"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Nenhuma imagem" });
      const up = await cloudinary.uploader.upload(req.file.path, {
        folder: "cabana/fotos",
      });
      fs.unlinkSync(req.file.path);
      await db.query(
        "INSERT INTO fotos_depoimento (depoimento_id, url_foto) VALUES (?, ?)",
        [req.params.id, up.secure_url],
      );
      res.json({ success: true, url: up.secure_url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Remover Foto Específica
app.delete("/api/admin/fotos/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM fotos_depoimento WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ROTA DE SEEDER (IMPORTADOR VISUAL) ---
app.post(
  "/api/admin/seed-review",
  checkAuth,
  upload.array("fotos", 5),
  async (req, res) => {
    try {
      const { nome, texto, nota } = req.body;

      // Orçamento Fake para vincular
      await db.query(
        `INSERT IGNORE INTO orcamentos (id, nome, whatsapp, email, status) VALUES (9999, 'Cliente Seeder', '000', 'seeder@teste.com', 'concluido')`,
      );

      // Cria o depoimento
      const [r] = await db.query(
        "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota, aprovado, data_criacao) VALUES (?, ?, ?, ?, 1, NOW())",
        [9999, nome, texto, nota || 5],
      );
      const depId = r.insertId;

      // Upload Múltiplo
      if (req.files && req.files.length > 0) {
        const uploads = req.files.map((file) => {
          return cloudinary.uploader
            .upload(file.path, { folder: "cabana/depoimentos_fake" })
            .then((up) => {
              fs.unlinkSync(file.path);
              return up.secure_url;
            });
        });
        const urls = await Promise.all(uploads);
        for (const url of urls) {
          await db.query(
            "INSERT INTO fotos_depoimento (depoimento_id, url_foto) VALUES (?, ?)",
            [depId, url],
          );
        }
      }
      res.json({ success: true, message: "Criado!" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));
