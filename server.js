// Doodle District LAN server: static files + a WebSocket room hub, with no npm dependencies.
//
// The original game was peer-to-peer over WebRTC and needed a public signalling service on the
// internet. This replaces that entirely: one machine runs this server, everybody on the LAN points
// their browser (and the in-game server box) at its IPv4 or IPv6 address, and every message is
// relayed here. No STUN, no NAT traversal, no mDNS candidates - things that all tend to fail on a
// closed network - and nothing to install.
//
//   node server.js [port]        default 8080, or set PORT
//
// Rooms live only in memory. A room dies when its last member leaves; if the host leaves while
// others are still in it, the oldest remaining member is promoted and everyone is told.

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_PLAYERS = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1: they get misread over voice chat
const MAX_FRAME = 1 << 20;

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  // path.normalize collapses "..", but a crafted path could still escape; check the result
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- minimal RFC 6455 server
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.closed = false;
    this.onmessage = null; this.onclose = null;
    this.fragOp = 0; this.frags = [];
    socket.on('data', (d) => this._feed(d));
    // Sockets handed over by an HTTP upgrade allow half-open, so a peer that hangs up gives us
    // 'end' and nothing else: no 'close', no 'error'. Miss that and the connection sits here for
    // ever — the player keeps their slot, the room is never dropped, and if they were the host
    // nobody is ever promoted in their place.
    socket.on('end', () => this._dead());
    socket.on('error', () => this._dead());
    socket.on('close', () => this._dead());
    socket.setNoDelay(true); // a 40ms Nagle delay on 20Hz position updates is very visible
  }
  _dead() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    if (this.onclose) this.onclose();
  }
  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._readFrame();
      if (!f) break;
      if (f.opcode === 0x8) { this.close(); return; }              // close
      if (f.opcode === 0x9) { this._write(f.payload, 0xa); continue; } // ping -> pong
      if (f.opcode === 0xa) continue;                              // pong
      if (f.opcode === 0x0) { this.frags.push(f.payload); }        // continuation
      else { this.fragOp = f.opcode; this.frags = [f.payload]; }
      if (!f.fin) continue;
      const body = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags);
      this.frags = [];
      if (this.fragOp === 0x1 && this.onmessage) this.onmessage(body.toString('utf8'));
    }
  }
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2);
      if (hi !== 0) { this.close(); return null; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > MAX_FRAME) { this.close(); return null; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    let payload;
    if (masked) {
      const key = b.slice(off, off + 4);
      payload = Buffer.allocUnsafe(len);
      b.copy(payload, 0, off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
    } else {
      payload = b.slice(off, off + len);
    }
    this.buf = b.slice(need);
    return { fin, opcode, payload };
  }
  _write(payload, opcode) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | opcode;
    try { this.socket.write(head); this.socket.write(payload); } catch (e) { this._dead(); }
  }
  send(str) { this._write(Buffer.from(str, 'utf8'), 0x1); }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this._closing = true;
      this.socket.end(Buffer.from([0x88, 0x00]));
      // end() only half-closes. A peer that never answers the close frame would otherwise hold
      // the socket open for ever, which is exactly the peer we are most likely closing on.
      setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* gone */ } }, 2000).unref();
    } catch (e) { /* already gone */ }
    if (this.onclose) this.onclose();
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WSConn(socket);
}

// ---------------------------------------------------------------- rooms
const clients = new Map();  // id -> client
const rooms = new Map();    // CODE -> room  (aliases point at the same room object)

let seq = 0;
const newId = () => 'p' + (++seq).toString(36) + Math.random().toString(36).slice(2, 7);
const randCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
const norm = (c) => String(c || '').trim().toUpperCase();

function freeCode() {
  for (let i = 0; i < 200; i++) { const c = randCode(); if (!rooms.has(c)) return c; }
  return randCode() + seq.toString(36).toUpperCase();
}

function makeRoom(code, host, { isPublic, name, map, max }) {
  const room = {
    code, codes: new Set([code]), hostId: host.id, isPublic: !!isPublic,
    members: new Map(), max: Math.min(Math.max(2, max || MAX_PLAYERS), 16),
    inMatch: false, accepting: true, hostName: name || '', map: map || null,
  };
  rooms.set(code, room);
  return room;
}

