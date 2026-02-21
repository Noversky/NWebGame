const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 15;
const SNAPSHOT_RATE = 10;
const WORLD_SIZE = 3200;
const FOOD_COUNT = 280;
const BASE_SPEED = 220;
const START_MASS = 24;
const ROOM_CODE_LEN = 6;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const players = new Map();
const rooms = new Map();
let nextPlayerId = 1;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 5;
}

function randomPos() {
  return {
    x: rand(60, WORLD_SIZE - 60),
    y: rand(60, WORLD_SIZE - 60)
  };
}

function sanitizeName(value, fallback) {
  const name = String(value || '').trim().slice(0, 18);
  return name || fallback;
}

function sanitizeAvatar(value) {
  const avatar = String(value || '').trim();
  if (!avatar) {
    return '';
  }
  const okPrefix = avatar.startsWith('data:image/png;base64,') ||
    avatar.startsWith('data:image/jpeg;base64,') ||
    avatar.startsWith('data:image/webp;base64,');
  if (!okPrefix || avatar.length > 20000) {
    return '';
  }
  return avatar;
}

function sanitizeChat(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function randomPlayerColor() {
  const hue = Math.floor(rand(0, 360));
  const sat = Math.floor(rand(68, 92));
  const light = Math.floor(rand(52, 66));
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  return null;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToPlayer(player, payload) {
  send(player.ws, payload);
}

function getRoomPlayers(room) {
  const list = [];
  for (const id of room.players) {
    const p = players.get(id);
    if (p) {
      list.push(p);
    }
  }
  return list;
}

function broadcast(room, payload) {
  for (const p of getRoomPlayers(room)) {
    sendToPlayer(p, payload);
  }
}

function roomPublicPlayers(room) {
  return getRoomPlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    score: p.score,
    alive: p.alive
  }));
}

function broadcastRoomUpdate(room) {
  broadcast(room, {
    t: 'room_update',
    code: room.code,
    host: room.hostId,
    state: room.state,
    players: roomPublicPlayers(room)
  });
}

function spawnFood(room, amount) {
  for (let i = 0; i < amount; i += 1) {
    const pos = randomPos();
    room.food.push({ x: pos.x, y: pos.y, mass: rand(2.4, 4.5) });
  }
}

function leaveRoom(player) {
  if (!player.roomCode) {
    return;
  }

  const room = rooms.get(player.roomCode);
  player.roomCode = null;
  player.inputX = 0;
  player.inputY = 0;
  player.alive = false;
  player.score = 0;
  player.mass = START_MASS;

  if (!room) {
    return;
  }

  room.players.delete(player.id);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (!room.players.has(room.hostId)) {
    room.hostId = room.players.values().next().value;
  }

  if (room.state === 'running') {
    checkRoundEnd(room);
  }

  broadcastRoomUpdate(room);
}

function ensureRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function createRoom(player, name, avatar) {
  leaveRoom(player);

  const code = generateRoomCode();
  if (!code) {
    sendToPlayer(player, { t: 'error', m: 'Не удалось создать комнату. Попробуйте снова.' });
    return;
  }

  player.name = sanitizeName(name, player.name);
  player.avatar = sanitizeAvatar(avatar);
  player.roomCode = code;
  player.score = 0;
  player.mass = START_MASS;
  player.alive = false;

  const room = {
    code,
    hostId: player.id,
    state: 'lobby',
    players: new Set([player.id]),
    food: []
  };

  rooms.set(code, room);
  broadcastRoomUpdate(room);
}

function joinRoom(player, code, name, avatar) {
  const room = ensureRoom(code);
  if (!room) {
    sendToPlayer(player, { t: 'error', m: 'Комната не найдена.' });
    return;
  }

  if (room.state === 'running') {
    sendToPlayer(player, { t: 'error', m: 'Игра уже идет. Подождите окончания раунда.' });
    return;
  }

  leaveRoom(player);

  player.name = sanitizeName(name, player.name);
  player.avatar = sanitizeAvatar(avatar);
  player.roomCode = room.code;
  player.score = 0;
  player.mass = START_MASS;
  player.alive = false;

  room.players.add(player.id);
  broadcastRoomUpdate(room);
}

