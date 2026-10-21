import { fileURLToPath } from 'node:url';
import express from 'express';
import { defineServer, defineRoom } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { BlockburgRoom } from './BlockburgRoom.js';

const PORT = Number(process.env.PORT) || 2567;
const GAME_DIR = fileURLToPath(new URL('../../', import.meta.url));   // the folder with the game's .html files

const server = defineServer({
  // the welcome message carries the whole world, so allow big messages (the default is only 4 KB)
  transport: new WebSocketTransport({ maxPayload: 8 * 1024 * 1024 }),
  rooms: { blockburg: defineRoom(BlockburgRoom) },
  // also serve the game itself, so http://localhost:2567 is all anyone needs to open
  express: (app) => {
    app.use((req, res, next) => (req.path.startsWith('/server') ? res.sendStatus(404) : next()));
    app.use(express.static(GAME_DIR, { index: 'index.html' }));
  },
});

server.listen(PORT).then(() => {
  console.log(`BLOCKBURG is running: open http://localhost:${PORT}`);
  process.send?.('ready');   // tells PM2 (on Colyseus Cloud) the server is up
});
