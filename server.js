// Obsidian Rush - servidor autoritativo (Node.js + ws)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Perfiles (token -> {name, elo, w, l}). En hosting gratis el disco se borra al redesplegar: ver README.
let db = {}; try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let st; const save = () => { clearTimeout(st); st = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 2000); };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server });

const W = 1200, H = 700, R = 16, DT = 1 / 30, WIN = 5, rnd = Math.random;
const MAG = 7, RELOAD = 1.7, FIRE_CD = .35, BODY = 45, HEAD = 100, SPD = 1400, K = .05; // Desert Eagle: cabeza = baja inmediata
const WALLS = [[540, 230, 120, 240], [180, 120, 150, 28], [870, 552, 150, 28], [180, 552, 150, 28], [870, 120, 150, 28]];
const SPAWN = [[110, 350], [1090, 350]];
const DIFF = { easy: { turn: 2.5, err: .4, fire: .5, spd: .7, dl: .7, hd: 0 }, normal: { turn: 5, err: .2, fire: .8, spd: .85, dl: .35, hd: .15 }, pro: { turn: 11, err: .07, fire: 1, spd: 1, dl: .12, hd: .45 } };
const matches = new Set(), queue = [];
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const name = e => e.bot ? e.name : e.prof.name;
const profMsg = u => ({ t: 'profile', name: u.prof.name, elo: u.prof.elo, w: u.prof.w, l: u.prof.l, online: wss.clients.size });

const blocked = (x, y, r) => x < r || y < r || x > W - r || y > H - r || WALLS.some(([a, b, w, h]) => x > a - r && x < a + w + r && y > b - r && y < b + h + r);
const los = (a, b) => { for (let t = 0; t <= 1; t += .05) if (blocked(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 3)) return false; return true; };
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

