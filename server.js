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

// Cache de imagens estáticas (1 dia)
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

// Ping Banco de Dados (Mantém vivo)
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

// --- FUNÇÕES AUXILIARES (Atualizada) ---

// Agora aceita 'referenciaPersonalizada' para sabermos se é SINAL, RESTANTE ou INTEGRAL
async function criarLinkMP(titulo, valor, pedidoId, tipoPagamento) {
  try {
    const preference = new Preference(mpClient);
    let domain = process.env.DOMAIN || `localhost:${PORT}`;
    domain = domain.replace(/\/$/, "");
    if (!domain.startsWith("http")) domain = `https://${domain}`;

    // Cria uma referência composta: ID_TIPO (ex: 55_SINAL)
    const externalRef = `${pedidoId}__${tipoPagamento}`;

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
        external_reference: externalRef, // ISSO É O SEGREDO DA AUTOMAÇÃO
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

// ... (Mantenha o resto do código até a rota gerar-links-mp) ...

// --- ROTA DE GERAÇÃO DE LINKS (Atualizada para 50% e 5% OFF) ---
// --- ROTA DE GERAÇÃO DE LINKS (CORRIGIDA: SOMA EXTRAS/FRETE/DESCONTOS) ---
app.post("/api/admin/gerar-links-mp/:id", checkAuth, async (req, res) => {
  try {
    // 1. Buscamos valor_final (itens) E valor_itens_extras
    const [r] = await db.query(
      "SELECT valor_final, valor_itens_extras, nome FROM orcamentos WHERE id = ?",
      [req.params.id],
    );
    if (r.length === 0) return res.status(404).json({ error: "Erro" });

    const vBase = parseFloat(r[0].valor_final || 0);
    const vExtras = parseFloat(r[0].valor_itens_extras || 0); // Frete (+) ou Desconto (-)

    // O TOTAL AGORA É A SOMA DOS DOIS
    const vTotal = vBase + vExtras;

    // Proteção contra valor zero ou negativo
    if (vTotal <= 0) {
      return res
        .status(400)
        .json({
          error:
            "O valor total do pedido (Itens + Extras) deve ser maior que zero.",
        });
    }

    const nome = r[0].nome.split(" ")[0];

    // 1. SINAL (50% do TOTAL REAL)
    const valSinal = (vTotal * 0.5).toFixed(2);
    const linkReserva = await criarLinkMP(
      `Sinal Reserva - ${nome}`,
      valSinal,
      req.params.id,
      "SINAL",
    );

    // 2. RESTANTE (50% do TOTAL REAL)
    const valRestante = (vTotal * 0.5).toFixed(2);
    const linkRestante = await criarLinkMP(
      `Restante - ${nome}`,
      valRestante,
      req.params.id,
      "RESTANTE",
    );

    // 3. INTEGRAL COM DESCONTO (5% OFF sobre o TOTAL REAL)
    const valIntegral = (vTotal * 0.95).toFixed(2);
    const linkIntegral = await criarLinkMP(
      `Total (5% OFF) - ${nome}`,
      valIntegral,
      req.params.id,
      "INTEGRAL",
    );

    res.json({
      reserva: valSinal,
      linkReserva,
      restante: valRestante,
      linkRestante,
      integral: valIntegral,
      linkIntegral,
    });
  } catch (e) {
    console.error("Erro ao gerar links:", e);
    res.status(500).json({ error: e.message });
  }
});

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
    corpoHtml += `<p style="color: green; font-weight: bold;">✅ Sua reserva está 100% quitada!</p>`;
  } else {
    corpoHtml += `
      <p style="color: orange; font-weight: bold;">✅ Reserva Garantida (Sinal)!</p>
      <p>Restante a Pagar: <strong>R$ ${Number(saldoDevedor).toFixed(2)}</strong></p>
      <a href="${linkRestante}" style="background: #ff6b6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Pagar Restante</a>
    `;
  }
  corpoHtml += `<br><br><hr><small>Cabana de Brincar</small></div>`;

  try {
    await transporter.sendMail({
      from: `"Cabana de Brincar" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: assunto,
      html: corpoHtml,
    });
  } catch (err) {
    console.error("Erro email:", err.message);
  }
}

// --- 4. WEBHOOK (MERCADO PAGO - ATUALIZADO) ---
app.post("/api/webhook", async (req, res) => {
  res.status(200).send("OK");
  const id = req.body?.data?.id || req.body?.id || req.query.id;

  if ((req.body?.type === "payment" || req.query.topic === "payment") && id) {
    try {
      const resp = await fetch(
        `https://api.mercadopago.com/v1/payments/${id}`,
        { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } },
      );

      if (resp.ok) {
        const payment = await resp.json();

        if (payment.status === "approved") {
          // Decodifica a referência: ID__TIPO
          const reference = payment.external_reference || "";
          const [pedidoIdStr, tipoPagamento] = reference.split("__"); // Ex: 55__SINAL
          const pedidoId = parseInt(pedidoIdStr);
          const valorPago = parseFloat(payment.transaction_amount);

          if (!pedidoId) return;

          // Busca dados atuais do pedido
          const [rows] = await db.query(
            "SELECT * FROM orcamentos WHERE id = ?",
            [pedidoId],
          );
          if (rows.length === 0) return;
          const pedido = rows[0];

          // --- CORREÇÃO: VERIFICAR DUPLICIDADE ---
          // Se já existe um pagamento deste TIPO (SINAL, RESTANTE, etc) para este orçamento, paramos aqui.
          const [pagamentoExistente] = await db.query(
            "SELECT id FROM pagamentos_orcamento WHERE orcamento_id = ? AND tipo = ?",
            [pedidoId, tipoPagamento],
          );

          if (pagamentoExistente.length > 0) {
            console.log(
              `Webhook ignorado: Pagamento '${tipoPagamento}' para orçamento #${pedidoId} já foi processado.`,
            );
            return; // Encerra a execução para não duplicar financeiro nem disparar e-mails repetidos
          }
          // ---------------------------------------

          // --- NOVO: REGISTRAR NA TABELA DE PAGAMENTOS DA FESTA ---
          await db.query(
            "INSERT INTO pagamentos_orcamento (orcamento_id, valor, tipo, data_pagamento, metodo) VALUES (?, ?, ?, NOW(), 'mercadopago')",
            [pedidoId, valorPago, tipoPagamento],
          );
          // --------------------------------------------------------

          // 1. LÓGICA DE STATUS
          let novoStatusPagamento = "parcial";
          let novoStatusAgenda = pedido.status_agenda;

          // Se for INTEGRAL, RESTANTE ou PEGUE_MONTE (completa o pagamento)
          if (tipoPagamento === "INTEGRAL" || tipoPagamento === "RESTANTE" || tipoPagamento === "PEGUE_MONTE") {
            novoStatusPagamento = "pago";
          }

          if (tipoPagamento === "SINAL" || tipoPagamento === "INTEGRAL" || tipoPagamento === "PEGUE_MONTE") {
            novoStatusAgenda = "agendado";
            await db.query("UPDATE orcamentos SET status = 'aprovado' WHERE id = ?", [pedidoId]);
            
            // NOVO: Se for Pegue e Monte, reserva o pacote para sumir do site!
            if (tipoPagamento === "PEGUE_MONTE" && pedido.tema) {
                // Extrai o ID do pacote que salvamos no texto do tema: (ID: 12)
                const match = pedido.tema.match(/ID: (\d+)/);
                if (match && match[1]) {
                    const idDoPacote = match[1];
                    await db.query("UPDATE pacotes_pegue_monte SET status = 'reservado' WHERE id = ?", [idDoPacote]);
                }
            }
          }

          // Atualiza o Status do Pedido
          await db.query(
            "UPDATE orcamentos SET status_pagamento = ?, status_agenda = ? WHERE id = ?",
            [novoStatusPagamento, novoStatusAgenda, pedidoId],
          );

          // 2. LÓGICA FINANCEIRA GERAL (Mantida para seu painel geral)
          let tituloLancamento = `Receita Pedido #${pedidoId}`;
          if (tipoPagamento === "SINAL")
            tituloLancamento = `Entrada (Sinal) - ${pedido.nome}`;
          else if (tipoPagamento === "RESTANTE")
            tituloLancamento = `Pagamento Restante - ${pedido.nome}`;
          else if (tipoPagamento === "INTEGRAL")
            tituloLancamento = `Pagamento Integral - ${pedido.nome}`;

          await db.query(
            "INSERT INTO custos_gerais (titulo, tipo, valor, data_registro) VALUES (?, 'receita', ?, NOW())",
            [tituloLancamento, valorPago],
          );

          // 3. ENVIO DE E-MAIL
          const valorTotal = parseFloat(pedido.valor_final || 0);
          if (pedido.email) {
            let linkRestanteEmail = "#"; // Aqui você pode gerar o link se desejar
            enviarEmailConfirmacao(
              pedido.email,
              pedido.nome,
              valorPago,
              valorTotal,
              linkRestanteEmail,
            );
          }
        }
      }
    } catch (e) {
      console.error("Webhook Error:", e.message);
    }
  }
});

