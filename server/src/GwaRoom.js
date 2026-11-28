import { Room, matchMaker } from '@colyseus/core';

/* GRAND WALK AUTO: Max's offbrand GTA 6 (gwa.html), on the same server as BLOCKBURG and MINECRAP.
   Nothing heavy runs here. Every player's browser runs its own traffic, people and cops; the room only
   relays where each player is (on foot or in which car), chat, and hits between players.
   Messages from a player:
     p     where I am: [x, y, z, yaw, car type (-1 on foot), car colour, car yaw, speed, stars, weapon, flags]
                                                     -> everyone else as 'p' { id, s }
     chat  { text }                                  -> everyone as 'chat' { id, name, text }
     to    { to, m }   one other player (shot them, ran them over)   -> them as 'm' { from, m }
     all   { m }       everyone else (explosions, "X got wasted")    -> them as 'm' { from, m }
   Same 4-letter codes as BLOCKBURG and MINECRAP (and from the same pool, so they never clash).
   The day/night clock starts when the room does, so everyone sees the same sunset. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VERSION = 'gwa-1';                // gwa.html's NET_VERSION: an old open tab gets asked to refresh
const MAX_ROOMS = Number(process.env.MAX_GWA_ROOMS) || 20;

async function freeCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!(await matchMaker.getRoomById(code))) return code;
  }
  throw new Error('No free room codes');
}
const cleanName = (s) => String(s || '').replace(/[^\w .-]/g, '').trim().slice(0, 16) || 'Player';
const cleanLook = (l) => Array.isArray(l) && (l.length === 4 || l.length === 5) && l.every(v => Number.isInteger(v) && v >= -1 && v <= 0xffffff) ? l : null;
const okState = (s) => Array.isArray(s) && s.length <= 12 && s.every(v => typeof v === 'number' && Number.isFinite(v));

export class GwaRoom extends Room {
  maxClients = 10;

  async onCreate(options) {
    if ((await matchMaker.query({ name: 'gwa' })).length >= MAX_ROOMS) throw new Error('The server is full right now. Join a friend\'s room with their code, or try again later.');
    this.roomId = await freeCode();
    this.pub = options.pub === true;
    this.names = new Map();      // sessionId -> name
    this.outfits = new Map();    // sessionId -> [skin, shirt, pants, hair] colours, then which face
    this.looks = new Map();      // sessionId -> where they were last
    this.born = Date.now();
    await this.setMetadata({ game: 'gwa', pub: this.pub });

    this.onMessage('p', (client, s) => {
      if (!okState(s)) return;
      this.looks.set(client.sessionId, s);
      this.broadcast('p', { id: client.sessionId, s }, { except: client });
    });
    this.onMessage('chat', (client, m) => {
      const text = String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (text) this.broadcast('chat', { id: client.sessionId, name: this.names.get(client.sessionId), text });
    });
    this.onMessage('to', (client, m) => {
      if (m && typeof m.to === 'string' && m.m && typeof m.m === 'object') this.clients.getById(m.to)?.send('m', { from: client.sessionId, m: m.m });
    });
    this.onMessage('all', (client, m) => {
      if (m && m.m && typeof m.m === 'object') this.broadcast('m', { from: client.sessionId, m: m.m }, { except: client });
    });
  }

  onJoin(client, options = {}) {
    if (options.v !== VERSION) throw new Error('GRAND WALK AUTO was updated: refresh the page to play online');
    // two people with the same name get a number, so chat and name tags stay clear
    let name = cleanName(options.name), n = 2;
    const taken = new Set(this.names.values());
    while (taken.has(name)) name = `${cleanName(options.name).slice(0, 13)}${n++}`;
    this.names.set(client.sessionId, name);
    this.outfits.set(client.sessionId, cleanLook(options.look));
    client.send('welcome', {
      v: VERSION, code: this.roomId, pub: this.pub, age: Date.now() - this.born, you: client.sessionId, name,
      players: [...this.names].filter(([id]) => id !== client.sessionId).map(([id, nm]) => ({ id, name: nm, s: this.looks.get(id) || null, look: this.outfits.get(id) })),
    });
    this.broadcast('join', { id: client.sessionId, name, look: this.outfits.get(client.sessionId) }, { except: client });
  }

  onLeave(client) {
    const name = this.names.get(client.sessionId);
    this.names.delete(client.sessionId);
    this.looks.delete(client.sessionId);
    this.outfits.delete(client.sessionId);
    this.broadcast('leave', { id: client.sessionId, name }, { except: client });
  }
}
