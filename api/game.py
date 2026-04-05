import json
import math
import os
import random
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler


REDIS_REST_URL = os.environ.get("REDIS_REST_URL")
REDIS_REST_TOKEN = os.environ.get("REDIS_REST_TOKEN")
REDIS_URL = os.environ.get("REDIS_URL")

ARENA = {
    "width": 2800,
    "height": 1800,
    "center_x": 1400,
    "center_y": 900,
    "island_radius": 760,
}

ROLE_STATS = {
    "wizard": {
        "max_health": 90,
        "speed": 205,
        "radius": 24,
        "basic_damage": 5,
        "basic_range": 240,
        "basic_cooldown": 0.4,
        "abilities": {"Q": {"name": "Arc Burst"}, "E": {"name": "Veil Step"}},
    },
    "fighter": {
        "max_health": 125,
        "speed": 175,
        "radius": 26,
        "basic_damage": 9,
        "basic_range": 100,
        "basic_cooldown": 0.52,
        "abilities": {"Q": {"name": "Seismic Slam"}, "E": {"name": "Rift Slash"}},
    },
    "juggernaut": {
        "max_health": 1500,
        "speed": 145,
        "radius": 36,
        "basic_damage": 24,
        "basic_range": 120,
        "basic_cooldown": 0.9,
        "abilities": {"Q": {"name": "Earthquake"}, "E": {"name": "Hunter Leap"}, "R": {"name": "Cyclone Maul"}},
    },
}

ROLE_COLORS = {"wizard": "#9ae2ff", "fighter": "#ffd86e", "juggernaut": "#4db3ff"}


def now():
    return time.time()


def clamp(value, low, high):
    return max(low, min(high, value))


def normalize(x, y):
    length = math.hypot(x, y)
    if length <= 0:
        return 0.0, 0.0
    return x / length, y / length


def distance(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def make_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(4))


