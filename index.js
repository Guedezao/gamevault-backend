require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-prod';

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

app.use(express.json());

// Armazenamento temporario em memoria (sera substituido pelo PostgreSQL)
const users = [];
const librariesByUser = new Map();
const wishlistsByUser = new Map();
let userCounter = 1;

const VALID_LIBRARY_STATUSES = ['backlog', 'playing', 'completed', 'dropped'];

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
  const body = {
    ...payload,
    iat: nowSec,
    exp: nowSec + parseTtlSeconds(ttl),
  };
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

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Token de autenticacao em falta ou invalido' });
  }
  const payload = verifyToken(token);
  if (!payload || !payload.sub) {
    return res.status(401).json({ message: 'Token invalido ou expirado' });
  }
  const user = users.find((u) => u.id === payload.sub);
  if (!user) {
    return res.status(401).json({ message: 'Utilizador nao encontrado' });
  }
  req.user = user;
  return next();
}

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || null,
    coverUrl: user.coverUrl || null,
  };
}

function getLibraryMap(userId) {
  if (!librariesByUser.has(userId)) {
    librariesByUser.set(userId, new Map());
  }
  return librariesByUser.get(userId);
}

function getWishlistSet(userId) {
  if (!wishlistsByUser.has(userId)) {
    wishlistsByUser.set(userId, new Set());
  }
  return wishlistsByUser.get(userId);
}

function parseMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) {
      return reject(new Error('Content-Type multipart/form-data em falta'));
    }
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
        if (raw.slice(dataEnd - 2, dataEnd).toString('utf8') === '\r\n') {
          dataEnd -= 2;
        }

        const nameMatch = headersText.match(/name="([^"]+)"/i);
        const filenameMatch = headersText.match(/filename="([^"]*)"/i);
        const typeMatch = headersText.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch && nameMatch[1] === 'file') {
          const fileBuf = raw.slice(dataStart, dataEnd);
          const mime = (typeMatch && typeMatch[1].trim()) || 'application/octet-stream';
          const filename = (filenameMatch && filenameMatch[1]) || 'upload';
          return resolve({
            filename,
            mime,
            size: fileBuf.length,
            dataUrl: `data:${mime};base64,${fileBuf.toString('base64')}`,
          });
        }
        pos = nextBoundary;
      }
      return reject(new Error('Campo "file" nao encontrado no upload'));
    });
    req.on('error', reject);
  });
}

// --- Autenticacao ---
app.post('/api/v1/auth/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email e password sao obrigatorios' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedUsername = String(username).trim();

  if (users.some((u) => u.email === normalizedEmail)) {
    return res.status(409).json({ message: 'Email ja registado' });
  }
  if (users.some((u) => u.username.toLowerCase() === normalizedUsername.toLowerCase())) {
    return res.status(409).json({ message: 'Username ja em utilizacao' });
  }

  const newUser = {
    id: `u${userCounter++}`,
    email: normalizedEmail,
    username: normalizedUsername,
    displayName: normalizedUsername,
    bio: '',
    avatarUrl: null,
    coverUrl: null,
    passwordHash: hashPassword(String(password)),
  };

  users.push(newUser);
  return res.status(201).json(toPublicUser(newUser));
});

app.post('/api/v1/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email e password sao obrigatorios' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = users.find((u) => u.email === normalizedEmail);
  if (!user || !verifyPassword(String(password), user.passwordHash)) {
    return res.status(401).json({ message: 'Credenciais invalidas' });
  }

  const accessToken = signToken({ sub: user.id, email: user.email }, process.env.TOKEN_TTL);
  return res.status(200).json({
    accessToken,
    tokenType: 'Bearer',
    user: toPublicUser(user),
  });
});

app.get('/api/v1/auth/me', requireAuth, (req, res) => {
  return res.status(200).json(toPublicUser(req.user));
});

// --- Biblioteca ---
app.get('/api/v1/me/library', requireAuth, (req, res) => {
  const lib = getLibraryMap(req.user.id);
  return res.status(200).json(Array.from(lib.values()));
});

