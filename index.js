require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 8000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-prod';
const RESEND_FROM = process.env.RESEND_FROM || 'GameVault <onboarding@resend.dev>';

if (!process.env.DATABASE_URL) {
  console.error('ERRO: DATABASE_URL em falta nas variaveis de ambiente.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origem nao permitida pelo CORS'));
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

app.use(express.json({ limit: '10mb' }));

const VALID_LIBRARY_STATUSES = ['backlog', 'playing', 'completed', 'dropped'];
const VALID_PAYMENT_METHODS = ['card_demo', 'multibanco_demo'];

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      cover_url TEXT,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      background_image TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      screenshots JSONB NOT NULL DEFAULT '[]'::jsonb,
      genres JSONB NOT NULL DEFAULT '[]'::jsonb,
      platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
      released TEXT,
      rating NUMERIC,
      rating_source TEXT,
      system_requirements JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS user_library (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS user_wishlist (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS game_offers (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      edition TEXT NOT NULL,
      activation_platform TEXT NOT NULL,
      region TEXT NOT NULL,
      price NUMERIC,
      currency TEXT NOT NULL DEFAULT 'EUR',
      available BOOLEAN NOT NULL DEFAULT FALSE,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
    );

    ALTER TABLE game_offers
      ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS game_reviews (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS user_cart_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL REFERENCES game_offers(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, offer_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      subtotal NUMERIC NOT NULL,
      total NUMERIC NOT NULL,
      payment_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      email_status TEXT NOT NULL DEFAULT 'not_sent',
      email_error TEXT,
      email_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      game_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      edition TEXT NOT NULL,
      region TEXT NOT NULL,
      activation_platform TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
      unit_price NUMERIC NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_item_keys (
      id TEXT PRIMARY KEY,
      order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `
    INSERT INTO games (
      id, slug, name, description, background_image, cover_image,
      screenshots, genres, platforms, released, rating, rating_source, system_requirements
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb)
    ON CONFLICT (id) DO NOTHING
    `,
    [
      'elden-ring',
      'elden-ring',
      'Elden Ring',
      'Um RPG de acao num vasto mundo de fantasia.',
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/page_bg_generated_v6b.jpg',
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/library_600x900.jpg',
      JSON.stringify([
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/ss_ae44317e3bd07b7698b4d2a93d91c7d8814a162b.1920x1080.jpg',
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/ss_3c41384a24d86dddd58a8f61db77f9dc0bfda8b5.1920x1080.jpg',
      ]),
      JSON.stringify(['RPG', 'Acao']),
      JSON.stringify(['PC', 'PlayStation', 'Xbox']),
      '2022-02-25',
      null,
      null,
      JSON.stringify({
        minimum: { os: null, processor: null, memory: null, graphics: null, storage: null, directX: null },
        recommended: { os: null, processor: null, memory: null, graphics: null, storage: null, directX: null },
      }),
    ]
  );

  await pool.query(
    `
    INSERT INTO game_offers (id, game_id, platform, edition, activation_platform, region, price, currency, available, stock)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      price = COALESCE(game_offers.price, EXCLUDED.price),
      stock = CASE WHEN game_offers.stock = 0 AND game_offers.price IS NULL THEN EXCLUDED.stock ELSE game_offers.stock END,
      available = CASE WHEN (CASE WHEN game_offers.stock = 0 AND game_offers.price IS NULL THEN EXCLUDED.stock ELSE game_offers.stock END) > 0 THEN TRUE ELSE FALSE END
    `,
    ['offer-001', 'elden-ring', 'PC', 'Standard (Demo)', 'Steam', 'EU', 39.99, 'EUR', true, 5]
  );
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, key] = (storedHash || '').split(':');
  if (!salt || !key) return false;
  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (derivedBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(derivedBuffer, keyBuffer);
}

function parseTtlSeconds(ttl) {
  if (!ttl) return 3600;
  const trimmed = String(ttl).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+)([smhd])$/i);
  if (!match) return 3600;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] || 3600);
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