def redis_request(command):
    if REDIS_REST_URL and REDIS_REST_TOKEN:
        payload = json.dumps(command).encode("utf-8")
        request = urllib.request.Request(
            REDIS_REST_URL,
            data=payload,
            headers={
                "Authorization": f"Bearer {REDIS_REST_TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    if REDIS_URL:
        return {"result": redis_tcp_request(command)}

    raise RuntimeError("Missing Redis configuration. Set REDIS_URL or REDIS_REST_URL/REDIS_REST_TOKEN in Vercel.")


def redis_tcp_request(command):
    parsed = urllib.parse.urlparse(REDIS_URL)
    host = parsed.hostname
    port = parsed.port or (6380 if parsed.scheme == "rediss" else 6379)
    password = parsed.password
    if not host:
        raise RuntimeError("REDIS_URL is invalid.")

    raw_socket = socket.create_connection((host, port), timeout=5)
    conn = raw_socket
    if parsed.scheme == "rediss":
        context = ssl.create_default_context()
        conn = context.wrap_socket(raw_socket, server_hostname=host)

    try:
        if password:
            write_resp(conn, ["AUTH", password])
            read_resp(conn)
        write_resp(conn, command)
        return read_resp(conn)
    finally:
        conn.close()


def write_resp(conn, values):
    encoded = [f"*{len(values)}\r\n".encode("utf-8")]
    for value in values:
        if value is None:
            value = ""
        if not isinstance(value, (bytes, bytearray)):
            value = str(value).encode("utf-8")
        encoded.append(f"${len(value)}\r\n".encode("utf-8"))
        encoded.append(value + b"\r\n")
    conn.sendall(b"".join(encoded))


def read_line(conn):
    chunks = []
    while True:
        char = conn.recv(1)
        if not char:
            raise RuntimeError("Redis connection closed unexpectedly.")
        chunks.append(char)
        if len(chunks) >= 2 and chunks[-2:] == [b"\r", b"\n"]:
            return b"".join(chunks[:-2])


def read_exact(conn, size):
    data = b""
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise RuntimeError("Redis connection closed unexpectedly.")
        data += chunk
    return data


def read_resp(conn):
    prefix = conn.recv(1)
    if not prefix:
        raise RuntimeError("Redis connection closed unexpectedly.")
    if prefix == b"+":
        return read_line(conn).decode("utf-8")
    if prefix == b"-":
        raise RuntimeError(read_line(conn).decode("utf-8"))
    if prefix == b":":
        return int(read_line(conn))
    if prefix == b"$":
        length = int(read_line(conn))
        if length == -1:
            return None
        data = read_exact(conn, length)
        read_exact(conn, 2)
        return data.decode("utf-8")
    if prefix == b"*":
        length = int(read_line(conn))
        if length == -1:
            return None
        return [read_resp(conn) for _ in range(length)]
    raise RuntimeError("Unsupported Redis response type.")


def get_room(code):
    response = redis_request(["GET", f"room:{code}"])
    value = response.get("result")
    return json.loads(value) if value else None


def set_room(code, room):
    redis_request(["SET", f"room:{code}", json.dumps(room)])


def room_exists(code):
    response = redis_request(["EXISTS", f"room:{code}"])
    return bool(response.get("result"))


def create_room():
    code = make_code()
    while room_exists(code):
        code = make_code()
    room = {
        "code": code,
        "created_at": now(),
        "phase": "Lobby",
        "message": "Waiting for players",
        "players": {},
        "projectiles": [],
        "effects": [],
        "winner": None,
        "started": False,
        "match_time": 0.0,
        "last_tick": now(),
        "host_view": {"camera_x": ARENA["center_x"], "camera_y": ARENA["center_y"], "zoom": 0.58},
    }
    set_room(code, room)
    return room


def new_player(name):
    return {
        "id": uuid.uuid4().hex[:10],
        "name": (name or "Hero").strip()[:18] or "Hero",
        "preferred_role": "random",
        "role": None,
        "team": None,
        "x": ARENA["center_x"],
        "y": ARENA["center_y"],
        "vx": 0.0,
        "vy": 0.0,
        "facing": 0.0,
        "radius": 24,
        "max_health": 100,
        "health": 100,
        "speed": 150,
        "basic_damage": 8,
        "basic_range": 100,
        "basic_cooldown": 0.0,
        "cooldowns": {},
        "invisible_until": 0.0,
        "flash_until": 0.0,
        "dead": False,
        "input": {"move_x": 0.0, "move_y": 0.0, "aim_x": 1.0, "aim_y": 0.0, "basic": False, "Q": False, "E": False, "R": False},
    }


def assign_match_roles(room):
    players = list(room["players"].values())
    if len(players) < 2:
        raise ValueError("At least 2 players are required.")
    juggernaut = random.choice(players)
    angle_step = (math.pi * 2) / len(players)
    survivor_ring = ARENA["island_radius"] * 0.66
    for index, player in enumerate(players):
        role = "juggernaut" if player["id"] == juggernaut["id"] else (
            player["preferred_role"] if player["preferred_role"] in {"wizard", "fighter"} else ("wizard" if index % 2 == 0 else "fighter")
        )
        stats = ROLE_STATS[role]
        player["role"] = role
        player["team"] = "juggernaut" if role == "juggernaut" else "survivor"
        player["max_health"] = stats["max_health"]
        player["health"] = stats["max_health"]
        player["speed"] = stats["speed"]
        player["radius"] = stats["radius"]
        player["basic_damage"] = stats["basic_damage"]
        player["basic_range"] = stats["basic_range"]
        player["basic_cooldown"] = 0.0
        player["cooldowns"] = {key: 0.0 for key in stats["abilities"].keys()}
        player["invisible_until"] = 0.0
        player["flash_until"] = 0.0
        player["dead"] = False
        player["input"].update({"basic": False, "Q": False, "E": False, "R": False})
        angle = angle_step * index
        radius = 0 if role == "juggernaut" else survivor_ring + (index % 2) * 70
        player["x"] = ARENA["center_x"] + math.cos(angle) * radius
        player["y"] = ARENA["center_y"] + math.sin(angle) * radius
        player["vx"] = 0.0
        player["vy"] = 0.0
        player["facing"] = angle + math.pi
    room["projectiles"].clear()
    room["effects"].clear()
    room["started"] = True
    room["winner"] = None
    room["phase"] = "Battle On"
    room["message"] = "Survive the island"
    room["match_time"] = 0.0
    room["last_tick"] = now()


def visible_targets(room, source):
    targets = []
    for target in room["players"].values():
        if target["dead"] or target["id"] == source["id"] or target["team"] == source["team"]:
            continue
        if source["role"] == "juggernaut" and target["invisible_until"] > room["match_time"]:
            continue
        targets.append(target)
    return targets


def nearest_target(room, source):
    targets = visible_targets(room, source)
    return min(targets, key=lambda target: distance(source, target), default=None)


def effect(room, kind, **payload):
    payload["kind"] = kind
    room["effects"].append(payload)


def floating_text(room, x, y, text, color):
    effect(room, "text", x=x, y=y, text=text, color=color, life=1.0, max_life=1.0)


def ring(room, x, y, color, size, life):
    effect(room, "ring", x=x, y=y, color=color, size=size, life=life, max_life=life)


def deal_damage(room, source, target, amount, label):
    if target["dead"]:
        return
    target["health"] = max(0, target["health"] - amount)
    target["flash_until"] = room["match_time"] + 0.15
    floating_text(room, target["x"], target["y"] - 28, f"{label} -{amount}", "#8ed7ff" if source["role"] == "juggernaut" else "#ffe7a2")
    if target["health"] <= 0:
        target["dead"] = True
        target["vx"] = 0.0
        target["vy"] = 0.0
        floating_text(room, target["x"], target["y"] - 54, f"{target['name']} fell", "#ff9688")


def spawn_projectile(room, owner, angle, speed, damage, life, color, radius, label):
    room["projectiles"].append({
        "owner_id": owner["id"], "x": owner["x"] + math.cos(angle) * (owner["radius"] + 18), "y": owner["y"] + math.sin(angle) * (owner["radius"] + 18),
        "vx": math.cos(angle) * speed, "vy": math.sin(angle) * speed, "damage": damage, "life": life, "color": color, "radius": radius, "label": label,
    })


def basic_attack(room, player):
    if player["dead"] or player["basic_cooldown"] > 0:
        return
    if player["role"] == "wizard":
        spawn_projectile(room, player, player["facing"], 560, player["basic_damage"], 1.1, "#9ae2ff", 7, "Lightning")
    elif player["role"] == "fighter":
        for target in visible_targets(room, player):
            if distance(player, target) <= player["basic_range"]:
                deal_damage(room, player, target, player["basic_damage"], "Sword slash")
                ring(room, target["x"], target["y"], "#ffd86e", 34, 0.18)
                break
    elif player["role"] == "juggernaut":
        hit = False
        for target in visible_targets(room, player):
            if distance(player, target) <= player["basic_range"]:
                deal_damage(room, player, target, player["basic_damage"], "Warhammer")
                hit = True
        if hit:
            ring(room, player["x"], player["y"], "#6cd6ff", 100, 0.2)
    player["basic_cooldown"] = ROLE_STATS[player["role"]]["basic_cooldown"]


def use_ability(room, player, slot):
    if player["dead"] or player["cooldowns"].get(slot, 0) > 0:
        return
    if player["role"] == "wizard" and slot == "Q":
        player["cooldowns"]["Q"] = 20
        for spread in (-0.09, 0.0, 0.09):
            spawn_projectile(room, player, player["facing"] + spread, 680, 12, 1.3, "#baf0ff", 9, "Arc burst")
        ring(room, player["x"], player["y"], "#9ae2ff", 82, 0.35)
    elif player["role"] == "wizard" and slot == "E":
        player["cooldowns"]["E"] = 40
        player["invisible_until"] = room["match_time"] + 10
        ring(room, player["x"], player["y"], "#cbf6ff", 100, 0.45)
    elif player["role"] == "fighter" and slot == "Q":
        player["cooldowns"]["Q"] = 35
        for target in visible_targets(room, player):
            if distance(player, target) <= 130:
                deal_damage(room, player, target, 20, "Slam")
        ring(room, player["x"], player["y"], "#ffd86e", 150, 0.35)
    elif player["role"] == "fighter" and slot == "E":
        player["cooldowns"]["E"] = 40
        spawn_projectile(room, player, player["facing"], 620, 24, 1.25, "#ffe28b", 12, "Rift slash")
    elif player["role"] == "juggernaut" and slot == "Q":
        player["cooldowns"]["Q"] = 30
        for target in visible_targets(room, player):
            deal_damage(room, player, target, 18, "Earthquake")
        ring(room, player["x"], player["y"], "#7bd8ff", 420, 0.6)
    elif player["role"] == "juggernaut" and slot == "E":
        target = nearest_target(room, player)
        if not target:
            return
        player["cooldowns"]["E"] = 50
        player["x"] = target["x"] - math.cos(player["facing"]) * 30
        player["y"] = target["y"] - math.sin(player["facing"]) * 30
        keep_on_island(player)
        for victim in visible_targets(room, player):
            if distance(player, victim) <= 150:
                deal_damage(room, player, victim, 42, "Ground pound")
        ring(room, player["x"], player["y"], "#5dc0ff", 180, 0.45)
    elif player["role"] == "juggernaut" and slot == "R":
        player["cooldowns"]["R"] = 45
        for target in visible_targets(room, player):
            if distance(player, target) <= 180:
                deal_damage(room, player, target, 34, "Spin attack")
        ring(room, player["x"], player["y"], "#8de3ff", 210, 0.4)


def keep_on_island(player):
    dx = player["x"] - ARENA["center_x"]
    dy = player["y"] - ARENA["center_y"]
    current_distance = math.hypot(dx, dy)
    max_distance = ARENA["island_radius"] - player["radius"] - 8
    if current_distance > max_distance:
        angle = math.atan2(dy, dx)
        player["x"] = ARENA["center_x"] + math.cos(angle) * max_distance
        player["y"] = ARENA["center_y"] + math.sin(angle) * max_distance


def update_player(room, player, dt):
    if player["dead"]:
        return
    player["basic_cooldown"] = max(0.0, player["basic_cooldown"] - dt)
    for key in list(player["cooldowns"].keys()):
        player["cooldowns"][key] = max(0.0, player["cooldowns"][key] - dt)
    move_x, move_y = normalize(player["input"]["move_x"], player["input"]["move_y"])
    player["vx"] = move_x * player["speed"]
    player["vy"] = move_y * player["speed"]
    aim_x = player["input"]["aim_x"]
    aim_y = player["input"]["aim_y"]
    if abs(aim_x) > 0.01 or abs(aim_y) > 0.01:
        player["facing"] = math.atan2(aim_y, aim_x)
    if player["input"]["basic"]:
        basic_attack(room, player)
    for slot in ("Q", "E", "R"):
        if player["input"].get(slot):
            use_ability(room, player, slot)
            player["input"][slot] = False
    player["x"] += player["vx"] * dt
    player["y"] += player["vy"] * dt
    keep_on_island(player)


def update_projectiles(room, dt):
    for projectile in room["projectiles"][:]:
        projectile["life"] -= dt
        projectile["x"] += projectile["vx"] * dt
        projectile["y"] += projectile["vy"] * dt
        if projectile["life"] <= 0:
            room["projectiles"].remove(projectile)
            continue
        owner = room["players"].get(projectile["owner_id"])
        if not owner or owner["dead"]:
            room["projectiles"].remove(projectile)
            continue
        hit_target = None
        for target in room["players"].values():
            if target["dead"] or target["id"] == owner["id"] or target["team"] == owner["team"]:
                continue
            if owner["role"] == "juggernaut" and target["invisible_until"] > room["match_time"]:
                continue
            if math.hypot(projectile["x"] - target["x"], projectile["y"] - target["y"]) <= projectile["radius"] + target["radius"]:
                hit_target = target
                break
        if hit_target:
            deal_damage(room, owner, hit_target, projectile["damage"], projectile["label"])
            ring(room, projectile["x"], projectile["y"], projectile["color"], 54, 0.2)
            room["projectiles"].remove(projectile)


def update_effects(room, dt):
    for current in room["effects"][:]:
        current["life"] -= dt
        if current["kind"] == "text":
            current["y"] -= 30 * dt
        if current["life"] <= 0:
            room["effects"].remove(current)


def update_camera(room):
    players = [player for player in room["players"].values() if not player["dead"]]
    if not players:
        room["host_view"]["camera_x"] = ARENA["center_x"]
        room["host_view"]["camera_y"] = ARENA["center_y"]
        room["host_view"]["zoom"] = 0.58
        return
    min_x = min(player["x"] for player in players)
    max_x = max(player["x"] for player in players)
    min_y = min(player["y"] for player in players)
    max_y = max(player["y"] for player in players)
    room["host_view"]["camera_x"] = (min_x + max_x) / 2
    room["host_view"]["camera_y"] = (min_y + max_y) / 2
    spread_x = max_x - min_x + 620
    spread_y = max_y - min_y + 460
    room["host_view"]["zoom"] = clamp(min(1280 / max(spread_x, 1), 720 / max(spread_y, 1)), 0.38, 0.9)


def update_winner(room):
    if room["winner"] or not room["started"]:
        return
    juggernaut_alive = any(player["role"] == "juggernaut" and not player["dead"] for player in room["players"].values())
    survivor_alive = any(player["role"] != "juggernaut" and not player["dead"] for player in room["players"].values())
    if not juggernaut_alive:
        room["winner"] = "Heroes win"
        room["phase"] = "Match Over"
        room["message"] = "The juggernaut has fallen"
    elif not survivor_alive:
        room["winner"] = "Juggernaut wins"
        room["phase"] = "Match Over"
        room["message"] = "The island belongs to the juggernaut"


def advance_room(room, current_time):
    if not room["started"]:
        room["last_tick"] = current_time
        return
    total_dt = min(0.5, max(0.0, current_time - room["last_tick"]))
    room["last_tick"] = current_time
    while total_dt > 0:
        dt = min(1 / 20, total_dt)
        room["match_time"] += dt
        for player in room["players"].values():
            update_player(room, player, dt)
        update_projectiles(room, dt)
        update_effects(room, dt)
        update_camera(room)
        update_winner(room)
        total_dt -= dt


def serialize_room_state(room, viewer_id=None):
    viewer = room["players"].get(viewer_id) if viewer_id else None
    players = []
    for player in room["players"].values():
        hidden_to_viewer = (
            viewer and viewer["role"] == "juggernaut" and player["role"] == "wizard" and player["invisible_until"] > room["match_time"] and player["id"] != viewer["id"]
        )
        players.append({
            "id": player["id"], "name": player["name"], "role": player["role"] or player["preferred_role"], "team": player["team"],
            "x": player["x"], "y": player["y"], "radius": player["radius"], "health": player["health"], "maxHealth": player["max_health"],
            "facing": player["facing"], "dead": player["dead"], "invisible": player["invisible_until"] > room["match_time"],
            "hiddenToViewer": hidden_to_viewer, "color": ROLE_COLORS.get(player["role"] or "wizard", "#9ae2ff"),
        })
    juggernaut = next((player for player in players if player["role"] == "juggernaut"), None)
    viewer_payload = None
    if viewer:
        stats = ROLE_STATS.get(viewer["role"], {"abilities": {}})
        abilities = [{"key": key, "name": meta["name"], "cooldown": viewer["cooldowns"].get(key, 0.0)} for key, meta in stats["abilities"].items()]
        viewer_payload = {
            "id": viewer["id"], "name": viewer["name"], "role": viewer["role"], "preferredRole": viewer["preferred_role"], "health": viewer["health"],
            "maxHealth": viewer["max_health"], "dead": viewer["dead"], "invisibleRemaining": max(0.0, viewer["invisible_until"] - room["match_time"]),
            "abilities": abilities,
        }
    return {
        "code": room["code"], "phase": room["phase"], "message": room["message"], "started": room["started"], "winner": room["winner"],
        "matchTime": room["match_time"], "arena": ARENA, "camera": room["host_view"], "juggernaut": juggernaut, "players": players,
        "projectiles": [{"x": p["x"], "y": p["y"], "radius": p["radius"], "color": p["color"]} for p in room["projectiles"]],
        "effects": [{"kind": e["kind"], "x": e["x"], "y": e["y"], "size": e.get("size"), "text": e.get("text"), "color": e["color"], "life": e["life"], "max_life": e["max_life"]} for e in room["effects"]],
        "you": viewer_payload,
    }


class handler(BaseHTTPRequestHandler):
    def _parse(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        route = (params.get("path") or [""])[0]
        return parsed, params, route

    def _json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self):
        try:
            _, params, route = self._parse()
            if route != "state":
                return self._json({"error": "Unknown endpoint."}, HTTPStatus.NOT_FOUND)
            code = (params.get("code") or [""])[0].upper()
            viewer_id = (params.get("playerId") or [""])[0]
            room = get_room(code)
            if not room:
                return self._json({"error": "Room not found."}, HTTPStatus.NOT_FOUND)
            advance_room(room, now())
            set_room(code, room)
            return self._json(serialize_room_state(room, viewer_id or None))
        except RuntimeError as error:
            return self._json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        except Exception as error:
            return self._json({"error": f"Unexpected server error: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        try:
            _, _, route = self._parse()
            payload = self._body()
            if route == "create-room":
                room = create_room()
                return self._json({"code": room["code"]})

            code = str(payload.get("code", "")).upper()
            room = get_room(code)
            if not room:
                return self._json({"error": "Room not found."}, HTTPStatus.NOT_FOUND)

            advance_room(room, now())

            if route == "join-room":
                if room["started"]:
                    return self._json({"error": "Match already started."}, HTTPStatus.BAD_REQUEST)
                player = new_player(payload.get("name", ""))
                room["players"][player["id"]] = player
                room["message"] = f"{len(room['players'])} players in lobby"
                set_room(code, room)
                return self._json({"playerId": player["id"], "code": code})

            player_id = payload.get("playerId", "")
            player = room["players"].get(player_id) if player_id else None

            if route == "set-role":
                if not player:
                    return self._json({"error": "Player not found."}, HTTPStatus.NOT_FOUND)
                preferred = payload.get("role", "random")
                if preferred not in {"wizard", "fighter", "random"}:
                    preferred = "random"
                player["preferred_role"] = preferred
                set_room(code, room)
                return self._json({"ok": True})

            if route == "start-match" or route == "restart-match":
                try:
                    assign_match_roles(room)
                except ValueError as error:
                    return self._json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                set_room(code, room)
                return self._json({"ok": True})

            if route == "input":
                if not player:
                    return self._json({"error": "Player not found."}, HTTPStatus.NOT_FOUND)
                data = player["input"]
                data["move_x"] = clamp(float(payload.get("moveX", 0.0)), -1.0, 1.0)
                data["move_y"] = clamp(float(payload.get("moveY", 0.0)), -1.0, 1.0)
                data["aim_x"] = clamp(float(payload.get("aimX", data["aim_x"])), -1.0, 1.0)
                data["aim_y"] = clamp(float(payload.get("aimY", data["aim_y"])), -1.0, 1.0)
                data["basic"] = bool(payload.get("basic", False))
                for slot in ("Q", "E", "R"):
                    if payload.get(slot):
                        data[slot] = True
                set_room(code, room)
                return self._json({"ok": True})

            return self._json({"error": "Unknown endpoint."}, HTTPStatus.NOT_FOUND)
        except RuntimeError as error:
            return self._json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        except Exception as error:
            return self._json({"error": f"Unexpected server error: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
