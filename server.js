// Кинозал — сервер совместного просмотра.
// Комнаты, синхронизация плеера, текстовый чат и сигналинг для голосового чата (WebRTC).

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CHAT_HISTORY = 150;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // пустая комната живёт 6 часов

// Серверы для WebRTC. STUN от Google работает почти везде.
// TURN нужен, если у кого-то строгий NAT (мобильный интернет, корпоративная сеть):
// задайте TURN_URL, TURN_USERNAME, TURN_CREDENTIAL в переменных окружения.
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return list;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/r/:room', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/** @type {Map<string, any>} */
const rooms = new Map();
const COLORS = ['#f2a33a', '#5ec2b7', '#e46f6f', '#8fa6f0', '#c88ee8', '#9ccb6b', '#f08fb4', '#e6c75a'];

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      users: new Map(), // socketId -> user
      chat: [],
      emptySince: null,
      colorIdx: 0,
      player: { source: null, playing: false, position: 0, rate: 1, updatedAt: Date.now(), by: null },
    };
    rooms.set(id, room);
  }
  return room;
}

function currentPosition(p) {
  if (!p.playing) return p.position;
  return p.position + ((Date.now() - p.updatedAt) / 1000) * p.rate;
}

function playerPayload(room) {
  const p = room.player;
  return { ...p, position: currentPosition(p), updatedAt: Date.now(), serverNow: Date.now() };
}

function userList(room) {
  return [...room.users.values()].map((u) => ({
    id: u.id, name: u.name, color: u.color, inVoice: u.inVoice, muted: u.muted,
  }));
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) room.chat.shift();
  io.to(room.id).emit('chat', msg);
}