function signToken(payload, ttl) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: nowSec, exp: nowSec + parseTtlSeconds(ttl) };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || nowSec >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function generateDemoKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i += 1) {
    raw += alphabet[bytes[i] % alphabet.length];
  }
  return `GV-DEMO-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function generateMultibancoDemoDetails() {
  const entityNum = 10000 + crypto.randomInt(90000);
  const r1 = String(crypto.randomInt(1000)).padStart(3, '0');
  const r2 = String(crypto.randomInt(1000)).padStart(3, '0');
  const r3 = String(crypto.randomInt(1000)).padStart(3, '0');
  return {
    entity: `DEMO-${entityNum}`,
    reference: `DEMO-${r1}-${r2}-${r3}`,
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildOrderEmailHtml({ user, order, items }) {
  const formattedDate = new Date(order.paidAt || order.createdAt).toLocaleString('pt-PT', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const rowsHtml = items
    .map((item) => {
      const keysHtml = (item.keys || [])
        .map(
          (k) =>
            `<div style="margin-top:6px;padding:8px 12px;background:#0f172a;color:#38bdf8;font-family:monospace;font-size:14px;border-radius:6px;letter-spacing:1px;">${escapeHtml(k.code)}</div>`
        )
        .join('');

      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e2e8f0;">
            <div style="font-weight:700;font-size:15px;color:#0f172a;">${escapeHtml(item.gameName)}</div>
            <div style="font-size:13px;color:#475569;margin-top:2px;">
              Plataforma: <strong>${escapeHtml(item.platform)}</strong> &bull;
              Edicao: <strong>${escapeHtml(item.edition)}</strong> &bull;
              Regiao: <strong>${escapeHtml(item.region)}</strong> &bull;
              Ativacao: <strong>${escapeHtml(item.activationPlatform)}</strong>
            </div>
            <div style="font-size:13px;color:#334155;margin-top:4px;">
              Quantidade: ${item.quantity} &times; ${Number(item.unitPrice).toFixed(2)} ${escapeHtml(order.currency)} (demonstrativo)
            </div>
            ${keysHtml}
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html lang="pt">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr>
          <td style="background:#0f172a;padding:24px;text-align:left;">
            <span style="font-size:22px;font-weight:800;letter-spacing:0.5px;color:#ffffff;">GameVault</span>
            <span style="display:inline-block;margin-left:8px;padding:2px 8px;font-size:11px;font-weight:600;background:#1e293b;color:#94a3b8;border-radius:999px;">PROJETO ACADEMICO</span>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Ola, ${escapeHtml(user.display_name || user.username)}!</h1>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#334155;">
              Obrigado pela tua compra demonstrativa no <strong>GameVault</strong>. A tua encomenda foi confirmada e as chaves ficticias abaixo ja estao disponiveis na tua area "As minhas compras".
            </p>
            <div style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#334155;margin-bottom:18px;">
              <div><strong>Encomenda:</strong> ${escapeHtml(order.id)}</div>
              <div><strong>Data:</strong> ${escapeHtml(formattedDate)}</div>
              <div><strong>Total demonstrativo:</strong> ${Number(order.total).toFixed(2)} ${escapeHtml(order.currency)}</div>
            </div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${rowsHtml}
            </table>
            <div style="margin-top:20px;padding:12px 14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:12px;line-height:1.5;color:#92400e;">
              <strong>Aviso Academico:</strong> Este email pertence exclusivamente a um projeto academico. Os pagamentos sao simulados e os codigos apresentados sao puramente demonstrativos, nao sendo validos para ativacao real na Steam, PlayStation, Xbox ou outras plataformas.
            </div>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

async function getFullOrderForUser(orderId, userId, client = pool) {
  const orderRes = await client.query(
    'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
    [orderId, userId]
  );
  const order = orderRes.rows[0];
  if (!order) return null;

  const itemsRes = await client.query(
    `SELECT id, order_id AS "orderId", offer_id AS "offerId", game_id AS "gameId",
            game_name AS "gameName", platform, edition, region,
            activation_platform AS "activationPlatform", quantity, unit_price AS "unitPrice"
     FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
    [order.id]
  );

  const itemIds = itemsRes.rows.map((i) => i.id);
  let keysByItem = new Map();
  if (itemIds.length > 0 && order.status === 'paid') {
    const keysRes = await client.query(
      `SELECT id, order_item_id AS "orderItemId", code, created_at AS "createdAt"
       FROM order_item_keys WHERE order_item_id = ANY($1::text[]) ORDER BY created_at ASC`,
      [itemIds]
    );
    for (const k of keysRes.rows) {
      if (!keysByItem.has(k.orderItemId)) keysByItem.set(k.orderItemId, []);
      keysByItem.get(k.orderItemId).push(k);
    }
  }

  const items = itemsRes.rows.map((item) => ({
    ...item,
    unitPrice: Number(item.unitPrice),
    keys: order.status === 'paid' ? keysByItem.get(item.id) || [] : [],
  }));

  return {
    id: order.id,
    userId: order.user_id,
    status: order.status,
    paymentMethod: order.payment_method,
    currency: order.currency,
    subtotal: Number(order.subtotal),
    total: Number(order.total),
    paymentDetails: order.payment_details || {},
    emailStatus: order.email_status,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    items,
  };
}

