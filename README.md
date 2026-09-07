# Doodle District

A local mirror of [doodleshooter.vercel.app](https://doodleshooter.vercel.app), rebuilt to run entirely on
your own LAN: no CDN, no internet, no signalling service. Everything the page needs — three.js, the
font — is vendored into `vendor/`, and multiplayer runs over a small WebSocket server included here.

## Running it

```
node server.js          # port 8080
node server.js 9000     # or pick your own
PORT=9000 node server.js
```

No `npm install`, no dependencies — the server is plain Node (tested on Node 20+). It serves the
static files and the game's rooms from the same port, and listens on `::`, so it answers on IPv4 and
IPv6 at once.

On startup it prints every address the machine can be reached at. Anyone on the same network opens
one of them in a browser; `/lan/info` returns the same list as JSON along with the current room count.

## Playing together

Open the game, choose **ONLINE**. Everyone can host and everyone can join:

- **CREATE ROOM** hands you a four-character code. Share it.
- **JOIN** takes that code, or **QUICK PLAY** drops you into any room with space.
- The lobby list shows public rooms on the same server; a room can be public or invite-only.

Rooms hold up to 10 players. If the host leaves, the server promotes whoever has been in the room
longest and the match carries on — nobody gets dropped. That covers the ugly exits too: a player who
closes their laptop or walks out of wifi range never sends a goodbye, so the server drops anyone
silent for 45 seconds rather than letting the room wait on a ghost.

### Connecting to someone else's machine

The **SERVER** box on the online screen points the client at whichever machine is running
`node server.js`. Leave it empty to use the one that served the page. Otherwise any of these work:

```
192.168.1.42            bare IPv4, port 8080 assumed
192.168.1.42:9000       with a port
fd12:3456::1            bare IPv6
[fd12:3456::1]:9000     IPv6 with a port
http://desktop.local:8080
```

The address is remembered between sessions. It is validated as you save it, and the lobby list
refreshes against the new server straight away.

### Game modes

Picked by the host in the lobby, before the match starts:

- **VERSUS** — free-for-all deathmatch on a timer. Most kills wins.
- **SQUAD** — co-op against the waves. Harder than solo and it scales with the squad: bigger wave
  counts, a higher live-enemy ceiling, tougher hits and more pickups per wave. Downed teammates show
  struck through on the scoreboard, and the run ends when the whole squad is down at once.

## How the multiplayer fits together

The original used WebRTC peer-to-peer. That is the wrong shape for a LAN — it needs a STUN server to
discover addresses, Chrome hides local candidates behind mDNS, and plenty of home routers will not
hairpin a connection back to the network it came from. So peering is gone; the server relays instead,
which on a LAN is a millisecond either way and works with no internet at all.

One player in each room is the host, and the host is authoritative over enemies, waves and pickups.
Clients mirror what it tells them. Damage authority is split: the host owns enemy health and decides
who dies, while enemy *projectiles* are replayed on every client so each one applies its own hurt
locally and reacts without waiting for a round trip. Melee and blast damage stay with the host and
arrive as a message.

Damage between *players* is not the host's to give, and it is not the shooter's either. A client that
thinks it hit someone sends a claim — the weapon, the damage, and the ray it fired — and the server
decides. Because a claim describes something the shooter saw a round trip and an interpolation buffer
ago, the server rewinds: it keeps 1.5 s of everyone's positions from the movement feed it is already
relaying, times each client's round trip itself (never asking, since a bigger number would buy a
deeper rewind), and tests the shot against where the target stood `rtt + 80 ms` ago, capped at half a
second. It then checks the damage against what that gun can do, the origin against where the shooter
was, and the rate against what the gun can fire. It has no copy of the level and no skeleton, so it
cannot know a wall was in the way and it tests a capsule rather than animated limbs — but the shot
now has to be plausible, and the latency is out of the way when it is judged.

## Layout

```
index.html      importmap points at vendor/, no external <script>
server.js       static files + rooms + WebSocket, zero dependencies
src/            game source
  net.js        client transport
  nav.js        navigation grid and A*
  enemies.js    enemy AI, spawning, replication
  main.js       game loop, lobby and HUD wiring
vendor/         three.js, BufferGeometryUtils, the font
```