// =========================================================================
// --- 5. NOVAS ROTAS: ALIMENTAÇÃO & CARDÁPIOS (CORRIGIDO) ---
// =========================================================================

// 5.1 GESTÃO DE ALIMENTOS (INSUMOS)
app.get("/api/alimentos", async (req, res) => {
  try {
    const apenasVisiveis = req.query.publico === "true";
    const filtro = apenasVisiveis
      ? "WHERE visivel_site = TRUE AND ativo = TRUE"
      : "WHERE ativo = TRUE";
    const [rows] = await db.query(
      `SELECT * FROM itens_alimentacao ${filtro} ORDER BY nome`,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/alimentos", checkAuth, async (req, res) => {
  try {
    const { nome, unidade, medida, valor, visivel_site } = req.body;
    // CORREÇÃO: Adicionado 'ativo' = 1 para que o item apareça nas buscas
    await db.query(
      "INSERT INTO itens_alimentacao (nome, unidade, medida, valor, visivel_site, ativo) VALUES (?, ?, ?, ?, ?, 1)",
      [nome, unidade, medida, valor, visivel_site ? 1 : 0],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/alimentos/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM itens_alimentacao WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/alimentos/:id", checkAuth, async (req, res) => {
  try {
    const { nome, unidade, medida, valor, visivel_site } = req.body;
    await db.query(
      "UPDATE itens_alimentacao SET nome=?, unidade=?, medida=?, valor=?, visivel_site=? WHERE id=?",
      [nome, unidade, medida, valor, visivel_site ? 1 : 0, req.params.id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5.2 GESTÃO DE CARDÁPIOS (PACOTES)
app.get("/api/cardapios", async (req, res) => {
  try {
    const isAdmin = req.query.admin === "true";
    const filtro = isAdmin ? "" : "WHERE ativo = TRUE";

    const [menus] = await db.query(
      `SELECT * FROM cardapios ${filtro} ORDER BY id DESC`,
    );

    const menusCompletos = await Promise.all(
      menus.map(async (menu) => {
        // Busca composição na nova tabela
        const [itens] = await db.query(
          `
            SELECT cc.quantidade, ia.id, ia.nome, ia.unidade, ia.medida, ia.valor 
            FROM cardapio_composicao cc 
            JOIN itens_alimentacao ia ON cc.alimento_id = ia.id 
            WHERE cc.cardapio_id = ?
        `,
          [menu.id],
        );

        // Cálculo de Preço
        let valorUnitario = 0;
        if (menu.tipo_preco === "soma") {
          valorUnitario = itens.reduce(
            (acc, item) => acc + parseFloat(item.valor) * item.quantidade,
            0,
          );
        } else {
          valorUnitario = parseFloat(menu.preco_fixo);
        }

        return { ...menu, itens, valor_final: valorUnitario };
      }),
    );

    res.json(menusCompletos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/api/admin/cardapios",
  checkAuth,
  upload.single("capa"),
  async (req, res) => {
    try {
      const {
        titulo,
        descricao,
        tipo_preco,
        preco_fixo,
        modo_cobranca,
        itens_json,
      } = req.body;
      let url_capa = "";

      if (req.file) {
        const up = await cloudinary.uploader.upload(req.file.path, {
          folder: "cabana/cardapios",
        });
        url_capa = up.secure_url;
        fs.unlinkSync(req.file.path);
      }

      const [result] = await db.query(
        "INSERT INTO cardapios (titulo, descricao, url_capa, tipo_preco, preco_fixo, modo_cobranca, ativo) VALUES (?, ?, ?, ?, ?, ?, 1)",
        [
          titulo,
          descricao,
          url_capa,
          tipo_preco,
          preco_fixo,
          modo_cobranca || "por_pessoa",
        ],
      );
      const cardapioId = result.insertId;

      if (itens_json) {
        const itens = JSON.parse(itens_json);
        for (const item of itens) {
          await db.query(
            "INSERT INTO cardapio_composicao (cardapio_id, alimento_id, quantidade) VALUES (?, ?, ?)",
            [cardapioId, item.id, item.quantidade],
          );
        }
      }
      res.json({ success: true, id: cardapioId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  },
);

app.put(
  "/api/admin/cardapios/:id",
  checkAuth,
  upload.single("capa"),
  async (req, res) => {
    try {
      const id = req.params.id;
      const {
        titulo,
        descricao,
        tipo_preco,
        preco_fixo,
        modo_cobranca,
        itens_json,
        ativo,
      } = req.body;

      let sql =
        "UPDATE cardapios SET titulo=?, descricao=?, tipo_preco=?, preco_fixo=?, modo_cobranca=?, ativo=? WHERE id=?";
      let params = [
        titulo,
        descricao,
        tipo_preco,
        preco_fixo,
        modo_cobranca,
        ativo,
        id,
      ];

      if (req.file) {
        const up = await cloudinary.uploader.upload(req.file.path, {
          folder: "cabana/cardapios",
        });
        fs.unlinkSync(req.file.path);
        sql =
          "UPDATE cardapios SET titulo=?, descricao=?, tipo_preco=?, preco_fixo=?, modo_cobranca=?, ativo=?, url_capa=? WHERE id=?";
        params = [
          titulo,
          descricao,
          tipo_preco,
          preco_fixo,
          modo_cobranca,
          ativo,
          up.secure_url,
          id,
        ];
      }

      await db.query(sql, params);

      if (itens_json) {
        await db.query(
          "DELETE FROM cardapio_composicao WHERE cardapio_id = ?",
          [id],
        );
        const itens = JSON.parse(itens_json);
        for (const item of itens) {
          await db.query(
            "INSERT INTO cardapio_composicao (cardapio_id, alimento_id, quantidade) VALUES (?, ?, ?)",
            [id, item.id, item.quantidade],
          );
        }
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.patch("/api/admin/cardapios/:id/status", checkAuth, async (req, res) => {
  try {
    const { ativo } = req.body;
    await db.query("UPDATE cardapios SET ativo = ? WHERE id = ?", [
      ativo,
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/cardapios/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM cardapios WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================================
// --- 6. ROTAS PÚBLICAS & ADMIN ANTIGAS (MANTIDAS) ---
// =========================================================================

// Salvar Orçamento
// Salvar Orçamento (ATUALIZADO PARA RECEBER VALOR)
app.post("/api/orcamento", async (req, res) => {
  const data = req.body;
  const qtdCriancas = parseInt(data.qtd_criancas) || 0;
  const qtdBarracas = parseInt(data.qtd_barracas) || 0;

  // RECEBE O VALOR CALCULADO NO FRONTEND
  const valorEstimado = parseFloat(data.valor_estimado) || 0;

  const sql = `INSERT INTO orcamentos (nome, whatsapp, email, endereco, qtd_criancas, faixa_etaria, modelo_barraca, qtd_barracas, cores, tema, itens_padrao, itens_adicionais, data_festa, horario, alimentacao, alergias, status_pagamento, valor_final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)`;

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
    valorEstimado, // Salva o valor calculado
  ];

  try {
    await db.query(sql, values);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar no banco." });
  }
});

// Listar Itens (Não-Alimentação)
// Listar Itens (Incluindo 'sistema' para as taxas)
app.get("/api/itens-disponiveis", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, descricao, categoria, valor FROM tabela_precos WHERE categoria IN ('padrao', 'tendas', 'sistema') AND disponivel = TRUE ORDER BY categoria, descricao",
    );
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

// Depoimentos e Fotos
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

// --- ADMIN: Agenda & Pedidos ---
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

// --- ADMIN: Financeiro (Rota Atualizada) ---
app.get("/api/admin/financeiro/relatorio", checkAuth, async (req, res) => {
  try {
    // 1. Busca Movimentações Gerais (Direita)
    // Se você inseriu receitas de festa aqui antes, elas aparecerão aqui.
    // O ideal é limpar a tabela custos_gerais e deixar só despesas/receitas avulsas.
    const [gerais] = await db.query(
      "SELECT * FROM custos_gerais ORDER BY data_registro DESC",
    );

    // 2. Busca Custos Específicos de Festas (Para cálculo de lucro)
    const [custosFestas] = await db.query(
      "SELECT cf.*, o.nome as nome_cliente FROM custos_festa cf JOIN orcamentos o ON cf.orcamento_id = o.id",
    );

    // 3. Busca O FLUXO DE PAGAMENTOS (Esquerda)
    // Traz o pagamento + Nome do Cliente + Data da Festa
    const [pagamentos] = await db.query(`
      SELECT 
        p.id, 
        p.valor, 
        p.tipo, 
        p.data_pagamento, 
        p.metodo,
        o.id as orcamento_id,
        o.nome, 
        o.tema,
        o.data_festa
      FROM pagamentos_orcamento p
      JOIN orcamentos o ON p.orcamento_id = o.id
      ORDER BY p.data_pagamento DESC
    `);

    res.json({ gerais, custosFestas, pagamentos });
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

// --- AÇÕES DE PEDIDOS ---
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

// --- PREÇOS (Hardware / Tabela Antiga) ---
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
    const allowedColumns = ["descricao", "valor", "categoria", "disponivel"];
    const column = Object.keys(data).find((key) =>
      allowedColumns.includes(key),
    );
    if (!column) return res.status(400).json({ error: "Campo inválido." });
    await db.query(`UPDATE tabela_precos SET ${column} = ? WHERE id = ?`, [
      data[column],
      id,
    ]);
    res.json({ success: true });
  } catch (e) {
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

// Gerar Links MP Admin
/*
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
*/
// --- AVALIAÇÕES ---
app.get("/api/admin/avaliacoes", checkAuth, async (req, res) => {
  try {
    const sql = `SELECT d.*, o.data_festa, GROUP_CONCAT(CONCAT(f.id, '::', f.url_foto) SEPARATOR '||') as fotos_info FROM depoimentos d LEFT JOIN orcamentos o ON d.orcamento_id = o.id LEFT JOIN fotos_depoimento f ON d.id = f.depoimento_id GROUP BY d.id ORDER BY d.data_criacao DESC`;
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
    await db.query(
      "UPDATE depoimentos SET aprovado = ?, texto = ?, nota = ?, nome_cliente = ? WHERE id = ?",
      [
        aprovado !== undefined ? aprovado : atual.aprovado,
        texto !== undefined ? texto : atual.texto,
        nota !== undefined ? nota : atual.nota,
        nome_cliente !== undefined ? nome_cliente : atual.nome_cliente,
        id,
      ],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/avaliacoes/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM depoimentos WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Seeder de Avaliações
app.post(
  "/api/admin/seed-review",
  checkAuth,
  upload.array("fotos", 5),
  async (req, res) => {
    try {
      const { nome, texto, nota } = req.body;
      await db.query(
        `INSERT IGNORE INTO orcamentos (id, nome, whatsapp, email, status) VALUES (9999, 'Cliente Seeder', '000', 'seeder@teste.com', 'concluido')`,
      );
      const [r] = await db.query(
        "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota, aprovado, data_criacao) VALUES (?, ?, ?, ?, 1, NOW())",
        [9999, nome, texto, nota || 5],
      );
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
            [r.insertId, url],
          );
        }
      }
      res.json({ success: true, message: "Criado!" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// --- SIMULADOR DINÂMICO ---
app.post(
  "/api/admin/ativos-simulador",
  checkAuth,
  upload.single("imagem"),
  async (req, res) => {
    try {
      const { tipo_cabana, categoria_ativo, item_id, camada_z } = req.body;
      if (!req.file)
        return res.status(400).json({ error: "Nenhuma imagem enviada" });
      const pasta =
        categoria_ativo === "item" ? "simulador/itens" : "simulador/bases";
      const up = await cloudinary.uploader.upload(req.file.path, {
        folder: `cabana/${pasta}`,
      });
      fs.unlinkSync(req.file.path);
      const sql = `INSERT INTO ativos_simulador (tipo_cabana, categoria_ativo, item_id, url_cloudinary, camada_z) VALUES (?, ?, ?, ?, ?)`;
      await db.query(sql, [
        tipo_cabana,
        categoria_ativo,
        item_id || null,
        up.secure_url,
        camada_z || 0,
      ]);
      res.json({ success: true, url: up.secure_url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.get("/api/simulador/ativos/:tipo", async (req, res) => {
  try {
    const { tipo } = req.params;
    const sql = `SELECT a.*, tp.descricao as nome_item FROM ativos_simulador a LEFT JOIN tabela_precos tp ON a.item_id = tp.id WHERE a.tipo_cabana = ? ORDER BY a.camada_z ASC`;
    const [rows] = await db.query(sql, [tipo]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/ativos-simulador", checkAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM ativos_simulador ORDER BY tipo_cabana, camada_z",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/ativos-simulador/:id", checkAuth, async (req, res) => {
  try {
    await db.query("DELETE FROM ativos_simulador WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// =========================================================================
// --- 7. SISTEMA DE FEEDBACK E AVALIAÇÕES (NOVO) ---
// =========================================================================

// 7.1 Gerar Token de Avaliação (Admin)
// Rota chamada pelo botão "Gerar Link Avaliação" na Agenda
app.post("/api/admin/gerar-token/:id", checkAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const token = uuidv4(); // Gera um ID único

    // Salva o token no pedido específico
    await db.query("UPDATE orcamentos SET feedback_token = ? WHERE id = ?", [
      token,
      id,
    ]);

    // Monta a URL completa
    let domain = process.env.DOMAIN || `localhost:${PORT}`;
    domain = domain.replace(/\/$/, "");
    if (!domain.startsWith("http")) domain = `https://${domain}`;

    const link = `${domain}/feedback.html?t=${token}`;

    res.json({ link });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 7.2 Validar Token e Pegar Dados do Cliente (Público)
// Rota chamada ao abrir a página feedback.html
app.get("/api/feedback/:token", async (req, res) => {
  try {
    const token = req.params.token;
    // Busca o nome do cliente baseado no token
    const [rows] = await db.query(
      "SELECT id, nome FROM orcamentos WHERE feedback_token = ?",
      [token],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Link inválido ou expirado" });
    }

    res.json({ nome: rows[0].nome });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7.3 Receber a Avaliação (Público)
// Rota chamada ao enviar o formulário de feedback
app.post("/api/feedback/:token", upload.array("fotos", 6), async (req, res) => {
  try {
    const token = req.params.token;

    // 1. Validar Token
    const [rows] = await db.query(
      "SELECT id, nome FROM orcamentos WHERE feedback_token = ?",
      [token],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Token inválido" });
    }

    const pedido = rows[0];
    const { nota, texto } = req.body;

    // 2. Salvar Depoimento
    // 'aprovado' = 0 para que o admin precise aprovar antes de aparecer no site
    const [r] = await db.query(
      "INSERT INTO depoimentos (orcamento_id, nome_cliente, texto, nota, aprovado, data_criacao) VALUES (?, ?, ?, ?, 0, NOW())",
      [pedido.id, pedido.nome, texto, nota],
    );
    const depoimentoId = r.insertId;

    // 3. Upload de Fotos (se houver)
    if (req.files && req.files.length > 0) {
      const uploads = req.files.map((file) => {
        return cloudinary.uploader
          .upload(file.path, { folder: "cabana/depoimentos_clientes" })
          .then((up) => {
            fs.unlinkSync(file.path);
            return up.secure_url;
          });
      });

      const urls = await Promise.all(uploads);

      for (const url of urls) {
        await db.query(
          "INSERT INTO fotos_depoimento (depoimento_id, url_foto) VALUES (?, ?)",
          [depoimentoId, url],
        );
      }
    }

    // Opcional: Remover o token para o link não ser usado novamente
    // await db.query("UPDATE orcamentos SET feedback_token = NULL WHERE id = ?", [pedido.id]);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
// Rota para ver o histórico financeiro de uma festa específica
app.get("/api/admin/pedidos/:id/pagamentos", checkAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM pagamentos_orcamento WHERE orcamento_id = ? ORDER BY data_pagamento DESC",
      [req.params.id],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// =========================================================================
// --- 8. SISTEMA PEGUE E MONTE ---
// =========================================================================

// --- FUNÇÃO AUXILIAR PARA LIMPEZA NO CLOUDINARY ---
// Extrai o ID público da imagem para podermos deletar do Cloudinary
function getCloudinaryPublicId(url) {
  if (!url) return null;
  try {
    const urlSemExtensao = url.substring(0, url.lastIndexOf('.'));
    const match = urlSemExtensao.match(/cabana\/.*$/); // Pega tudo a partir da pasta 'cabana'
    return match ? match[0] : null;
  } catch (e) {
    return null;
  }
}

// 8.1 Listar Pacotes (Público/Admin)
app.get("/api/pegue-monte", async (req, res) => {
  try {
    const apenasLiberados = req.query.liberados === "true";
    const filtro = apenasLiberados ? "WHERE status = 'liberado'" : "";
    
    const [rows] = await db.query(`SELECT * FROM pacotes_pegue_monte ${filtro} ORDER BY id DESC`);
    
    const pacotes = rows.map(p => {
      let fotosArray = [];
      if (p.fotos) {
          // Garante que não vai dar erro se o mysql2 já tiver convertido o JSON
          fotosArray = typeof p.fotos === 'string' ? JSON.parse(p.fotos) : p.fotos;
      }
      return { ...p, fotos: fotosArray };
    });

    res.json(pacotes);
  } catch (e) {
    console.error("Erro na rota /api/pegue-monte:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 8.2 Cadastrar Pacote com Múltiplas Fotos (Admin)
app.post("/api/admin/pegue-monte", checkAuth, upload.array("fotos", 10), async (req, res) => {
  try {
    const { nome_pacote, descricao, valor, status } = req.body;
    let urlsFotos = [];

    // Faz o upload de todas as fotos para o Cloudinary
    if (req.files && req.files.length > 0) {
      const uploads = req.files.map(file => {
        return cloudinary.uploader.upload(file.path, { folder: "cabana/pegue_monte" })
          .then(up => {
            fs.unlinkSync(file.path);
            return up.secure_url;
          });
      });
      urlsFotos = await Promise.all(uploads);
    }

    const fotosJson = JSON.stringify(urlsFotos);

    const [result] = await db.query(
      "INSERT INTO pacotes_pegue_monte (nome_pacote, descricao, valor, status, fotos) VALUES (?, ?, ?, ?, ?)",
      [nome_pacote, descricao, valor, status || 'liberado', fotosJson]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (e) {
    console.error("Erro ao cadastrar pacote:", e);
    res.status(500).json({ error: e.message });
  }
});

// 8.3 Alternar Status (Liberado <-> Reservado) Rápido (Admin)
app.patch("/api/admin/pegue-monte/:id/status", checkAuth, async (req, res) => {
  try {
    const { status } = req.body; // 'liberado' ou 'reservado'
    await db.query("UPDATE pacotes_pegue_monte SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 8.4 Excluir Pacote (Admin) - Limpa Banco e Cloudinary
app.delete("/api/admin/pegue-monte/:id", checkAuth, async (req, res) => {
  try {
    const pacoteId = req.params.id;

    // 1. Busca as fotos antes de apagar o pacote do banco
    const [pacote] = await db.query("SELECT fotos FROM pacotes_pegue_monte WHERE id = ?", [pacoteId]);
    
    if (pacote.length > 0 && pacote[0].fotos) {
        const fotosLista = typeof pacote[0].fotos === 'string' ? JSON.parse(pacote[0].fotos) : pacote[0].fotos;
        
        // 2. Percorre a lista de fotos e deleta uma por uma do Cloudinary
        for (const urlFoto of fotosLista) {
            const publicId = getCloudinaryPublicId(urlFoto);
            if (publicId) {
                await cloudinary.uploader.destroy(publicId).catch(err => console.error("Erro ao limpar Cloudinary:", err));
            }
        }
    }

    // 3. Deleta o pacote do banco de dados
    await db.query("DELETE FROM pacotes_pegue_monte WHERE id = ?", [pacoteId]);
    res.json({ success: true });
  } catch (e) {
    console.error("Erro ao excluir pacote:", e);
    res.status(500).json({ error: e.message });
  }
});

// 8.5 Receber Pedido de Pegue e Monte do Cliente (Público) - COM MERCADO PAGO
app.post("/api/orcamento-pegue-monte", async (req, res) => {
  try {
    const { nome, telefone, email, data_festa, pacote_id, nome_pacote, valor_pacote } = req.body;

    const sql = `INSERT INTO orcamentos 
      (nome, whatsapp, email, data_festa, modelo_barraca, status_pagamento, valor_final, tema) 
      VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`;

    // Guardamos o ID do pacote no 'tema' para o webhook conseguir ler depois
    const values = [
      nome, telefone, email || null, data_festa, 
      'PEGUE E MONTE', valor_pacote, 
      `Pacote Pegue e Monte: ${nome_pacote} (ID: ${pacote_id})` 
    ];

    const [result] = await db.query(sql, values);
    const pedidoId = result.insertId;

    // NOVO: Gera o link do Mercado Pago para o Valor Integral
    // Passamos "PEGUE_MONTE" como tipo de pagamento para o Webhook saber como agir
    const linkMP = await criarLinkMP(
      `Pegue e Monte - ${nome_pacote}`,
      valor_pacote,
      pedidoId,
      "PEGUE_MONTE"
    );

    // NOTA: Removemos aquele código que reservava o pacote automaticamente. 
    // Agora a reserva real só acontece quando o Webhook confirmar o pagamento!

    res.status(201).json({ success: true, pedido_id: pedidoId, link_pagamento: linkMP });
  } catch (e) {
    console.error("Erro ao registrar orçamento Pegue e Monte:", e);
    res.status(500).json({ error: "Erro ao registrar o pedido pegue e monte." });
  }
});

// 8.6 Editar Pacote (Admin) - Com gerenciamento inteligente de fotos no Cloudinary
app.put("/api/admin/pegue-monte/:id", checkAuth, upload.array("fotos", 10), async (req, res) => {
  try {
    const { nome_pacote, descricao, valor, status, fotos_mantidas } = req.body;
    const pacoteId = req.params.id;

    // 1. Pega as fotos atuais do banco
    const [atual] = await db.query("SELECT fotos FROM pacotes_pegue_monte WHERE id = ?", [pacoteId]);
    if (atual.length === 0) return res.status(404).json({ error: "Pacote não encontrado" });
    
    const fotosAntigas = typeof atual[0].fotos === 'string' ? JSON.parse(atual[0].fotos) : (atual[0].fotos || []);
    
    // 2. Lê as fotos que o admin NÃO deletou na interface (as que ficaram no modal)
    let fotosFinais = fotos_mantidas ? JSON.parse(fotos_mantidas) : [];

    // 3. Lógica de Limpeza: Se a foto estava no banco, mas não está nas 'fotos_mantidas', o admin excluiu!
    const fotosParaDeletar = fotosAntigas.filter(fotoAntiga => !fotosFinais.includes(fotoAntiga));
    for (const urlFoto of fotosParaDeletar) {
        const publicId = getCloudinaryPublicId(urlFoto);
        if (publicId) {
            await cloudinary.uploader.destroy(publicId).catch(err => console.error("Erro ao deletar sobra no Cloudinary:", err));
        }
    }

    // 4. Se enviou novos arquivos, faz upload e soma com as fotos finais mantidas
    if (req.files && req.files.length > 0) {
      const uploads = req.files.map(file => {
        return cloudinary.uploader.upload(file.path, { folder: "cabana/pegue_monte" })
          .then(up => {
            fs.unlinkSync(file.path); // limpa o cache local do multer
            return up.secure_url;
          });
      });
      const urlsNovas = await Promise.all(uploads);
      fotosFinais = [...fotosFinais, ...urlsNovas]; 
    }

    const fotosJsonStr = JSON.stringify(fotosFinais);

    // 5. Atualiza os dados no banco
    await db.query(
      "UPDATE pacotes_pegue_monte SET nome_pacote = ?, descricao = ?, valor = ?, status = ?, fotos = ? WHERE id = ?",
      [nome_pacote, descricao, valor, status || 'liberado', fotosJsonStr, pacoteId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("Erro ao editar pacote Pegue e Monte:", e);
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => console.log(`🔥 Server on ${PORT}`));
