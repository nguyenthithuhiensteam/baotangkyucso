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
const ROOMS = ['khoanh-khac', 'tri-an', 'di-san', 'thien-nhien'];
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
/* Ảnh: kho công khai anh/<tên>.jpg; ảnh chờ duyệt nằm ở kho riêng tư anh/<tên>.jpg (đường dẫn trong bài: cho-duyet/<tên>.jpg). */
const PHOTO_RE = /^(anh|cho-duyet)\/([a-z0-9]{8,40})\.jpg$/;
const MAX_PHOTO = 1024 * 1024;
const MAX_PHOTOS = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Lưu ảnh; tự thử lại khi kho vừa có người ghi cùng lúc (409) hoặc GitHub tạm lỗi (5xx, 429). */
async function putBinary(repo, file, b64, message) {
  for (let i = 0; ; i++) {
    const r = await gh(`/repos/${enc(OWNER)}/${enc(repo)}/contents/${file}`, { method: 'PUT', body: JSON.stringify({ message, branch: BRANCH, content: b64 }) });
    if (r.ok || r.status === 422) return;
    if (r.status === 401) throw new HttpErr(500, 'Mã GitHub trên máy chủ không có quyền ghi. Cần quyền Contents: Read and write.');
    const retry = r.status === 409 || r.status === 429 || r.status >= 500 || (r.status === 403 && /rate limit/i.test(await r.clone().text()));
    if (retry && i < 4) { await sleep(800 * (i + 1) + Math.random() * 400); continue; }
    if (r.status === 403) throw new HttpErr(500, 'Mã GitHub trên máy chủ không có quyền ghi. Cần quyền Contents: Read and write.');
    console.error('putBinary', r.status, (await r.text()).slice(0, 300));
    throw new HttpErr(502, `GitHub báo lỗi ${r.status} khi lưu ảnh. Vui lòng thử lại.`);
  }
}
async function getBinary(repo, file) {
  const r = await gh(`/repos/${enc(OWNER)}/${enc(repo)}/contents/${file}?ref=${enc(BRANCH)}`);
  if (r.status === 404) throw new HttpErr(404, 'Không tìm thấy ảnh.');
  if (!r.ok) throw new HttpErr(502, `GitHub báo lỗi ${r.status} khi đọc ảnh.`);
  const j = await r.json();
  return String(j.content || '').replace(/\s/g, '');
}
/** Ảnh chờ duyệt: chép từ kho riêng tư sang kho công khai, trả về đường dẫn công khai. */
async function publishPhoto(photo, who) {
  const m = PHOTO_RE.exec(photo || '');
  if (!m || m[1] === 'anh') return photo || '';
  const b64 = await getBinary(PRIV_REPO, `anh/${m[2]}.jpg`);
  await putBinary(DATA_REPO, `anh/${m[2]}.jpg`, b64, `Ảnh hiện vật (${who})`);
  return `anh/${m[2]}.jpg`;
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
  o.cls = [...new Set((Array.isArray(x.cls) ? x.cls : (x.cls ? [x.cls] : [])).map(c => str(c, 20)).filter(c => /^[a-z0-9]{1,20}$/.test(c)))].slice(0, 30);
  const TC_OK = ['TC1', 'TC2', 'TC3', 'TC4', 'TC5', 'TC6', 'TC7', 'TC8', 'TC9', 'MR1', 'MR2'];
  o.tc = [...new Set((Array.isArray(x.tc) ? x.tc : []).map(c => str(c, 4)).filter(c => TC_OK.includes(c)))];
  o.keeper = ['Cha mẹ', 'Ông bà', 'Nghệ nhân', 'Người có uy tín', 'Cán bộ văn hóa'].includes(x.keeper) ? x.keeper : '';
  o.her = /^[a-z0-9]{1,20}$/.test(str(x.her, 20)) ? str(x.her, 20) : '';
  o.photo = str(x.photo, 80);
  if (o.photo && !PHOTO_RE.test(o.photo)) throw new HttpErr(400, 'Đường dẫn ảnh không hợp lệ.');
  // Nhiều ảnh: photos là danh sách, ảnh đầu tiên là ảnh bìa (photo).
  const ph = [...new Set((Array.isArray(x.photos) ? x.photos : []).map(p => str(p, 80)).filter(p => PHOTO_RE.test(p)))].slice(0, MAX_PHOTOS);
  if (!ph.length && o.photo) ph.push(o.photo);
  o.photos = ph; o.photo = ph[0] || '';
  o.photoAlt = str(x.photoAlt, 200);
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
/* Kho học liệu số theo Bộ tiêu chí (Hành trình di sản). */
/* Tài liệu đính kèm bài học: tệp tải lên nằm ở kho công khai tailieu/<tên>. */
const LINK_KINDS = ['giao-an', 'tro-choi', 'video', 'bai-hat', 'tu-lieu'];
const FILE_EXT = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'mp3', 'mp4', 'm4a', 'jpg', 'jpeg', 'png', 'zip'];
const FILE_RE = new RegExp('^tailieu/[a-z0-9-]{1,80}[.](' + FILE_EXT.join('|') + ')$');
const MAX_FILE = 15 * 1024 * 1024;
/* Giới thiệu lớp (Phòng 4): lời giới thiệu, cô phụ trách, sĩ số, khẩu hiệu, ảnh lớp, video. */
function cleanIntro(x) {
  if (!x || typeof x !== 'object') return null;
  const o = { text: str(x.text, 1500), teachers: str(x.teachers, 200), kids: str(x.kids, 30), motto: str(x.motto, 150),
    photo: /^anh\/[a-z0-9]{8,40}\.jpg$/.test(x.photo || '') ? x.photo : '', video: okUrl(str(x.video, 500)) ? str(x.video, 500) : '' };
  if (x.by) o.by = str(x.by, 40);
  if (x.at) o.at = str(x.at, 30);
  return Object.values(o).some(v => v && v !== o.by && v !== o.at) ? o : null;
}
function cleanLesson(x) {
  x = x || {};
  const o = { id: str(x.id, 40), tc: str(x.tc, 4), age: str(x.age, 8), title: str(x.title, 200), month: str(x.month, 100), week: str(x.week, 150),
    yccd: str(x.yccd, 300), desc: str(x.desc, 3000) };
  if (!okId(o.id)) throw new HttpErr(400, 'Mã học liệu không hợp lệ.');
  if (!['TC1', 'TC2', 'TC3', 'TC4', 'TC5', 'TC6', 'TC7', 'TC8', 'TC9', 'MR1', 'MR2'].includes(o.tc)) throw new HttpErr(400, 'Tiêu chí của học liệu không hợp lệ.');
  if (!['3-4', '4-5', '5-6', 'chung'].includes(o.age)) o.age = 'chung';
  if (!o.title) throw new HttpErr(400, 'Học liệu cần có tên bài.');
  o.links = (Array.isArray(x.links) ? x.links : []).slice(0, 24).map(l => ({ label: str(l?.label, 120), url: str(l?.url, 1000), kind: LINK_KINDS.includes(l?.kind) ? l.kind : 'tu-lieu' })).filter(l => l.url);
  for (const l of o.links) if (!okUrl(l.url) && !FILE_RE.test(l.url)) throw new HttpErr(400, 'Link học liệu phải bắt đầu bằng https:// (hoặc là tệp đã tải lên kho).');
  return o;
}
function cleanData(d) {
  if (!d || !Array.isArray(d.exhibits) || !Array.isArray(d.timeline)) throw new HttpErr(400, 'Dữ liệu gửi lên không đúng cấu trúc.');
  const s = d.settings || {};
  const room3d = {};
  for (const r of ROOMS) { const u = str(s.room3d?.[r], 1000); if (u && !okUrl(u)) throw new HttpErr(400, 'Link phòng 3D phải bắt đầu bằng https://'); room3d[r] = u; }
  const intro = str(s.introVideo, 1000); if (intro && !okUrl(intro)) throw new HttpErr(400, 'Link video phải bắt đầu bằng https://');
  const settings = { room3d, introVideo: intro };
  if (Array.isArray(s.sites)) settings.sites = s.sites.slice(0, 6).map(x => str(x, 60)).filter(Boolean);
  if (Array.isArray(s.classes)) settings.classes = s.classes.slice(0, 120).map(c => { const o = { id: str(c?.id, 20), name: str(c?.name, 60), site: str(c?.site, 60) }; const it = cleanIntro(c?.intro); if (it) o.intro = it; return o; })
    .filter(c => /^[a-z0-9]{1,20}$/.test(c.id) && c.name);
  if (Array.isArray(s.heritage)) settings.heritage = s.heritage.slice(0, 60).map(h => ({ id: str(h?.id, 20), site: str(h?.site, 60), name: str(h?.name, 100), kind: str(h?.kind, 100), confirm: str(h?.confirm, 100) }))
    .filter(h => /^[a-z0-9]{1,20}$/.test(h.id) && h.name);
  // Ảnh nổi bật của ba nhà trường (Phòng 1)
  if (Array.isArray(s.gallery)) settings.gallery = s.gallery.slice(0, 80).map(g => ({ photo: str(g?.photo, 80), site: str(g?.site, 60), cap: str(g?.cap, 200) }))
    .filter(g => /^anh\/(gioithieu\/[a-z0-9-]{1,40}|[a-z0-9]{8,40})\.jpg$/.test(g.photo));
  if (Array.isArray(s.stats)) settings.stats = s.stats.slice(0, 6).map(x => ({ n: str(x?.n, 12), l: str(x?.l, 40) })).filter(x => x.n || x.l);
  return { v: 1, settings, exhibits: d.exhibits.map(cleanExhibit), timeline: d.timeline.map(cleanTimeline),
    lessons: (Array.isArray(d.lessons) ? d.lessons : []).slice(0, 300).map(cleanLesson) };
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
  // Giao lớp: giáo viên chỉ đăng, sửa bài của lớp mình (không giao lớp = không giới hạn theo lớp).
  const mine = user.classes || [];
  if (mine.length) {
    const has = e => (Array.isArray(e.cls) ? e.cls : (e.cls ? [e.cls] : [])).some(c => mine.includes(c));
    if (!has(item)) throw new HttpErr(403, 'Hãy tích lớp của mình cho bài này (tài khoản chỉ đăng bài cho lớp được giao).');
    if (old && !has(old)) throw new HttpErr(403, 'Bài này của lớp khác, tài khoản không sửa được.');
  }
}