function startGame(player) {
  if (!player.roomCode) {
    return;
  }
  const room = rooms.get(player.roomCode);
  if (!room) {
    return;
  }

  if (room.hostId !== player.id) {
    sendToPlayer(player, { t: 'error', m: 'Только создатель комнаты может начать игру.' });
    return;
  }

  if (room.players.size < 2) {
    sendToPlayer(player, { t: 'error', m: 'Нужно минимум 2 игрока.' });
    return;
  }

  room.state = 'running';
  room.food = [];
  spawnFood(room, FOOD_COUNT);

  for (const p of getRoomPlayers(room)) {
    const pos = randomPos();
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.inputX = 0;
    p.inputY = 0;
    p.mass = START_MASS;
    p.score = 0;
    p.alive = true;
    sendToPlayer(p, { t: 'game_started', world: WORLD_SIZE });
  }

  broadcastRoomUpdate(room);
}

function leaderboardForRoom(room) {
  return getRoomPlayers(room)
    .map((p) => [p.name, p.score, p.id, p.alive])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function checkRoundEnd(room) {
  if (room.state !== 'running') {
    return;
  }

  const alive = getRoomPlayers(room).filter((p) => p.alive);
  if (alive.length > 1) {
    return;
  }

  room.state = 'lobby';
  room.food = [];

  const winner = alive[0] || null;
  broadcast(room, {
    t: 'game_over',
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : 'Никто'
  });

  for (const p of getRoomPlayers(room)) {
    p.alive = false;
    p.mass = START_MASS;
    p.inputX = 0;
    p.inputY = 0;
  }

  broadcastRoomUpdate(room);
}

function physicsRoom(room, dt) {
  if (room.state !== 'running') {
    return;
  }

  const active = getRoomPlayers(room).filter((p) => p.alive);

  for (const p of active) {
    const mag = Math.hypot(p.inputX, p.inputY);
    let dirX = 0;
    let dirY = 0;

    if (mag > 0.001) {
      dirX = p.inputX / mag;
      dirY = p.inputY / mag;
    }

    const speed = BASE_SPEED / Math.pow(p.mass / START_MASS, 0.33);
    p.vx = dirX * speed;
    p.vy = dirY * speed;

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const r = radiusFromMass(p.mass);
    p.x = clamp(p.x, r, WORLD_SIZE - r);
    p.y = clamp(p.y, r, WORLD_SIZE - r);
  }

  const eatenFood = new Set();
  for (const p of active) {
    const r = radiusFromMass(p.mass);
    for (let i = 0; i < room.food.length; i += 1) {
      if (eatenFood.has(i)) {
        continue;
      }
      const f = room.food[i];
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (dx * dx + dy * dy <= r * r) {
        eatenFood.add(i);
        p.mass += f.mass;
        p.score += Math.round(f.mass * 10);
      }
    }
  }

  if (eatenFood.size > 0) {
    room.food = room.food.filter((_, idx) => !eatenFood.has(idx));
    spawnFood(room, eatenFood.size);
  }

  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    if (!a.alive) {
      continue;
    }

    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      if (!b.alive) {
        continue;
      }

      const ar = radiusFromMass(a.mass);
      const br = radiusFromMass(b.mass);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);

      const aCanEat = a.mass > b.mass * 1.12 && dist < ar;
      const bCanEat = b.mass > a.mass * 1.12 && dist < br;

      if (!aCanEat && !bCanEat) {
        continue;
      }

      if (aCanEat) {
        a.mass += b.mass * 0.82;
        a.score += b.score;
        const movedScore = b.score;
        b.score = 0;
        b.alive = false;
        b.inputX = 0;
        b.inputY = 0;
        sendToPlayer(a, { t: 'eat', victim: b.name, gain: movedScore });
        sendToPlayer(b, { t: 'dead', killer: a.name });
      } else if (bCanEat) {
        b.mass += a.mass * 0.82;
        b.score += a.score;
        const movedScore = a.score;
        a.score = 0;
        a.alive = false;
        a.inputX = 0;
        a.inputY = 0;
        sendToPlayer(b, { t: 'eat', victim: a.name, gain: movedScore });
        sendToPlayer(a, { t: 'dead', killer: b.name });
      }
    }
  }

  checkRoundEnd(room);
}

