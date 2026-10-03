from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from starlette.middleware.base import BaseHTTPMiddleware
import json
import os

app = FastAPI()

class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)

STREAMER_PIN = "1234"
MOD_PIN = "9876"
SETTINGS_FILE = "game_settings.json"

DEFAULT_GAMES = [
    {"round": 1, "name": "Jackbox: Fibbage", "points": 1, "has_subrounds": False, "subrounds_target": 3},
    {"round": 2, "name": "Lach-Challenge", "points": 2, "has_subrounds": True, "subrounds_target": 3},
    {"round": 3, "name": "Jackbox: Quiplash", "points": 3, "has_subrounds": False, "subrounds_target": 3},
    {"round": 4, "name": "Stadt, Land, Fluss", "points": 4, "has_subrounds": True, "subrounds_target": 5},
    {"round": 5, "name": "2. Lach-Challenge", "points": 5, "has_subrounds": True, "subrounds_target": 3},
    {"round": 6, "name": "Quiz", "points": 6, "has_subrounds": False, "subrounds_target": 3},
    {"round": 7, "name": "Jackbox: Survey Scramble", "points": 7, "has_subrounds": False, "subrounds_target": 3},
    {"round": 8, "name": "Überraschung", "points": 0, "has_subrounds": False, "subrounds_target": 3}
]

def load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Fehler beim Laden von {SETTINGS_FILE}: {e}")
    return {
        "player1_name": "Oldmanstuff",
        "player2_name": "Kuhmunity",
        "total_rounds": 8,
        "games": DEFAULT_GAMES
    }

saved_config = load_settings()
tot_rounds = saved_config.get("total_rounds", 8)