function dropRoom(room) {
  for (const c of room.codes) if (rooms.get(c) === room) rooms.delete(c);
}

function send(client, obj) { if (client && client.ws && !client.ws.closed) client.ws.send(JSON.stringify(obj)); }
function toRoom(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const m of room.members.values()) if (m.id !== exceptId && m.ws && !m.ws.closed) m.ws.send(s);
}

function roomInfo(room) {
  return {
    code: room.code, players: room.members.size, max: room.max, inMatch: room.inMatch,
    hostName: room.hostName, isPublic: room.isPublic, map: room.map, full: room.members.size >= room.max,
  };
}
const roster = (room) => [...room.members.values()].map((m) => ({ id: m.id, name: m.name }));

function leaveRoom(client, reason) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.members.delete(client.id);
  if (room.members.size === 0) { dropRoom(room); return; }
  if (room.hostId === client.id) {
    // promote the longest-standing member rather than dropping everyone's match
    const next = room.members.values().next().value;
    room.hostId = next.id; room.hostName = next.name;
    toRoom(room, { t: 'host', id: next.id, code: room.code });
  }
  toRoom(room, { t: 'gone', id: client.id, reason: reason || null });
}

function joinRoom(client, room, meta) {
  if (!room.accepting) return { error: 'that lobby is closed' };
  if (room.members.size >= room.max) return { error: 'that lobby is full' };
  leaveRoom(client);
  client.room = room;
  client.meta = meta || {};
  room.members.set(client.id, client);
  toRoom(room, { t: 'peer', id: client.id, meta: { name: client.name, ...(meta || {}) } }, client.id);
  return {
    t: 'joined', code: room.code, id: client.id, hostId: room.hostId, isPublic: room.isPublic,
    map: room.map, inMatch: room.inMatch, max: room.max, members: roster(room),
  };
}

// a lobby that changed hosts keeps living on generation codes (CODE-1, CODE-2); look through them
function resolveRoom(code) {
  const c = norm(code);
  if (rooms.has(c)) return rooms.get(c);
  const base = c.replace(/-\d+$/, '');
  if (rooms.has(base)) return rooms.get(base);
  for (const suf of ['-1', '-2', '-3']) if (rooms.has(base + suf)) return rooms.get(base + suf);
  return null;
}

function onMessage(client, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const room = client.room;

  switch (m.t) {
    case 'hello':
      client.name = String(m.name || '').slice(0, 14);
      send(client, { t: 'hello', id: client.id, max: MAX_PLAYERS });
      break;

    case 'name':
      client.name = String(m.name || '').slice(0, 14);
      if (room && room.hostId === client.id) room.hostName = client.name;
      break;

    case 'create': {
      leaveRoom(client);
      const want = m.code ? norm(m.code) : null;
      if (want && rooms.has(want)) { send(client, { t: 'error', for: 'create', message: 'that code is taken' }); break; }
      const r = makeRoom(want || freeCode(), client, { isPublic: m.isPublic, name: client.name, map: m.map, max: m.max });
      client.room = r; r.members.set(client.id, client);
      send(client, { t: 'created', code: r.code, id: client.id, hostId: r.hostId, isPublic: r.isPublic, max: r.max, members: roster(r) });
      break;
    }

    case 'alias': {
      // after a host transfer the lobby answers on a generation code; re-claim the code people know
      if (!room || room.hostId !== client.id) break;
      const c = norm(m.code);
      if (!c || (rooms.has(c) && rooms.get(c) !== room)) { send(client, { t: 'error', for: 'alias', message: 'that code is taken' }); break; }
      rooms.set(c, room); room.codes.add(c); room.code = c;
      send(client, { t: 'alias', code: c });
      toRoom(room, { t: 'roominfo', code: c }, client.id);
      break;
    }

    case 'join': {
      const r = resolveRoom(m.code);
      if (!r) { send(client, { t: 'error', for: 'join', message: 'no lobby with that code' }); break; }
      const res = joinRoom(client, r, m.meta);
      if (res.error) send(client, { t: 'error', for: 'join', message: res.error });
      else send(client, res);
      break;
    }

    case 'quick': {
      // the fullest lobby with room left, so players pile into one game instead of scattering
      let best = null;
      for (const r of new Set(rooms.values())) {
        if (!r.isPublic || !r.accepting || r.members.size >= r.max) continue;
        if (!best || r.members.size > best.members.size) best = r;
      }
      if (!best) { send(client, { t: 'error', for: 'quick', message: 'no open public lobbies' }); break; }
      const res = joinRoom(client, best, m.meta);
      if (res.error) send(client, { t: 'error', for: 'quick', message: res.error });
      else send(client, res);
      break;
    }

    case 'list':
      send(client, {
        t: 'list',
        rooms: [...new Set(rooms.values())].filter((r) => r.isPublic).map(roomInfo).sort((a, b) => b.players - a.players),
      });
      break;

    case 'state':
      if (!room || room.hostId !== client.id) break;
      if (typeof m.inMatch === 'boolean') room.inMatch = m.inMatch;
      if (typeof m.accepting === 'boolean') room.accepting = m.accepting;
      if (m.map) room.map = m.map;
      break;

    case 'kick': {
      if (!room || room.hostId !== client.id) break;
      const victim = room.members.get(m.id);
      if (!victim) break;
      send(victim, { t: 'closed', reason: m.reason || 'kicked' });
      leaveRoom(victim, m.reason || 'kicked');
      break;
    }

    case 'leave':
      leaveRoom(client);
      break;

    // game payload: the server does the routing the host used to do by hand
    case 'm': {
      if (!room) break;
      const out = JSON.stringify({ t: 'm', tt: m.tt, d: m.d, from: client.id });
      if (m.to) { const target = room.members.get(m.to); if (target && target.ws && !target.ws.closed) target.ws.send(out); break; }
      if (m.relay || client.id === room.hostId) { for (const p of room.members.values()) if (p.id !== client.id && p.ws && !p.ws.closed) p.ws.send(out); break; }
      const host = room.members.get(room.hostId);
      if (host && host.ws && !host.ws.closed) host.ws.send(out);
      break;
    }

    case 'ping':
      send(client, { t: 'pong', d: m.d });
      break;

    default: break;
  }
}

