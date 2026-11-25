import { Room, matchMaker } from '@colyseus/core';

/* MINECRAP: Max's blocky survival game (minecrap.html), on the same server as BLOCKBURG.
   Unlike a BLOCKBURG room, nothing heavy runs here: no headless game, no physics. The room keeps
   the world (its seed plus every block anyone changed, and what's in each chest), relays what
   players do, and picks a "leader": the player whose browser runs the mobs for everyone.
   Messages from a player:
     p     where I am: [x, y, z, yaw, pitch, held item, swinging]   -> everyone else as 'p' { id, s }
     b     I changed a block: { i, t }                               -> stored, everyone else as 'b'
     c     a chest's contents now: { i, items }                      -> stored, everyone else as 'c'
     chat  { text }                                                  -> everyone as 'chat' { id, name, text }
     to    { to, m }   one other player (mob hits, PvP, loot)        -> them as 'm' { from, m }
     all   { m }       everyone else (mobs from the leader, effects) -> them as 'm' { from, m }
   Same 4-letter codes as BLOCKBURG (and from the same pool, so they never clash). */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VERSION = 'mc-1';                 // minecrap.html's NET_VERSION: an old open tab gets asked to refresh
const W = 96, H = 48, D = 96, CELLS = W * H * D;
const MAX_BLOCK = 14;                   // block ids 0 (air) to 14 (chest)
const MAX_ITEM = 40;
const MAX_ROOMS = Number(process.env.MAX_MINECRAP_ROOMS) || 20;   // each one is tiny, but let's not be silly

async function freeCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!(await matchMaker.getRoomById(code))) return code;
  }
  throw new Error('No free room codes');
}
const cleanName = (s) => String(s || '').replace(/[^\w .-]/g, '').trim().slice(0, 16) || 'Player';
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function cleanItems(items) {
  const out = {};
  if (!items || typeof items !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(items)) {
    const id = Number(k);
    if (int(id, 1, MAX_ITEM) && int(v, 1, 9999) && n++ < 27) out[id] = v;
  }
  return out;
}

export class MinecrapRoom extends Room {
  maxClients = 10;

  async onCreate(options) {
    if ((await matchMaker.query({ name: 'minecrap' })).length >= MAX_ROOMS) throw new Error('The server is full right now. Join a friend\'s room with their code, or try again later.');
    this.roomId = await freeCode();
    this.pub = options.pub === true;
    this.mode = options.mode === 'creative' ? 'creative' : 'survival';
    this.seed = (Math.random() * 1e9 | 0) + 1;
    this.edits = new Map();      // cell -> block id
    this.chests = new Map();     // cell -> { item id: count }
    this.names = new Map();      // sessionId -> name
    this.looks = new Map();      // sessionId -> where they were last
    this.leader = null;
    this.born = Date.now();      // the day/night clock starts when the room does
    await this.setMetadata({ game: 'minecrap', pub: this.pub, mode: this.mode });

    this.onMessage('p', (client, s) => {
      if (!Array.isArray(s) || s.length > 8) return;
      this.looks.set(client.sessionId, s);
      this.broadcast('p', { id: client.sessionId, s }, { except: client });
    });
    this.onMessage('b', (client, m) => {
      if (!m || !int(m.i, W * D, CELLS - 1) || !int(m.t, 0, MAX_BLOCK)) return;   // (the bottom layer is bedrock: nobody digs out of the world)
      this.edits.set(m.i, m.t);
      if (m.t !== 14) this.chests.delete(m.i);
      this.broadcast('b', { i: m.i, t: m.t }, { except: client });
    });
    this.onMessage('c', (client, m) => {
      if (!m || !int(m.i, 0, CELLS - 1)) return;
      const items = cleanItems(m.items);
      this.chests.set(m.i, items);
      this.broadcast('c', { i: m.i, items }, { except: client });
    });
    this.onMessage('chat', (client, m) => {
      const text = String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (text) this.broadcast('chat', { id: client.sessionId, name: this.names.get(client.sessionId), text });
    });
    this.onMessage('to', (client, m) => {
      if (m && typeof m.to === 'string') this.clients.getById(m.to)?.send('m', { from: client.sessionId, m: m.m });
    });
    this.onMessage('all', (client, m) => {
      if (m) this.broadcast('m', { from: client.sessionId, m: m.m }, { except: client });
    });
  }

  onJoin(client, options = {}) {
    if (options.v !== VERSION) throw new Error('MINECRAP was updated: refresh the page to play online');
    // two people with the same name get a number, so chat and name tags stay clear
    let name = cleanName(options.name), n = 2;
    const taken = new Set(this.names.values());
    while (taken.has(name)) name = `${cleanName(options.name).slice(0, 13)}${n++}`;
    this.names.set(client.sessionId, name);
    if (!this.leader) this.leader = client.sessionId;
    client.send('welcome', {
      v: VERSION, code: this.roomId, pub: this.pub, mode: this.mode, seed: this.seed,
      age: Date.now() - this.born, you: client.sessionId, name, leader: this.leader,
      edits: [...this.edits], chests: [...this.chests],
      players: [...this.names].filter(([id]) => id !== client.sessionId).map(([id, nm]) => ({ id, name: nm, s: this.looks.get(id) || null })),
    });
    this.broadcast('join', { id: client.sessionId, name }, { except: client });
  }

  onLeave(client) {
    const name = this.names.get(client.sessionId);
    this.names.delete(client.sessionId);
    this.looks.delete(client.sessionId);
    if (this.leader === client.sessionId) this.leader = this.clients.find(c => c.sessionId !== client.sessionId)?.sessionId || null;
    this.broadcast('leave', { id: client.sessionId, name, leader: this.leader }, { except: client });
  }
}
