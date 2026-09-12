"""Das Backend verwaltet den aktuellen Spielstand, prüft die PINs und sendet Aktualisierungen per
   WebSocket an alle verbundenen Clients."""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List

app = FastAPI()

# Sicherheits-Pins (später via Umgebungsvariablen konfigurierbar)
STREAMER_PIN = "1234"
MOD_PIN = "9876"

# Zentraler Spielstand im Arbeitsspeicher
game_state = {
    "score_streamer": 0,
    "score_chat": 0,
    "round": 1
}

# WebSocket Verbindungsmanager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

# WebSocket-Endpunkt für die Live-Aktualisierung
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Sofort aktuellen Stand beim Verbinden senden
    await websocket.send_json(game_state)
    try:
        while True:
            await websocket.receive_text()  # Verbindung offen halten
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# Datenmodell für Updates vom Mod
class StateUpdate(BaseModel):
    pin: str
    action: str  # z.B. "inc_streamer", "dec_streamer", "inc_chat", "dec_chat", "next_round", "reset"

@app.post("/api/update")
async def update_score(data: StateUpdate):
    if data.pin != MOD_PIN:
        raise HTTPException(status_code=403, detail="Ungültige Mod-PIN")

    if data.action == "inc_streamer":
        game_state["score_streamer"] += 1
    elif data.action == "dec_streamer":
        game_state["score_streamer"] = max(0, game_state["score_streamer"] - 1)
    elif data.action == "inc_chat":
        game_state["score_chat"] += 1
    elif data.action == "dec_chat":
        game_state["score_chat"] = max(0, game_state["score_chat"] - 1)
    elif data.action == "next_round":
        game_state["round"] += 1
    elif data.action == "reset":
        game_state["score_streamer"] = 0
        game_state["score_chat"] = 0
        game_state["round"] = 1

    # Alle angeschlossenen Screens in Echtzeit updaten
    await manager.broadcast(game_state)
    return {"status": "success", "state": game_state}

# Statische HTML-Dateien ausliefern
app.mount("/", StaticFiles(directory="static", html=True), name="static")
