import { fileURLToPath } from 'node:url';
import express from 'express';
import { defineServer, defineRoom, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { BlockburgRoom } from './BlockburgRoom.js';
import { MinecrapRoom } from './MinecrapRoom.js';
import { GwaRoom } from './GwaRoom.js';

const PORT = Number(process.env.PORT) || 2567;
const GAME_DIR = fileURLToPath(new URL('../../', import.meta.url));   // the folder with the game's .html files

const server = defineServer({
  // the welcome message carries the whole world, so allow big messages (the default is only 4 KB)
  transport: new WebSocketTransport({ maxPayload: 8 * 1024 * 1024 }),
  // Play Online matches on the game and on pub, so it never lands in a friend's private room
  rooms: {
    blockburg: defineRoom(BlockburgRoom).filterBy(['place', 'pub']),
    // MINECRAP (minecrap.html): Play Online matches on pub, so it never lands in a friend's private room
    minecrap: defineRoom(MinecrapRoom).filterBy(['pub']),
    // GRAND WALK AUTO (gwa.html): same idea, the public city or a private room with a code
    gwa: defineRoom(GwaRoom).filterBy(['pub']),
  },
  // also serve the game itself, so http://localhost:2567 is all anyone needs to open
  express: (app) => {
    // how many people are in each game's public rooms (MINECRAP's as "minecrap", GRAND WALK AUTO's as "gwa"), for the Play Online buttons (the website on github.io asks too)
    app.get('/api/online', async (req, res) => {
      res.set('Access-Control-Allow-Origin', '*');
      const n = {};
      for (const r of await matchMaker.query({ name: 'blockburg' })) if (r.metadata?.pub) n[r.metadata.place] = (n[r.metadata.place] || 0) + r.clients;
      for (const r of await matchMaker.query({ name: 'minecrap' })) if (r.metadata?.pub) n.minecrap = (n.minecrap || 0) + r.clients;
      for (const r of await matchMaker.query({ name: 'gwa' })) if (r.metadata?.pub) n.gwa = (n.gwa || 0) + r.clients;
      res.json(n);
    });
    app.use((req, res, next) => (req.path.startsWith('/server') ? res.sendStatus(404) : next()));
    app.use(express.static(GAME_DIR, { index: 'index.html' }));
  },
});

server.listen(PORT).then(() => {
  console.log(`BLOCKBURG is running: open http://localhost:${PORT}`);
  process.send?.('ready');   // tells PM2 (on Colyseus Cloud) the server is up
});