async function sendOrderEmailIfNeeded(orderId, user) {
  const fullOrder = await getFullOrderForUser(orderId, user.id);
  if (!fullOrder || fullOrder.status !== 'paid') return fullOrder;
  if (fullOrder.emailStatus === 'sent') return fullOrder;

  if (!resend) {
    await pool.query(
      `UPDATE orders SET email_status = 'failed', email_error = 'RESEND_API_KEY nao configurada' WHERE id = $1`,
      [orderId]
    );
    return getFullOrderForUser(orderId, user.id);
  }

  try {
    const html = buildOrderEmailHtml({ user, order: fullOrder, items: fullOrder.items });
    const response = await resend.emails.send({
      from: RESEND_FROM,
      to: user.email,
      subject: 'GameVault — A tua encomenda está pronta!',
      html,
    });

    if (response && response.error) {
      await pool.query(
        `UPDATE orders SET email_status = 'failed', email_error = $1 WHERE id = $2`,
        [response.error.message || 'Erro no Resend', orderId]
      );
    } else {
      await pool.query(
        `UPDATE orders SET email_status = 'sent', email_error = NULL, email_sent_at = NOW() WHERE id = $1`,
        [orderId]
      );
    }
  } catch (err) {
    await pool.query(
      `UPDATE orders SET email_status = 'failed', email_error = $1 WHERE id = $2`,
      [err.message || 'Falha ao contactar Resend', orderId]
    );
  }

  return getFullOrderForUser(orderId, user.id);
}

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    avatarUrl: row.avatar_url || null,
    coverUrl: row.cover_url || null,
  };
}

function toPublicGame(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    backgroundImage: row.background_image,
    coverImage: row.cover_image,
    screenshots: row.screenshots || [],
    genres: row.genres || [],
    platforms: row.platforms || [],
    released: row.released,
    rating: row.rating !== null ? Number(row.rating) : null,
    ratingSource: row.rating_source,
    systemRequirements: row.system_requirements || {},
  };
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Token de autenticacao em falta ou invalido' });
  }
  const payload = verifyToken(token);
  if (!payload || !payload.sub) {
    return res.status(401).json({ message: 'Token invalido ou expirado' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0]) {
      return res.status(401).json({ message: 'Utilizador nao encontrado' });
    }
    req.user = rows[0];
    return next();
  } catch {
    return res.status(500).json({ message: 'Erro interno na autenticacao' });
  }
}

function parseMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return reject(new Error('Content-Type multipart/form-data em falta'));
    const boundary = match[1] || match[2];
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(`--${boundary}`);
      let pos = raw.indexOf(boundaryBuf);
      while (pos !== -1) {
        pos += boundaryBuf.length;
        if (raw.slice(pos, pos + 2).toString('utf8') === '--') break;
        if (raw.slice(pos, pos + 2).toString('utf8') === '\r\n') pos += 2;
        const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), pos);
        if (headerEnd === -1) break;
        const headersText = raw.slice(pos, headerEnd).toString('utf8');
        const dataStart = headerEnd + 4;
        const nextBoundary = raw.indexOf(boundaryBuf, dataStart);
        if (nextBoundary === -1) break;
        let dataEnd = nextBoundary;
        if (raw.slice(dataEnd - 2, dataEnd).toString('utf8') === '\r\n') dataEnd -= 2;
        const nameMatch = headersText.match(/name="([^"]+)"/i);
        const typeMatch = headersText.match(/Content-Type:\s*([^\r\n]+)/i);
        if (nameMatch && nameMatch[1] === 'file') {
          const fileBuf = raw.slice(dataStart, dataEnd);
          const mime = (typeMatch && typeMatch[1].trim()) || 'application/octet-stream';
          return resolve({ dataUrl: `data:${mime};base64,${fileBuf.toString('base64')}` });
        }
        pos = nextBoundary;
      }
      return reject(new Error('Campo "file" nao encontrado no upload'));
    });
    req.on('error', reject);
  });
}

