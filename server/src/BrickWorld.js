import * as CANNON from 'cannon-es';

/* The bricks of one game, and their physics. The server runs this; every browser only shows it.
   Set up exactly like the game's own physics (same gravity, materials, solver, sleep rules),
   so bricks fall, tumble and settle the way they always have.

   People and flying balls aren't simulated here yet (the host's browser still runs them). Instead
   each one is a "ghost" body that follows where the host says it is, so walking into a brick or
   bouncing a superball off it still knocks it over. */

const GRAV = 196.2;
const G_PART = 1, G_GHOST = 4;
const r2 = (n) => Math.round(n * 100) / 100, r3 = (n) => Math.round(n * 1000) / 1000;

export class BrickWorld {
  constructor() {
    const world = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAV, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.solver.iterations = 12;
    this.physPart = new CANNON.Material('part'); this.physHum = new CANNON.Material('hum'); this.physBall = new CANNON.Material('ball');
    world.defaultContactMaterial.friction = 0.5;
    world.defaultContactMaterial.restitution = 0.05;
    world.addContactMaterial(new CANNON.ContactMaterial(this.physPart, this.physPart, { friction: 0.6, restitution: 0.05 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physHum, this.physPart, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.physBall, this.physPart, { friction: 0.2, restitution: 0.92 }));
    this.parts = new Map();    // nid -> { nid, d (the brick's description), locked, mode, body, sent }
    this.ghosts = new Map();   // 'h:<hid>' or 'p:<pid>' -> { body, seen }
    this.fellOut = [];         // bricks that fell off the world since the last update
  }

  /* ---- bricks ---- */
  // d is the game's serialize() format: s shape, z size, p position, q rotation, a anchored, b bouncy, m mass
  add(nid, d, locked = false, asleep = false) {
    if (this.parts.has(nid) || !d || !Array.isArray(d.z) || !Array.isArray(d.p)) return;
    const size = d.z.map(n => Math.min(1024, Math.max(0.05, +n || 1)));
    let shape;
    if (d.s === 'ball') shape = new CANNON.Sphere(size[0] / 2);
    else if (d.s === 'cyl') shape = new CANNON.Cylinder(size[0] / 2, size[0] / 2, size[1], 12);
    else shape = new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2));
    const mass = +d.m || Math.max(1, size[0] * size[1] * size[2] * 0.7);
    const body = new CANNON.Body({ mass, shape, material: d.s === 'ball' && d.b ? this.physBall : this.physPart,
      collisionFilterGroup: G_PART, collisionFilterMask: -1 });
    body.position.set(...d.p);
    if (Array.isArray(d.q)) body.quaternion.set(...d.q);
    body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.6;
    const p = { nid, d: { ...d, z: size }, locked, mass, body, mode: d.a ? 'static' : 'dynamic', sent: null };
    body.userData = { part: p };
    this.setBody(p, p.mode);
    this.world.addBody(body);
    if (asleep && p.mode === 'dynamic') body.sleep();
    this.parts.set(nid, p);
  }
  remove(nid) {
    const p = this.parts.get(nid);
    if (!p) return;
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
    else b.velocity.set(dx * 15, dy * 15, dz * 15);
    g.seen = now;
  }

  /* ---- every tick ---- */
  step(dt, now) {
    for (const g of this.ghosts.values()) if (now - g.seen > 150) g.body.velocity.set(0, 0, 0);   // no news: stand still
    this.world.step(1 / 120, Math.min(dt, 1 / 20), 8);
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
