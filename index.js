require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

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

const games = [
  {
    id: 'elden-ring',
    slug: 'elden-ring',
    name: 'Elden Ring',
    description: 'Um RPG de acao num vasto mundo de fantasia.',
    backgroundImage: '',
    coverImage: '',
    screenshots: [],
    genres: ['RPG', 'Acao'],
    platforms: ['PC', 'PlayStation', 'Xbox'],
    released: '2022-02-25',
    rating: null,
    ratingSource: null,
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

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