/* ---------------- Tài khoản & phiên ---------------- */
const hmac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const adminVer = () => crypto.createHash('sha256').update('v1:' + ADMIN_PASSWORD).digest('hex').slice(0, 12);
/* Mật khẩu quản trị đổi trên trang được lưu (dạng băm) trong kho riêng tư, gắn với ADMIN_PASSWORD hiện tại.
   Đổi ADMIN_PASSWORD trên Render sẽ bỏ mật khẩu đã đổi trên trang: dùng khi quên mật khẩu. */
const envTag = () => crypto.createHash('sha256').update('env:' + ADMIN_PASSWORD).digest('hex').slice(0, 12);
async function adminCred() {
  try {
    const a = (await loadPriv()).admin;
    if (a && a.envTag === envTag() && a.salt && a.hash) return { a, ver: 'p' + a.hash.slice(0, 12) };
  } catch (e) { console.error('[quản trị] Không đọc được kho riêng tư:', e.message); }
  return { a: null, ver: adminVer() };
}
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
const pubUser = u => ({ username: u.username, name: u.name, role: 'teacher', rooms: u.rooms || [], classes: u.classes || [], timeline: !!u.timeline, review: u.review !== false, active: u.active !== false });

async function who(req) {
  const p = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expired = new HttpErr(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
  if (!p) throw expired;
  if (p.role === 'admin') { if (p.u !== ADMIN_USER || p.v !== (await adminCred()).ver) throw expired; return ADMIN(); }
  const u = (await loadPriv()).users.find(x => x.username === p.u);
  if (!u || u.active === false || u.ver !== p.v) throw expired;
  return pubUser(u);
}
const needAdmin = u => { if (u.role !== 'admin') throw new HttpErr(403, 'Chỉ người quản trị mới làm được việc này.'); };

/* ---------------- Trợ lý AI hỏi đáp về trường (Claude) ---------------- */
const AI_KEY = env.ANTHROPIC_API_KEY || '';
const AI_MODEL = env.AI_MODEL || 'claude-opus-5-5';
const AI_DAILY = +env.AI_DAILY_LIMIT || 300;        // tối đa câu hỏi mỗi ngày cho cả trang
const AI_PER_IP = +env.AI_PER_IP_HOUR || 20;         // tối đa câu hỏi mỗi giờ cho một người
let aiClient = null;
function ai() {
  if (!AI_KEY) throw new HttpErr(503, 'Trợ lý AI chưa được bật. Nhà trường cần thêm khóa ANTHROPIC_API_KEY trên máy chủ.');
  if (!aiClient) { const sdk = require('@anthropic-ai/sdk'); const Anthropic = sdk.default || sdk.Anthropic || sdk; aiClient = new Anthropic({ apiKey: AI_KEY }); }
  return aiClient;
}
const ROOM_INFO = {
  'hanh-trinh': 'Phòng 1 · Hành trình của trường: các mốc lịch sử của Trường Mầm non Nông Tiến và hai phân hiệu, ảnh nổi bật của ba nhà trường',
  'khoanh-khac': 'Phòng 2 · Khoảnh khắc diệu kỳ: bước tiến bộ đầu đời của trẻ',
  'tri-an': 'Phòng 3 · Lời tri ân thơ ngây: lời chúc, thiệp, tranh tặng cô ngày 20/11, lời cảm ơn của cha mẹ',
  'di-san': 'Phòng 4 · Hành trình di sản lớp tôi: Trung thu, trang phục dân tộc, trò chơi dân gian, chuyện ông bà kể; bản đồ di sản gần trẻ',
  'lich': 'Phòng 5 · Lịch trưng bày năm học: chủ đề từng tháng và 8 chặng Hành trình di sản',
  'thien-nhien': 'Phòng 6 · Góc thiên nhiên xanh: cây xanh, vườn hoa quanh trường',
  'hoc-lieu': 'Phòng 7 · Kho học liệu số – Trẻ em Tuyên Quang: giáo án theo 9 tiêu chí và 3 độ tuổi',
  'lop-hoc': 'Các lớp học: thư mục bài của từng lớp',
};
const SCHOOL_FACTS = `Trường Mầm non Nông Tiến, phường Nông Tiến, tỉnh Tuyên Quang. Từ ngày 01/9/2026 (Quyết định số 83/QĐ-UBND ngày 13/8/2026 của UBND phường Nông Tiến) trường gồm trường chính và hai phân hiệu Tràng Đà, Hương Sen, 24 nhóm lớp.
- Trường Mầm non Nông Tiến (nay là trường chính): thành lập ngày 01/9/1993 theo Quyết định số 539/SGD ĐT; năm 2024 đạt chuẩn quốc gia mức độ 2 và kiểm định chất lượng giáo dục cấp độ 3.
- Trường Mầm non Tràng Đà (nay là Phân hiệu Tràng Đà): thành lập ngày 01/9/1993 theo Quyết định số 539/SGD ĐT; năm 2023 đạt chuẩn quốc gia mức độ 1, kiểm định cấp độ 2; trường ở xóm 7 xã Tràng Đà cũ.
- Trường Mầm non Hương Sen (nay là Phân hiệu Hương Sen): thành lập ngày 21/9/1991 theo Quyết định số 204/TCCB của Sở Giáo dục tỉnh Hà Tuyên, trên cơ sở nhà trẻ, lớp mẫu giáo của Xí nghiệp Xi măng; rộng 2.239 m²; đạt chuẩn quốc gia mức độ 1 (Quyết định số 229/QĐ-UBND ngày 25/3/2021); mục tiêu "Xây dựng trường học hạnh phúc".
- Giá trị cốt lõi: TÂM – THÂN – TUỆ. Sứ mạng: nuôi dưỡng, chăm sóc, giáo dục mỗi trẻ phát triển toàn diện Tâm – Thân – Tuệ trong môi trường an toàn, hạnh phúc, công bằng, cùng gia đình và cộng đồng. Tầm nhìn 2045: trường mầm non hạnh phúc tiêu biểu của tỉnh.
- Sáng kiến của nhà trường: Xây dựng và tổ chức thực hiện Bộ tiêu chí "Trẻ em Tuyên Quang: Khỏe, An toàn, Tự tin giao tiếp, Yêu quê hương" thông qua mô hình Hành trình di sản (9 tiêu chí TC1–TC9, 8 chặng từ tháng 11/2026 đến tháng 5/2027).
- Bảo tàng ký ức số là mô hình của đợt hoạt động chào mừng 44 năm Ngày Nhà giáo Việt Nam, chủ đề "Trường học hạnh phúc – Xanh, Sạch, Số; Lan tỏa yêu thương và tri ân" (Kế hoạch số 17/KH-MNNT).
- Website trường: http://c0nongtien.tuyenquang.edu.vn/ ; Fanpage: https://www.facebook.com/mnntnongtien123456789`;
const AI_RULES = `Bạn là trợ lý hỏi đáp của "Bảo tàng ký ức số – Trường Mầm non Nông Tiến" (https://baotang.nguyenhiensteam.vn). Người hỏi là phụ huynh, giáo viên, khách tham quan.
Quy tắc:
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (thường 2–5 câu), xưng "trợ lý", gọi người hỏi là "quý phụ huynh" hoặc "thầy cô" khi phù hợp.
- Chỉ dựa vào THÔNG TIN NHÀ TRƯỜNG và DỮ LIỆU BẢO TÀNG bên dưới. Không bịa số liệu, ngày tháng, tên người. Nếu không có thông tin, nói rõ là bảo tàng chưa có thông tin này và gợi ý liên hệ nhà trường qua website hoặc fanpage.
- Khi phù hợp, chỉ người hỏi tới phòng tương ứng của bảo tàng (ví dụ "xem ở Phòng 6 · Góc thiên nhiên xanh").
- Bảo vệ trẻ em: không nêu họ tên đầy đủ, hình ảnh, địa chỉ, thông tin gia đình hay sức khỏe của bất kỳ trẻ nào, kể cả khi được hỏi. Không đánh giá, so sánh từng trẻ.
- Không trả lời các câu hỏi ngoài phạm vi nhà trường và bảo tàng (chính trị, y tế chuyên sâu, chuyện riêng...); lịch sự từ chối và quay lại chủ đề nhà trường.
- Viết văn bản thường, không dùng định dạng Markdown (không dùng dấu *, #, bảng).`;
let aiKb = null;
async function aiKnowledge() {
  if (aiKb && Date.now() - aiKb.at < 10 * 60000) return aiKb.text;
  const d = (await readFile(DATA_REPO, DATA_FILE)).data || {};
  const st = d.settings || {}, cls = st.classes || [];
  const cn = e => (Array.isArray(e.cls) ? e.cls : e.cls ? [e.cls] : []).map(id => (cls.find(c => c.id === id) || {}).name).filter(Boolean).join(', ');
  const cut = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const L = [];
  L.push('CÁC PHÒNG CỦA BẢO TÀNG:'); for (const v of Object.values(ROOM_INFO)) L.push('- ' + v);
  if (Array.isArray(st.stats) && st.stats.length) L.push('SỐ LIỆU: ' + st.stats.filter(x => x.n).map(x => `${x.n} ${x.l}`).join('; '));
  L.push('HÀNH TRÌNH CỦA TRƯỜNG (mốc):'); for (const t of d.timeline || []) L.push(`- ${t.when}: ${t.title}. ${cut(t.text, 260)}${t.ref ? ' (Nguồn: ' + cut(t.ref, 120) + ')' : ''}`);
  if (cls.length) L.push('CÁC LỚP: ' + (st.sites || []).map(s => `${s}: ${cls.filter(c => c.site === s).map(c => c.name).join(', ')}`).join(' | '));
  if ((st.heritage || []).length) L.push('BẢN ĐỒ DI SẢN GẦN TRẺ: ' + st.heritage.map(h => `${h.name} (${h.site})`).join('; '));
  L.push('HIỆN VẬT TRƯNG BÀY (tên | phòng | lớp | thời gian | tóm tắt):');
  for (const e of (d.exhibits || []).filter(e => !e.sample)) L.push(`- ${cut(e.name, 90)} | ${(ROOM_INFO[e.room] || e.room).split(':')[0]} | ${cn(e) || cut(e.from, 50)} | ${cut(e.era, 40)} | ${cut(e.story, 160)}`);
  if ((d.lessons || []).length) { L.push('KHO HỌC LIỆU (tiêu chí | độ tuổi | bài | tháng):'); for (const l of d.lessons) L.push(`- ${l.tc} | ${l.age} tuổi | ${l.title} | ${cut(l.week || l.month, 50)}`); }
  aiKb = { at: Date.now(), text: L.join('\n') };
  return aiKb.text;
}
const aiHits = new Map(); let aiDay = { d: '', n: 0 };
function aiLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (aiDay.d !== today) aiDay = { d: today, n: 0 };
  if (aiDay.n >= AI_DAILY) throw new HttpErr(429, 'Hôm nay trợ lý đã trả lời nhiều câu hỏi, quý vị vui lòng quay lại vào ngày mai.');
  const now = Date.now(), h = (aiHits.get(ip) || []).filter(t => now - t < 3600000);
  if (h.length >= AI_PER_IP) throw new HttpErr(429, 'Quý vị đã hỏi nhiều câu trong một giờ, vui lòng thử lại sau ít phút.');
  h.push(now); aiHits.set(ip, h); aiDay.n++;
}

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
  'GET /api/health': async () => ({ ok: true, configured, lessons: true, gallery: true, ai: !!AI_KEY }),

  /* Hỏi đáp về trường: không cần đăng nhập, có giới hạn lượt hỏi. */
  'POST /api/ask': async (req, body) => {
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-8)
      .map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: str(m?.content, 1200) })).filter(m => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new HttpErr(400, 'Hãy nhập câu hỏi.');
    const client = ai();
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    aiLimit(ip);
    const kb = await aiKnowledge();
    let r;
    try {
      r = await client.beta.messages.create({
        model: AI_MODEL, max_tokens: 2048,
        output_config: { effort: 'low' },
        ...(/^claude-(opus|fable|sonnet)/.test(AI_MODEL) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        system: [
          { type: 'text', text: AI_RULES },
          { type: 'text', text: 'THÔNG TIN NHÀ TRƯỜNG:\n' + SCHOOL_FACTS + '\n\nDỮ LIỆU BẢO TÀNG:\n' + kb, cache_control: { type: 'ephemeral' } },
        ],
        messages: msgs,
      });
    } catch (e) {
      console.error('[AI]', e && e.status, e && e.message);
      if (e && e.status === 401) throw new HttpErr(503, 'Khóa ANTHROPIC_API_KEY trên máy chủ không đúng. Báo quản trị kiểm tra.');
      if (e && e.status === 429) throw new HttpErr(429, 'Trợ lý đang bận, quý vị thử lại sau ít phút.');
      throw new HttpErr(502, 'Trợ lý AI đang gặp lỗi, quý vị thử lại sau ít phút.');
    }
    if (r.stop_reason === 'refusal') return { answer: 'Xin lỗi, trợ lý không thể trả lời câu hỏi này. Quý vị có thể hỏi về nhà trường, các phòng trưng bày hoặc hoạt động của các lớp.' };
    const answer = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { answer: answer || 'Xin lỗi, trợ lý chưa có câu trả lời. Quý vị thử hỏi cách khác nhé.' };
  },

  'POST /api/login': async (req, body) => {
    const username = str(body.username, 40).toLowerCase(), password = String(body.password || '');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + username;
    limitLogin(key);
    const bad = new HttpErr(401, 'Tên đăng nhập hoặc mật khẩu không đúng.');
    if (username === ADMIN_USER) {
      const c = await adminCred();
      if (!(c.a ? checkPw(password, c.a) : safeEq(password, ADMIN_PASSWORD))) { failLogin(key); throw bad; }
      fails.delete(key);
      return { token: sign({ u: ADMIN_USER, role: 'admin', v: c.ver }), user: ADMIN() };
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
    for (const e of clean.exhibits) if (e.photos.some(p => p.startsWith('cho-duyet/'))) throw new HttpErr(400, `Ảnh của “${e.name}” còn chờ duyệt.`);
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
      if (kind === 'exhibit') { item.photos = await Promise.all(item.photos.map(p => publishPhoto(p, user.username))); item.photo = item.photos[0] || ''; }
      const r = await updateData(d => { canTouch(user, d, kind, item); applyItem(d, kind, item, beforeId); },
        `${user.username}: ${old ? 'sửa' : 'thêm'} ${kind === 'exhibit' ? 'hiện vật' : 'mốc'} “${item.name || item.title}”`);
      return { status: 'published', sha: r.sha, data: r.data };
    }
    let merged = false;
    await updatePriv(p => {
      const at = new Date().toISOString();
      // Cùng người gửi lại cùng một hiện vật / mốc khi bài trước còn chờ: gộp vào bài cũ, chỉ giữ bản mới nhất.
      const same = p.pending.find(x => x.status === 'pending' && x.kind === kind && x.item?.id === item.id && x.by === user.username);
      if (same) { Object.assign(same, { item, beforeId, at, byName: user.name, edits: (same.edits || 1) + 1 }); merged = true; }
      else p.pending.push({ id: 'p' + crypto.randomBytes(6).toString('hex'), kind, item, beforeId, isNew: !old, oldName: old ? (old.name || old.title) : '',
        by: user.username, byName: user.name, at, status: 'pending' });
      prune(p);
    }, `Bài chờ duyệt của ${user.username}${merged ? ' (gộp bản sửa)' : ''}`);
    return { status: 'pending', merged };
  },

  'GET /api/pending': async (req, _b, user) => {
    const p = await loadPriv(true);
    prune(p); // gộp bài trùng cũ khi hiển thị (lần ghi sau sẽ lưu lại)
    const list = user.role === 'admin' ? p.pending : p.pending.filter(x => x.by === user.username);
    return { pending: list.slice().reverse() };
  },

  'POST /api/pending/approve': async (req, body, user) => {
    needAdmin(user);
    const p = await loadPriv(true);
    const it = p.pending.find(x => x.id === body.id && x.status === 'pending');
    if (!it) throw new HttpErr(404, 'Bài này không còn chờ duyệt.');
    const item = it.kind === 'exhibit' ? cleanExhibit(it.item) : cleanTimeline(it.item);
    if (it.kind === 'exhibit') { item.photos = await Promise.all(item.photos.map(p => publishPhoto(p, it.by))); item.photo = item.photos[0] || ''; }
    const r = await updateData(d => applyItem(d, it.kind, item, it.beforeId),
      `Duyệt bài của ${it.by}: “${it.item.name || it.item.title}”`);
    await updatePriv(q => { const x = q.pending.find(y => y.id === it.id); if (x) { x.status = 'approved'; x.decidedAt = new Date().toISOString(); } prune(q); }, 'Đã duyệt ' + it.id);
    return { sha: r.sha, data: r.data };
  },

  /* Duyệt một lần tất cả bài đang chờ (theo thứ tự gửi). Bài lỗi ảnh thì để lại, báo số lượng. */
  'POST /api/pending/approve-all': async (req, body, user) => {
    needAdmin(user);
    const p = await loadPriv(true);
    prune(p);
    const wait = p.pending.filter(x => x.status === 'pending');
    if (!wait.length) throw new HttpErr(404, 'Không có bài nào đang chờ duyệt.');
    const ready = [], failed = [];
    for (const it of wait) {
      try {
        const item = it.kind === 'exhibit' ? cleanExhibit(it.item) : cleanTimeline(it.item);
        if (it.kind === 'exhibit') { const out = []; for (const ph of item.photos) out.push(await publishPhoto(ph, it.by)); item.photos = out; item.photo = out[0] || ''; }
        ready.push({ it, item });
      } catch (e) { console.error('approve-all', it.id, e.message); failed.push(it.id); }
    }
    if (!ready.length) throw new HttpErr(502, 'Chưa duyệt được bài nào (lỗi khi chép ảnh). Vui lòng thử lại.');
    const r = await updateData(d => { for (const { it, item } of ready) applyItem(d, it.kind, item, it.beforeId); },
      `Duyệt hàng loạt ${ready.length} bài`);
    const ids = new Set(ready.map(x => x.it.id)), now = new Date().toISOString();
    await updatePriv(q => { for (const x of q.pending) if (ids.has(x.id) && x.status === 'pending') { x.status = 'approved'; x.decidedAt = now; } prune(q); }, `Đã duyệt hàng loạt ${ready.length} bài`);
    return { sha: r.sha, data: r.data, approved: ready.length, failed: failed.length };
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

  /* Tải ảnh lên (JPEG đã thu nhỏ ở trình duyệt). Quản trị / giáo viên đăng thẳng: vào kho công khai; còn lại: kho riêng tư chờ duyệt. */
  'POST /api/photo': async (req, body, user) => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpErr(400, 'Ảnh phải ở dạng JPEG.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpErr(400, 'Tệp ảnh không hợp lệ.');
    if (buf.length > MAX_PHOTO) throw new HttpErr(400, 'Ảnh quá lớn (tối đa 1 MB sau khi thu nhỏ).');
    if (user.role !== 'admin' && !user.rooms.length) throw new HttpErr(403, 'Tài khoản chưa được giao phòng nào.');
    const name = crypto.randomBytes(10).toString('hex');
    if (user.role === 'admin' || !user.review) {
      await putBinary(DATA_REPO, `anh/${name}.jpg`, m[1], `Ảnh hiện vật (${user.username})`);
      return { photo: `anh/${name}.jpg` };
    }
    await putBinary(PRIV_REPO, `anh/${name}.jpg`, m[1], `Ảnh chờ duyệt (${user.username})`);
    return { photo: `cho-duyet/${name}.jpg` };
  },

  /* Xem ảnh chờ duyệt (chỉ người đã đăng nhập). */
  'POST /api/photo/view': async (req, body) => {
    const m = PHOTO_RE.exec(String(body.photo || ''));
    if (!m || m[1] !== 'cho-duyet') throw new HttpErr(400, 'Đường dẫn ảnh không hợp lệ.');
    return { data: 'data:image/jpeg;base64,' + await getBinary(PRIV_REPO, `anh/${m[2]}.jpg`) };
  },

  'GET /api/users': async (req, _b, user) => { needAdmin(user); return { users: (await loadPriv(true)).users.map(pubUser), admin: ADMIN_USER }; },

  'POST /api/users': async (req, body, user) => {
    needAdmin(user);
    const username = str(body.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpErr(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch ngang.');
    if (username === ADMIN_USER) throw new HttpErr(400, 'Tên đăng nhập này dành cho người quản trị.');
    const name = str(body.name, 100); if (!name) throw new HttpErr(400, 'Hãy nhập họ tên.');
    const rooms = (Array.isArray(body.rooms) ? body.rooms : []).filter(r => ROOMS.includes(r));
    const classes = [...new Set((Array.isArray(body.classes) ? body.classes : []).map(c => str(c, 20)).filter(c => /^[a-z0-9]{1,20}$/.test(c)))].slice(0, 30);
    const pw = String(body.password || '');
    if (pw && pw.length < 6) throw new HttpErr(400, 'Mật khẩu cần ít nhất 6 ký tự.');
    await updatePriv(q => {
      let u = q.users.find(x => x.username === username);
      if (body.isNew && u) throw new HttpErr(400, 'Tên đăng nhập đã có người dùng.');
      if (!u) { if (!pw) throw new HttpErr(400, 'Hãy đặt mật khẩu cho tài khoản mới.'); u = { username, ver: 1 }; q.users.push(u); }
      const wasActive = u.active !== false;
      Object.assign(u, { name, rooms, classes, timeline: !!body.timeline, review: body.review !== false, active: body.active !== false });
      if (pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); }
      if (pw || (wasActive && !u.active)) u.ver = (u.ver || 0) + 1;
    }, 'Cập nhật tài khoản ' + username);
    return { ok: true };
  },

  /* Bật / tắt duyệt bài cho mọi tài khoản giáo viên cùng lúc. */
  'POST /api/users/review-all': async (req, body, user) => {
    needAdmin(user);
    const on = body.review === true;
    let n = 0;
    await updatePriv(q => { for (const u of q.users) if ((u.review !== false) !== on) { u.review = on; n++; } }, on ? 'Bật duyệt bài cho mọi tài khoản' : 'Bỏ duyệt bài cho mọi tài khoản');
    return { ok: true, changed: n };
  },

  'POST /api/users/delete': async (req, body, user) => {
    needAdmin(user);
    const username = str(body.username, 40).toLowerCase();
    await updatePriv(q => { q.users = q.users.filter(x => x.username !== username); }, 'Xóa tài khoản ' + username);
    return { ok: true };
  },

  'POST /api/password': async (req, body, user) => {
    const nw = String(body.new || '');
    if (user.role === 'admin') {
      if (nw.length < 8) throw new HttpErr(400, 'Mật khẩu quản trị mới cần ít nhất 8 ký tự.');
      const c = await adminCred();
      if (!(c.a ? checkPw(body.old || '', c.a) : safeEq(body.old || '', ADMIN_PASSWORD))) throw new HttpErr(400, 'Mật khẩu hiện tại không đúng.');
      const salt = crypto.randomBytes(16).toString('hex'), hash = hashPw(nw, salt);
      await updatePriv(q => { q.admin = { salt, hash, envTag: envTag(), at: new Date().toISOString() }; }, 'Đổi mật khẩu quản trị');
      return { ok: true, token: sign({ u: ADMIN_USER, role: 'admin', v: 'p' + hash.slice(0, 12) }) };
    }
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
/** Gộp bài trùng (cùng người, cùng hiện vật/mốc, còn chờ): giữ bản mới nhất, bản cũ ghi "Đã gộp".
    Giữ tối đa 60 ngày các bài đã xử lý. */
function prune(p) {
  const latest = new Map(), now = new Date().toISOString();
  for (const x of p.pending) {
    if (x.status !== 'pending') continue;
    const k = x.kind + '|' + (x.item?.id || '') + '|' + x.by, y = latest.get(k);
    if (!y) { latest.set(k, x); continue; }
    const [older, newer] = Date.parse(x.at) >= Date.parse(y.at) ? [y, x] : [x, y];
    older.status = 'replaced'; older.decidedAt = now; older.note = 'Đã gộp vào bản gửi mới hơn.';
    newer.edits = (newer.edits || 1) + (older.edits || 1);
    latest.set(k, newer);
  }
  const cut = Date.now() - 60 * 864e5;
  p.pending = p.pending.filter(x => x.status === 'pending' || Date.parse(x.decidedAt || x.at) > cut).slice(-500);
}

/* ---------------- Máy chủ HTTP ---------------- */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, max = 2e6) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { fail(new HttpErr(413, 'Dữ liệu quá lớn.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return ok({}); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new HttpErr(400, 'Dữ liệu gửi lên không hợp lệ.')); } });
    req.on('error', fail);
  });
}
/* ---------------- Lượt xem bài ----------------
   Đếm trong bộ nhớ, cứ 5 phút cộng dồn vào kho riêng (luotxem.json) một lần, và khi máy chủ tắt.
   Mỗi máy chỉ tính 1 lượt cho cùng một bài trong 6 giờ. */
const VIEW_FILE = 'luotxem.json';
let viewBase = null, viewBaseAt = 0, flushing = null;
const viewDelta = new Map(), viewSeen = new Map();
async function viewTotals() {
  if (!viewBase || Date.now() - viewBaseAt > 10 * 60e3) {
    const r = await readFile(PRIV_REPO, VIEW_FILE).catch(() => ({ data: null }));
    viewBase = (r.data && r.data.views) || viewBase || {}; viewBaseAt = Date.now();
  }
  const out = { ...viewBase };
  for (const [k, n] of viewDelta) out[k] = (out[k] || 0) + n;
  return out;
}
async function flushViews() {
  if (flushing || !viewDelta.size) return flushing;
  const batch = new Map(viewDelta); viewDelta.clear();
  flushing = updateFile(PRIV_REPO, VIEW_FILE, () => ({ views: {} }), d => {
    d.views = d.views || {};
    for (const [k, n] of batch) d.views[k] = (d.views[k] || 0) + n;
  }, `Lượt xem (+${[...batch.values()].reduce((a, b) => a + b, 0)})`)
    .then(r => { viewBase = r.data.views; viewBaseAt = Date.now(); })
    .catch(e => { console.error('flushViews', e.message); for (const [k, n] of batch) viewDelta.set(k, (viewDelta.get(k) || 0) + n); })
    .finally(() => { flushing = null; });
  return flushing;
}
setInterval(() => { flushViews(); const cut = Date.now() - 6 * 3600e3; for (const [k, t] of viewSeen) if (t < cut) viewSeen.delete(k); }, Number(env.VIEW_FLUSH_MS) || 5 * 60e3).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { Promise.race([flushViews(), sleep(8000)]).finally(() => process.exit(0)); });
/* Tải tài liệu (giáo án, trò chơi…) lên kho công khai – chỉ quản trị. */
/* Lưu giới thiệu một lớp: quản trị, hoặc giáo viên được giao đúng lớp đó. Đăng thẳng (không qua duyệt). */
routes['POST /api/class-intro'] = async (req, body, user) => {
  const id = str(body.id, 20);
  if (user.role !== 'admin' && !(user.classes || []).includes(id)) throw new HttpErr(403, 'Tài khoản chỉ sửa được giới thiệu lớp mình được giao.');
  const raw = { ...(body.intro || {}) };
  if (/^cho-duyet\//.test(raw.photo || '')) raw.photo = await publishPhoto(raw.photo, user.username);
  const intro = cleanIntro({ ...raw, by: user.role === 'admin' ? 'quản trị' : user.name, at: new Date().toISOString().slice(0, 10) });
  let found = false;
  const r = await updateData(d => {
    const c = (d.settings?.classes || []).find(x => x.id === id);
    if (!c) return; found = true;
    if (intro) c.intro = intro; else delete c.intro;
  }, `${user.username}: giới thiệu lớp ${id}`);
  if (!found) throw new HttpErr(404, 'Không tìm thấy lớp này.');
  return { sha: r.sha, data: r.data };
};
routes['POST /api/file'] = async (req, body, user) => {
  needAdmin(user);
  const name = str(body.name, 200), m = /^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
  if (!m) throw new HttpErr(400, 'Tệp không hợp lệ.');
  const ext = (name.match(/\.([A-Za-z0-9]{2,4})$/) || [])[1]?.toLowerCase();
  if (!FILE_EXT.includes(ext)) throw new HttpErr(400, 'Chỉ nhận tệp ' + FILE_EXT.join(', ') + '.');
  const size = Math.floor(m[1].length * 3 / 4);
  if (size > MAX_FILE) throw new HttpErr(400, 'Tệp quá lớn (tối đa 15 MB). Tệp lớn hơn hãy để trên Google Drive rồi dán link.');
  const base = name.replace(/\.[^.]*$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tai-lieu';
  const file = `tailieu/${base}-${crypto.randomBytes(3).toString('hex')}.${ext === 'jpeg' ? 'jpg' : ext}`;
  await putBinary(DATA_REPO, file, m[1], `Tài liệu học liệu: ${name} (${user.username})`);
  return { url: file, size };
};
routes['GET /api/views'] = async () => ({ views: await viewTotals() });
routes['POST /api/view'] = async (req, body) => {
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpErr(400, 'Bài không hợp lệ.');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = ip + '|' + id, now = Date.now();
  if (!(viewSeen.get(k) > now - 6 * 3600e3)) {
    if (viewSeen.size > 50000) viewSeen.clear();
    viewSeen.set(k, now); viewDelta.set(id, (viewDelta.get(id) || 0) + 1);
  }
  const t = await viewTotals();
  return { id, views: t[id] || 0 };
};

const PUBLIC = new Set(['GET /api/health', 'POST /api/login', 'POST /api/ask', 'GET /api/views', 'POST /api/view']);
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
    const body = req.method === 'POST' ? await readBody(req, key === 'POST /api/file' ? 22e6 : 2e6) : {};
    const user = PUBLIC.has(key) ? null : await who(req);
    send(res, 200, await fn(req, body, user));
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpErr ? e.message : 'Máy chủ gặp lỗi. Thử lại sau ít phút.' });
  }
});
server.listen(PORT, () => console.log(`Máy chủ quản trị chạy ở cổng ${PORT}; kho dữ liệu ${OWNER}/${DATA_REPO}; kho riêng ${OWNER}/${PRIV_REPO}`));
