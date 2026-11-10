'use strict';
/*
 * Máy chủ quản trị Bảo tàng ký ức số.
 * - Giữ mã GitHub (GITHUB_TOKEN) ở phía máy chủ; giáo viên không bao giờ thấy mã.
 * - Một tài khoản quản trị (ADMIN_USER / ADMIN_PASSWORD), các tài khoản giáo viên do quản trị tạo.
 * - Dữ liệu công khai: <DATA_REPO>/data/museum.json
 * - Tài khoản + bài chờ duyệt: <PRIVATE_REPO>/quantri.json (kho riêng tư)
 * Không cần thư viện ngoài: chỉ dùng Node.js >= 20.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const env = process.env;
const PORT = +env.PORT || 8787;
const OWNER = env.GITHUB_OWNER || 'nguyenthithuhiensteam';
const DATA_REPO = env.DATA_REPO || 'baotangkyucso';
const PRIV_REPO = env.PRIVATE_REPO || 'baotangkyucso-quantri';
const BRANCH = env.BRANCH || 'main';
const TOKEN = env.GITHUB_TOKEN || '';
const ADMIN_USER = (env.ADMIN_USER || 'quantri').trim().toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const SECRET = env.SESSION_SECRET || '';
const GH_API = env.GITHUB_API || 'https://api.github.com';
const ORIGINS = (env.ALLOWED_ORIGINS || 'https://baotang.nguyenhiensteam.vn,https://baotangkyucso.onrender.com')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const DATA_FILE = 'data/museum.json';
const PRIV_FILE = 'quantri.json';
const ROOMS = ['khoanh-khac', 'tri-an', 'di-san'];
const SESSION_MS = 7 * 24 * 3600 * 1000;

const configured = !!(TOKEN && ADMIN_PASSWORD.length >= 8 && SECRET.length >= 16);
if (!configured) console.error('[cấu hình] Thiếu GITHUB_TOKEN, ADMIN_PASSWORD (>= 8 ký tự) hoặc SESSION_SECRET (>= 16 ký tự).');

class HttpErr extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

/* ---------------- GitHub ---------------- */
async function gh(path, opt = {}) {
  return fetch(GH_API + path, {
    ...opt,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'baotangkyucso-api',
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}
const enc = encodeURIComponent;
async function readFile(repo, file) {
  const r = await gh(`/repos/${enc(OWNER)}/${enc(repo)}/contents/${file}?ref=${enc(BRANCH)}&t=${Date.now()}`);
  if (r.status === 404) {
    if (repo === PRIV_REPO) {
      const rr = await gh(`/repos/${enc(OWNER)}/${enc(repo)}`);
      if (rr.status === 404) throw new HttpErr(500, `Chưa có kho riêng tư "${repo}", hoặc mã GitHub chưa được cấp quyền vào kho đó.`);
    }
    return { sha: null, data: null };
  }
  if (r.status === 401) throw new HttpErr(500, 'Mã GitHub trên máy chủ không đúng hoặc đã hết hạn. Báo người quản trị tạo mã mới.');
  if (!r.ok) throw new HttpErr(502, `GitHub báo lỗi ${r.status} khi đọc ${file}.`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function writeFile(repo, file, data, sha, message) {
  const body = { message, branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${enc(OWNER)}/${enc(repo)}/contents/${file}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) throw new HttpErr(409, 'Dữ liệu vừa được người khác thay đổi.');
  if (r.status === 401 || r.status === 403) throw new HttpErr(500, 'Mã GitHub trên máy chủ không có quyền ghi. Cần quyền Contents: Read and write.');
  if (!r.ok) throw new HttpErr(502, `GitHub báo lỗi ${r.status} khi lưu ${file}.`);
  return (await r.json()).content.sha;
}
/** Đọc, sửa và ghi lại một tệp; tự thử lại nếu có người khác vừa ghi. */
async function updateFile(repo, file, fallback, mutate, message) {
  for (let i = 0; ; i++) {
    const cur = await readFile(repo, file);
    const d = cur.data ?? fallback();
    const res = await mutate(d);
    try {
      const sha = await writeFile(repo, file, d, cur.sha, typeof message === 'function' ? message(res) : message);
      if (repo === PRIV_REPO) privCache = { at: Date.now(), sha, data: d };
      return { sha, data: d, res };
    } catch (e) { if (e.status !== 409 || i >= 2) throw e; }
  }
}
let privCache = null;
const blankPriv = () => ({ users: [], pending: [] });
async function loadPriv(fresh) {
  if (!fresh && privCache && Date.now() - privCache.at < 15000) return privCache.data;
  const cur = await readFile(PRIV_REPO, PRIV_FILE);
  const d = cur.data || blankPriv();
  d.users = d.users || []; d.pending = d.pending || [];
  privCache = { at: Date.now(), sha: cur.sha, data: d };
  return d;
}
const updatePriv = (mutate, message) => updateFile(PRIV_REPO, PRIV_FILE, blankPriv, d => { d.users = d.users || []; d.pending = d.pending || []; return mutate(d); }, message);
const updateData = (mutate, message) => updateFile(DATA_REPO, DATA_FILE, () => { throw new HttpErr(500, 'Kho chưa có tệp data/museum.json.'); }, mutate, message);

/* ---------------- Dữ liệu bảo tàng ---------------- */
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const okUrl = u => /^https:\/\/[^\s"'<>]+$/i.test(u);
const okId = id => /^[A-Za-z0-9_-]{1,40}$/.test(id);
function cleanExhibit(x) {
  x = x || {};
  const o = { id: str(x.id, 40), room: str(x.room, 40), art: str(x.art, 20) || 'sach' };
  if (!okId(o.id)) throw new HttpErr(400, 'Mã hiện vật không hợp lệ.');
  if (!ROOMS.includes(o.room)) throw new HttpErr(400, 'Phòng trưng bày không hợp lệ.');
  if (!/^[a-z0-9]{1,20}$/.test(o.art)) o.art = 'sach';
  o.name = str(x.name, 200);
  if (!o.name) throw new HttpErr(400, 'Hãy nhập tên hiện vật.');
  o.era = str(x.era, 200); o.plan = str(x.plan, 200); o.from = str(x.from, 200);
  o.story = str(x.story, 4000); o.ask = str(x.ask, 500);
  for (const k of ['video', 'audio', 'link3d', 'drive']) {
    o[k] = str(x[k], 1000);
    if (o[k] && !okUrl(o[k])) throw new HttpErr(400, 'Link phải bắt đầu bằng https://');
  }
  o.sample = !!x.sample;
  return o;
}
function cleanTimeline(x) {
  x = x || {};
  const o = { id: str(x.id, 40), when: str(x.when, 100), title: str(x.title, 300), text: str(x.text, 3000), ref: str(x.ref, 300), todo: str(x.todo, 1000) };
  if (!okId(o.id)) throw new HttpErr(400, 'Mã mốc không hợp lệ.');
  if (!o.when || !o.title) throw new HttpErr(400, 'Mốc lịch sử cần có thời gian và tiêu đề.');
  return o;
}
function cleanData(d) {
  if (!d || !Array.isArray(d.exhibits) || !Array.isArray(d.timeline)) throw new HttpErr(400, 'Dữ liệu gửi lên không đúng cấu trúc.');
  const s = d.settings || {};
  const room3d = {};
  for (const r of ROOMS) { const u = str(s.room3d?.[r], 1000); if (u && !okUrl(u)) throw new HttpErr(400, 'Link phòng 3D phải bắt đầu bằng https://'); room3d[r] = u; }
  const intro = str(s.introVideo, 1000); if (intro && !okUrl(intro)) throw new HttpErr(400, 'Link video phải bắt đầu bằng https://');
  return { v: 1, settings: { room3d, introVideo: intro }, exhibits: d.exhibits.map(cleanExhibit), timeline: d.timeline.map(cleanTimeline) };
}
function applyItem(data, kind, item, beforeId) {
  if (kind === 'exhibit') {
    const i = data.exhibits.findIndex(e => e.id === item.id);
    if (i >= 0) data.exhibits[i] = item; else data.exhibits.push(item);
  } else {
    const rest = data.timeline.filter(t => t.id !== item.id);
    const at = beforeId ? rest.findIndex(t => t.id === beforeId) : -1;
    if (at >= 0) rest.splice(at, 0, item); else rest.push(item);
    data.timeline = rest;
  }
}
function canTouch(user, data, kind, item) {
  if (user.role === 'admin') return;
  if (kind === 'timeline') { if (!user.timeline) throw new HttpErr(403, 'Tài khoản chưa được giao quyền sửa dòng thời gian.'); return; }
  if (!user.rooms.includes(item.room)) throw new HttpErr(403, 'Tài khoản chưa được giao phòng này.');
  const old = data.exhibits.find(e => e.id === item.id);
  if (old && !user.rooms.includes(old.room)) throw new HttpErr(403, 'Hiện vật này thuộc phòng chưa được giao cho tài khoản.');
}

/* ---------------- Tài khoản & phiên ---------------- */
const hmac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const adminVer = () => crypto.createHash('sha256').update('v1:' + ADMIN_PASSWORD).digest('hex').slice(0, 12);
function sign(p) { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + SESSION_MS })).toString('base64url'); return b + '.' + hmac(b); }
function verifyToken(t) {
  const [b, s] = String(t || '').split('.');
  if (!b || !s) return null;
  const e = hmac(b);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function checkPw(pw, u) { const h = Buffer.from(hashPw(pw, u.salt), 'hex'), w = Buffer.from(u.hash, 'hex'); return h.length === w.length && crypto.timingSafeEqual(h, w); }
function safeEq(a, b) { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); }
const ADMIN = () => ({ username: ADMIN_USER, name: 'Quản trị nhà trường', role: 'admin' });
const pubUser = u => ({ username: u.username, name: u.name, role: 'teacher', rooms: u.rooms || [], timeline: !!u.timeline, review: u.review !== false, active: u.active !== false });

async function who(req) {
  const p = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expired = new HttpErr(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
  if (!p) throw expired;
  if (p.role === 'admin') { if (p.u !== ADMIN_USER || p.v !== adminVer()) throw expired; return ADMIN(); }
  const u = (await loadPriv()).users.find(x => x.username === p.u);
  if (!u || u.active === false || u.ver !== p.v) throw expired;
  return pubUser(u);
}
const needAdmin = u => { if (u.role !== 'admin') throw new HttpErr(403, 'Chỉ người quản trị mới làm được việc này.'); };

const fails = new Map();
function limitLogin(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now() && f.n >= 8) throw new HttpErr(429, 'Nhập sai quá nhiều lần. Hãy chờ 15 phút rồi thử lại.');
}
function failLogin(key) {
  const f = fails.get(key);
  if (!f || f.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + 15 * 60000 }); else f.n++;
}

/* ---------------- Các đường dẫn API ---------------- */
const routes = {
  'GET /api/health': async () => ({ ok: true, configured }),

  'POST /api/login': async (req, body) => {
    const username = str(body.username, 40).toLowerCase(), password = String(body.password || '');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + username;
    limitLogin(key);
    const bad = new HttpErr(401, 'Tên đăng nhập hoặc mật khẩu không đúng.');
    if (username === ADMIN_USER) {
      if (!safeEq(password, ADMIN_PASSWORD)) { failLogin(key); throw bad; }
      fails.delete(key);
      return { token: sign({ u: ADMIN_USER, role: 'admin', v: adminVer() }), user: ADMIN() };
    }
    const u = (await loadPriv(true)).users.find(x => x.username === username);
    if (!u || !checkPw(password, u)) { failLogin(key); throw bad; }
    if (u.active === false) throw new HttpErr(403, 'Tài khoản đang bị khóa. Liên hệ người quản trị.');
    fails.delete(key);
    return { token: sign({ u: u.username, role: 'teacher', v: u.ver }), user: pubUser(u) };
  },

  'GET /api/me': async (req, _b, user) => ({ user }),

  'GET /api/data': async () => { const r = await readFile(DATA_REPO, DATA_FILE); if (!r.data) throw new HttpErr(500, 'Kho chưa có tệp data/museum.json.'); return r; },

  'POST /api/save': async (req, body, user) => {
    needAdmin(user);
    const clean = cleanData(body.data);
    const cur = await readFile(DATA_REPO, DATA_FILE);
    if (body.sha && cur.sha && body.sha !== cur.sha) throw new HttpErr(409, 'Có người vừa lưu hoặc vừa có bài được duyệt. Bấm “Tải bản mới nhất” rồi làm lại thay đổi.');
    const sha = await writeFile(DATA_REPO, DATA_FILE, clean, cur.sha, 'Cập nhật Bảo tàng ký ức (quản trị) ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
    return { sha, data: clean };
  },

  'POST /api/submit': async (req, body, user) => {
    const kind = body.kind === 'timeline' ? 'timeline' : 'exhibit';
    const item = kind === 'exhibit' ? cleanExhibit(body.item) : cleanTimeline(body.item);
    const beforeId = body.beforeId && okId(String(body.beforeId)) ? String(body.beforeId) : null;
    const cur = await readFile(DATA_REPO, DATA_FILE);
    canTouch(user, cur.data, kind, item);
    const old = kind === 'exhibit' ? cur.data.exhibits.find(e => e.id === item.id) : cur.data.timeline.find(t => t.id === item.id);
    if (user.role === 'admin' || !user.review) {
      const r = await updateData(d => { canTouch(user, d, kind, item); applyItem(d, kind, item, beforeId); },
        `${user.username}: ${old ? 'sửa' : 'thêm'} ${kind === 'exhibit' ? 'hiện vật' : 'mốc'} “${item.name || item.title}”`);
      return { status: 'published', sha: r.sha, data: r.data };
    }
    await updatePriv(p => {
      p.pending.push({ id: 'p' + crypto.randomBytes(6).toString('hex'), kind, item, beforeId, isNew: !old, oldName: old ? (old.name || old.title) : '',
        by: user.username, byName: user.name, at: new Date().toISOString(), status: 'pending' });
      prune(p);
    }, `Bài chờ duyệt của ${user.username}`);
    return { status: 'pending' };
  },

  'GET /api/pending': async (req, _b, user) => {
    const p = await loadPriv(true);
    const list = user.role === 'admin' ? p.pending : p.pending.filter(x => x.by === user.username);
    return { pending: list.slice().reverse() };
  },

  'POST /api/pending/approve': async (req, body, user) => {
    needAdmin(user);
    const p = await loadPriv(true);
    const it = p.pending.find(x => x.id === body.id && x.status === 'pending');
    if (!it) throw new HttpErr(404, 'Bài này không còn chờ duyệt.');
    const r = await updateData(d => applyItem(d, it.kind, it.kind === 'exhibit' ? cleanExhibit(it.item) : cleanTimeline(it.item), it.beforeId),
      `Duyệt bài của ${it.by}: “${it.item.name || it.item.title}”`);
    await updatePriv(q => { const x = q.pending.find(y => y.id === it.id); if (x) { x.status = 'approved'; x.decidedAt = new Date().toISOString(); } prune(q); }, 'Đã duyệt ' + it.id);
    return { sha: r.sha, data: r.data };
  },

  'POST /api/pending/reject': async (req, body, user) => {
    needAdmin(user);
    let found = false;
    await updatePriv(q => {
      const x = q.pending.find(y => y.id === body.id && y.status === 'pending');
      if (!x) return;
      found = true; x.status = 'rejected'; x.note = str(body.note, 500); x.decidedAt = new Date().toISOString(); prune(q);
    }, 'Trả lại ' + str(body.id, 40));
    if (!found) throw new HttpErr(404, 'Bài này không còn chờ duyệt.');
    return { ok: true };
  },

  'GET /api/users': async (req, _b, user) => { needAdmin(user); return { users: (await loadPriv(true)).users.map(pubUser), admin: ADMIN_USER }; },

  'POST /api/users': async (req, body, user) => {
    needAdmin(user);
    const username = str(body.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpErr(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch ngang.');
    if (username === ADMIN_USER) throw new HttpErr(400, 'Tên đăng nhập này dành cho người quản trị.');
    const name = str(body.name, 100); if (!name) throw new HttpErr(400, 'Hãy nhập họ tên.');
    const rooms = (Array.isArray(body.rooms) ? body.rooms : []).filter(r => ROOMS.includes(r));
    const pw = String(body.password || '');
    if (pw && pw.length < 6) throw new HttpErr(400, 'Mật khẩu cần ít nhất 6 ký tự.');
    await updatePriv(q => {
      let u = q.users.find(x => x.username === username);
      if (body.isNew && u) throw new HttpErr(400, 'Tên đăng nhập đã có người dùng.');
      if (!u) { if (!pw) throw new HttpErr(400, 'Hãy đặt mật khẩu cho tài khoản mới.'); u = { username, ver: 1 }; q.users.push(u); }
      const wasActive = u.active !== false;
      Object.assign(u, { name, rooms, timeline: !!body.timeline, review: body.review !== false, active: body.active !== false });
      if (pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); }
      if (pw || (wasActive && !u.active)) u.ver = (u.ver || 0) + 1;
    }, 'Cập nhật tài khoản ' + username);
    return { ok: true };
  },

  'POST /api/users/delete': async (req, body, user) => {
    needAdmin(user);
    const username = str(body.username, 40).toLowerCase();
    await updatePriv(q => { q.users = q.users.filter(x => x.username !== username); }, 'Xóa tài khoản ' + username);
    return { ok: true };
  },

  'POST /api/password': async (req, body, user) => {
    if (user.role === 'admin') throw new HttpErr(400, 'Mật khẩu quản trị đổi trong phần Environment của Render.');
    const nw = String(body.new || '');
    if (nw.length < 6) throw new HttpErr(400, 'Mật khẩu mới cần ít nhất 6 ký tự.');
    let token;
    await updatePriv(q => {
      const u = q.users.find(x => x.username === user.username);
      if (!u || !checkPw(body.old || '', u)) throw new HttpErr(400, 'Mật khẩu hiện tại không đúng.');
      u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(nw, u.salt); u.ver = (u.ver || 0) + 1;
      token = sign({ u: u.username, role: 'teacher', v: u.ver });
    }, 'Đổi mật khẩu ' + user.username);
    return { ok: true, token };
  },
};
/** Giữ tối đa 60 ngày các bài đã duyệt / trả lại. */
function prune(p) {
  const cut = Date.now() - 60 * 864e5;
  p.pending = p.pending.filter(x => x.status === 'pending' || Date.parse(x.decidedAt || x.at) > cut).slice(-500);
}

/* ---------------- Máy chủ HTTP ---------------- */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { fail(new HttpErr(413, 'Dữ liệu quá lớn.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return ok({}); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new HttpErr(400, 'Dữ liệu gửi lên không hợp lệ.')); } });
    req.on('error', fail);
  });
}
const PUBLIC = new Set(['GET /api/health', 'POST /api/login']);
const server = http.createServer(async (req, res) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = (req.url || '/').split('?')[0];
  if (path === '/') return send(res, 200, { ok: true, service: 'Bảo tàng ký ức số – máy chủ quản trị' });
  const key = req.method + ' ' + path;
  const fn = routes[key];
  if (!fn) return send(res, 404, { error: 'Không có đường dẫn này.' });
  try {
    if (!configured && key !== 'GET /api/health') throw new HttpErr(503, 'Máy chủ chưa được cấu hình đủ (GITHUB_TOKEN, ADMIN_PASSWORD, SESSION_SECRET).');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const user = PUBLIC.has(key) ? null : await who(req);
    send(res, 200, await fn(req, body, user));
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpErr ? e.message : 'Máy chủ gặp lỗi. Thử lại sau ít phút.' });
  }
});
server.listen(PORT, () => console.log(`Máy chủ quản trị chạy ở cổng ${PORT}; kho dữ liệu ${OWNER}/${DATA_REPO}; kho riêng ${OWNER}/${PRIV_REPO}`));
