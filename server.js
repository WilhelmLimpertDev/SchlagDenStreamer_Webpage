const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 8000;
const MOD_PIN = "9876";
const SETTINGS_FILE = path.join(__dirname, 'game_settings.json');

const DEFAULT_GAMES = [
  { round: 1, name: "Jackbox: Fibbage", points: 1, has_subrounds: false, subrounds_target: 3 },
  { round: 2, name: "Lach-Challenge", points: 2, has_subrounds: true, subrounds_target: 3 },
  { round: 3, name: "Jackbox: Quiplash", points: 3, has_subrounds: false, subrounds_target: 3 },
  { round: 4, name: "Stadt, Land, Fluss", points: 4, has_subrounds: true, subrounds_target: 5 },
  { round: 5, name: "2. Lach-Challenge", points: 5, has_subrounds: true, subrounds_target: 3 },
  { round: 6, name: "Quiz", points: 6, has_subrounds: false, subrounds_target: 3 },
  { round: 7, name: "Jackbox: Survey Scramble", points: 7, has_subrounds: false, subrounds_target: 3 },
  { round: 8, name: "Überraschung", points: 0, has_subrounds: false, subrounds_target: 3 }
];

function loadSavedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error("Fehler beim Laden von game_settings.json:", e);
  }
  return {
    player1_name: "Oldmanstuff",
    player2_name: "Kuhmunity",
    total_rounds: 8,
    games: DEFAULT_GAMES
  };
}

let savedConfig = loadSavedSettings();

let gameState = {
  player1_name: savedConfig.player1_name || "Oldmanstuff",
  player2_name: savedConfig.player2_name || "Kuhmunity",
  score_streamer: 0,
  score_chat: 0,
  round: 1,
  total_rounds: savedConfig.total_rounds || 8,
  games: savedConfig.games || DEFAULT_GAMES,
  round_history: {},
  sub_history: {}
};

function initRoundHistory() {
  gameState.round_history = {};
  gameState.sub_history = {};
  for (let i = 1; i <= gameState.total_rounds; i++) {
    gameState.round_history[String(i)] = null;
    gameState.sub_history[String(i)] = [];
  }
}
initRoundHistory();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcastState() {
  const payload = JSON.stringify(gameState);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (e) {
        console.error('WebSocket Send-Fehler:', e);
      }
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  try {
    ws.send(JSON.stringify(gameState));
  } catch (e) {}
  ws.on('error', (err) => console.error('WS Error:', err));
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

app.post('/api/update', (req, res) => {
  const { pin, action, round_num, winner } = req.body;
  if (pin !== MOD_PIN) return res.status(403).json({ detail: "Ungültige Mod-PIN" });

  const targetRoundInt = round_num ? parseInt(round_num, 10) : gameState.round;
  const targetRoundStr = String(targetRoundInt);

  const currentGameObj = gameState.games.find(g => g.round === targetRoundInt);
  const roundPoints = currentGameObj ? parseInt(currentGameObj.points, 10) : 0;
  const maxSubrounds = currentGameObj && currentGameObj.has_subrounds ? (currentGameObj.subrounds_target || 3) : 3;

  if (!Array.isArray(gameState.sub_history[targetRoundStr])) {
    gameState.sub_history[targetRoundStr] = [];
  }

  if (action === "inc_streamer") {
    gameState.score_streamer += 1;
  } else if (action === "dec_streamer") {
    gameState.score_streamer = Math.max(0, gameState.score_streamer - 1);
  } else if (action === "inc_chat") {
    gameState.score_chat += 1;
  } else if (action === "dec_chat") {
    gameState.score_chat = Math.max(0, gameState.score_chat - 1);
  } else if (action === "add_sub_win") {
    if ((winner === "p1" || winner === "p2") && gameState.sub_history[targetRoundStr].length < maxSubrounds) {
      gameState.sub_history[targetRoundStr].push(winner);
    }
  } else if (action === "undo_sub_win") {
    if (gameState.sub_history[targetRoundStr].length > 0) {
      gameState.sub_history[targetRoundStr].pop();
    }
  } else if (action === "reset_sub") {
    gameState.sub_history[targetRoundStr] = [];
  } else if (action === "next_round") {
    if (gameState.round < gameState.total_rounds) gameState.round += 1;
  } else if (action === "prev_round") {
    if (gameState.round > 1) gameState.round -= 1;
  } else if (action === "win_streamer" || action === "win_chat" || action === "win_clear") {
    const previousWinner = gameState.round_history[targetRoundStr];

    if (previousWinner === "streamer") {
      gameState.score_streamer = Math.max(0, gameState.score_streamer - roundPoints);
    } else if (previousWinner === "chat") {
      gameState.score_chat = Math.max(0, gameState.score_chat - roundPoints);
    }

    if (action === "win_streamer") {
      gameState.round_history[targetRoundStr] = "streamer";
      gameState.score_streamer += roundPoints;
    } else if (action === "win_chat") {
      gameState.round_history[targetRoundStr] = "chat";
      gameState.score_chat += roundPoints;
    } else if (action === "win_clear") {
      gameState.round_history[targetRoundStr] = null;
    }
  } else if (action === "reset") {
    gameState.score_streamer = 0;
    gameState.score_chat = 0;
    gameState.round = 1;
    initRoundHistory();
  }

  broadcastState();
  return res.json({ status: "success", state: gameState });
});

app.post('/api/settings', (req, res) => {
  const { pin, player1_name, player2_name, total_rounds, games } = req.body;
  if (pin !== MOD_PIN) return res.status(403).json({ detail: "Ungültige Mod-PIN" });

  const p1 = (player1_name && player1_name.trim()) ? player1_name.trim() : "Oldmanstuff";
  const p2 = (player2_name && player2_name.trim()) ? player2_name.trim() : "Kuhmunity";
  const numRounds = Math.min(10, Math.max(1, parseInt(total_rounds, 10) || 8));
  const newGames = [];

  for (let i = 1; i <= numRounds; i++) {
    const incoming = games ? games.find(g => g.round === i) : null;
    newGames.push({
      round: i,
      name: incoming && incoming.name ? incoming.name.trim() : `Spiel ${i}`,
      points: incoming && incoming.points !== undefined ? Math.max(0, parseInt(incoming.points, 10)) : i,
      has_subrounds: incoming && Boolean(incoming.has_subrounds),
      subrounds_target: incoming && incoming.subrounds_target ? Math.max(1, parseInt(incoming.subrounds_target, 10)) : 3
    });
  }

  gameState.player1_name = p1;
  gameState.player2_name = p2;
  gameState.total_rounds = numRounds;
  gameState.games = newGames;
  if (gameState.round > numRounds) gameState.round = numRounds;

  const updatedHistory = {};
  const updatedSubHistory = {};
  for (let i = 1; i <= numRounds; i++) {
    const key = String(i);
    updatedHistory[key] = gameState.round_history[key] || null;
    updatedSubHistory[key] = gameState.sub_history[key] || [];
  }
  gameState.round_history = updatedHistory;
  gameState.sub_history = updatedSubHistory;

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      player1_name: p1,
      player2_name: p2,
      total_rounds: numRounds,
      games: newGames
    }, null, 2));
  } catch (e) {
    console.error("Konnte Einstellungen nicht schreiben:", e);
  }

  broadcastState();
  return res.json({ status: "success", state: gameState });
});

