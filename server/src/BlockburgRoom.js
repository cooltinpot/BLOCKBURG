import { Room, matchMaker } from '@colyseus/core';
import { BrickWorld } from './BrickWorld.js';
import { loadGame } from './headless.js';

// Same letters as the game's room codes: no 0/O or 1/I, so codes are easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLACES = ['classic', 'baseplate'];
// each running room's game uses about a fifth of a CPU core; past this many, new games wait for one to close
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 4;

async function freeCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!(await matchMaker.getRoomById(code))) return code;
  }
  throw new Error('No free room codes');
}

/* One Blockburg game. The 4-letter room code is the room's id, so friends join with joinById(code).

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
    const place = PLACES.includes(options.place) ? options.place : 'classic';
    await this.setMetadata({ place });
    this.bricks = new BrickWorld();

    // boot the game and make it this room's host
    this.game = await loadGame();
    this.host = this.makeHostLink();
    this.game.g.serverHost(this.host.room, place);

    this.onMessage('toHost', (client, m) => this.toHost({ from: client.sessionId, m }));
    // a player who just got the welcome: the game's copy of the bricks can be a moment behind, so here's where every brick really is
    this.onMessage('bricks', (client) => client.send('w', { t: 'bs', p: this.bricks.all() }));

    // physics 60 times a second, brick positions out to everyone 15 times a second
    this.setSimulationInterval((dt) => this.bricks.step(dt / 1000, this.clock.currentTime), 1000 / 60);
    this.clock.setInterval(() => this.sendBricks(), 1000 / 15);
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
      try { handlers[type]?.(msg); } catch (e) { console.warn('BLOCKBURG game error:', e); }
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
    this.toHost({ from: client.sessionId, m: { t: 'bye' } });
  }

  // the last player left (Colyseus closes empty rooms by itself): stop this room's game
  onDispose() {
    this.game?.stop();
  }
}