// --- Autenticacao ---
app.post('/api/v1/auth/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email e password sao obrigatorios' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedUsername = String(username).trim();
  const id = `u_${crypto.randomUUID().slice(0, 8)}`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, username, display_name, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, normalizedEmail, normalizedUsername, normalizedUsername, hashPassword(String(password))]
    );
    return res.status(201).json(toPublicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Email ou username ja registado' });
    }
    return res.status(500).json({ message: 'Erro ao registar utilizador' });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email e password sao obrigatorios' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    const user = rows[0];
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ message: 'Credenciais invalidas' });
    }
    const accessToken = signToken({ sub: user.id, email: user.email }, process.env.TOKEN_TTL);
    return res.status(200).json({
      accessToken,
      tokenType: 'Bearer',
      user: toPublicUser(user),
    });
  } catch {
    return res.status(500).json({ message: 'Erro ao iniciar sessao' });
  }
});

app.get('/api/v1/auth/me', requireAuth, (req, res) => {
  return res.status(200).json(toPublicUser(req.user));
});

// --- Biblioteca ---
app.get('/api/v1/me/library', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT game_id AS "gameId", status, added_at AS "addedAt", updated_at AS "updatedAt" FROM user_library WHERE user_id = $1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  return res.status(200).json(rows);
});

app.put('/api/v1/me/library/:gameId', requireAuth, async (req, res) => {
  const { gameId } = req.params;
  const status = (req.body && req.body.status) || 'backlog';
  if (!VALID_LIBRARY_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Estado invalido. Valores permitidos: ${VALID_LIBRARY_STATUSES.join(', ')}`,
    });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO user_library (user_id, game_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, game_id)
       DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
       RETURNING game_id AS "gameId", status, added_at AS "addedAt", updated_at AS "updatedAt"`,
      [req.user.id, gameId, status]
    );
    return res.status(200).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ message: 'Jogo nao encontrado' });
    return res.status(500).json({ message: 'Erro ao atualizar biblioteca' });
  }
});

app.delete('/api/v1/me/library/:gameId', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM user_library WHERE user_id = $1 AND game_id = $2',
    [req.user.id, req.params.gameId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Jogo nao encontrado na biblioteca' });
  return res.status(204).send();
});

// --- Wishlist ---
app.get('/api/v1/me/wishlist', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT game_id AS "gameId" FROM user_wishlist WHERE user_id = $1 ORDER BY added_at DESC',
    [req.user.id]
  );
  return res.status(200).json(rows);
});

app.put('/api/v1/me/wishlist/:gameId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO user_wishlist (user_id, game_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, req.params.gameId]
    );
    return res.status(200).json({ gameId: req.params.gameId, wishlisted: true });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ message: 'Jogo nao encontrado' });
    return res.status(500).json({ message: 'Erro ao adicionar a wishlist' });
  }
});

app.delete('/api/v1/me/wishlist/:gameId', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM user_wishlist WHERE user_id = $1 AND game_id = $2',
    [req.user.id, req.params.gameId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Jogo nao encontrado na wishlist' });
  return res.status(204).send();
});

// --- Perfil ---
app.get('/api/v1/me/profile', requireAuth, (req, res) => {
  return res.status(200).json(toPublicUser(req.user));
});

app.patch('/api/v1/me/profile', requireAuth, async (req, res) => {
  const { displayName, username, bio } = req.body || {};
  const nextUsername = username !== undefined ? String(username).trim() : req.user.username;
  const nextDisplayName = displayName !== undefined ? String(displayName).trim() : req.user.display_name;
  const nextBio = bio !== undefined ? String(bio) : req.user.bio;

  if (!nextUsername) return res.status(400).json({ message: 'Username nao pode estar vazio' });

  try {
    const { rows } = await pool.query(
      'UPDATE users SET username = $1, display_name = $2, bio = $3 WHERE id = $4 RETURNING *',
      [nextUsername, nextDisplayName, nextBio, req.user.id]
    );
    return res.status(200).json(toPublicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Username ja em utilizacao' });
    return res.status(500).json({ message: 'Erro ao atualizar perfil' });
  }
});

app.post('/api/v1/me/avatar', requireAuth, async (req, res) => {
  try {
    const file = await parseMultipartFile(req);
    const { rows } = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *',
      [file.dataUrl, req.user.id]
    );
    return res.status(200).json({ avatarUrl: rows[0].avatar_url, user: toPublicUser(rows[0]) });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Falha no upload do avatar' });
  }
});