function startMatch(a, b, ranked, diff) {
  const ps = [a, b].map((e, i) => ({ e, x: SPAWN[i][0], y: SPAWN[i][1], a: i ? Math.PI : 0, hp: 100, pt: 0, ammo: MAG, rl: 0, fq: 0, rq: 0, th: 1.5, er2: 0, cd: 0, mv: [0, 0], bt: 0, bd: 1, er: 0, et: 0, spd: 1 }));
  const m = { ps, ev: [], bullets: [], score: [0, 0], phase: 'play', pt: 0, ranked, diff, over: false };
  ps.forEach((p, i) => { if (!p.e.bot) { p.e.m = m; p.e.i = i; send(p.e.ws, { t: 'match', you: i, names: [name(a), name(b)], walls: WALLS, ranked }); } });
  matches.add(m);
}
function resetRound(m) {
  m.phase = 'play'; m.bullets = [];
  m.ps.forEach((p, i) => { p.x = SPAWN[i][0]; p.y = SPAWN[i][1]; p.a = i ? Math.PI : 0; p.hp = 100; p.cd = 0; p.ammo = MAG; p.rl = 0; p.fq = 0; p.rq = 0; });
}
function think(m, i) { // IA
  const p = m.ps[i], e = m.ps[1 - i], d = DIFF[m.diff] || DIFF.normal;
  const dx = e.x - p.x, dy = e.y - p.y, dist = Math.hypot(dx, dy) || 1, vis = los(p, e);
  if ((p.et -= DT) <= 0) { p.et = .4; p.er = (rnd() - .5) * 2 * d.err; p.er2 = (rnd() - .5) * d.err; p.th = rnd() < d.hd ? 2.6 : 1.5; }
  if ((p.bt -= DT) <= 0) { p.bt = .5 + rnd() * 1.2; p.bd = rnd() < .5 ? -1 : 1; }
  const df = angDiff(p.a, Math.atan2(dy, dx) + p.er);
  p.a += Math.sign(df) * Math.min(Math.abs(df), d.turn * DT);
  if (p.lane === undefined) p.lane = rnd() < .5 ? 180 : 520; // rodea el muro central por arriba o por abajo
  let tx = e.x, ty = e.y;
  if (!vis && Math.hypot(600 - p.x, p.lane - p.y) > 90) { tx = 600; ty = p.lane; }
  const md = Math.hypot(tx - p.x, ty - p.y) || 1, nx = (tx - p.x) / md, ny = (ty - p.y) / md, rad = !vis || dist > 380 ? 1 : dist < 200 ? -1 : 0, st = vis ? .9 : .3;
  p.mv = [nx * rad - ny * p.bd * st, ny * rad + nx * p.bd * st]; p.spd = d.spd;
  p.pt = Math.max(-1.2, Math.min(1.2, Math.atan2(p.th - 2.5, dist * K) + p.er2));
  p.fq = vis && Math.abs(df) < .12 + d.err * .4 && rnd() < d.fire ? 1 : 0;
  if (p.ammo < MAG && p.rl <= 0 && !vis && rnd() < .05) p.rq = 1;
}
function move(p) {
  const [x, y] = p.mv, l = Math.hypot(x, y); if (!l) return;
  const v = 250 * p.spd * DT / l, nx = p.x + x * v, ny = p.y + y * v;
  if (!blocked(nx, p.y, R)) p.x = nx; if (!blocked(p.x, ny, R)) p.y = ny;
}
function bc(m) {
  const s = { t: 's', p: m.ps.map(p => [p.x | 0, p.y | 0, +p.a.toFixed(2), Math.max(0, p.hp), +p.pt.toFixed(2)]), b: m.bullets.map(b => [b.x | 0, b.y | 0, +b.h.toFixed(2), b.o]), sc: m.score, ph: m.phase, am: m.ps.map(p => p.ammo), rl: m.ps.map(p => p.rl > 0 ? 1 : 0), ev: m.ev };
  m.ps.forEach(p => { if (!p.e.bot) send(p.e.ws, s); });
  m.ev = [];
}
function tick(m) {
  if (m.over) return;
  if (m.phase === 'wait') { if ((m.pt -= DT) <= 0) resetRound(m); return bc(m); }
  m.ps.forEach((p, i) => {
    if (p.e.bot) think(m, i); else p.spd = 1;
    move(p);
    p.cd -= DT;
    if (p.rl > 0) { if ((p.rl -= DT) <= 0) p.ammo = MAG; } else if (p.rq && p.ammo < MAG) p.rl = RELOAD;
    p.rq = 0;
    if (p.fq) { // semiautomática: un disparo por clic
      p.fq = 0;
      if (p.cd <= 0 && p.rl <= 0 && p.ammo > 0) {
        p.cd = FIRE_CD + (p.e.bot ? (DIFF[m.diff] || DIFF.normal).dl : 0); p.ammo--;
        const c = Math.cos(p.a), sn = Math.sin(p.a), cp = Math.cos(p.pt), sp = Math.sin(p.pt);
        m.bullets.push({ x: p.x + c * 22, y: p.y + sn * 22, h: 2.5, vx: c * cp * SPD, vy: sn * cp * SPD, vh: sp * SPD * K, o: i, l: .9 });
        m.ev.push({ k: 's', i }); if (p.ammo === 0) p.rq = 1;
      }
    }
  });
  m.bullets = m.bullets.filter(b => {
    for (let q = 0; q < 4; q++) { // 4 subpasos para que las balas rápidas no atraviesen nada
      b.x += b.vx * DT / 4; b.y += b.vy * DT / 4; b.h += b.vh * DT / 4;
      if (b.h <= 0 || b.x < 0 || b.y < 0 || b.x > W || b.y > H) return false;
      if (b.h < 3.2 && WALLS.some(([wx, wy, ww, wh]) => b.x > wx && b.x < wx + ww && b.y > wy && b.y < wy + wh)) return false;
      const t = m.ps[1 - b.o];
      if (t.hp <= 0 || m.phase !== 'play') continue;
      const d = Math.hypot(t.x - b.x, t.y - b.y), head = b.h >= 2.05 && b.h <= 3.2 && d < 15;
      if (head || (b.h < 2.05 && d < 19)) {
        t.hp -= head ? HEAD : BODY;
        m.ev.push({ k: 'h', v: 1 - b.o, hd: head ? 1 : 0, s: b.o });
        if (t.hp <= 0) { m.score[b.o]++; if (m.score[b.o] >= WIN) finish(m, b.o); else { m.phase = 'wait'; m.pt = 1.6; } }
        return false;
      }
    }
    b.l -= DT; return b.l > 0;
  });
  if (!m.over) bc(m);
}
function finish(m, w) {
  bc(m); m.over = true; m.phase = 'over'; matches.delete(m);
  const d = [0, 0];
  if (m.ranked) {
    const [a, b] = m.ps.map(p => p.e.prof), ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400)), da = Math.round(32 * ((w === 0 ? 1 : 0) - ea));
    d[0] = da; d[1] = -da;
    [a, b].forEach((pr, i) => { pr.elo = Math.max(0, pr.elo + d[i]); i === w ? pr.w++ : pr.l++; });
    save();
  }
  m.ps.forEach((p, i) => { const u = p.e; if (u.bot) return; u.m = null; send(u.ws, { t: 'end', win: i === w, delta: d[i], ranked: m.ranked, sc: m.score, elo: u.prof.elo }); send(u.ws, profMsg(u)); });
}
function leave(u) {
  const q = queue.indexOf(u); if (q >= 0) queue.splice(q, 1);
  const m = u.m; if (!m || m.over) return;
  u.m = null;
  if (m.ranked) finish(m, 1 - u.i); else { m.over = true; matches.delete(m); }
}

