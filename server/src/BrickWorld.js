import * as CANNON from 'cannon-es';

/* The bricks of one game, and their physics. The server runs this; every browser only shows it.
   Set up exactly like the game's own physics (same gravity, materials, solver, sleep rules),
   so bricks fall, tumble and settle the way they always have.

   People and flying balls aren't simulated here yet (the host's browser still runs them). Instead
   each one is a "ghost" body that follows where the host says it is, so walking into a brick or
   bouncing a superball off it still knocks it over. */

const GRAV = 196.2;

// a driver's seat moves its whole welded car: th = gas (-1 reverse .. 1), st = steer (-1 left .. 1 right). (The game has the same.)
function driveBodies(seat, bodies, th, st, dt) {
  const f = seat.quaternion.vmult(new CANNON.Vec3(0, 0, -1)), up = seat.quaternion.vmult(new CANNON.Vec3(0, 1, 0)), len = Math.hypot(f.x, f.z);
  const tipped = len < 0.2;   // (pointing straight up or down: no gas, just getting back on its wheels)
  if (tipped) { f.x = 0; f.z = -1; } else { f.x /= len; f.z /= len; }
  // the car keeps its own speed (the ground's friction would eat it), unless something really is stopping it
  const v = seat.velocity, real = v.x * f.x + v.z * f.z, was = seat.carSpeed || 0;
  const speed = Math.sign(was) * Math.min(Math.abs(was), Math.abs(real) + 10);
  const target = tipped ? 0 : th > 0 ? th * 60 : th * 25;
  const s = seat.carSpeed = speed + (target - speed) * Math.min(1, dt * (th ? 2.2 : 0.9));
  const w = -st * 1.8 * Math.max(-1, Math.min(1, s / 15));   // (no turning on the spot; backing up steers the other way)
  const k = up.y < 0.7 ? 6 : 3;   // (it gently stays on its wheels, and leans back up harder when it tips)
  for (const b of bodies) {
    if (b.type !== CANNON.Body.DYNAMIC) continue;
    const rx = b.position.x - seat.position.x, rz = b.position.z - seat.position.z;
    b.velocity.set(f.x * s + w * rz, v.y, f.z * s - w * rx); b.angularVelocity.set(-up.z * k, w, up.x * k); b.wakeUp();
  }
}

// welds hold exactly: after each physics step every brick of a group goes right back to its spot on the group's
// first brick. (The lock constraints carry the pushes and pulls, but they're springy and would slowly drift apart.)
function weldSnap(groups) {
  for (const g of groups) {
    let root = null;
    for (const q of g) {
      if (!root) { root = q; continue; }
      const b = q.body, rb = root.body, r = q.weldRel;
      if (!r || q.weldRoot !== root || b.type === CANNON.Body.KINEMATIC || rb.type === CANNON.Body.KINEMATIC) continue;
      const off = rb.quaternion.vmult(r.p), w = rb.angularVelocity;
      b.position.set(rb.position.x + off.x, rb.position.y + off.y, rb.position.z + off.z);
      rb.quaternion.mult(r.q, b.quaternion);
      b.velocity.set(rb.velocity.x + w.y * off.z - w.z * off.y, rb.velocity.y + w.z * off.x - w.x * off.z, rb.velocity.z + w.x * off.y - w.y * off.x);
      b.angularVelocity.copy(w); b.aabbNeedsUpdate = true;
    }
  }
}
// where a welded brick sits on its group's first brick (kept for weldSnap)
function weldRelOf(root, q) {
  const iq = root.body.quaternion.conjugate();
  return { p: iq.vmult(q.body.position.vsub(root.body.position)), q: iq.mult(q.body.quaternion) };
}

// wedges: their corners (half sizes) and faces, counterclockwise seen from outside. (The game has the same polyOf.)
function polyOf(shape, size) {
  const [x, y, z] = size.map(s => s / 2);
  if (shape === 'wedge') return { verts: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [-x, y, -z], [x, y, -z]],
    faces: [[0, 1, 2, 3], [0, 4, 5, 1], [3, 2, 5, 4], [0, 3, 4], [1, 5, 2]] };
  return { verts: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [x, y, -z]],   // corner wedge: the tip is at the back right
    faces: [[0, 1, 2, 3], [0, 4, 1], [1, 4, 2], [3, 2, 4], [0, 3, 4]] };
}

/* Which bodies might be touching? SAP (cannon's usual answer) compares every brick with its neighbors on every
   step, even thousands of anchored bricks that never move, and that alone made big builds crawl. Here every body
   goes into a grid by where it is, and only the bodies that are moving (falling bricks, people's ghosts, balls)
   look around their own grid cells. Bricks that sit still cost next to nothing. (The game has the same.) */
