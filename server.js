const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// Verhindert, dass der Server bei unerwarteten Fehlern abstürzt
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception abgefangen:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection abgefangen:', reason);
});

const app = express();
const server = http.createServer(app);

// Port von Hostinger Umgebungsvariablen übernehmen
const PORT = process.env.PORT || 8000;

const STREAMER_PIN = "1234";
const MOD_PIN = "9876";
const TOTAL_ROUNDS = 8;

let gameState = {
  score_streamer: 0,
  score_chat: 0,
  round: 1,
  round_history: {}
};

for (let i = 1; i <= TOTAL_ROUNDS; i++) {
  gameState.round_history[String(i)] = null;
}

// CORS & No-Cache Header für zuverlässigen Live-Zugriff
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// WebSocket Server mit Fehlerbehandlung
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcastState() {
  const payload = JSON.stringify(gameState);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (e) {
        console.error('Fehler beim Senden an Client:', e);
      }
    }
  });
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  try {
    ws.send(JSON.stringify(gameState));
  } catch (e) {
    console.error('Initialer Send-Fehler:', e);
  }

  ws.on('error', (err) => {
    console.error('Client WebSocket Fehler:', err);
  });
});

// Heartbeat Ping alle 25 Sekunden (verhindert Timeout durch Hostinger/Nginx-Proxy)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// REST API
app.post('/api/update', (req, res) => {
  const { pin, action, round_num } = req.body;

  if (pin !== MOD_PIN) {
    return res.status(403).json({ detail: "Ungültige Mod-PIN" });
  }

  const targetRoundInt = round_num ? parseInt(round_num, 10) : gameState.round;
  const targetRoundStr = String(targetRoundInt);
  const roundPoints = targetRoundInt === 8 ? 0 : targetRoundInt;

  if (action === "inc_streamer") {
    gameState.score_streamer += 1;
  } else if (action === "dec_streamer") {
    gameState.score_streamer = Math.max(0, gameState.score_streamer - 1);
  } else if (action === "inc_chat") {
    gameState.score_chat += 1;
  } else if (action === "dec_chat") {
    gameState.score_chat = Math.max(0, gameState.score_chat - 1);
  } else if (action === "next_round") {
    if (gameState.round < TOTAL_ROUNDS) gameState.round += 1;
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
    for (let i = 1; i <= TOTAL_ROUNDS; i++) {
      gameState.round_history[String(i)] = null;
    }
  }

  broadcastState();
  return res.json({ status: "success", state: gameState });
});

// Fallback für alle anderen Routen auf index.html oder 404 vermeiden
app.get('/health', (req, res) => res.send('OK'));

server.listen(PORT, () => {
  console.log(`Server läuft stabil auf Port ${PORT}`);
});