setInterval(() => matches.forEach(tick), 1000 / 30);
setInterval(() => { // emparejamiento: el rango de puntos se amplía con la espera
  const now = Date.now(); queue.sort((a, b) => a.q - b.q);
  for (let i = 0; i < queue.length; i++) for (let j = i + 1; j < queue.length; j++) {
    const a = queue[i], b = queue[j], range = 100 + 40 * (((now - a.q) / 1000) | 0);
    if (Math.abs(a.prof.elo - b.prof.elo) <= range) { queue.splice(j, 1); queue.splice(i, 1); startMatch(a, b, true); i--; break; }
  }
}, 1000);

wss.on('connection', ws => {
  const u = { ws, prof: null, m: null, i: 0, q: 0 }; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      const tok = String(m.token || '').slice(0, 64); if (tok.length < 8) return;
      u.prof = db[tok] || (db[tok] = { name: 'Jugador', elo: 800, w: 0, l: 0 });
      u.prof.name = String(m.name || 'Jugador').replace(/[<>]/g, '').slice(0, 14) || 'Jugador'; save();
      return send(ws, profMsg(u));
    }
    if (!u.prof) return;
    if (m.t === 'play' && !u.m && queue.indexOf(u) < 0) {
      if (m.mode === 'ai') { const diff = DIFF[m.diff] ? m.diff : 'normal'; startMatch(u, { bot: 1, name: 'IA ' + { easy: 'Fácil', normal: 'Normal', pro: 'Pro' }[diff] }, false, diff); }
      else { u.q = Date.now(); queue.push(u); send(ws, { t: 'queue' }); }
    } else if (m.t === 'cancel') { const q = queue.indexOf(u); if (q >= 0) queue.splice(q, 1); }
    else if (m.t === 'leave') leave(u);
    else if ((m.t === 'in' || m.t === 'fire') && u.m && !u.m.over) {
      const p = u.m.ps[u.i], c = v => Math.max(-1, Math.min(1, +v || 0));
      if (m.t === 'in') { p.mv = [c(m.mx), c(m.my)]; if (m.r) p.rq = 1; }
      p.a = Number(m.a) || 0; p.pt = Math.max(-1.3, Math.min(1.3, Number(m.pt) || 0));
      if (m.t === 'fire') p.fq = 1;
    }
    else if (m.t === 'top') send(ws, { t: 'top', list: Object.values(db).sort((a, b) => b.elo - a.elo).slice(0, 10).map(p => ({ name: p.name, elo: p.elo })) });
  });
  ws.on('close', () => leave(u));
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);
server.listen(PORT, () => console.log('Obsidian Rush en http://localhost:' + PORT));