function systemMessage(room, text) {
  pushChat(room, { id: crypto.randomUUID(), system: true, text, at: Date.now() });
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function validSource(src) {
  if (!src || typeof src !== 'object') return null;
  const type = src.type;
  if (type === 'youtube') {
    const id = clean(src.value, 20);
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
    return { type, value: id, title: clean(src.title, 200) || 'YouTube' };
  }
  if (type === 'rutube') {
    const v = clean(src.value, 120);
    if (!/^[a-f0-9]{32}(\?p=[A-Za-z0-9_-]{1,64})?$/i.test(v)) return null;
    return { type, value: v, title: clean(src.title, 200) || 'Rutube' };
  }
  if (type === 'url') {
    const url = clean(src.value, 2000);
    if (!/^https?:\/\//i.test(url)) return null;
    return { type, value: url, title: clean(src.title, 200) || url };
  }
  if (type === 'file') {
    const name = clean(src.title, 200);
    if (!name) return null;
    return { type, value: null, title: name, size: Number(src.size) || 0 };
  }
  return null;
}

io.on('connection', (socket) => {
  let room = null;
  let user = null;

  socket.on('time', (clientSent, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('join', (data, ack) => {
    if (room) return;
    const roomId = clean(data?.room, 40).toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(roomId)) return ack?.({ error: 'Неверный код комнаты' });
    room = getRoom(roomId);
    room.emptySince = null;
    user = {
      id: socket.id,
      name: clean(data?.name, 32) || 'Гость',
      color: COLORS[room.colorIdx++ % COLORS.length],
      inVoice: false,
      muted: false,
    };
    room.users.set(socket.id, user);
    socket.join(room.id);
    ack?.({
      you: user,
      users: userList(room),
      chat: room.chat,
      player: playerPayload(room),
      iceServers: iceServers(),
    });
    socket.to(room.id).emit('users', userList(room));
    systemMessage(room, `${user.name} заходит в зал`);
  });

  socket.on('rename', (name) => {
    if (!room) return;
    const n = clean(name, 32);
    if (!n || n === user.name) return;
    const old = user.name;
    user.name = n;
    io.to(room.id).emit('users', userList(room));
    systemMessage(room, `${old} теперь ${n}`);
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const t = clean(text, 1000);
    if (!t) return;
    pushChat(room, { id: crypto.randomUUID(), from: user.id, name: user.name, color: user.color, text: t, at: Date.now() });
  });

  socket.on('reaction', (emoji) => {
    if (!room) return;
    const e = clean(emoji, 8);
    if (!e) return;
    io.to(room.id).emit('reaction', { emoji: e, from: user.id, color: user.color });
  });

  socket.on('source', (src) => {
    if (!room) return;
    const s = validSource(src);
    if (!s) return;
    room.player = { source: s, playing: false, position: 0, rate: 1, updatedAt: Date.now(), by: user.id };
    io.to(room.id).emit('player', { ...playerPayload(room), reason: 'source' });
    systemMessage(room, `${user.name} включает «${s.title}»`);
  });

  socket.on('control', (c) => {
    if (!room || !room.player.source || !c) return;
    const p = room.player;
    const pos = Number(c.position);
    const position = Number.isFinite(pos) && pos >= 0 ? pos : currentPosition(p);
    const prevPos = currentPosition(p);
    if (c.action === 'play') {
      Object.assign(p, { playing: true, position, updatedAt: Date.now(), by: user.id });
      systemMessage(room, `${user.name}: ▶ продолжить с ${fmt(position)}`);
    } else if (c.action === 'pause') {
      Object.assign(p, { playing: false, position, updatedAt: Date.now(), by: user.id });
      systemMessage(room, `${user.name}: ❚❚ пауза на ${fmt(position)}`);
    } else if (c.action === 'seek') {
      Object.assign(p, { position, updatedAt: Date.now(), by: user.id });
      if (Math.abs(position - prevPos) > 2) systemMessage(room, `${user.name}: перемотка на ${fmt(position)}`);
    } else if (c.action === 'rate') {
      const r = Number(c.rate);
      if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(r)) return;
      Object.assign(p, { rate: r, position: prevPos, updatedAt: Date.now(), by: user.id });
      systemMessage(room, `${user.name}: скорость ×${r}`);
    } else return;
    io.to(room.id).emit('player', { ...playerPayload(room), reason: c.action, by: user.id });
  });

  // Плеер у кого-то закончил ролик — ставим на паузу у всех.
  socket.on('ended', () => {
    if (!room || !room.player.playing) return;
    Object.assign(room.player, { playing: false, position: currentPosition(room.player), updatedAt: Date.now() });
    io.to(room.id).emit('player', { ...playerPayload(room), reason: 'ended' });
  });

  // ---- голосовой чат: сигналинг WebRTC ----
  socket.on('voice-join', (ack) => {
    if (!room) return;
    user.inVoice = true;
    user.muted = false;
    const peers = [...room.users.values()].filter((u) => u.inVoice && u.id !== user.id).map((u) => u.id);
    ack?.({ peers });
    io.to(room.id).emit('users', userList(room));
  });

  socket.on('voice-leave', () => {
    if (!room || !user.inVoice) return;
    user.inVoice = false;
    socket.to(room.id).emit('voice-left', user.id);
    io.to(room.id).emit('users', userList(room));
  });

  socket.on('voice-mute', (muted) => {
    if (!room) return;
    user.muted = !!muted;
    io.to(room.id).emit('users', userList(room));
  });

  socket.on('signal', (msg) => {
    if (!room || !msg || typeof msg.to !== 'string') return;
    const target = room.users.get(msg.to);
    if (!target) return;
    io.to(msg.to).emit('signal', { from: user.id, data: msg.data });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.users.delete(socket.id);
    if (user.inVoice) socket.to(room.id).emit('voice-left', user.id);
    io.to(room.id).emit('users', userList(room));
    systemMessage(room, `${user.name} выходит из зала`);
    if (room.users.size === 0) {
      room.emptySince = Date.now();
      // Никого не осталось — ставим на паузу, чтобы позиция не «уезжала».
      if (room.player.playing) {
        Object.assign(room.player, { playing: false, position: currentPosition(room.player), updatedAt: Date.now() });
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL_MS) rooms.delete(id);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Кинозал запущен: http://localhost:${PORT}`));