// ---------------------------------------------------------------- wiring
const server = http.createServer((req, res) => {
  if (req.url === '/lan/info') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ port: PORT, addresses: localAddresses(), rooms: new Set(rooms.values()).size, players: clients.size }));
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws') { socket.destroy(); return; }
  const ws = handleUpgrade(req, socket);
  if (!ws) return;
  const client = { id: newId(), ws, name: '', room: null, meta: {}, seen: Date.now() };
  clients.set(client.id, client);
  ws.onmessage = (raw) => { client.seen = Date.now(); try { onMessage(client, raw); } catch (e) { console.error('message error:', e.message); } };
  ws.onclose = () => { leaveRoom(client); clients.delete(client.id); };
  send(client, { t: 'hello', id: client.id, max: MAX_PLAYERS });
});

// Closing a laptop lid or dropping off the wifi sends no FIN, so TCP alone would hold that player's
// slot for minutes. Clients ping every 15s; three missed pings and we treat them as gone, which
// frees the slot and promotes a new host through the same path as a clean disconnect.
const SILENT_MS = 45000;
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) if (now - c.seen > SILENT_MS) c.ws.close();
}, 5000).unref();

function localAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && /^fe80:/i.test(a.address)) continue; // link-local needs a zone id browsers will not take
      out.push({ iface, family: a.family, address: a.address });
    }
  }
  // IPv4 first: it is what people can actually read out loud to each other
  return out.sort((a, b) => (a.family === b.family ? 0 : a.family === 'IPv4' ? -1 : 1));
}

server.listen(PORT, () => {
  const addrs = localAddresses();
  const url = (a) => (a.family === 'IPv6' ? `http://[${a.address}]:${PORT}` : `http://${a.address}:${PORT}`);
  console.log('\n  Doodle District — LAN server\n');
  console.log(`  on this machine   http://localhost:${PORT}`);
  if (!addrs.length) console.log('  (no LAN address found — is this machine on a network?)');
  for (const a of addrs) console.log(`  on the LAN        ${url(a)}   [${a.iface} ${a.family}]`);
  console.log('\n  Others open one of the LAN links, or keep their own copy and type');
  console.log(`  the address into PLAY ONLINE → server. Ctrl+C to stop.\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`port ${PORT} is already in use — try: node server.js ${PORT + 1}`);
  else console.error(e.message);
  process.exit(1);
});
