import { Room, matchMaker } from '@colyseus/core';
import { BrickWorld } from './BrickWorld.js';
import { loadGame } from './headless.js';

// Same letters as the game's room codes: no 0/O or 1/I, so codes are easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLACES = ['classic', 'baseplate', 'redblue'];
// each running room's game uses about a fifth of a CPU core; past this many, new games wait for one to close
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 4;

/* The lag watch. Once a second each room checks how its game and its brick physics are keeping up.
   A room that stays too slow (or keeps crashing) sends everyone out with the reason, then restarts
   itself with a fresh world and the same code, so they can rejoin. When the whole server is slow,
   only the room doing the most work restarts (and then the others get a moment to recover). */
const LAG = {
  minFps: 20,         // the game normally runs 60 frames a second
  minSteps: 25,       // the brick physics normally steps 60 times a second
  badFor: 8,          // seconds in a row that slow before restarting
  maxErrors: 60,      // game errors in 10 seconds before it counts as crashed
  calm: 15000,        // after any room restarts, the others wait this long before restarting too
};
const rooms = new Set();
let lastRestart = 0;

async function freeCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!(await matchMaker.getRoomById(code))) return code;
  }
  throw new Error('No free room codes');
}

/* One Blockburg game. The 4-letter room code is the room's id, so friends join with joinById(code).
   A public room (pub: true) is a game's open server: Play Online joins it with joinOrCreate, so
   everyone who picks that game lands in the same room (a new one opens only when it's full).

   The game itself runs here: each room boots its own copy of blockburg-classic.html with no screen
   (headless.js), and that copy is the host. It runs the people, tools, damage, hats, chat and Guests,
   exactly as a host's browser used to. The bricks' physics runs in BrickWorld.
   Every person who joins is a client. Messages:
     toHost  a player -> the game                (the game gets it as 'm' with { from, m })
     bricks  a player who just joined -> here:  send me every brick's position
     m       the game -> one player, or everyone (welcome, events, snapshots...)
     w       here -> everyone (and the game): where the bricks are now, bricks that fell off the world
   Inside, the game talks to this room through `this.host` (see makeHostLink). */
export class BlockburgRoom extends Room {
  maxClients = 8;

  async onCreate(options) {
    if ((await matchMaker.query({ name: 'blockburg' })).length >= MAX_ROOMS) throw new Error('The server is full right now. Join a friend\'s room with their code, or try again later.');
    this.roomId = await freeCode();
    this.place = PLACES.includes(options.place) ? options.place : 'classic';
    this.pub = options.pub === true;
    await this.setMetadata({ place: this.place, pub: this.pub });
    await this.boot();

    this.onMessage('toHost', (client, m) => { if (!this.restarting) this.toHost({ from: client.sessionId, m }); });
    // a player who just got the welcome: the game's copy of the bricks can be a moment behind, so here's where every brick really is
    this.onMessage('bricks', (client) => client.send('w', { t: 'bs', p: this.bricks.all() }));

    // physics 60 times a second, brick positions out to everyone 15 times a second
    this.setSimulationInterval((dt) => {
      if (this.restarting) return;
      const t0 = performance.now();
      try { this.bricks.step(dt / 1000, this.clock.currentTime); } catch (e) { this.errors++; this.lastError = String(e?.message || e).slice(0, 120); }
      this.steps++; this.busy += performance.now() - t0;
    }, 1000 / 60);
    this.clock.setInterval(() => { if (!this.restarting) this.sendBricks(); }, 1000 / 15);
    this.clock.setInterval(() => this.lagWatch(), 1000);
    rooms.add(this);
  }

  // a fresh world: a new brick world, and a new copy of the game as its host
  async boot() {
    this.bricks = new BrickWorld();
    this.game = await loadGame();
    this.host = this.makeHostLink();
    this.game.g.serverHost(this.host.room, this.place);
    Object.assign(this, { steps: 0, busy: 0, errors: 0, lastError: '', slowFor: 0, errLog: [], seen: { at: performance.now(), frames: 0, busy: 0, errors: 0 } });
  }

  // once a second: is this room keeping up?
  lagWatch() {
    if (this.restarting || !this.game) return;
    const now = performance.now(), p = this.game.perf, s = this.seen, secs = Math.max(0.25, (now - s.at) / 1000);
    const fps = (p.frames - s.frames) / secs, steps = this.steps / secs;
    this.work = (p.busy - s.busy + this.busy) / secs;   // ms of work each second (1000 = a whole CPU core)
    const errors = p.errors - s.errors + this.errors;
    Object.assign(s, { at: now, frames: p.frames, busy: p.busy, errors: p.errors }); this.steps = 0; this.busy = 0; this.errors = 0;
    // crashing: lots of errors over the last 10 seconds
    this.errLog.push(errors); if (this.errLog.length > 10) this.errLog.shift();
    if (this.errLog.reduce((a, b) => a + b, 0) >= LAG.maxErrors) return this.restart('crash', `error: ${p.lastError || this.lastError || 'unknown'}`);
    // lagging
    const slow = fps < LAG.minFps || steps < LAG.minSteps;
    this.slowFor = slow ? this.slowFor + secs : 0;
    this.lagNote = `${Math.round(fps)} game frames and ${Math.round(steps)} physics steps a second, instead of 60`;
    if (this.slowFor < LAG.badFor || Date.now() - lastRestart < LAG.calm) return;
    // the whole server can be slow because of one room: only the busiest slow room restarts
    const worst = [...rooms].filter(r => !r.restarting && r.slowFor >= LAG.badFor).sort((a, b) => (b.work || 0) - (a.work || 0))[0];
    if (worst === this) this.restart('serverlag', this.lagNote);
  }

