// How Colyseus Cloud starts BLOCKBURG: it runs the server with PM2, using this file.
module.exports = {
  apps: [{
    name: 'blockburg',
    script: 'server/src/index.js',
    time: true,
    watch: false,
    // just one copy: rooms and their codes live in this process's memory, so a second copy couldn't find the first one's rooms
    instances: 1,
    exec_mode: 'fork',
    wait_ready: true,   // the server says "ready" once it's listening (see server/src/index.js)
    env_production: { NODE_ENV: 'production' },
  }],
};