function snapshotRoom(room) {
  if (room.state !== 'running') {
    return;
  }

  const alivePlayers = getRoomPlayers(room).filter((p) => p.alive);

  for (const viewer of alivePlayers) {
    const visiblePlayers = [];
    const visibleFood = [];

    for (const p of alivePlayers) {
      if (Math.abs(p.x - viewer.x) < 1000 && Math.abs(p.y - viewer.y) < 700) {
        visiblePlayers.push([
          p.id,
          Math.round(p.x),
          Math.round(p.y),
          Math.round(p.mass * 10) / 10,
          p.score
        ]);
      }
    }

    for (const f of room.food) {
      if (Math.abs(f.x - viewer.x) < 1000 && Math.abs(f.y - viewer.y) < 700) {
        visibleFood.push([
          Math.round(f.x),
          Math.round(f.y),
          Math.round(f.mass * 10) / 10
        ]);
      }
    }

    sendToPlayer(viewer, { t: 's', you: viewer.id, p: visiblePlayers, f: visibleFood });
  }

  const lb = leaderboardForRoom(room);
  broadcast(room, { t: 'lb', v: lb });
}

const publicDir = path.join(process.cwd(), 'public');

const server = http.createServer((req, res) => {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  reqPath = decodeURIComponent(reqPath.split('?')[0]);
  const filePath = path.join(publicDir, reqPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function createPlayer(ws) {
  const id = `p${nextPlayerId}`;
  nextPlayerId += 1;

  const player = {
    id,
    ws,
    roomCode: null,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    inputX: 0,
    inputY: 0,
    mass: START_MASS,
    score: 0,
    alive: false,
    name: `Player ${nextPlayerId - 1}`,
    avatar: '',
    color: randomPlayerColor(),
    lastChatAt: 0
  };

  players.set(id, player);
  return player;
}

wss.on('connection', (ws) => {
  const player = createPlayer(ws);

  sendToPlayer(player, {
    t: 'welcome',
    id: player.id,
    world: WORLD_SIZE,
    tick: TICK_RATE,
    name: 'NWebGame'
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const p = players.get(player.id);
    if (!p) {
      return;
    }

    if (msg.t === 'create_room') {
      createRoom(p, msg.name, msg.avatar);
      return;
    }

    if (msg.t === 'join_room') {
      joinRoom(p, msg.code, msg.name, msg.avatar);
      return;
    }

    if (msg.t === 'start_game') {
      startGame(p);
      return;
    }

    if (msg.t === 'leave_room') {
      leaveRoom(p);
      return;
    }

    if (msg.t === 'set_profile') {
      p.name = sanitizeName(msg.name, p.name);
      p.avatar = sanitizeAvatar(msg.avatar);
      if (p.roomCode) {
        const room = rooms.get(p.roomCode);
        if (room) {
          broadcastRoomUpdate(room);
        }
      }
      return;
    }

    if (msg.t === 'chat') {
      if (!p.roomCode) {
        return;
      }
      const room = rooms.get(p.roomCode);
      if (!room) {
        return;
      }
      const now = Date.now();
      if (now - p.lastChatAt < 500) {
        return;
      }
      p.lastChatAt = now;

      const text = sanitizeChat(msg.text);
      if (!text) {
        return;
      }
      broadcast(room, {
        t: 'chat',
        fromId: p.id,
        fromName: p.name,
        text,
        at: now
      });
      return;
    }

    if (msg.t === 'input') {
      if (!p.roomCode) {
        return;
      }
      const room = rooms.get(p.roomCode);
      if (!room || room.state !== 'running' || !p.alive) {
        return;
      }
      p.inputX = clamp(Number(msg.x) || 0, -1, 1);
      p.inputY = clamp(Number(msg.y) || 0, -1, 1);
    }
  });

  ws.on('close', () => {
    const p = players.get(player.id);
    if (!p) {
      return;
    }
    leaveRoom(p);
    players.delete(player.id);
  });
});

let prev = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.066, (now - prev) / 1000);
  prev = now;

  for (const room of rooms.values()) {
    physicsRoom(room, dt);
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    snapshotRoom(room);
  }
}, 1000 / SNAPSHOT_RATE);

server.listen(PORT, () => {
  console.log(`NWebGame running on http://localhost:${PORT}`);
});
