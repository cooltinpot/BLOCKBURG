import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import * as THREE_ from 'three';
import * as CANNON from 'cannon-es';

/* Runs the real game (blockburg-classic.html) on the server, with no screen and no sound.
   happy-dom pretends to be a browser page; the bits that need a real graphics card or speakers
   (WebGL, canvas drawing, audio) are swapped for do-nothing stand-ins. */

const GAME_FILE = new URL('../../blockburg-classic.html', import.meta.url);

// an object that accepts any call or property and does nothing
function noop() {
  const f = function () { return proxy; };
  const proxy = new Proxy(f, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : k in t ? t[k] : proxy),
    set: () => true, apply: () => proxy, construct: () => proxy,
  });
  return proxy;
}

class FakeRenderer {
  constructor() {
    this.domElement = { style: {}, addEventListener() { }, removeEventListener() { }, getContext() { return null; }, toDataURL: () => '', requestPointerLock() { } };
    this.shadowMap = { enabled: false, type: 0 }; this.capabilities = { getMaxAnisotropy: () => 1 };
    this.info = { render: {} };
  }
  setSize() { } setPixelRatio() { } render() { } setClearColor() { } dispose() { } getPixelRatio() { return 1; }
  compile() { } setAnimationLoop() { } getSize(v) { return v ? v.set(800, 600) : { x: 800, y: 600 }; }
}

function fake2d(canvas) {
  const ctx = noop();
  return new Proxy(ctx, {
    get: (t, k) => {
      if (k === 'canvas') return canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
      if (k === 'getImageData' || k === 'createImageData') return (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
      return ctx[k];
    },
    set: () => true,
  });
}

// boot one copy of the game; resolves to { g: the game's window.__g, stop() } once it's running
export async function loadGame() {
  const window = startGame();
  let stopped = false;
  window.requestAnimationFrame = (cb) => setTimeout(() => { if (!stopped) cb(performance.now()); }, 1000 / 60);
  for (let waited = 0; !window.__g; waited += 50) {
    if (window.__bootError) throw window.__bootError;
    if (waited > 15000) throw new Error('The game took too long to start');
    await new Promise(r => setTimeout(r, 50));
  }
  return {
    g: window.__g,
    stop() { stopped = true; window.happyDOM.abort().catch(() => { }); window.close(); },
  };
}

function startGame() {
  const html = readFileSync(GAME_FILE, 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const bodyHtml = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/g, '');

  const window = new Window({ url: 'http://localhost/', width: 800, height: 600,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, navigator: { userAgent: 'BlockburgServer' } } });
  window.document.body.innerHTML = bodyHtml;
  window.HTMLCanvasElement.prototype.getContext = function () { return fake2d(this); };
  window.HTMLCanvasElement.prototype.toDataURL = () => '';
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 1000 / 60);   // (loadGame swaps in one that can stop)
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.AudioContext = function () { return noop(); };   // no speakers on a server
  window.__BLOCKBURG_HEADLESS__ = true;
  // pictures (sky, faces) only matter on a screen: hand back empty textures without loading anything
  class FakeTextureLoader { load() { return new THREE_.Texture(); } setCrossOrigin() { return this; } setPath() { return this; } }
  window.__deps = { THREE: { ...THREE_, WebGLRenderer: FakeRenderer, TextureLoader: FakeTextureLoader }, CANNON };

  const src = '"use strict";\n(async () => {\n' + script
    .replace(/^import \* as THREE from .*$/m, 'const THREE = globalThis.__deps.THREE;')
    .replace(/^import \* as CANNON from .*$/m, 'const CANNON = globalThis.__deps.CANNON;') + '\n})().catch(e => globalThis.__bootError = e);';
  vm.runInContext(src, window, { filename: 'blockburg-classic.html' });
  return window;
}

// quick check: node src/headless.js   (boots the game, lets the Guests run around for a few seconds)
if (process.argv[1] && process.argv[1].endsWith('headless.js')) {
  const t0 = Date.now();
  const { g, stop } = await loadGame();
  console.log(`booted in ${Date.now() - t0} ms: ${g.parts.length} parts, ${g.humanoids.length} characters`);
  g.playPlace('classic');
  const where = () => g.npcs.map(n => `${n.name}@${n.pos.x.toFixed(0)},${n.pos.z.toFixed(0)} "${n.ai && n.ai.thought}"`).join(' | ');
  console.log('start:', where());
  setTimeout(() => { console.log('8s later:', where()); stop(); process.exit(0); }, 8000);
}