  // send everyone out (saying why), then start the room over: same code, fresh world
  async restart(why, detail) {
    if (this.restarting) return;
    this.restarting = true; lastRestart = Date.now();
    console.warn(`BLOCKBURG room ${this.roomId}: restarting (${why}: ${detail})`);
    this.autoDispose = false;   // (stay open while it's empty, so everyone can rejoin with the same code)
    await this.lock();
    for (const c of [...this.clients]) {
      c.send('m', { t: 'kicked', why, detail, code: this.roomId });
      c.leave(4000);
    }
    try { this.game?.stop(); } catch { }
    try { await this.boot(); } catch (e) {
      console.warn(`BLOCKBURG room ${this.roomId}: couldn't restart`, e);
      this.restarting = false; this.disconnect(); return;
    }
    this.restarting = false;
    await this.unlock();
    this.autoDispose = true;
    this.resetAutoDisposeTimeout(60);   // nobody back in a minute: then it closes like any empty room
  }

  // what the game sees as its room: the same send / onMessage a browser's Colyseus room has
  makeHostLink() {
    const handlers = {};
    const room = {
      roomId: this.roomId,
      connection: { isOpen: true },
      onMessage: (type, cb) => { handlers[type] = cb; },
      onLeave() { },
      leave: async () => { },
      send: (type, msg) => this.fromHost(type, msg),
    };
    const deliver = (type, msg) => {
      try { handlers[type]?.(msg); } catch (e) { this.errors++; this.lastError = String(e?.message || e).slice(0, 120); console.warn('BLOCKBURG game error:', e); }
    };
    return { room, deliver };
  }

  // the game (the host) wants to send something
  fromHost(type, msg) {
    if (!msg) return;
    switch (type) {
      case 'all':   // to every player; it also tells the brick world which bricks appeared or vanished, and where people are
        this.watchHost(msg);
        if (this.clients.length) this.broadcast('m', msg);
        break;
      case 'toPeer': this.clients.getById(msg.to)?.send('m', msg.m); break;
      case 'world': this.onWorld(msg); break;
      case 'kick': this.clients.getById(msg.to)?.leave(); break;   // turned away (wrong version, room full...)
    }
  }
  toHost(msg) { this.host.deliver('m', msg); }

  watchHost(m) {
    if (m.t === 'ev' && Array.isArray(m.e)) {
      for (const e of m.e) {
        if (!Array.isArray(e)) continue;
        if (e[0] === 'pc') this.bricks.add(e[1], e[2], !!e[3], !!e[4]);
        else if (e[0] === 'pr') this.bricks.remove(e[1]);
        else if (e[0] === 'pp') { const p = this.bricks.parts.get(e[1]); if (p) p.d.c = e[2]; }
      }
    } else if (m.t === 's') this.bricks.updateGhosts(m.h, m.pr, this.clock.currentTime);
  }

  onWorld(m) {
    const B = this.bricks;
    switch (m.t) {
      // the whole world, once, right after the game starts: [nid, brick, locked, asleep] + hinges
      case 'seed':
        for (const r of Array.isArray(m.parts) ? m.parts : []) if (Array.isArray(r)) B.add(r[0], r[1], !!r[2], !!r[3]);
        for (const h of Array.isArray(m.hinges) ? m.hinges : []) if (Array.isArray(h)) B.hinge(h);
        break;
      case 'mode': B.setMode(m.nid, m.m, m.a); break;              // picked up, dropped, anchored
      case 'drag': for (const r of Array.isArray(m.l) ? m.l : []) if (Array.isArray(r)) B.drag(...r); break;
      case 'kick': B.kick(m.nid, m.v); break;                      // a sword swing or a Guest kicking a ball
      case 'blast': B.blast(m.c, m.r); break;                      // an explosion
      case 'door': B.door(m.nid, !!m.on); break;                  // a door opened or closed
      case 'weld': B.weld(m.nid, m.id ?? null); break;              // welded together (or apart)
      case 'time': B.timeScale = Math.min(3, Math.max(0.05, +m.k || 1)); break;   // /time
      case 'drive': B.drive(m.nid, +m.th, +m.st, this.clock.currentTime); break;   // someone driving a car
    }
  }

  sendBricks() {
    const p = this.bricks.moved(), out = [];
    if (p.length) out.push({ t: 'bs', p });
    if (this.bricks.fellOut.length) { out.push({ t: 'ev', e: this.bricks.fellOut.map(nid => ['pr', nid]) }); this.bricks.fellOut = []; }
    for (const m of out) {
      if (this.clients.length) this.broadcast('w', m);
      this.host.deliver('w', m);   // the game mirrors the bricks too
    }
  }

  onLeave(client) {
    if (!this.restarting) this.toHost({ from: client.sessionId, m: { t: 'bye' } });
  }

  // the last player left (Colyseus closes empty rooms by itself): stop this room's game
  onDispose() {
    rooms.delete(this);
    this.game?.stop();
  }
}
