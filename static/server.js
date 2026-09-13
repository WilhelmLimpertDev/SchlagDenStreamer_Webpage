const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Port von Hostinger oder Standard 8000
const PORT = process.env.PORT || 8000;

// Sicherheits-PINs
const STREAMER_PIN = "1234";
const MOD_PIN = "9876";
const TOTAL_ROUNDS = 7;

// Zentraler Spielstand
let gameState = {
  score_streamer: 0,
  score_chat: 0,
  round: 1,
  round_history: {}
};

// Rundenhistorie initialisieren
for (let i = 1; i <= TOTAL_ROUNDS; i++) {
  gameState.round_history[String(i)] = null;
}

// JSON-Body Parser für Express
app.use(express.json());

// Statische Dateien aus dem Ordner 'static' ausliefern
app.use(express.static(path.join(__dirname, 'static')));

// WebSocket: Live-Verbindungen verwalten
function broadcastState() {
  const payload = JSON.stringify(gameState);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  // Sofort den aktuellen Stand an den frisch verbundenen Client schicken
  ws.send(JSON.stringify(gameState));

  ws.on('error', (err) => console.error('WebSocket Fehler:', err));
});

// REST API für Mod-Aktionen
app.post('/api/update', (req, res) => {
  const { pin, action, round_num } = req.body;

  if (pin !== MOD_PIN) {
    return res.status(403).json({ detail: "Ungueltige Mod-PIN" });
  }

  const targetRoundInt = round_num ? parseInt(round_num, 10) : gameState.round;
  const targetRoundStr = String(targetRoundInt);
  const roundPoints = targetRoundInt; // Runde 1 = 1 Pkt, Runde 2 = 2 Pkte, usw.

  // Manuelle Punkte-Korrekturen
  if (action === "inc_streamer") {
    gameState.score_streamer += 1;
  } else if (action === "dec_streamer") {
    gameState.score_streamer = Math.max(0, gameState.score_streamer - 1);
  } else if (action === "inc_chat") {
    gameState.score_chat += 1;
  } else if (action === "dec_chat") {
    gameState.score_chat = Math.max(0, gameState.score_chat - 1);
  }

  // Runden-Navigation
  else if (action === "next_round") {
    if (gameState.round < TOTAL_ROUNDS) gameState.round += 1;
  } else if (action === "prev_round") {
    if (gameState.round > 1) gameState.round -= 1;
  }

  // Runden-Sieger & Punkte-Verrechnung
  else if (action === "win_streamer" || action === "win_chat" || action === "win_clear") {
    const previousWinner = gameState.round_history[targetRoundStr];

    // Vorherige Punkte abziehen
    if (previousWinner === "streamer") {
      gameState.score_streamer = Math.max(0, gameState.score_streamer - roundPoints);
    } else if (previousWinner === "chat") {
      gameState.score_chat = Math.max(0, gameState.score_chat - roundPoints);
    }

    // Neuen Gewinner und Punkte eintragen
    if (action === "win_streamer") {
      gameState.round_history[targetRoundStr] = "streamer";
      gameState.score_streamer += roundPoints;
    } else if (action === "win_chat") {
      gameState.round_history[targetRoundStr] = "chat";
      gameState.score_chat += roundPoints;
    } else if (action === "win_clear") {
      gameState.round_history[targetRoundStr] = null;
    }
  }

  // Spiel zurücksetzen
  else if (action === "reset") {
    gameState.score_streamer = 0;
    gameState.score_chat = 0;
    gameState.round = 1;
    for (let i = 1; i <= TOTAL_ROUNDS; i++) {
      gameState.round_history[String(i)] = null;
    }
  }

  // Live-Broadcast an alle Overlays & Host-Panels
  broadcastState();

  return res.json({ status: "success", state: gameState });
});

// Server starten
server.listen(PORT, () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});