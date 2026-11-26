require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-prod';

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
      available BOOLEAN NOT NULL DEFAULT FALSE
    );

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
  `);

  // Seed inicial do Elden Ring e oferta estrutural se ainda nao existirem
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
    INSERT INTO game_offers (id, game_id, platform, edition, activation_platform, region, price, currency, available)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO NOTHING
    `,
    ['offer-001', 'elden-ring', 'PC', 'Standard', 'Steam', 'EU', null, 'EUR', false]
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
  } catch (err) {
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
    if (err.code === '23503') {
      return res.status(404).json({ message: 'Jogo nao encontrado' });
    }
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
            region, price, currency, available
     FROM game_offers WHERE game_id = $1`,
    [req.params.id]
  );
  const formatted = rows.map((r) => ({ ...r, price: r.price !== null ? Number(r.price) : null }));
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