app.delete('/api/v1/me/avatar', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE users SET avatar_url = NULL WHERE id = $1 RETURNING *',
    [req.user.id]
  );
  return res.status(200).json({ avatarUrl: null, user: toPublicUser(rows[0]) });
});

app.post('/api/v1/me/cover', requireAuth, async (req, res) => {
  try {
    const file = await parseMultipartFile(req);
    const { rows } = await pool.query(
      'UPDATE users SET cover_url = $1 WHERE id = $2 RETURNING *',
      [file.dataUrl, req.user.id]
    );
    return res.status(200).json({ coverUrl: rows[0].cover_url, user: toPublicUser(rows[0]) });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Falha no upload da capa' });
  }
});

app.delete('/api/v1/me/cover', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE users SET cover_url = NULL WHERE id = $1 RETURNING *',
    [req.user.id]
  );
  return res.status(200).json({ coverUrl: null, user: toPublicUser(rows[0]) });
});

// --- Carrinho Persistente (/api/v1/me/cart) ---
app.get('/api/v1/me/cart', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT offer_id AS "offerId", game_id AS "gameId", quantity
     FROM user_cart_items
     WHERE user_id = $1
     ORDER BY added_at ASC`,
    [req.user.id]
  );
  return res.status(200).json({ items: rows });
});

app.put('/api/v1/me/cart/:offerId', requireAuth, async (req, res) => {
  const { offerId } = req.params;
  const quantity = req.body && req.body.quantity !== undefined ? Number(req.body.quantity) : 1;

  if (!Number.isInteger(quantity) || quantity !== 1) {
    return res.status(400).json({ message: 'Quantidade invalida. Nesta versao a quantidade deve ser 1.' });
  }

  const offerRes = await pool.query('SELECT * FROM game_offers WHERE id = $1', [offerId]);
  const offer = offerRes.rows[0];
  if (!offer) {
    return res.status(404).json({ message: 'Oferta nao encontrada' });
  }
  if (!offer.available || Number(offer.stock) < quantity || offer.price === null) {
    return res.status(409).json({ message: 'Oferta sem stock ou indisponivel para compra' });
  }

  await pool.query(
    `INSERT INTO user_cart_items (user_id, offer_id, game_id, quantity)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, offer_id)
     DO UPDATE SET quantity = 1`,
    [req.user.id, offer.id, offer.game_id]
  );

  const { rows } = await pool.query(
    `SELECT offer_id AS "offerId", game_id AS "gameId", quantity
     FROM user_cart_items
     WHERE user_id = $1
     ORDER BY added_at ASC`,
    [req.user.id]
  );
  return res.status(200).json({ items: rows });
});

app.delete('/api/v1/me/cart/:offerId', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM user_cart_items WHERE user_id = $1 AND offer_id = $2',
    [req.user.id, req.params.offerId]
  );
  if (!rowCount) {
    return res.status(404).json({ message: 'Artigo nao encontrado no carrinho' });
  }
  const { rows } = await pool.query(
    `SELECT offer_id AS "offerId", game_id AS "gameId", quantity
     FROM user_cart_items
     WHERE user_id = $1
     ORDER BY added_at ASC`,
    [req.user.id]
  );
  return res.status(200).json({ items: rows });
});

app.delete('/api/v1/me/cart', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM user_cart_items WHERE user_id = $1', [req.user.id]);
  return res.status(200).json({ items: [] });
});

// --- Encomendas & Checkout Simulado ---
app.post('/api/v1/orders/checkout', requireAuth, async (req, res) => {
  const paymentMethod = req.body && req.body.paymentMethod;
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({
      message: `Metodo de pagamento invalido. Valores permitidos: ${VALID_PAYMENT_METHODS.join(', ')}`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cartRes = await client.query(
      `SELECT c.offer_id, c.quantity,
              o.game_id, o.platform, o.edition, o.activation_platform, o.region,
              o.price, o.currency, o.available, o.stock,
              g.name AS game_name
       FROM user_cart_items c
       JOIN game_offers o ON o.id = c.offer_id
       JOIN games g ON g.id = o.game_id
       WHERE c.user_id = $1
       ORDER BY c.added_at ASC`,
      [req.user.id]
    );

    if (cartRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'O carrinho esta vazio' });
    }

    let subtotal = 0;
    const currency = cartRes.rows[0].currency || 'EUR';

    for (const row of cartRes.rows) {
      if (!row.available || Number(row.stock) < Number(row.quantity) || row.price === null) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: `Stock insuficiente para ${row.game_name} (${row.edition})`,
        });
      }
      subtotal += Number(row.price) * Number(row.quantity);
    }

    subtotal = Number(subtotal.toFixed(2));
    const total = subtotal;
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const paymentDetails =
      paymentMethod === 'multibanco_demo'
        ? generateMultibancoDemoDetails()
        : { label: 'Cartao Bancario Demonstrativo' };

    await client.query(
      `INSERT INTO orders (id, user_id, status, payment_method, currency, subtotal, total, payment_details)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7::jsonb)`,
      [orderId, req.user.id, paymentMethod, currency, subtotal, total, JSON.stringify(paymentDetails)]
    );

    for (const row of cartRes.rows) {
      const itemId = `item_${crypto.randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO order_items (
          id, order_id, offer_id, game_id, game_name, platform, edition, region, activation_platform, quantity, unit_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          itemId,
          orderId,
          row.offer_id,
          row.game_id,
          row.game_name,
          row.platform,
          row.edition,
          row.region,
          row.activation_platform,
          Number(row.quantity),
          Number(row.price),
        ]
      );
    }

    await client.query('DELETE FROM user_cart_items WHERE user_id = $1', [req.user.id]);
    await client.query('COMMIT');

    const responseBody = {
      orderId,
      status: 'pending',
      paymentMethod,
      total,
      currency,
    };
    if (paymentMethod === 'multibanco_demo') {
      responseBody.paymentDetails = paymentDetails;
    }

    return res.status(201).json(responseBody);
  } catch {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Erro ao criar encomenda de checkout' });
  } finally {
    client.release();
  }
});