game_state = {
    "player1_name": saved_config.get("player1_name", "Oldmanstuff"),
    "player2_name": saved_config.get("player2_name", "Kuhmunity"),
    "score_streamer": 0,
    "score_chat": 0,
    "round": 1,
    "total_rounds": tot_rounds,
    "games": saved_config.get("games", DEFAULT_GAMES),
    "round_history": {str(i): None for i in range(1, tot_rounds + 1)},
    "sub_history": {str(i): [] for i in range(1, tot_rounds + 1)}
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
    winner: Optional[str] = None

class GameItem(BaseModel):
    round: int
    name: str
    points: int
    has_subrounds: Optional[bool] = False
    subrounds_target: Optional[int] = 3

class SettingsUpdate(BaseModel):
    pin: str
    player1_name: Optional[str] = "Oldmanstuff"
    player2_name: Optional[str] = "Kuhmunity"
    total_rounds: int
    games: List[GameItem]

class ImportPayload(BaseModel):
    pin: str
    import_type: str
    player1_name: Optional[str] = "Oldmanstuff"
    player2_name: Optional[str] = "Kuhmunity"
    total_rounds: int
    games: List[GameItem]
    score_streamer: Optional[int] = None
    score_chat: Optional[int] = None
    round: Optional[int] = None
    round_history: Optional[Dict[str, Any]] = None
    sub_history: Optional[Dict[str, Any]] = None

@app.post("/api/update")
async def update_score(data: StateUpdate):
    if data.pin != MOD_PIN:
        raise HTTPException(status_code=403, detail="Ungültige Mod-PIN")

    current_round = game_state["round"]
    target_round_int = data.round_num if data.round_num is not None else current_round
    target_round_str = str(target_round_int)

    game_match = next((g for g in game_state["games"] if g["round"] == target_round_int), None)
    round_points = int(game_match["points"]) if game_match else 0
    max_subs = game_match.get("subrounds_target", 3) if game_match else 3

    if target_round_str not in game_state["sub_history"]:
        game_state["sub_history"][target_round_str] = []

    if data.action == "inc_streamer":
        game_state["score_streamer"] += 1
    elif data.action == "dec_streamer":
        game_state["score_streamer"] = max(0, game_state["score_streamer"] - 1)
    elif data.action == "inc_chat":
        game_state["score_chat"] += 1
    elif data.action == "dec_chat":
        game_state["score_chat"] = max(0, game_state["score_chat"] - 1)

    elif data.action == "add_sub_win":
        if data.winner in ["p1", "p2"] and len(game_state["sub_history"][target_round_str]) < max_subs:
            game_state["sub_history"][target_round_str].append(data.winner)
    elif data.action == "undo_sub_win":
        if len(game_state["sub_history"][target_round_str]) > 0:
            game_state["sub_history"][target_round_str].pop()
    elif data.action == "reset_sub":
        game_state["sub_history"][target_round_str] = []

    elif data.action == "next_round":
        if game_state["round"] < game_state["total_rounds"]:
            game_state["round"] += 1
    elif data.action == "prev_round":
        if game_state["round"] > 1:
            game_state["round"] -= 1

    elif data.action in ["win_streamer", "win_chat", "win_clear"]:
        previous_winner = game_state["round_history"].get(target_round_str)

        if previous_winner == "streamer":
            game_state["score_streamer"] = max(0, game_state["score_streamer"] - round_points)
        elif previous_winner == "chat":
            game_state["score_chat"] = max(0, game_state["score_chat"] - round_points)

        if data.action == "win_streamer":
            game_state["round_history"][target_round_str] = "streamer"
            game_state["score_streamer"] += round_points
        elif data.action == "win_chat":
            game_state["round_history"][target_round_str] = "chat"
            game_state["score_chat"] += round_points
        elif data.action == "win_clear":
            game_state["round_history"][target_round_str] = None

    elif data.action == "reset":
        game_state["score_streamer"] = 0
        game_state["score_chat"] = 0
        game_state["round"] = 1
        tot = game_state["total_rounds"]
        game_state["round_history"] = {str(i): None for i in range(1, tot + 1)}
        game_state["sub_history"] = {str(i): [] for i in range(1, tot + 1)}

    await manager.broadcast(game_state)
    return {"status": "success", "state": game_state}

@app.post("/api/settings")
async def save_settings(data: SettingsUpdate):
    if data.pin != MOD_PIN:
        raise HTTPException(status_code=403, detail="Ungültige Mod-PIN")

    p1 = data.player1_name.strip() if data.player1_name and data.player1_name.strip() else "Oldmanstuff"
    p2 = data.player2_name.strip() if data.player2_name and data.player2_name.strip() else "Kuhmunity"
    num_rounds = min(10, max(1, data.total_rounds))
    new_games = []
    for g in data.games:
        if g.round <= num_rounds:
            new_games.append({
                "round": g.round,
                "name": g.name.strip(),
                "points": max(0, g.points),
                "has_subrounds": bool(g.has_subrounds),
                "subrounds_target": max(1, g.subrounds_target or 3)
            })

    game_state["player1_name"] = p1
    game_state["player2_name"] = p2
    game_state["total_rounds"] = num_rounds
    game_state["games"] = new_games
    if game_state["round"] > num_rounds:
        game_state["round"] = num_rounds

    updated_history = {}
    updated_subs = {}
    for i in range(1, num_rounds + 1):
        k = str(i)
        updated_history[k] = game_state["round_history"].get(k, None)
        updated_subs[k] = game_state["sub_history"].get(k, [])
    game_state["round_history"] = updated_history
    game_state["sub_history"] = updated_subs

    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "player1_name": p1,
                "player2_name": p2,
                "total_rounds": num_rounds,
                "games": new_games
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Fehler beim Speichern: {e}")

    await manager.broadcast(game_state)
    return {"status": "success", "state": game_state}

@app.post("/api/import")
async def import_data(data: ImportPayload):
    if data.pin != MOD_PIN:
        raise HTTPException(status_code=403, detail="Ungültige Mod-PIN")

    p1 = data.player1_name.strip() if data.player1_name and data.player1_name.strip() else "Oldmanstuff"
    p2 = data.player2_name.strip() if data.player2_name and data.player2_name.strip() else "Kuhmunity"
    num_rounds = min(10, max(1, data.total_rounds))
    new_games = []
    for g in data.games:
        if g.round <= num_rounds:
            new_games.append({
                "round": g.round,
                "name": g.name.strip(),
                "points": max(0, g.points),
                "has_subrounds": bool(g.has_subrounds),
                "subrounds_target": max(1, g.subrounds_target or 3)
            })

    game_state["player1_name"] = p1
    game_state["player2_name"] = p2
    game_state["total_rounds"] = num_rounds
    game_state["games"] = new_games

    if data.import_type == "full":
        game_state["score_streamer"] = data.score_streamer or 0
        game_state["score_chat"] = data.score_chat or 0
        game_state["round"] = min(num_rounds, max(1, data.round or 1))
        game_state["round_history"] = {str(i): (data.round_history or {}).get(str(i), None) for i in range(1, num_rounds + 1)}
        game_state["sub_history"] = {str(i): (data.sub_history or {}).get(str(i), []) for i in range(1, num_rounds + 1)}
    else:
        if game_state["round"] > num_rounds:
            game_state["round"] = num_rounds
        updated_history = {}
        updated_subs = {}
        for i in range(1, num_rounds + 1):
            k = str(i)
            updated_history[k] = game_state["round_history"].get(k, None)
            updated_subs[k] = game_state["sub_history"].get(k, [])
        game_state["round_history"] = updated_history
        game_state["sub_history"] = updated_subs

    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "player1_name": p1,
                "player2_name": p2,
                "total_rounds": num_rounds,
                "games": new_games
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Fehler beim Speichern: {e}")

    await manager.broadcast(game_state)
    return {"status": "success", "state": game_state}

app.mount("/", StaticFiles(directory="static", html=True), name="static")