// cannon remembers "who touched whom" in a table with a slot for EVERY pair of bodies (3,800 bricks = 7 million
// slots), and wipes all of it clean on every step: that, more than anything, made big builds slow forever.
// This one only keeps the pairs that really are touching.
class SparseCollisionMatrix {
  constructor() { this.m = new Map(); }
  key(bi, bj) { const i = bi.index, j = bj.index; return i > j ? i * 1048576 + j : j * 1048576 + i; }
  get(bi, bj) { return this.m.get(this.key(bi, bj)) || 0; }
  set(bi, bj, value) { if (value) this.m.set(this.key(bi, bj), value); else this.m.delete(this.key(bi, bj)); }
  reset() { this.m.clear(); }
  setNumObjects() { }
}
class StillBroadphase extends CANNON.Broadphase {
  constructor(cell = 8) { super(); this.cell = cell; this.useBoundingBoxes = true; this.cells = new Map(); this.big = new Set(); this.stamp = 0; this.ticks = 0; }
  // a body only moves to new grid cells when it really moved (most bricks never do)
  place(b, x0, x1, z0, z1) {
    this.unplace(b);
    b._bp = [x0, x1, z0, z1];
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 16) { b._bpBig = true; this.big.add(b); return; }   // (the ground, giant baseplates: everyone checks those)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 65536 + z; let c = this.cells.get(k); if (!c) this.cells.set(k, c = []); c.push(b); }
  }
  unplace(b) {
    if (!b._bp) return;
    if (b._bpBig) { this.big.delete(b); b._bpBig = false; }
    else { const [x0, x1, z0, z1] = b._bp; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const c = this.cells.get(x * 65536 + z); const i = c ? c.indexOf(b) : -1; if (i >= 0) c.splice(i, 1); } }
    b._bp = null;
  }
  collisionPairs(world, p1, p2) {
    const S = this.cell, movers = [], STATIC = CANNON.Body.STATIC, SLEEPING = CANNON.Body.SLEEPING;
    if (++this.ticks % 600 === 0) { for (const c of this.cells.values()) for (const b of c) b._bp = null; for (const b of this.big) b._bp = null; this.cells.clear(); this.big.clear(); }   // (now and then: forget removed bodies)
    for (const b of world.bodies) {
      if (b.aabbNeedsUpdate) b.updateAABB();
      if (b.type !== STATIC && b.sleepState !== SLEEPING) movers.push(b);
      const lo = b.aabb.lowerBound, hi = b.aabb.upperBound, g = b._bp;
      const x0 = Math.floor(lo.x / S), x1 = Math.floor(hi.x / S), z0 = Math.floor(lo.z / S), z1 = Math.floor(hi.z / S);
      if (!g || g[0] !== x0 || g[1] !== x1 || g[2] !== z0 || g[3] !== z1) this.place(b, x0, x1, z0, z1);
    }
    for (const m of movers) {
      const st = ++this.stamp;
      const test = (o) => {
        if (o === m || o._bpStamp === st || !o.world) return;
        o._bpStamp = st;
        if (o.type !== STATIC && o.sleepState !== SLEEPING && o.id < m.id) return;   // two movers: the pair is made once
        if (this.needBroadphaseCollision(m, o)) this.doBoundingBoxBroadphase(m, o, p1, p2);
      };
      this.big.forEach(test);
      if (m._bpBig) { world.bodies.forEach(test); continue; }   // (something giant is moving)
      const [x0, x1, z0, z1] = m._bp;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const c = this.cells.get(x * 65536 + z); if (c) c.forEach(test); }
    }
  }
  aabbQuery(world, aabb, result = []) {
    for (const b of world.bodies) { if (b.aabbNeedsUpdate) b.updateAABB(); if (b.aabb.overlaps(aabb)) result.push(b); }
    return result;
  }
}
const G_PART = 1, G_GHOST = 4;
const r2 = (n) => Math.round(n * 100) / 100, r3 = (n) => Math.round(n * 1000) / 1000;