app.put('/api/v1/me/library/:gameId', requireAuth, (req, res) => {
  const { gameId } = req.params;
  const status = (req.body && req.body.status) || 'backlog';
  if (!VALID_LIBRARY_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Estado invalido. Valores permitidos: ${VALID_LIBRARY_STATUSES.join(', ')}`,
    });
  }

  const lib = getLibraryMap(req.user.id);
  const existing = lib.get(gameId);
  const now = new Date().toISOString();
  const entry = {
    gameId,
    status,
    updatedAt: now,
    addedAt: existing ? existing.addedAt : now,
  };
  lib.set(gameId, entry);
  return res.status(200).json(entry);
});

app.delete('/api/v1/me/library/:gameId', requireAuth, (req, res) => {
  const { gameId } = req.params;
  const lib = getLibraryMap(req.user.id);
  if (!lib.has(gameId)) {
    return res.status(404).json({ message: 'Jogo nao encontrado na biblioteca' });
  }
  lib.delete(gameId);
  return res.status(204).send();
});

// --- Wishlist ---
app.get('/api/v1/me/wishlist', requireAuth, (req, res) => {
  const wish = getWishlistSet(req.user.id);
  const items = Array.from(wish.values()).map((gameId) => ({ gameId }));
  return res.status(200).json(items);
});

app.put('/api/v1/me/wishlist/:gameId', requireAuth, (req, res) => {
  const { gameId } = req.params;
  const wish = getWishlistSet(req.user.id);
  wish.add(gameId);
  return res.status(200).json({ gameId, wishlisted: true });
});

app.delete('/api/v1/me/wishlist/:gameId', requireAuth, (req, res) => {
  const { gameId } = req.params;
  const wish = getWishlistSet(req.user.id);
  if (!wish.has(gameId)) {
    return res.status(404).json({ message: 'Jogo nao encontrado na wishlist' });
  }
  wish.delete(gameId);
  return res.status(204).send();
});

// --- Perfil ---
app.get('/api/v1/me/profile', requireAuth, (req, res) => {
  return res.status(200).json(toPublicUser(req.user));
});

app.patch('/api/v1/me/profile', requireAuth, (req, res) => {
  const { displayName, username, bio } = req.body || {};

  if (username !== undefined) {
    const cleanUsername = String(username).trim();
    if (!cleanUsername) {
      return res.status(400).json({ message: 'Username nao pode estar vazio' });
    }
    const taken = users.some(
      (u) => u.id !== req.user.id && u.username.toLowerCase() === cleanUsername.toLowerCase()
    );
    if (taken) {
      return res.status(409).json({ message: 'Username ja em utilizacao' });
    }
    req.user.username = cleanUsername;
  }

  if (displayName !== undefined) {
    req.user.displayName = String(displayName).trim();
  }

  if (bio !== undefined) {
    req.user.bio = String(bio);
  }

  return res.status(200).json(toPublicUser(req.user));
});

app.post('/api/v1/me/avatar', requireAuth, async (req, res) => {
  try {
    const file = await parseMultipartFile(req);
    req.user.avatarUrl = file.dataUrl;
    return res.status(200).json({ avatarUrl: req.user.avatarUrl, user: toPublicUser(req.user) });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Falha no upload do avatar' });
  }
});

app.delete('/api/v1/me/avatar', requireAuth, (req, res) => {
  req.user.avatarUrl = null;
  return res.status(200).json({ avatarUrl: null, user: toPublicUser(req.user) });
});

app.post('/api/v1/me/cover', requireAuth, async (req, res) => {
  try {
    const file = await parseMultipartFile(req);
    req.user.coverUrl = file.dataUrl;
    return res.status(200).json({ coverUrl: req.user.coverUrl, user: toPublicUser(req.user) });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Falha no upload da capa' });
  }
});

app.delete('/api/v1/me/cover', requireAuth, (req, res) => {
  req.user.coverUrl = null;
  return res.status(200).json({ coverUrl: null, user: toPublicUser(req.user) });
});

// --- Jogos e Ofertas ---
const games = [
  {
    id: 'elden-ring',
    slug: 'elden-ring',
    name: 'Elden Ring',
    description: 'Um RPG de acao num vasto mundo de fantasia.',
    backgroundImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/page_bg_generated_v6b.jpg',
    coverImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/library_600x900.jpg',
    screenshots: [
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/ss_ae44317e3bd07b7698b4d2a93d91c7d8814a162b.1920x1080.jpg',
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/ss_3c41384a24d86dddd58a8f61db77f9dc0bfda8b5.1920x1080.jpg',
    ],
    genres: ['RPG', 'Acao'],
    platforms: ['PC', 'PlayStation', 'Xbox'],
    released: '2022-02-25',
    rating: null,
    ratingSource: null,
    systemRequirements: {
      minimum: {
        os: null,
        processor: null,
        memory: null,
        graphics: null,
        storage: null,
        directX: null,
      },
      recommended: {
        os: null,
        processor: null,
        memory: null,
        graphics: null,
        storage: null,
        directX: null,
      },
    },
  },
];

const gameOffers = [
  {
    id: 'offer-001',
    gameId: 'elden-ring',
    platform: 'PC',
    edition: 'Standard',
    activationPlatform: 'Steam',
    region: 'EU',
    price: null,
    currency: 'EUR',
    available: false,
  },
];

app.get('/api/v1/games', (req, res) => {
  res.json(games);
});

app.get('/api/v1/games/:id', (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) {
    return res.status(404).json({ message: 'Jogo nao encontrado' });
  }
  return res.json(game);
});

app.get('/api/v1/games/:id/offers', (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) {
    return res.status(404).json({ message: 'Jogo nao encontrado' });
  }
  const offers = gameOffers.filter((o) => o.gameId === game.id);
  return res.status(200).json(offers);
});

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