app.post('/api/v1/me/orders/:orderId/simulate-payment', requireAuth, async (req, res) => {
  const { orderId } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [orderId, req.user.id]
    );
    const order = orderRes.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Encomenda nao encontrada' });
    }

    if (order.status === 'paid') {
      await client.query('COMMIT');
      const finalOrder = await sendOrderEmailIfNeeded(orderId, req.user);
      return res.status(200).json(finalOrder);
    }

    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Nao e possivel confirmar encomenda no estado ${order.status}` });
    }

    const itemsRes = await client.query(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [order.id]
    );

    for (const item of itemsRes.rows) {
      const offerRes = await client.query(
        'SELECT * FROM game_offers WHERE id = $1 FOR UPDATE',
        [item.offer_id]
      );
      const offer = offerRes.rows[0];
      if (!offer || !offer.available || Number(offer.stock) < Number(item.quantity)) {
        await client.query(
          `UPDATE orders SET status = 'failed' WHERE id = $1`,
          [order.id]
        );
        await client.query('COMMIT');
        return res.status(409).json({
          message: `Stock esgotado durante a confirmacao para ${item.game_name}`,
        });
      }
    }

    for (const item of itemsRes.rows) {
      const updateStockRes = await client.query(
        `UPDATE game_offers
         SET stock = stock - $1,
             available = CASE WHEN (stock - $1) > 0 THEN TRUE ELSE FALSE END
         WHERE id = $2 AND stock >= $1
         RETURNING stock`,
        [Number(item.quantity), item.offer_id]
      );

      if (updateStockRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Conflito de stock detetado' });
      }

      for (let i = 0; i < Number(item.quantity); i += 1) {
        const keyId = `key_${crypto.randomUUID().slice(0, 8)}`;
        const code = generateDemoKey();
        await client.query(
          'INSERT INTO order_item_keys (id, order_item_id, code) VALUES ($1, $2, $3)',
          [keyId, item.id, code]
        );
      }
    }

    await client.query(
      `UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1`,
      [order.id]
    );

    await client.query('COMMIT');

    const finalOrder = await sendOrderEmailIfNeeded(order.id, req.user);
    return res.status(200).json(finalOrder);
  } catch {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Erro ao confirmar pagamento simulado' });
  } finally {
    client.release();
  }
});

app.post('/api/v1/me/orders/:orderId/resend-email', requireAuth, async (req, res) => {
  const existing = await getFullOrderForUser(req.params.orderId, req.user.id);
  if (!existing) return res.status(404).json({ message: 'Encomenda nao encontrada' });
  if (existing.status !== 'paid') {
    return res.status(400).json({ message: 'Apenas encomendas pagas podem enviar chaves por email' });
  }
  const updated = await sendOrderEmailIfNeeded(existing.id, req.user);
  return res.status(200).json(updated);
});

app.get('/api/v1/me/orders', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  const orders = [];
  for (const row of rows) {
    const full = await getFullOrderForUser(row.id, req.user.id);
    if (full) orders.push(full);
  }
  return res.status(200).json(orders);
});

app.get('/api/v1/me/orders/:orderId', requireAuth, async (req, res) => {
  const order = await getFullOrderForUser(req.params.orderId, req.user.id);
  if (!order) return res.status(404).json({ message: 'Encomenda nao encontrada' });
  return res.status(200).json(order);
});

// --- Jogos, Ofertas e Reviews ---
app.get('/api/v1/games', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM games ORDER BY name ASC');
  return res.status(200).json(rows.map(toPublicGame));
});

app.get('/api/v1/games/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Jogo nao encontrado' });
  return res.status(200).json(toPublicGame(rows[0]));
});

app.get('/api/v1/games/:id/offers', async (req, res) => {
  const gameRes = await pool.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
  if (!gameRes.rows[0]) return res.status(404).json({ message: 'Jogo nao encontrado' });

  const { rows } = await pool.query(
    `SELECT id, game_id AS "gameId", platform, edition, activation_platform AS "activationPlatform",
            region, price, currency, available, stock
     FROM game_offers WHERE game_id = $1 ORDER BY id ASC`,
    [req.params.id]
  );
  const formatted = rows.map((r) => ({
    ...r,
    price: r.price !== null ? Number(r.price) : null,
    stock: Number(r.stock),
  }));
  return res.status(200).json(formatted);
});

app.get('/api/v1/games/:id/reviews', async (req, res) => {
  const gameRes = await pool.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
  if (!gameRes.rows[0]) return res.status(404).json({ message: 'Jogo nao encontrado' });

  const { rows } = await pool.query(
    `SELECT r.id, r.game_id AS "gameId", r.user_id AS "userId",
            u.username, u.display_name AS "displayName",
            r.rating, r.comment, r.created_at AS "createdAt", r.updated_at AS "updatedAt"
     FROM game_reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.game_id = $1
     ORDER BY r.updated_at DESC`,
    [req.params.id]
  );
  return res.status(200).json(rows);
});

app.post('/api/v1/games/:id/reviews', requireAuth, async (req, res) => {
  const gameRes = await pool.query('SELECT id FROM games WHERE id = $1', [req.params.id]);
  if (!gameRes.rows[0]) return res.status(404).json({ message: 'Jogo nao encontrado' });

  const { rating, comment } = req.body || {};
  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ message: 'A classificacao (rating) deve ser um numero inteiro entre 1 e 5' });
  }

  const reviewId = `rev_${crypto.randomUUID().slice(0, 8)}`;
  const cleanComment = comment !== undefined ? String(comment).trim() : '';

  const { rows } = await pool.query(
    `INSERT INTO game_reviews (id, game_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (game_id, user_id)
     DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = NOW()
     RETURNING id, game_id AS "gameId", user_id AS "userId", rating, comment,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [reviewId, req.params.id, req.user.id, numericRating, cleanComment]
  );

  return res.status(201).json({
    ...rows[0],
    username: req.user.username,
    displayName: req.user.display_name,
  });
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor a correr na porta ${PORT} e ligado ao PostgreSQL`);
    });
  })
  .catch((err) => {
    console.error('Erro ao inicializar a base de dados PostgreSQL:', err);
    process.exit(1);
  });