export class BrickWorld {
  constructor() {
    const world = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAV, 0) });
    world.broadphase = new StillBroadphase(); world.broadphase.setWorld(world);
    world.collisionMatrix = new SparseCollisionMatrix(); world.collisionMatrixPrevious = new SparseCollisionMatrix();
    world.allowSleep = true;
    world.solver.iterations = 12;
    this.physPart = new CANNON.Material('part'); this.physHum = new CANNON.Material('hum'); this.physBall = new CANNON.Material('ball');
    world.defaultContactMaterial.friction = 0.5;
    world.defaultContactMaterial.restitution = 0.05;
    world.addContactMaterial(new CANNON.ContactMaterial(this.physPart, this.physPart, { friction: 0.6, restitution: 0.05 }));
    // car wheels roll (well, slide, but nearly without friction) so cars can really go. (The game has the same.)
    this.physWheel = new CANNON.Material('wheel');
    world.addContactMaterial(new CANNON.ContactMaterial(this.physWheel, this.physPart, { friction: 0.02, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physWheel, this.physWheel, { friction: 0.02, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physWheel, this.physHum, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physHum, this.physPart, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physBall, this.physPart, { friction: 0.2, restitution: 0.92 }));
    this.parts = new Map();    // nid -> { nid, d (the brick's description), locked, mode, body, sent }
    this.ghosts = new Map();   // 'h:<hid>' or 'p:<pid>' -> { body, seen }
    this.fellOut = [];
    this.welds = new Map();    // weld number -> the bricks welded together
    this.driven = new Map();   // driver's seat nid -> { th, st, at }: someone is driving that car         // bricks that fell off the world since the last update
  }

  /* ---- bricks ---- */
  // d is the game's serialize() format: s shape, z size, p position, q rotation, a anchored, b bouncy, m mass
  add(nid, d, locked = false, asleep = false) {
    if (this.parts.has(nid) || !d || !Array.isArray(d.z) || !Array.isArray(d.p)) return;
    const size = d.z.map(n => Math.min(1024, Math.max(0.05, +n || 1)));
    let shape;
    if (d.s === 'ball') shape = new CANNON.Sphere(size[0] / 2);
    else if (d.s === 'cyl') shape = new CANNON.Cylinder(size[0] / 2, size[0] / 2, size[1], 12);
    else if (d.s === 'wedge' || d.s === 'cwedge') {
      const { verts, faces } = polyOf(d.s, size);
      shape = new CANNON.ConvexPolyhedron({ vertices: verts.map(v => new CANNON.Vec3(...v)), faces });
    }
    else shape = new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2));
    const mass = +d.m || Math.max(1, size[0] * size[1] * size[2] * 0.7);
    const body = new CANNON.Body({ mass, shape, material: d.wh ? this.physWheel : d.s === 'ball' && d.b ? this.physBall : this.physPart,
      collisionFilterGroup: G_PART, collisionFilterMask: -1 });
    body.position.set(...d.p);
    if (Array.isArray(d.q)) body.quaternion.set(...d.q);
    body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.6;
    if (d.op) body.collisionResponse = false;   // an open door
    if (d.wh) body.linearDamping = 0.4;          // a car wheel: a parked car rolls to a stop
    const p = { nid, d: { ...d, z: size }, locked, mass, body, mode: d.a ? 'static' : 'dynamic', sent: null };
    body.userData = { part: p };
    this.setBody(p, p.mode);
    this.world.addBody(body);
    if (asleep && p.mode === 'dynamic') body.sleep();
    this.parts.set(nid, p);
    if (d.wd) { p.d.wd = undefined; this.weldJoin(p, d.wd); }
  }
  remove(nid) {
    const p = this.parts.get(nid);
    if (!p) return;
    if (p.d.wd) this.weldJoin(p, null);   // (the rest of its group stays welded)
    for (const c of [...this.world.constraints]) if (c.bodyA === p.body || c.bodyB === p.body) this.world.removeConstraint(c);
    this.world.removeBody(p.body); this.parts.delete(nid);
    this.wakeNear(p.body.position, Math.max(...p.d.z) + 3);   // whatever it was holding up can fall now
  }
  // dynamic = physics moves it, static = anchored in place, kinematic = someone is dragging it
  setMode(nid, mode, anchored) {
    const p = this.parts.get(nid);
    if (!p || !['dynamic', 'static', 'kinematic'].includes(mode)) return;
    p.mode = mode; p.d.a = !!anchored;
    this.setBody(p, mode);
    if (mode !== 'kinematic') this.wakeNear(p.body.position, Math.max(...p.d.z) + 4);
  }
  setBody(p, mode) {
    const b = p.body;
    if (mode === 'dynamic') { b.type = CANNON.Body.DYNAMIC; b.mass = p.mass; }
    else { b.type = mode === 'static' ? CANNON.Body.STATIC : CANNON.Body.KINEMATIC; b.mass = 0; }
    b.updateMassProperties(); b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
    b.aabbNeedsUpdate = true; b.wakeUp();
  }
  /* welds: bricks with the same weld number hang on the group's first brick with lock constraints (the game has the same) */
  weldJoin(p, id) {
    id = id || null;
    if ((p.d.wd || null) === id) return;
    if (p.weldC) { this.world.removeConstraint(p.weldC); p.weldC = null; }
    const old = p.d.wd;
    if (old) { const g = this.welds.get(old); if (g) { g.delete(p); if (g.size) this.weldRelink(old); else this.welds.delete(old); } }
    p.d.wd = id || undefined;
    if (id) { if (!this.welds.has(id)) this.welds.set(id, new Set()); this.welds.get(id).add(p); this.weldRelink(id); }
  }
  weldRelink(id) {
    const g = this.welds.get(id); if (!g) return;
    for (const q of g) if (q.weldC) { this.world.removeConstraint(q.weldC); q.weldC = null; }
    let root = null;
    for (const q of g) {
      if (!root) { root = q; continue; }
      q.weldRoot = root; q.weldRel = weldRelOf(root, q);
      q.weldC = new CANNON.LockConstraint(root.body, q.body); q.weldC.collideConnected = false;   // (welded bricks don't push on each other)
      this.world.addConstraint(q.weldC); q.body.wakeUp();
    }
  }
  drive(nid, th, st, now) {
    const p = this.parts.get(nid);
    if (p && p.d.st === 2 && Number.isFinite(th) && Number.isFinite(st)) this.driven.set(nid, { th: Math.max(-1, Math.min(1, th)), st: Math.max(-1, Math.min(1, st)), at: now });
  }
  weld(nid, id) { const p = this.parts.get(nid); if (p && (id === null || Number.isFinite(id))) this.weldJoin(p, id); }
  // a door (or any brick a script opens): open = things pass through it
  door(nid, on) {
    const p = this.parts.get(nid);
    if (!p) return;
    p.d.op = on ? 1 : undefined; p.body.collisionResponse = !on;
    if (!on) this.wakeNear(p.body.position, Math.max(...p.d.z) + 3);
  }
  // a brick being dragged: [nid, x, y, z, qx, qy, qz, qw]
  drag(nid, x, y, z, qx, qy, qz, qw) {
    const p = this.parts.get(nid);
    if (!p || p.mode !== 'kinematic' || ![x, y, z, qx, qy, qz, qw].every(Number.isFinite)) return;
    p.body.position.set(x, y, z); p.body.quaternion.set(qx, qy, qz, qw);
    p.body.velocity.set(0, 0, 0); p.body.angularVelocity.set(0, 0, 0); p.body.aabbNeedsUpdate = true;
  }
  kick(nid, v) {
    const p = this.parts.get(nid);
    if (!p || p.mode !== 'dynamic' || !Array.isArray(v) || !v.every(Number.isFinite)) return;
    p.body.wakeUp(); p.body.velocity.x += v[0]; p.body.velocity.y += v[1]; p.body.velocity.z += v[2];
  }
  // an explosion: throws every loose brick within the radius away from the center
  blast(c, radius) {
    if (!Array.isArray(c) || !c.every(Number.isFinite) || !(radius > 0 && radius < 100)) return;
    for (const p of this.parts.values()) {
      if (p.mode !== 'dynamic') continue;
      const b = p.body, dx = b.position.x - c[0], dy = b.position.y - c[1], dz = b.position.z - c[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      const f = 1 - dist / radius, k = dist > 1e-6 ? 1 / dist : 0;
      b.wakeUp();
      b.velocity.x += dx * k * 110 * f; b.velocity.y += dy * k * 110 * f + 35 * f; b.velocity.z += dz * k * 110 * f;
      b.angularVelocity.set(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
    }
  }
  // a hinge between two bricks (the seesaw): [nidA, nidB, pivotA, axisA, pivotB, axisB]
  hinge([a, b, pivotA, axisA, pivotB, axisB]) {
    const A = this.parts.get(a), B = this.parts.get(b);
    if (!A || !B) return;
    const v = (arr) => new CANNON.Vec3(...arr);
    this.world.addConstraint(new CANNON.HingeConstraint(A.body, B.body,
      { pivotA: v(pivotA), axisA: v(axisA), pivotB: v(pivotB), axisB: v(axisB), collideConnected: false }));
  }
  wakeNear(pos, r) {
    for (const p of this.parts.values()) if (p.mode === 'dynamic' && p.body.position.distanceTo(pos) < r) p.body.wakeUp();
  }

  /* ---- ghosts: people and flying balls, following the host's snapshots ---- */
  // h rows: [hid, x, y, z, yaw, flags, ...]  (flag 4 = dead)   pr rows: [pid, kind, x, y, z, ...]
  updateGhosts(h, pr, now) {
    const seen = new Set();
    for (const r of Array.isArray(h) ? h : []) {
      if (!Array.isArray(r) || r[5] & 4) continue;   // the dead don't push anything
      seen.add('h:' + r[0]); this.ghostTo('h:' + r[0], r[1], r[2], r[3], 'hum', now);
    }
    for (const r of Array.isArray(pr) ? pr : []) {
      if (!Array.isArray(r) || (r[1] !== 'sb' && r[1] !== 'bm')) continue;
      seen.add('p:' + r[0]); this.ghostTo('p:' + r[0], r[2], r[3], r[4], r[1], now);
    }
    for (const [key, g] of this.ghosts) if (!seen.has(key)) { this.world.removeBody(g.body); this.ghosts.delete(key); }
  }
  ghostTo(key, x, y, z, kind, now) {
    if (![x, y, z].every(Number.isFinite)) return;
    let g = this.ghosts.get(key);
    if (!g) {
      const body = new CANNON.Body({ type: CANNON.Body.KINEMATIC, mass: 0, material: kind === 'sb' ? this.physBall : kind === 'hum' ? this.physHum : this.physPart,
        collisionFilterGroup: G_GHOST, collisionFilterMask: G_PART });
      if (kind === 'hum') [-1.6, 0, 1.6].forEach(dy => body.addShape(new CANNON.Sphere(1), new CANNON.Vec3(0, dy, 0)));   // same capsule as a character
      else body.addShape(new CANNON.Sphere(kind === 'sb' ? 1 : 0.8));
      body.allowSleep = false; body.position.set(x, y, z);
      this.world.addBody(body);
      g = { body }; this.ghosts.set(key, g);
    }
    const b = g.body, dx = x - b.position.x, dy = y - b.position.y, dz = z - b.position.z;
    // glide there by the next snapshot (moving, not teleporting, so bricks it bumps get the right push)
    if (Math.hypot(dx, dy, dz) > 12) { b.position.set(x, y, z); b.velocity.set(0, 0, 0); }
    else { const v = 15 / (this.timeScale || 1); b.velocity.set(dx * v, dy * v, dz * v); }
    g.seen = now;
  }

  /* ---- every tick ---- */
  step(dt, now) {
    for (const g of this.ghosts.values()) if (now - g.seen > 150) g.body.velocity.set(0, 0, 0);   // no news: stand still
    // at most 3 catch-up steps: with lots of bricks a tick can run late, and catching up with even more steps
    // only makes the next tick later still, until the whole room crawls
    for (const [nid, d] of this.driven) {   // cars being driven (a driver stops counting half a second after their last word)
      const p = this.parts.get(nid);
      if (!p || now - d.at > 500) { this.driven.delete(nid); continue; }
      const g = p.d.wd && this.welds.get(p.d.wd);
      driveBodies(p.body, g ? [...g].map(q => q.body) : [p.body], d.th, d.st, Math.min(dt, 1 / 20) * (this.timeScale || 1));
    }
    const k = this.timeScale || 1;   // (/time: slow motion or fast forward)
    this.world.step(1 / 120 * Math.min(1, k), Math.min(dt, 1 / 20) * k, 3 * Math.ceil(Math.max(1, k)));
    weldSnap(this.welds.values());
    for (const p of [...this.parts.values()]) {
      if (!p.locked && p.body.position.y < -200) { this.remove(p.nid); this.fellOut.push(p.nid); }
    }
  }
  // every brick, for someone who just joined: [nid, x, y, z, qx, qy, qz, qw]
  all() {
    return [...this.parts.values()].map(({ nid, body: b }) =>
      [nid, r2(b.position.x), r2(b.position.y), r2(b.position.z), r3(b.quaternion.x), r3(b.quaternion.y), r3(b.quaternion.z), r3(b.quaternion.w)]);
  }
  // the bricks that moved since last time: [nid, x, y, z, qx, qy, qz, qw]
  moved() {
    const out = [];
    for (const p of this.parts.values()) {
      const b = p.body, q = b.quaternion, s = p.sent;
      const x = r2(b.position.x), y = r2(b.position.y), z = r2(b.position.z), qx = r3(q.x), qy = r3(q.y), qz = r3(q.z), qw = r3(q.w);
      if (s && s[0] === x && s[1] === y && s[2] === z && s[3] === qx && s[4] === qy && s[5] === qz && s[6] === qw) continue;
      p.sent = [x, y, z, qx, qy, qz, qw];
      out.push([p.nid, x, y, z, qx, qy, qz, qw]);
    }
    return out;
  }
}
