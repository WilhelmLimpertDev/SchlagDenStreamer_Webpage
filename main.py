"""Das Backend verwaltet den aktuellen Spielstand, prüft die PINs und sendet Aktualisierungen per
   WebSocket an alle verbundenen Clients."""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI()

STREAMER_PIN = "1234"
MOD_PIN = "9876"
TOTAL_ROUNDS = 7

# Zentraler Spielstand
game_state = {
    "score_streamer": 0,
    "score_chat": 0,
    "round": 1,
    "round_history": {str(i): None for i in range(1, TOTAL_ROUNDS + 1)}
}

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                pass

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    await websocket.send_json(game_state)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

class StateUpdate(BaseModel):
    pin: str
    action: str
    round_num: Optional[int] = None

@app.post("/api/update")
async def update_score(data: StateUpdate):
    if data.pin != MOD_PIN:
        raise HTTPException(status_code=403, detail="Ungültige Mod-PIN")

    current_round = game_state["round"]
    target_round_int = data.round_num if data.round_num is not None else current_round
    target_round_str = str(target_round_int)
    round_points = target_round_int  # Runde 1 = 1 Punkt, Runde 2 = 2 Punkte, etc.

    # 1. Manuelle Korrekturen (+/- 1 Punkt)
    if data.action == "inc_streamer":
        game_state["score_streamer"] += 1
    elif data.action == "dec_streamer":
        game_state["score_streamer"] = max(0, game_state["score_streamer"] - 1)
    elif data.action == "inc_chat":
        game_state["score_chat"] += 1
    elif data.action == "dec_chat":
        game_state["score_chat"] = max(0, game_state["score_chat"] - 1)

    # 2. Rundenwechsel manuell
    elif data.action == "next_round":
        if game_state["round"] < TOTAL_ROUNDS:
            game_state["round"] += 1
    elif data.action == "prev_round":
        if game_state["round"] > 1:
            game_state["round"] -= 1

    # 3. Rundensieger zuweisen & Punkte automatisch verrechnen
    elif data.action in ["win_streamer", "win_chat", "win_clear"]:
        previous_winner = game_state["round_history"].get(target_round_str)

        # Vorherige Punkte abziehen, falls die Runde schon vergeben war
        if previous_winner == "streamer":
            game_state["score_streamer"] = max(0, game_state["score_streamer"] - round_points)
        elif previous_winner == "chat":
            game_state["score_chat"] = max(0, game_state["score_chat"] - round_points)

        # Neuen Gewinner und Punkte setzen
        if data.action == "win_streamer":
            game_state["round_history"][target_round_str] = "streamer"
            game_state["score_streamer"] += round_points
        elif data.action == "win_chat":
            game_state["round_history"][target_round_str] = "chat"
            game_state["score_chat"] += round_points
        elif data.action == "win_clear":
            game_state["round_history"][target_round_str] = None

    # 4. Spiel zurücksetzen
    elif data.action == "reset":
        game_state["score_streamer"] = 0
        game_state["score_chat"] = 0
        game_state["round"] = 1
        game_state["round_history"] = {str(i): None for i in range(1, TOTAL_ROUNDS + 1)}

    await manager.broadcast(game_state)
    return {"status": "success", "state": game_state}

app.mount("/", StaticFiles(directory="static", html=True), name="static")
