// Arena opponents share player bodies and snapshots. Only the host makes decisions; health,
// respawns and bomb progress belong to the match, and every damaging claim goes through the server.
import * as THREE from 'three';
import { makeBody, SEE_THROUGH } from './physics.js';
import { encodeLocal } from './players.js';
import { INK } from './render.js';
import { clamp, angleLerp } from './util.js';

const point = (p) => Array.isArray(p) ? new THREE.Vector3().fromArray(p) : p?.isVector3 ? p.clone() : p && Number.isFinite(p.x) ? new THREE.Vector3(p.x, p.y, p.z) : null;
const distanceXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const weaponIndex = (rule) => rule === 'knives' ? 3 : rule === 'grenades' ? 5 : 0;
const random = (lo, hi) => lo + Math.random() * (hi - lo);

export class ArenaBots {
  constructor(ctx, match) {
    this.ctx = ctx; this.match = match; this.sims = new Map(); this.sequence = 0;
    this.nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  clear() { this.sims.clear(); }
  replayGrenades() {
    if (!this.match.net.isHost || this.match.state?.phase !== 'live') return 0;
    let sent = 0;
    for (const n of this.ctx.player.nades) {
      if (!n.charged || !n.botLaunch || n.expiresAt <= this.match.now() || !this.match.actor(n.owner)?.bot || n.round !== this.match.state.round) continue;
      // Reconnect may retry a registration, but never turns the current in-flight position into
      // a fresh launch or replenishes a fuse. The server deduplicates the unchanged grenade id.
      this.match.net.send('botnade', { id: n.owner, nade: n.botLaunch, round: n.round }); sent++;
    }
    return sent;
  }
  _position(actor) {
    const sim = actor.bot && this.sims.get(actor.id);
    if (sim && sim.life === actor.life && sim.round === this.match.state.round) return sim.body.pos;
    const body = this.match.body(actor.id)?.body;
    return body?.pos || point(actor.ps?.slice(0, 3)) || point(actor.spawn);
  }
  _sites() {
    const source = this.ctx.level.bombSites || [];
    return source.map((site, i) => ({ id: site.id || site.key || String.fromCharCode(65 + i), pos: point(site.pos || site.p || site.center || site), radius: site.radius || site.r || 3.2 })).filter((site) => site.pos);
  }
  _create(actor, now) {
    // A transferred host resumes the last wire position; a new life starts at its assigned base.
    const previous = this.sims.get(actor.id), freshLife = previous && (previous.life !== actor.life || previous.round !== this.match.state.round);
    const snap = freshLife ? null : actor.ps;
    const pos = point(snap?.slice(0, 3)) || point(actor.spawn) || new THREE.Vector3();
    const body = makeBody(pos, 0.35, 1.75, 0.6); body.onGround = true;
    if (snap?.length > 10) body.vel.fromArray(snap.slice(8, 11));
    const sim = { id: actor.id, life: actor.life, round: this.match.state.round, body, yaw: snap?.[3] ?? actor.yaw ?? 0, pitch: 0,
      hp: actor.hp, alive: actor.alive, target: null, seenAt: 0, lastSeen: null, eye: new THREE.Vector3(),
      thinkAt: now + random(0, 150), pathAt: 0, path: [], pathIndex: 0, goal: null,
      fireAt: now + random(650, 1100), acquiredAt: now, burst: 0, grenadeAt: now + random(2500, 4500),
      chargeAt: null, firedUntil: 0, wireAt: 0, stuck: 0, lastPos: pos.clone(), side: Math.random() < 0.5 ? -1 : 1,
      patrolAt: 0, patrol: null, lastIntent: false, role: this._hash(actor.id) };
    this.sims.set(actor.id, sim); this._publish(actor, sim, now, true); return sim;
  }
  _hash(id) { let value = 0; for (const c of id) value = (value * 31 + c.charCodeAt(0)) >>> 0; return value; }
  _visible(sim, actor, now) {
    if (!actor.alive || actor.protectedUntil > now) return false;
    const p = this._position(actor); if (!p) return false;
    const eye = p.clone(); eye.y += 1.0;
    return sim.eye.distanceToSquared(eye) < 72 * 72 && this.ctx.world.hasLineOfSight(sim.eye, eye, SEE_THROUGH);
  }
  _think(actor, sim, now) {
    let target = null, best = Infinity;
    for (const other of this.match.state.actors) {
      if (other.team === actor.team || other.id === actor.id || !this._visible(sim, other, now)) continue;
      const p = this._position(other), dist = sim.body.pos.distanceToSquared(p) * (sim.target === other.id ? 0.8 : 1);
      if (dist < best) { best = dist; target = other; }
    }
    if (target) {
      if (sim.target !== target.id) { sim.acquiredAt = now; sim.fireAt = Math.max(sim.fireAt, now + random(450, 850)); sim.chargeAt = null; }
      sim.target = target.id; sim.lastSeen = this._position(target).clone(); sim.seenAt = now;
    } else if (now - sim.seenAt > 4200 || !this.match.actor(sim.target)?.alive) { sim.target = null; sim.lastSeen = null; sim.chargeAt = null; }
    sim.thinkAt = now + random(170, 280);
  }
  _objective(actor, sim, now) {
    const state = this.match.state, sites = this._sites(), bomb = state.bomb;
    if (state.mode === 'demolition' && bomb) {
      const attack = actor.team === state.attackTeam;
      if (attack && bomb.status === 'carried' && bomb.carrier === actor.id && sites.length) {
        const site = sites[(sim.role + state.round) % sites.length];
        return { pos: site.pos, interact: true, radius: Math.min(1.3, site.radius * 0.55), priority: true };
      }
      if (attack && bomb.status === 'dropped') return { pos: point(bomb.pos), interact: true, radius: 0.65, priority: true };
      if (bomb.status === 'planted') {
        const pos = point(bomb.pos); if (!pos) return null;
        if (!attack) {
          // One defender works on the bomb while the others cover; losing that defender hands
          // the job to the nearest survivor on the next frame rather than resetting the team.
          const candidates = state.actors.filter((a) => a.team === actor.team && a.alive && a.bot);
          candidates.sort((a, b) => (this._position(a)?.distanceToSquared(pos) ?? Infinity) - (this._position(b)?.distanceToSquared(pos) ?? Infinity));
          if (candidates[0]?.id === actor.id) return { pos, interact: true, radius: 1.25, priority: true };
        }
        const a = sim.role * 2.39996, guard = pos.clone().add(new THREE.Vector3(Math.cos(a) * 6, 0, Math.sin(a) * 6));
        return { pos: guard, interact: false, radius: 1.6, priority: false };
      }
      if (!attack && sites.length) return { pos: sites[sim.role % sites.length].pos, interact: false, radius: 2.5, priority: false };
    }
    return null;
  }
  _patrol(actor, sim, now) {
    if (sim.patrol && now < sim.patrolAt && distanceXZ(sim.body.pos, sim.patrol) > 2) return sim.patrol;
    const bases = this.ctx.level.teamSpawns?.[1 - actor.team] || [], sites = this._sites();
    const destinations = [...sites.map((s) => s.pos), ...bases.map(point).filter(Boolean)];
    if (!destinations.length) destinations.push(...(this.ctx.level.arenaSpawns || []).map(point).filter(Boolean));
    const chosen = destinations.length ? destinations[(sim.role + Math.floor(now / 14000)) % destinations.length] : new THREE.Vector3();
    sim.patrol = chosen.clone(); sim.patrolAt = now + random(11000, 17000); return sim.patrol;
  }
  _route(sim, goal, now) {
    if (!goal) return null;
    if (!sim.goal || sim.goal.distanceToSquared(goal) > 5 || now >= sim.pathAt) {
      sim.goal = goal.clone(); sim.pathAt = now + random(800, 1350);
      const nav = this.ctx.nav;
      sim.path = nav.walkClear(sim.body.pos, goal) ? [goal.clone()] : nav.findPath(sim.body.pos, goal, 16000) || [];
      sim.pathIndex = 0;
    }
    while (sim.pathIndex < sim.path.length - 1 && distanceXZ(sim.body.pos, sim.path[sim.pathIndex]) < 0.65 && Math.abs(sim.body.pos.y - sim.path[sim.pathIndex].y) < 1.35) sim.pathIndex++;
    return sim.path[sim.pathIndex] || null;
  }
  _walk(actor, sim, goal, stopRadius, dt, now, visibleTarget) {
    const b = sim.body, desired = new THREE.Vector3(), atGoal = goal && distanceXZ(b.pos, goal) <= stopRadius && Math.abs(b.pos.y - goal.y) < 1.25;
    const next = !atGoal && this._route(sim, goal, now);
    if (next) {
      desired.subVectors(next, b.pos); desired.y = 0;
      if (desired.lengthSq() > 0.01) desired.normalize();
      if (next.y > b.pos.y + 0.55 && next.y < b.pos.y + 1.6 && b.onGround) b.vel.y = 7.8;
    }
    // Bodies are not dynamic colliders. Separation keeps teammates from merging into a stack
    // at doors, and also leaves space for a human working on the bomb.
    if (!atGoal) for (const other of this.match.state.actors) {
      if (other.id === actor.id || !other.alive) continue;
      const p = this._position(other); if (!p || Math.abs(p.y - b.pos.y) > 1.5) continue;
      const dx = b.pos.x - p.x, dz = b.pos.z - p.z, d = Math.hypot(dx, dz);
      if (d > 0.02 && d < 1.2) { desired.x += dx / d * (1.2 - d) * 0.85; desired.z += dz / d * (1.2 - d) * 0.85; }
    }
    const rule = this.match.lobby.weaponMode, speed = rule === 'knives' ? 6.5 : visibleTarget ? 4.1 : 5.4;
    if (desired.lengthSq() > 1) desired.normalize();
    b.vel.x += (desired.x * speed - b.vel.x) * Math.min(1, dt * 10); b.vel.z += (desired.z * speed - b.vel.z) * Math.min(1, dt * 10);
    b.vel.y -= 24 * dt; this.ctx.world.moveBody(b, dt);
    if (desired.lengthSq() > 0.2 && b.pos.distanceToSquared(sim.lastPos) < dt * dt * 0.3) sim.stuck += dt; else sim.stuck = Math.max(0, sim.stuck - dt * 2);
    if (sim.stuck > 0.7 && b.onGround) { b.vel.y = 7.8; sim.pathAt = 0; sim.side *= -1; sim.stuck = 0; }
    sim.lastPos.copy(b.pos);
    return atGoal && Math.hypot(b.vel.x, b.vel.z) < 0.35;
  }
  _visualShot(actor, sim, kind, origin, end, now) {
    if (actor.protectedUntil > now) {
      actor.protectedUntil = 0;
      this.match.net.send('unshield', { id: actor.id, round: this.match.state.round, life: actor.life });
    }
    sim.firedUntil = now + 120;
    const ink = actor.team === 0 ? INK.BLUE : INK.ORANGE;
    if (kind !== 'katana') this.ctx.effects.tracer(origin, end, ink, 0.02, 0.1);
    this.ctx.effects.strokeBurst(origin, ink, 4, 3, { life: 0.09, size: 0.03 });
    if (kind === 'katana') this.ctx.audio?.noise?.({ dur: 0.2, gain: 0.35, type: 'bandpass', freq: 500, freqEnd: 3000, q: 1.5, pos: origin });
    else this.ctx.audio?.remoteShot?.(kind, origin);
    this.match.net.send('botshots', { id: actor.id, k: kind, o: origin.toArray(), e: end.toArray(), round: this.match.state.round });
  }
  _attack(actor, sim, target, dt, now) {
    if (!target || !this._visible(sim, target, now)) { sim.chargeAt = null; return; }
    const pos = this._position(target), aim = pos.clone(); aim.y += 1.02;
    const delta = aim.clone().sub(sim.eye), distance = delta.length(); delta.normalize();
    const rule = this.match.lobby.weaponMode;
    if (rule === 'grenades') { if (now >= sim.grenadeAt && distance > 7 && distance < 48) this._grenade(actor, sim, aim, now); return; }
    if (rule === 'knives') {
      if (distance > 12 && distance < 40 && now >= sim.grenadeAt) this._grenade(actor, sim, aim, now);
      if (distance > 4.1 || now < sim.fireAt) { sim.chargeAt = null; return; }
      if (sim.chargeAt === null) sim.chargeAt = now;
      if (now - sim.chargeAt < 800) return;
      sim.chargeAt = null; sim.fireAt = now + 750;
      this._visualShot(actor, sim, 'katana', sim.eye, aim, now);
      if (distance < 3.2) this.match.net.send('bothit', { id: actor.id, to: target.id, k: 'katana', charge: 1, dmg: 165, round: this.match.state.round });
      return;
    }
    if (now < sim.fireAt || now - sim.acquiredAt < 500 || distance > 65) return;
    if (sim.burst <= 0) sim.burst = 3;
    sim.burst--; sim.fireAt = now + (sim.burst ? 170 : random(800, 1250));
    const hit = Math.random() < clamp(0.8 - distance * 0.009, 0.22, 0.74);
    const end = aim.clone();
    if (!hit) { end.x += random(0.8, 1.9) * sim.side; end.y += random(-0.6, 0.9); }
    const dir = end.clone().sub(sim.eye).normalize(), wall = this.ctx.world.raycast(sim.eye, dir, distance + 3, SEE_THROUGH);
    this._visualShot(actor, sim, 'rifle', sim.eye, wall && wall.dist < distance ? wall.point : end, now);
    if (hit && (!wall || wall.dist >= distance)) this.match.net.send('bothit', { id: actor.id, to: target.id, k: 'rifle', dmg: 19, o: sim.eye.toArray(), d: dir.toArray(), r: distance + 1, round: this.match.state.round });
  }
  _grenade(actor, sim, aim, now) {
    if (actor.protectedUntil > now) {
      actor.protectedUntil = 0;
      this.match.net.send('unshield', { id: actor.id, round: this.match.state.round, life: actor.life });
    }
    const pos = sim.eye.clone(), delta = aim.clone().sub(pos), flat = Math.hypot(delta.x, delta.z);
    const flight = clamp(flat / 15, 0.85, 2.1), vel = new THREE.Vector3(delta.x / flight, delta.y / flight + 11 * flight, delta.z / flight);
    if (vel.length() > 65) vel.multiplyScalar(65 / vel.length());
    // Use the same seven-second fuse and bouncing projectile as a human throw, so a grenade
    // remains visible, dodgeable and live after its thrower dies.
    const packet = { id: `${actor.id.slice(0, 36)}:${actor.life}:${this.nonce}:${++this.sequence}`, charged: true, phase: 'thrown', pos: pos.toArray(), vel: vel.toArray(), expiresAt: now + 7000, thrownAt: now };
    this._publish(actor, sim, now, true);
    this.match.net.send('botnade', { id: actor.id, nade: packet, round: this.match.state.round });
    this.ctx.player.receiveGrenade(packet, actor.id);
    const nade = this.ctx.player.nades.find((n) => n.owner === actor.id && n.id === packet.id);
    if (nade) { nade.mine = true; nade.bot = true; nade.round = this.match.state.round; nade.thrownAt = now; nade.botLaunch = packet; }
    sim.firedUntil = now + 250; sim.grenadeAt = now + random(3600, 5200);
  }
  _publish(actor, sim, now, force = false) {
    sim.hp = actor.hp; sim.alive = actor.alive;
    const ps = encodeLocal(sim, weaponIndex(this.match.lobby.weaponMode), { firing: now < sim.firedUntil });
    actor.ps = ps;
    const remote = this.match.remote.get(actor.id);
    // The host already has this body's current position. Interpolating it a second time would
    // pull its collision target backwards between packets; guests still interpolate at 10 Hz.
    if (remote) {
      const stamp = performance.now() / 1000;
      remote.push(ps, stamp); remote.snapA = remote.snapB; remote.body.pos.copy(sim.body.pos); remote.update(0, stamp + 0.08);
    }
    if (!force && now < sim.wireAt) return;
    this.match.net.send('botps', { id: actor.id, ps, round: this.match.state.round, life: actor.life }); sim.wireAt = now + 100;
  }
  update(dt) {
    const match = this.match, state = match.state;
    if (!match.net.isHost || !state || state.phase !== 'live') return;
    const now = match.now(); dt = clamp(dt, 0, 0.1);
    const ids = new Set(state.actors.filter((a) => a.bot).map((a) => a.id));
    for (const id of this.sims.keys()) if (!ids.has(id)) this.sims.delete(id);
    for (const actor of state.actors) {
      if (!actor.bot) continue;
      let sim = this.sims.get(actor.id);
      if (!sim || sim.life !== actor.life || sim.round !== state.round) sim = this._create(actor, now);
      if (!actor.alive) { sim.body.vel.set(0, 0, 0); sim.chargeAt = null; this._publish(actor, sim, now); continue; }
      sim.eye.copy(sim.body.pos); sim.eye.y += 1.45;
      if (now >= sim.thinkAt) this._think(actor, sim, now);
      const target = match.actor(sim.target), visible = target && this._visible(sim, target, now), objective = this._objective(actor, sim, now);
      const rule = match.lobby.weaponMode;
      let goal = objective?.pos || this._patrol(actor, sim, now), stop = objective?.radius || 1.5;
      if (visible && !objective?.priority) {
        goal = this._position(target).clone(); stop = rule === 'knives' ? 2.0 : rule === 'grenades' ? 17 : 15;
        if (rule !== 'knives' && distanceXZ(sim.body.pos, goal) < stop + 8) {
          const away = sim.body.pos.clone().sub(goal); away.y = 0; away.normalize();
          const side = new THREE.Vector3(-away.z, 0, away.x).multiplyScalar(sim.side * 3.3);
          const tactical = goal.clone().addScaledVector(away, stop).add(side);
          if (this.ctx.nav.walkClear(sim.body.pos, tactical)) { goal = tactical; stop = 0.9; }
        }
      } else if (sim.lastSeen && !objective?.priority) { goal = sim.lastSeen; stop = 1.5; }
      let dodging = false;
      for (const nade of this.ctx.player.nades) {
        if (!nade.charged || nade.expiresAt - now > 2100 || match.actor(nade.owner)?.team === actor.team) continue;
        const pos = point(nade.pos); if (!pos || pos.distanceToSquared(sim.body.pos) > 64) continue;
        const away = sim.body.pos.clone().sub(pos); away.y = 0;
        if (away.lengthSq() < 0.1) away.set(sim.side, 0, 1);
        const escape = sim.body.pos.clone().addScaledVector(away.normalize(), 8);
        if (this.ctx.nav.walkClear(sim.body.pos, escape)) { goal = escape; stop = 0.5; dodging = true; break; }
      }
      const stopped = this._walk(actor, sim, goal, stop, dt, now, visible);
      sim.eye.copy(sim.body.pos); sim.eye.y += 1.45;
      const look = visible ? this._position(target).clone().add(new THREE.Vector3(0, 1, 0)) : sim.path[sim.pathIndex] || goal;
      if (look) { const v = look.clone().sub(sim.eye); sim.yaw = angleLerp(sim.yaw, Math.atan2(-v.x, -v.z), Math.min(1, dt * 7)); sim.pitch += (Math.atan2(v.y, Math.hypot(v.x, v.z)) - sim.pitch) * Math.min(1, dt * 7); }
      const interacting = !!(objective?.interact && stopped && !dodging);
      if (interacting || sim.lastIntent) match.intent(actor.id, { held: interacting, moving: !stopped, attacking: false, round: state.round, life: actor.life });
      sim.lastIntent = interacting;
      if (!interacting) this._attack(actor, sim, visible ? target : null, dt, now);
      this._publish(actor, sim, now);
    }
  }
}
