const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const statsEl = document.getElementById('stats');
const lbEl = document.getElementById('leaderboard');

const lobbyOverlay = document.getElementById('lobbyOverlay');
const lobbyState = document.getElementById('lobbyState');
const messageEl = document.getElementById('message');

const nameInput = document.getElementById('nameInput');
const avatarInput = document.getElementById('avatarInput');
const avatarBtn = document.getElementById('avatarBtn');
const avatarPreview = document.getElementById('avatarPreview');
const avatarFallback = document.getElementById('avatarFallback');

const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const roomActions = document.getElementById('roomActions');

const roomPanel = document.getElementById('roomPanel');
const roomCodeLabel = document.getElementById('roomCodeLabel');
const roomPlayers = document.getElementById('roomPlayers');
const startBtn = document.getElementById('startBtn');
const leaveBtn = document.getElementById('leaveBtn');

const chatBox = document.getElementById('chatBox');
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const game = {
  ws: null,
  id: null,
  world: 3200,
  connected: false,
  roomCode: null,
  roomHost: null,
  roomState: 'none',
  playersMeta: new Map(),
  playersDraw: new Map(),
  food: [],
  leaderboard: [],
  camX: 0,
  camY: 0,
  inputX: 0,
  inputY: 0,
  lastSentX: 0,
  lastSentY: 0,
  avatarData: '',
  avatarImages: new Map(),
  isRunning: false
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function massToRadius(mass) {
  return Math.sqrt(mass) * 5;
}

function safeName() {
  return nameInput.value.trim().slice(0, 18) || 'Player';
}

function firstLetter(name) {
  const base = String(name || '').trim();
  return (base[0] || 'P').toUpperCase();
}

function wsSend(payload) {
  if (game.ws && game.ws.readyState === WebSocket.OPEN) {
    game.ws.send(JSON.stringify(payload));
  }
}

function showMessage(text) {
  messageEl.textContent = text || '';
}

function addChatLine(name, text, mine) {
  const row = document.createElement('div');
  row.className = mine ? 'chatLine mine' : 'chatLine';
  row.textContent = `${name}: ${text}`;
  chatLog.appendChild(row);
  while (chatLog.children.length > 80) {
    chatLog.removeChild(chatLog.firstChild);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function updateAvatarPreview() {
  avatarFallback.textContent = firstLetter(safeName());

  if (game.avatarData) {
    avatarPreview.src = game.avatarData;
    avatarPreview.classList.remove('hidden');
    avatarFallback.classList.add('hidden');
    return;
  }

  avatarPreview.classList.add('hidden');
  avatarFallback.classList.remove('hidden');
}

function renderRoomPlayers() {
  const list = [...game.playersMeta.values()];
  roomPlayers.innerHTML = list
    .map((p) => {
      const hostMark = p.id === game.roomHost ? ' (host)' : '';
      const alive = game.roomState === 'running' ? (p.alive ? 'в игре' : 'выбит') : 'готов';
      const letter = firstLetter(p.name);
      const avatar = p.avatar
        ? `<img src="${p.avatar}" alt="" />`
        : `<div class="roomPlayerAvatar">${escapeHtml(letter)}</div>`;
      return `<div class="roomPlayer">${avatar}<div>${escapeHtml(p.name)}${hostMark}<br><small>${alive} | очки: ${p.score}</small></div></div>`;
    })
    .join('');
}

function refreshUI() {
  const inRoom = Boolean(game.roomCode);
  roomActions.classList.toggle('hidden', inRoom);
  roomPanel.classList.toggle('hidden', !inRoom);

  if (inRoom) {
    roomCodeLabel.textContent = game.roomCode;
    const isHost = game.id && game.id === game.roomHost;
    const canStart = isHost && game.roomState !== 'running' && game.playersMeta.size >= 2;
    startBtn.classList.toggle('hidden', !canStart);
    lobbyState.textContent = game.roomState === 'running' ? 'Раунд идет' : 'Лобби комнаты';
  }

  const showOverlay = !inRoom || game.roomState !== 'running';
  lobbyOverlay.classList.toggle('hidden', !showOverlay);
  chatBox.classList.toggle('hidden', !inRoom);
}

function getAvatarImage(data) {
  if (!data) {
    return null;
  }
  if (!game.avatarImages.has(data)) {
    const img = new Image();
    img.src = data;
    game.avatarImages.set(data, img);
  }
  return game.avatarImages.get(data);
}

function applyRoomUpdate(msg) {
  game.roomCode = msg.code;
  game.roomHost = msg.host;
  game.roomState = msg.state;

  const newMeta = new Map();
  for (const p of msg.players) {
    newMeta.set(p.id, {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      alive: p.alive
    });
  }
  game.playersMeta = newMeta;

  renderRoomPlayers();
  refreshUI();
}

function handleSnapshot(msg) {
  const seenIds = new Set();
  for (const p of msg.p) {
    const [id, x, y, mass, score] = p;
    const old = game.playersDraw.get(id);
    game.playersDraw.set(id, {
      id,
      x: old ? old.x : x,
      y: old ? old.y : y,
      tx: x,
      ty: y,
      mass,
      score
    });
    seenIds.add(id);

    const meta = game.playersMeta.get(id);
    if (meta) {
      meta.score = score;
    }
  }
  for (const id of game.playersDraw.keys()) {
    if (!seenIds.has(id)) {
      game.playersDraw.delete(id);
    }
  }

  game.food = msg.f.map((f, i) => ({ id: i, x: f[0], y: f[1], mass: f[2] }));
}

function connect() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${location.host}`);
  game.ws = ws;

  ws.addEventListener('open', () => {
    game.connected = true;
    statsEl.textContent = 'Подключено';
    showMessage('');
  });

  ws.addEventListener('close', () => {
    game.connected = false;
    game.roomCode = null;
    game.roomState = 'none';
    game.playersMeta.clear();
    game.playersDraw.clear();
    game.isRunning = false;
    refreshUI();
    statsEl.textContent = 'Соединение потеряно. Переподключение...';
    setTimeout(connect, 1000);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.t === 'welcome') {
      game.id = msg.id;
      game.world = msg.world;
      return;
    }

    if (msg.t === 'error') {
      showMessage(msg.m || 'Ошибка');
      return;
    }

    if (msg.t === 'room_update') {
      applyRoomUpdate(msg);
      return;
    }

    if (msg.t === 'game_started') {
      game.world = msg.world;
      game.isRunning = true;
      game.playersDraw.clear();
      showMessage('');
      refreshUI();
      return;
    }

    if (msg.t === 's') {
      handleSnapshot(msg);
      return;
    }

    if (msg.t === 'lb') {
      game.leaderboard = msg.v;
      lbEl.innerHTML = `Лидеры:<br>${game.leaderboard
        .map((x, i) => `${i + 1}. ${escapeHtml(x[0])} - ${x[1]}${x[3] ? '' : ' (выбыл)'}`)
        .join('<br>')}`;
      return;
    }

    if (msg.t === 'game_over') {
      game.isRunning = false;
      const winText = msg.winnerName ? `Победил: ${msg.winnerName}` : 'Раунд завершен';
      showMessage(winText);
      refreshUI();
      return;
    }

    if (msg.t === 'eat') {
      addChatLine('Система', `Вы съели ${msg.victim} и получили ${msg.gain} очков`, true);
      return;
    }

    if (msg.t === 'dead') {
      addChatLine('Система', `Вас съел игрок ${msg.killer}`, true);
      return;
    }

    if (msg.t === 'chat') {
      addChatLine(msg.fromName || 'Игрок', msg.text || '', msg.fromId === game.id);
    }
  });
}

function setInputFromPoint(clientX, clientY) {
  if (!game.isRunning) {
    game.inputX = 0;
    game.inputY = 0;
    return;
  }
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const len = Math.hypot(dx, dy);

  if (len < 5) {
    game.inputX = 0;
    game.inputY = 0;
    return;
  }

  const max = Math.min(len, 170);
  game.inputX = (dx / len) * (max / 170);
  game.inputY = (dy / len) * (max / 170);
}

function drawGrid(camX, camY) {
  const step = 80;
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(80, 124, 153, 0.18)';

  const startX = -((camX - w / 2) % step);
  const startY = -((camY - h / 2) % step);

  for (let x = startX; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  for (let y = startY; y < h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawAvatar(x, y, r, avatarData) {
  const img = getAvatarImage(avatarData);
  if (!img || !img.complete) {
    return false;
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  ctx.restore();
  return true;
}

function drawFallbackAvatar(x, y, r, name) {
  ctx.beginPath();
  ctx.fillStyle = '#000000';
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(10, r * 0.95)}px Trebuchet MS`;
  ctx.fillText(firstLetter(name), x, y + 1);
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (const p of game.playersDraw.values()) {
    p.x += (p.tx - p.x) * 0.35;
    p.y += (p.ty - p.y) * 0.35;
  }

  const me = game.playersDraw.get(game.id);
  if (me) {
    game.camX += (me.x - game.camX) * 0.2;
    game.camY += (me.y - game.camY) * 0.2;
    statsEl.textContent = `Масса: ${Math.round(me.mass)} | Очки: ${me.score} | Игроков в кадре: ${game.playersDraw.size}`;
  }

  drawGrid(game.camX, game.camY);

  const offsetX = window.innerWidth / 2 - game.camX;
  const offsetY = window.innerHeight / 2 - game.camY;

  ctx.save();
  ctx.translate(offsetX, offsetY);

  ctx.strokeStyle = 'rgba(129, 179, 214, 0.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, game.world, game.world);

  for (const f of game.food) {
    ctx.beginPath();
    ctx.fillStyle = '#77d6ad';
    ctx.arc(f.x, f.y, Math.max(2, f.mass * 1.7), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of game.playersDraw.values()) {
    const meta = game.playersMeta.get(p.id);
    const r = massToRadius(p.mass);
    const isMe = p.id === game.id;

    ctx.beginPath();
    ctx.fillStyle = isMe ? '#5ec2ff' : '#f48f5f';
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    const faceR = r * 0.8;
    if (!drawAvatar(p.x, p.y, faceR, meta ? meta.avatar : '')) {
      drawFallbackAvatar(p.x, p.y, faceR, meta ? meta.name : p.id);
    }

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.max(11, r * 0.33)}px Trebuchet MS`;
    ctx.fillText(meta ? meta.name : p.id, p.x, p.y + r + 14);
  }

  ctx.restore();
  requestAnimationFrame(render);
}

async function compressAvatar(file) {
  const img = await new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(src);
      resolve(image);
    };
    image.onerror = reject;
    image.src = src;
  });

  const side = 64;
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  const cctx = c.getContext('2d');

  const srcSize = Math.min(img.width, img.height);
  const sx = Math.floor((img.width - srcSize) / 2);
  const sy = Math.floor((img.height - srcSize) / 2);
  cctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, side, side);

  let out = c.toDataURL('image/webp', 0.72);
  if (out.length > 20000) {
    out = c.toDataURL('image/jpeg', 0.62);
  }
  return out.length <= 20000 ? out : '';
}

createBtn.addEventListener('click', () => {
  wsSend({ t: 'create_room', name: safeName(), avatar: game.avatarData });
});

joinBtn.addEventListener('click', () => {
  wsSend({
    t: 'join_room',
    code: roomCodeInput.value.trim().toUpperCase(),
    name: safeName(),
    avatar: game.avatarData
  });
});

leaveBtn.addEventListener('click', () => {
  wsSend({ t: 'leave_room' });
  game.roomCode = null;
  game.roomState = 'none';
  game.playersMeta.clear();
  game.playersDraw.clear();
  refreshUI();
});

startBtn.addEventListener('click', () => {
  wsSend({ t: 'start_game' });
});

nameInput.addEventListener('change', () => {
  wsSend({ t: 'set_profile', name: safeName(), avatar: game.avatarData });
});

nameInput.addEventListener('input', () => {
  updateAvatarPreview();
});

avatarBtn.addEventListener('click', () => {
  avatarInput.click();
});

avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files && avatarInput.files[0];
  if (!file) {
    return;
  }
  try {
    const avatar = await compressAvatar(file);
    if (!avatar) {
      showMessage('Аватар слишком большой после сжатия. Выберите другой.');
      return;
    }
    game.avatarData = avatar;
    updateAvatarPreview();
    wsSend({ t: 'set_profile', name: safeName(), avatar: game.avatarData });
  } catch {
    showMessage('Не удалось загрузить аватар.');
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !game.roomCode) {
    return;
  }
  wsSend({ t: 'chat', text });
  chatInput.value = '';
});

window.addEventListener('mousemove', (e) => {
  setInputFromPoint(e.clientX, e.clientY);
});

window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) {
    return;
  }
  setInputFromPoint(t.clientX, t.clientY);
  e.preventDefault();
}, { passive: false });

window.addEventListener('touchend', () => {
  game.inputX = 0;
  game.inputY = 0;
});

window.addEventListener('resize', resize);
resize();
updateAvatarPreview();
connect();
requestAnimationFrame(render);

setInterval(() => {
  if (!game.isRunning) {
    return;
  }
  const dx = Math.abs(game.inputX - game.lastSentX);
  const dy = Math.abs(game.inputY - game.lastSentY);
  if (dx < 0.04 && dy < 0.04) {
    return;
  }
  game.lastSentX = game.inputX;
  game.lastSentY = game.inputY;
  wsSend({ t: 'input', x: game.inputX, y: game.inputY });
}, 95);