// Neuer Import-Endpunkt
app.post('/api/import', (req, res) => {
  const { pin, import_type, player1_name, player2_name, total_rounds, games, score_streamer, score_chat, round, round_history, sub_history } = req.body;
  if (pin !== MOD_PIN) return res.status(403).json({ detail: "Ungültige Mod-PIN" });

  const p1 = (player1_name && player1_name.trim()) ? player1_name.trim() : "Oldmanstuff";
  const p2 = (player2_name && player2_name.trim()) ? player2_name.trim() : "Kuhmunity";
  const numRounds = Math.min(10, Math.max(1, parseInt(total_rounds, 10) || 8));
  const newGames = [];

  for (let i = 1; i <= numRounds; i++) {
    const incoming = games ? games.find(g => g.round === i) : null;
    newGames.push({
      round: i,
      name: incoming && incoming.name ? incoming.name.trim() : `Spiel ${i}`,
      points: incoming && incoming.points !== undefined ? Math.max(0, parseInt(incoming.points, 10)) : i,
      has_subrounds: incoming && Boolean(incoming.has_subrounds),
      subrounds_target: incoming && incoming.subrounds_target ? Math.max(1, parseInt(incoming.subrounds_target, 10)) : 3
    });
  }

  gameState.player1_name = p1;
  gameState.player2_name = p2;
  gameState.total_rounds = numRounds;
  gameState.games = newGames;

  if (import_type === "full") {
    gameState.score_streamer = score_streamer || 0;
    gameState.score_chat = score_chat || 0;
    gameState.round = Math.min(numRounds, Math.max(1, round || 1));
    gameState.round_history = {};
    gameState.sub_history = {};
    for (let i = 1; i <= numRounds; i++) {
      const k = String(i);
      gameState.round_history[k] = (round_history && round_history[k]) ? round_history[k] : null;
      gameState.sub_history[k] = (sub_history && Array.isArray(sub_history[k])) ? sub_history[k] : [];
    }
  } else {
    if (gameState.round > numRounds) gameState.round = numRounds;
    const updatedHistory = {};
    const updatedSubHistory = {};
    for (let i = 1; i <= numRounds; i++) {
      const key = String(i);
      updatedHistory[key] = gameState.round_history[key] || null;
      updatedSubHistory[key] = gameState.sub_history[key] || [];
    }
    gameState.round_history = updatedHistory;
    gameState.sub_history = updatedSubHistory;
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      player1_name: p1,
      player2_name: p2,
      total_rounds: numRounds,
      games: newGames
    }, null, 2));
  } catch (e) {
    console.error("Konnte Einstellungen nicht schreiben:", e);
  }

  broadcastState();
  return res.json({ status: "success", state: gameState });
});

app.get('/health', (req, res) => res.send('OK'));

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});