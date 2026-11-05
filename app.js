// La tienda de Macarena: app independiente con datos compartidos en Firebase.
// Dos usuarios: Macarena (solo vende) y Papás (todo: dulces, cierres, historial, ajustes).
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, connectAuthEmulator,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  query, orderBy, writeBatch, increment, getDocs, setDoc, connectFirestoreEmulator
} from './vendor/firebase.js';
import { firebaseConfig, USERS } from './firebase-config.js';

// Una "app" de Firebase por usuario: así las dos sesiones quedan guardadas en el celular
// y se puede cambiar de usuario desde la pantalla de inicio sin escribir la contraseña otra vez.
const EMU = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && new URLSearchParams(location.search).has('emu');
const ROLES = ['kid', 'parent'];
const apps = {}, auths = {}, dbs = {};
ROLES.forEach(r => {
  apps[r] = initializeApp(firebaseConfig, 'tienda-' + r);
  auths[r] = getAuth(apps[r]);
  if (EMU) connectAuthEmulator(auths[r], 'http://127.0.0.1:9099', { disableWarnings: true });
});
function dbFor(r) {
  if (!dbs[r]) {
    try { dbs[r] = initializeFirestore(apps[r], { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
    catch (e) { dbs[r] = initializeFirestore(apps[r], {}); }
    if (EMU) connectFirestoreEmulator(dbs[r], '127.0.0.1', 8080);
  }
  return dbs[r];
}
let db = null;

const OLD_KEY = 'tiendaMacarena.v1';
const SOUND_KEY = 'tiendaMacarena.sound';
const COLORS = ['#ffb3c7','#ffd59e','#fff09a','#bff0b5','#a8e6e1','#b9d4ff','#d7c2ff','#ffc6a8','#f5b5f0','#c9e7a0'];
const EMOJIS = ['🍭','🍬','🍫','🍪','🧁','🍩','🍡','🍦','🍧','🍰','🥤','🧃','🍿','🍓','🍒','🍋','🍉','🍌','🥨','🧇','🍯','⭐','🎈','🐻'];
const DENOMS = [100000,50000,20000,10000,5000,2000,1000,500,200,100,50];
const SAMPLE = [
  ['Chupeta','🍭',500],['Bombón','🍬',300],['Chocolatina','🍫',1000],['Galleta','🍪',800],['Gomitas','🐻',500],
  ['Masmelo','🍡',300],['Chicle','🫧',200],['Caramelo','🍬',100],['Paleta de agua','🍧',1000],['Ponqué','🧁',1500],
  ['Rosquilla','🍩',1200],['Bon bon bum','🍭',600],['Barrilete','🍓',200],['Mani','🥜',700],['Crispetas','🍿',1000],
  ['Jugo cajita','🧃',1500],['Gaseosa mini','🥤',1500],['Cocadas','🥥',800],['Bocadillo','🍯',500],['Helado','🍦',2000]
];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

// ---------- estado ----------
// S se llena desde Firebase. role: 'kid' | 'parent' | null
const S = { items: [], sales: [], turn: null, closings: [], debts: [], loaded: { items: false, sales: false, turn: false } };
let role = null, user = null, unsubs = [];
let sound = true;
try { sound = localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) {}

const fmt = n => '$' + Math.round(n).toLocaleString('es-CO');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Foto o dibujo del dulce
const pic = i => i && i.photo && /^data:image\/(jpeg|png|webp);base64,/.test(i.photo) ? `<img class="ph" src="${i.photo}" alt="">` : esc(i ? i.emoji : '🍬');
// Achica la foto a un cuadrado de 240 px (unos 20 KB) para que cargue rápido y quepa en Firebase.
function shrinkPhoto(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => { const S2 = 240, c = document.createElement('canvas'); c.width = c.height = S2;
      const m = Math.min(im.naturalWidth, im.naturalHeight), x = (im.naturalWidth - m) / 2, y = (im.naturalHeight - m) / 2;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, S2, S2); g.drawImage(im, x, y, m, m, 0, 0, S2, S2);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', .72)); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
    im.src = url;
  });
}
// Achica la foto del comprobante (máx. 1280 px, JPEG) para que quepa en Firebase (límite 1 MB por documento).
// Se baja la calidad hasta que pese menos de ~450 KB; casi siempre queda en 100-250 KB.
function shrinkReceipt(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const tries = [[1280, .62], [1100, .55], [950, .5], [800, .45], [700, .4]];
      let out = '';
      for (const [max, q] of tries) {
        const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', q);
        if (out.length < 450000) break;
      }
      out.startsWith('data:image/jpeg;base64,') && out.length < 900000 ? res(out) : rej(new Error('big'));
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
    im.src = url;
  });
}

// ---------- plata colombiana (para la calculadora de vueltas) ----------
// Colores aproximados de los billetes y monedas, para que Macarena los reconozca.
const MONEY = [
  { v: 100000, bill: true, c: '#a9dba0', label: 'Cien mil' },
  { v: 50000, bill: true, c: '#e0b0e0', label: 'Cincuenta mil' },
  { v: 20000, bill: true, c: '#a9c6f0', label: 'Veinte mil' },
  { v: 10000, bill: true, c: '#f2a49a', label: 'Diez mil' },
  { v: 5000, bill: true, c: '#d8b48c', label: 'Cinco mil' },
  { v: 2000, bill: true, c: '#f5c08a', label: 'Dos mil' },
  { v: 1000, c: '#e9c85b', ring: '#cfd3d8', label: 'Mil' },
  { v: 500, c: '#cfd3d8', ring: '#e9c85b', label: 'Quinientos' },
  { v: 200, c: '#d4d7dc', label: 'Doscientos' },
  { v: 100, c: '#e6c35a', label: 'Cien' },
  { v: 50, c: '#dcdfe3', label: 'Cincuenta' }
];
const short = v => v >= 1000 ? (v / 1000).toLocaleString('es-CO') + ' mil' : String(v);
function moneyPic(m, small) {
  return m.bill
    ? `<span class="bill${small ? ' sm' : ''}" style="--c:${m.c}"><b class="num">${fmt(m.v)}</b></span>`
    : `<span class="coin${small ? ' sm' : ''}" style="--c:${m.c};--r:${m.ring || 'rgba(0,0,0,.18)'}"><b class="num">${m.v >= 1000 ? short(m.v) : m.v}</b></span>`;
}
// El vuelto en billetes y monedas, de los más grandes a los más pequeños.
function changeParts(amount) {
  const parts = []; let left = amount;
  MONEY.forEach(m => { while (left >= m.v) { parts.push(m); left -= m.v; } });
  return { parts, left };
}
const itemById = id => S.items.find(i => i.id === id);
const total = sales => sales.reduce((a, s) => a + s.price, 0);
const dt = t => new Date(t).toLocaleString('es-CO', { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });
const hr = t => new Date(t).toLocaleTimeString('es-CO', { hour:'numeric', minute:'2-digit' });
const num = v => Math.max(0, Math.round(Number(String(v).replace(/[^\d]/g, '')) || 0));

let mode = 'kid', tab = 'hoy', editing = null, confirmKey = null, counted = '', den = {}, note = '', inv = {};
let loginWho = null, loginErr = '', loginBusy = false, fatal = '';
const app = document.getElementById('app');

// ---------- escritura ----------
const itemsCol = () => collection(db, 'items');
const salesCol = () => collection(db, 'sales');
const closingsCol = () => collection(db, 'closings');
const turnDoc = () => doc(db, 'meta', 'turn');
const debtsCol = () => collection(db, 'debts');
const receiptDoc = id => doc(db, 'receipts', id);

function commit(batch, okMsg) {
  batch.commit().then(() => { if (okMsg) toast(okMsg); })
    .catch(err => { console.error(err); toast(err && err.code === 'permission-denied' ? 'No tienes permiso para eso' : 'No se pudo guardar. Revisa el internet.'); });
}
// Firebase permite máximo 500 operaciones por lote: las partimos en lotes de 400.
async function runOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(fn => fn(b));
    await b.commit();
  }
}
function sampleOps() {
  return SAMPLE.map((s, i) => b => b.set(doc(itemsCol()), {
    name: s[0], emoji: s[1], price: s[2], color: COLORS[i % COLORS.length], stock: 20, active: true, example: true, order: i
  }));
}

// ---------- sonido ----------
let ac;
function ding() {
  if (!sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle';
    o.frequency.setValueAtTime(880, ac.currentTime); o.frequency.exponentialRampToValueAtTime(1320, ac.currentTime + .12);
    g.gain.setValueAtTime(.18, ac.currentTime); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + .25);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + .26);
  } catch (e) {}
}

// ---------- aviso ----------
let tt;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 1800);
}

// ---------- sesión ----------
function roleOf(u) {
  const e = (u && u.email || '').toLowerCase();
  if (e === USERS.parent.email) return 'parent';
  if (e === USERS.kid.email) return 'kid';
  return null;
}

// screen: 'boot' | 'home' | 'login' | 'offer' | 'unlock' | 'app'
let screen = 'boot', pendingRole = null;
const sessions = { kid: null, parent: null }, authReady = { kid: false, parent: false };
const LAST_KEY = 'tiendaMacarena.last', LOCK_KEY = 'tiendaMacarena.lock.';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };

ROLES.forEach(r => onAuthStateChanged(auths[r], u => {
  // Solo se acepta la sesión si el correo corresponde a ese usuario.
  sessions[r] = u && roleOf(u) === r ? u : null;
  if (u && !sessions[r]) signOut(auths[r]);
  const first = !authReady[r]; authReady[r] = true;
  if (!u && role === r) deactivate();
  if (first && authReady.kid && authReady.parent) boot();
  else if (screen !== 'app') render();
}));

function boot() {
  const last = lsGet(LAST_KEY);
  if (last && sessions[last]) {
    if (lockOf(last)) { pendingRole = last; screen = 'unlock'; render(); }
    else activate(last);
  } else { screen = 'home'; render(); }
}

function stopListening() {
  unsubs.forEach(f => f()); unsubs = [];
  S.items = []; S.sales = []; S.turn = null; S.closings = []; S.loaded = { items: false, sales: false, turn: false };
}
function activate(r) {
  stopListening();
  role = r; user = sessions[r]; db = dbFor(r); fatal = '';
  mode = r === 'parent' ? 'parent' : 'kid'; tab = 'hoy'; editing = null; confirmKey = null;
  counted = ''; den = {}; note = ''; inv = {};
  lsSet(LAST_KEY, r); screen = 'app'; loadCart();
  listen(); render(); scrollTo(0, 0);
}
function deactivate() {
  stopListening(); role = null; user = null; db = null; screen = 'home'; render(); scrollTo(0, 0);
}
// Ir a la pantalla de inicio. Si los papás no tienen desbloqueo, se cierra su sesión
// para que Macarena no pueda entrar a su modo sin la contraseña.
function goHome() {
  if (role === 'parent' && !lockOf('parent')) { const a = auths.parent; deactivate(); signOut(a); return; }
  deactivate();
}
async function logoutRole(r) {
  lsSet(LOCK_KEY + r, null);
  if (role === r) deactivate();
  await signOut(auths[r]);
  render();
}

// ---------- Face ID / huella / bloqueo del celular (WebAuthn) ----------
// Es un candado local: el celular confirma que eres tú antes de abrir la sesión guardada.
const lockOf = r => lsGet(LOCK_KEY + r);
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
async function lockAvailable() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch (e) { return false; }
}
async function createLock(r) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rand(32),
    rp: { name: 'Tienda de Macarena' },
    user: { id: rand(16), name: USERS[r].email, displayName: r === 'kid' ? 'Macarena' : 'Papás' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000, attestation: 'none'
  } });
  lsSet(LOCK_KEY + r, b64(cred.rawId));
}
async function checkLock(r) {
  const id = lockOf(r); if (!id) return true;
  try {
    await navigator.credentials.get({ publicKey: {
      challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(id), transports: ['internal'] }],
      userVerification: 'required', timeout: 60000
    } });
    return true;
  } catch (e) { console.warn(e); return false; }
}
async function enter(r) {
  if (!sessions[r]) { loginWho = r; loginErr = ''; screen = 'login'; render(); return; }
  if (lockOf(r) && !(await checkLock(r))) { toast('No se pudo confirmar. Intenta de nuevo.'); return; }
  if (role === r && screen === 'unlock') { screen = 'app'; render(); return; }
  activate(r);
}
// Volver a pedir Face ID si la app estuvo en segundo plano más de 2 minutos.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (screen === 'app' && role && lockOf(role) && Date.now() - hiddenAt > 120000) { pendingRole = role; screen = 'unlock'; render(); }
});

function onErr(err) {
  console.error(err);
  fatal = err && err.code === 'permission-denied'
    ? 'Este usuario no tiene permiso para ver la tienda. Revisa las reglas de seguridad en Firebase.'
    : 'No se pudieron cargar los datos. Revisa el internet.';
  render();
}

function listen() {
  unsubs.push(onSnapshot(query(itemsCol(), orderBy('order')), snap => {
    S.items = snap.docs.map(d => ({ id: d.id, ...d.data() })); S.loaded.items = true; refresh();
  }, onErr));
  unsubs.push(onSnapshot(query(salesCol(), orderBy('t')), snap => {
    S.sales = snap.docs.map(d => ({ id: d.id, ...d.data() })); S.loaded.sales = true; refresh();
  }, onErr));
  unsubs.push(onSnapshot(query(debtsCol(), orderBy('t')), snap => {
    S.debts = snap.docs.map(d => ({ id: d.id, ...d.data() })); refresh();
  }, onErr));
  unsubs.push(onSnapshot(turnDoc(), snap => {
    S.turn = snap.exists() ? snap.data() : null; S.loaded.turn = true;
    // Primera vez: los papás crean el turno y los dulces de ejemplo.
    if (!snap.exists() && role === 'parent' && !snap.metadata.fromCache) initStore();
    refresh();
  }, onErr));
  if (role === 'parent') {
    unsubs.push(onSnapshot(query(closingsCol(), orderBy('end')), snap => {
      S.closings = snap.docs.map(d => ({ id: d.id, ...d.data() })); refresh();
    }, onErr));
  }
}

let initing = false;
async function initStore() {
  if (initing) return; initing = true;
  try {
    const existing = await getDocs(itemsCol());
    const ops = [b => b.set(turnDoc(), { start: Date.now(), base: 0 })];
    if (existing.empty) ops.push(...sampleOps());
    await runOps(ops);
  } catch (e) { console.error(e); } finally { initing = false; }
}

const turn = () => S.turn || { start: Date.now(), base: 0 };
const ready = () => S.loaded.items && S.loaded.sales && S.loaded.turn;

// ---------- INICIO / LOGIN ----------
const WHO = { kid: { icon: '👧', name: 'Soy Macarena', sub: 'Para vender en la tienda' }, parent: { icon: '👪', name: 'Somos los papás', sub: 'Productos, precios, cierres e historial' } };
function renderHome() {
  app.innerHTML = `
  <div class="login">
    <div class="logo">🍭</div>
    <h1>La tienda de Macarena</h1>
    <p class="muted">¿Quién va a usar la tienda?</p>
    ${ROLES.map(r => { const w = WHO[r], saved = !!sessions[r], lk = !!lockOf(r);
      return `<button class="who" data-who="${r}"><span>${w.icon}</span><b>${w.name}</b>
        <small>${saved ? (lk ? '🔓 Entrar con Face ID o huella' : '✓ Sesión guardada · Entrar') : w.sub}</small></button>`; }).join('')}
    ${ROLES.some(r => sessions[r]) ? `<details class="more"><summary class="muted">Cerrar sesiones guardadas</summary>
      ${ROLES.filter(r => sessions[r]).map(r => `<button class="btn ghost" data-logout="${r}">Cerrar sesión de ${r === 'kid' ? 'Macarena' : 'los papás'}</button>`).join('')}
    </details>` : ''}
  </div>`;
}
function renderLogin() {
  const w = USERS[loginWho];
  app.innerHTML = `
  <form class="login" id="loginform">
    <div class="logo">${WHO[loginWho].icon}</div>
    <h1>${loginWho === 'kid' ? 'Entrar como Macarena' : 'Entrar como papás'}</h1>
    <p class="muted">Escribe la contraseña de <b>${esc(w.email)}</b>. Queda guardada en este celular.</p>
    <div class="field"><label class="lbl" for="pw">Contraseña</label>
      <input id="pw" type="password" autocomplete="current-password" required></div>
    ${loginErr ? `<p class="err">${esc(loginErr)}</p>` : ''}
    <button class="btn big" type="submit" ${loginBusy ? 'disabled' : ''}>${loginBusy ? 'Entrando…' : 'Entrar'}</button>
    <button class="btn ghost big" type="button" id="backhome">Volver al inicio</button>
  </form>`;
  setTimeout(() => document.getElementById('pw')?.focus(), 50);
}
function renderOffer() {
  app.innerHTML = `
  <div class="login">
    <div class="logo">🔐</div>
    <h1>¿Entrar con Face ID o huella?</h1>
    <p class="muted">La próxima vez que elijas ${pendingRole === 'kid' ? '<b>Macarena</b>' : '<b>los papás</b>'} en el inicio, el celular te pedirá Face ID, la huella o su clave de bloqueo en vez de la contraseña.</p>
    ${pendingRole === 'parent' ? '<p class="muted">Recomendado: así Macarena no puede entrar al modo papás desde el inicio.</p>' : ''}
    <button class="btn big" id="lockyes">Sí, activar</button>
    <button class="btn ghost big" id="lockno">Ahora no</button>
  </div>`;
}
function renderUnlock() {
  app.innerHTML = `
  <div class="login">
    <div class="logo">🔒</div>
    <h1>${pendingRole === 'kid' ? 'Tienda de Macarena' : 'Modo papás'}</h1>
    <p class="muted">Desbloquea con Face ID, la huella o la clave del celular.</p>
    <button class="btn big" id="unlock">Desbloquear</button>
    <button class="btn ghost big" id="unlockhome">Ir al inicio</button>
  </div>`;
}
app.addEventListener('submit', async e => {
  if (e.target.id !== 'loginform') return;
  e.preventDefault();
  const r = loginWho, pw = document.getElementById('pw').value;
  loginBusy = true; loginErr = ''; renderLogin();
  try {
    const cred = await signInWithEmailAndPassword(auths[r], USERS[r].email, pw);
    sessions[r] = cred.user; loginBusy = false; loginWho = null;
    if (!lockOf(r) && await lockAvailable()) { pendingRole = r; screen = 'offer'; render(); }
    else activate(r);
    return;
  } catch (err) {
    const c = err && err.code || '';
    loginErr = c.includes('network') ? 'No hay internet. Conéctate e intenta de nuevo.'
      : c.includes('too-many') ? 'Demasiados intentos. Espera un rato e intenta de nuevo.'
      : 'Contraseña incorrecta.';
  }
  loginBusy = false; renderLogin();
});

// ---------- MODO MACARENA ----------
// Cada cliente es una "venta": Macarena toca los dulces, ve el total de esa venta y toca "Cobrar".
let cart = [];
const CART_KEY = () => 'tiendaMacarena.cesta.' + role;
function loadCart() { try { cart = JSON.parse(lsGet(CART_KEY()) || '[]'); } catch (e) { cart = []; } }
function saveCart() { lsSet(CART_KEY(), cart.length ? JSON.stringify(cart) : null); }
const inCart = id => cart.filter(x => x === id).length;
const cartItems = () => cart.map(itemById).filter(Boolean);
// Promo por cantidad: "2 por $800". Cada grupo completo se cobra al precio de promo; lo que sobra, a precio normal.
const hasPromo = i => i && Number.isInteger(i.promoQty) && i.promoQty >= 2 && i.promoPrice > 0;
const promoTxt = i => `${i.promoQty} por ${fmt(i.promoPrice)}`;
function priceLines(ci) {
  const seen = new Map();
  ci.forEach(i => seen.set(i.id, (seen.get(i.id) || 0) + 1));
  const done = new Map();
  return ci.map(i => {
    const k = done.get(i.id) || 0; done.set(i.id, k + 1);
    if (!hasPromo(i)) return { it: i, price: i.price, promo: false };
    const q = i.promoQty, inPromo = Math.floor(seen.get(i.id) / q) * q;
    if (k >= inPromo) return { it: i, price: i.price, promo: false };
    const base = Math.floor(i.promoPrice / q), extra = i.promoPrice - base * q;
    return { it: i, price: base + ((k % q) < extra ? 1 : 0), promo: true };
  });
}
const cartTotal = () => priceLines(cartItems()).reduce((a, l) => a + l.price, 0);
const cartFull = () => cartItems().reduce((a, i) => a + i.price, 0);
// Agrupa las ventas del turno por cliente (ticket). Las ventas viejas sin ticket cuentan solas.
function tickets(sales) {
  const m = new Map();
  sales.forEach(s => { const k = s.ticket || s.id; const g = m.get(k) || { id: k, t: s.t, by: s.by, sales: [] }; g.sales.push(s); m.set(k, g); });
  return [...m.values()].sort((a, b) => a.t - b.t);
}
function renderKid() {
  const items = S.items.filter(i => i.active);
  const nT = tickets(S.sales).length;
  const ci = cartItems();
  app.innerHTML = `
  <div class="kidtop">
    <h1 id="kidtitle">La tienda de Macarena</h1>
    <div class="row" style="flex-wrap:nowrap">${role === 'parent' ? '<button class="btn ghost" id="toparent">Modo papás</button>' : ''}<button class="lockbtn" id="home" aria-label="Inicio: cambiar de usuario">🏠</button></div>
  </div>
  <div class="today"><span>☀️ Hoy vendiste</span><b class="num">${fmt(total(S.sales))}</b><small>${nT} ${nT === 1 ? 'venta' : 'ventas'}</small>${debtsOpen().length ? `<button class="fiadosbtn" id="kidfiados">📝 Fiados (${debtsOpen().length})</button>` : ''}</div>
  <div class="grid kidgrid">${items.map(i => {
    // Siempre se puede vender: el inventario es solo una guía (si dice 0 pero hay en físico, igual se vende).
    const c = inCart(i.id), left = i.stock - c, low = left > 0 && left <= 3;
    return `<button class="candy${c ? ' picked' : ''}" data-sell="${i.id}" style="--c:${esc(i.color)}" aria-label="Agregar ${esc(i.name)} de ${fmt(i.price)}">
      ${c ? `<span class="cnt num">${c}</span>` : ''}
      ${low ? `<span class="low">Quedan ${left}</span>` : ''}
      <span class="em">${pic(i)}</span><span class="nm">${esc(i.name)}</span><span class="pr num">${fmt(i.price)}</span>${hasPromo(i) ? `<span class="promo num">🎉 ${promoTxt(i)}</span>` : ''}</button>`; }).join('')}
    ${items.length ? '' : '<p class="muted">No hay productos todavía. Los papás los agregan desde su celular.</p>'}
  </div>
  <div class="bar cart"><div class="bar-in">
    ${ci.length ? `
      <div class="cart-head"><b>🛒 Venta ${nT + 1}</b><span class="muted">Toca uno de aquí para quitarlo</span></div>
      <div class="chips">${ci.map((i, n) => `<button class="chip" data-unpick="${n}" style="--c:${esc(i.color)}" aria-label="Quitar ${esc(i.name)}">${pic(i)}<small>✕</small></button>`).join('')}</div>
      <div class="cart-foot">
        <button class="clearcart" id="clearcart" aria-label="Borrar esta venta">🗑️</button>
        <div class="money"><small>Total</small><b class="num">${fmt(cartTotal())}</b>${cartFull() > cartTotal() ? `<span class="disc num">🎉 ¡Descuento! −${fmt(cartFull() - cartTotal())}</span>` : ''}</div>
        <button class="pay" id="pay">✅ Cobrar</button>
      </div>`
    : `<div class="cart-empty">🛒 <span>Toca lo que te compran</span></div>`}
  </div></div>`;
}
function pick(id, el) {
  const it = itemById(id); if (!it) return;
  const r = el.getBoundingClientRect();
  cart.push(id); saveCart(); ding(); renderKid();
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = '+' + fmt(it.price);
  f.style.left = (r.left + r.width / 2 - 50) + 'px'; f.style.top = (r.top + 10) + 'px'; document.body.appendChild(f); setTimeout(() => f.remove(), 900);
  const nb = app.querySelector(`[data-sell="${id}"]`); if (nb) nb.classList.add('pop');
}
function unpick(n) { cart.splice(n, 1); saveCart(); renderKid(); }
// Al cobrar, Macarena elige cómo le pagaron: billetes (efectivo) o transferencia.
function askPay() {
  if (!cartItems().length) { cart = []; saveCart(); renderKid(); return; }
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'askpay';
  o.innerHTML = `<div class="pinbox paybox" role="dialog" aria-label="Cómo te pagaron"><h2>¿Cómo te pagaron?</h2>
    <b class="num paytotal">${fmt(cartTotal())}</b>
    <button class="paybtn cash" data-paywith="cash"><span>💵</span>Billetes o monedas</button>
    <button class="paybtn transfer" data-paywith="transfer"><span>📱</span>Transferencia</button>
    <button class="paybtn credit" data-paywith="credit"><span>📝</span>Fiado (paga después)</button>
    <button class="btn ghost big" data-paywith="">Volver</button></div>`;
  o.addEventListener('click', e => {
    if (e.target === o) { o.remove(); return; }
    const b = e.target.closest('[data-paywith]'); if (!b) return;
    o.remove();
    const w = b.dataset.paywith;
    if (w === 'credit') askWho();
    else if (w === 'cash') askChange(cartTotal(), r => pay('cash', null, null, r));
    else if (w === 'transfer') askReceipt(cartTotal(), img => pay('transfer', null, img));
  });
  document.body.appendChild(o);
}
// Fiado: preguntar quién queda debiendo (la Nana lo escribe, o toca un nombre que ya fió antes).
function askWho() {
  const names = [...new Set(S.debts.slice().reverse().map(d => d.name))].slice(0, 8);
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'askwho';
  o.innerHTML = `<div class="pinbox paybox" role="dialog" aria-label="Quién queda debiendo"><h2>📝 ¿Quién queda debiendo?</h2>
    <b class="num paytotal">${fmt(cartTotal())}</b>
    ${names.length ? `<div class="whochips">${names.map(n => `<button class="btn ghost" data-who-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
    <input id="whoname" maxlength="30" placeholder="Nombre" autocomplete="off">
    <button class="paybtn credit" id="whook"><span>📝</span>Anotar fiado</button>
    <button class="btn ghost big" id="whoback">Volver</button></div>`;
  const go = n => { n = (n || '').trim().slice(0, 30); if (!n) { toast('Escribe el nombre'); return; } o.remove(); pay('credit', n); };
  o.addEventListener('click', e => {
    if (e.target === o || e.target.closest('#whoback')) { o.remove(); return; }
    const c = e.target.closest('[data-who-name]'); if (c) { go(c.dataset.whoName); return; }
    if (e.target.closest('#whook')) go(o.querySelector('#whoname').value);
  });
  document.body.appendChild(o); setTimeout(() => { const i = o.querySelector('#whoname'); i && i.focus(); }, 50);
}
// Calculadora de vueltas: Macarena toca los billetes y monedas que le dieron y la app le dice cuánto devolver
// (con dibujos de la plata que tiene que devolver).
function askChange(sum, done) {
  let given = [];
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'askchange';
  const draw = () => {
    const g = given.reduce((a, v) => a + v, 0), back = g - sum, cp = changeParts(Math.max(0, back));
    let res;
    if (!g) res = `<div class="chg-res wait">👇 Toca la plata que te dieron</div>`;
    else if (back < 0) res = `<div class="chg-res bad">😮 Falta <b class="num">${fmt(-back)}</b><small>Pídele más plata</small></div>`;
    else if (back === 0) res = `<div class="chg-res ok">🎉 ¡Exacto! <small>No hay que devolver nada</small></div>`;
    else res = `<div class="chg-res give"><span>Devuelve</span><b class="num">${fmt(back)}</b>
      <div class="chg-parts">${cp.parts.map(m => moneyPic(m, true)).join('')}${cp.left ? `<span class="muted num">+ ${fmt(cp.left)}</span>` : ''}</div></div>`;
    o.innerHTML = `<div class="pinbox paybox chgbox" role="dialog" aria-label="Calculadora de vueltas">
      <div class="chg-top"><span>Cuesta</span><b class="num">${fmt(sum)}</b></div>
      <div class="chg-given"><span>Te dio <b class="num">${fmt(g)}</b></span>
        <div class="chg-tray">${given.length ? given.map((v, n) => `<button data-ungive="${n}" aria-label="Quitar ${fmt(v)}">${moneyPic(MONEY.find(m => m.v === v), true)}</button>`).join('') : '<small class="muted">Aquí sale lo que toques</small>'}</div></div>
      ${res}
      <div class="chg-money">${MONEY.map(m => `<button data-give="${m.v}" aria-label="${m.label}: ${fmt(m.v)}">${moneyPic(m)}</button>`).join('')}</div>
      ${g >= sum ? `<button class="paybtn cash" id="chgok"><span>✅</span>${back > 0 ? 'Ya devolví' : 'Listo'}</button>`
        : !g ? `<button class="paybtn cash" id="chgexact"><span>👌</span>Me pagó exacto</button>` : ''}
      <button class="btn ghost big" id="chgback">Volver</button></div>`;
  };
  o.addEventListener('click', e => {
    if (e.target === o || e.target.closest('#chgback')) { o.remove(); askPay(); return; }
    const gv = e.target.closest('[data-give]'); if (gv) { given.push(+gv.dataset.give); ding(); draw(); return; }
    const ug = e.target.closest('[data-ungive]'); if (ug) { given.splice(+ug.dataset.ungive, 1); draw(); return; }
    if (e.target.closest('#chgexact')) { o.remove(); done({ given: sum, back: 0 }); return; }
    if (e.target.closest('#chgok')) { const g = given.reduce((a, v) => a + v, 0); o.remove(); done({ given: g, back: g - sum }); }
  });
  draw(); document.body.appendChild(o);
}
// Transferencia: tomarle foto al comprobante que muestra el cliente. Si no se puede, se sigue sin foto.
function askReceipt(sum, done, back) {
  let img = null, busy = false;
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'askreceipt';
  const draw = () => {
    o.innerHTML = `<div class="pinbox paybox" role="dialog" aria-label="Foto del comprobante"><h2>📱 Transferencia</h2>
      <b class="num paytotal">${fmt(sum)}</b>
      ${img ? `<img class="rcprev" src="${img}" alt="Foto del comprobante">
        <button class="paybtn transfer" id="rcok"><span>✅</span>Listo</button>
        <label class="btn ghost big rcagain">📸 Tomar otra foto<input type="file" id="rcfile" accept="image/*" capture="environment" hidden></label>`
      : `<p style="margin:0;font-weight:800">Pídele al cliente que te muestre el comprobante y tómale una foto.</p>
        <label class="paybtn transfer rccam${busy ? ' busy' : ''}"><span>📸</span>${busy ? 'Preparando…' : 'Tomar foto'}<input type="file" id="rcfile" accept="image/*" capture="environment" hidden></label>
        <button class="btn ghost" id="rcskip">Seguir sin foto</button>`}
      <button class="btn ghost big" id="rcback">Volver</button></div>`;
  };
  o.addEventListener('click', e => {
    if (e.target === o || e.target.closest('#rcback')) { o.remove(); (back || askPay)(); return; }
    if (e.target.closest('#rcskip')) { o.remove(); done(null); return; }
    if (e.target.closest('#rcok')) { o.remove(); done(img); }
  });
  o.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    busy = true; draw();
    shrinkReceipt(f).then(d => { img = d; busy = false; draw(); }, () => { busy = false; draw(); toast('No se pudo leer esa foto. Intenta otra vez.'); });
  });
  draw(); document.body.appendChild(o);
}
// Antes de guardar, Macarena revisa la venta: lo que lleva, el total y cómo pagó.
// Si algo está mal, toca "Arreglar" y vuelve a la canasta sin que se guarde nada.
function confirmSale(method, who, receipt, change) {
  const ci = cartItems(); if (!ci.length) { cart = []; saveCart(); renderKid(); return; }
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'confirmsale';
  const how = method === 'transfer' ? '📱 Transferencia' + (receipt ? ' 🧾' : '') : method === 'credit' ? '📝 Fiado: ' + esc(who) : '💵 Billetes o monedas';
  o.innerHTML = `<div class="pinbox paybox" role="dialog" aria-label="Revisar la venta"><h2>👀 ¿Está bien?</h2>
    <div class="cfitems">${ci.map(i => `<span class="chip" style="--c:${esc(i.color)}">${pic(i)}</span>`).join('')}</div>
    <b class="num paytotal">${fmt(cartTotal())}</b>
    <span class="cfhow">${how}</span>
    ${change && change.back > 0 ? `<span class="partyback">Vuelto: <b class="num">${fmt(change.back)}</b></span>` : ''}
    <button class="paybtn cash" id="cfyes"><span>✅</span>Sí, está bien</button>
    <button class="paybtn cffix" id="cfno"><span>↩️</span>No, arreglar</button></div>`;
  o.addEventListener('click', e => {
    if (e.target.closest('#cfyes')) { o.remove(); pay(method, who, receipt, change, true); return; }
    if (e.target.closest('#cfno')) { o.remove(); toast('Arregla la venta y vuelve a cobrar'); }
  });
  document.body.appendChild(o);
}
function pay(method, who, receipt, change, ok) {
  if (!ok) { confirmSale(method, who, receipt, change); return; }
  const ci = cartItems(); if (!ci.length) { cart = []; saveCart(); renderKid(); return; }
  const sum = cartTotal(), ticket = uid(), t = Date.now(), counts = new Map();
  const b = writeBatch(db);
  const lines = priceLines(ci);
  if (method === 'credit') b.set(doc(db, 'debts', ticket), { name: who, total: sum, items: lines.map(l => ({ name: l.it.name, emoji: l.it.emoji, price: l.price })), t, by: role, paid: false });
  lines.forEach(({ it, price, promo }) => {
    b.set(doc(salesCol()), { itemId: it.id, name: it.name, emoji: it.emoji, price, t, by: role, ticket, pay: method, ...(promo ? { promo: true } : {}), ...(receipt ? { rc: true } : {}) });
    counts.set(it.id, (counts.get(it.id) || 0) + 1);
  });
  counts.forEach((n, id) => b.update(doc(db, 'items', id), { stock: increment(-n) }));
  if (receipt) b.set(receiptDoc(ticket), { img: receipt, t, by: role });
  commit(b);
  cart = []; saveCart(); cashSound(); renderKid();
  const o = document.createElement('div'); o.className = 'overlay party';
  o.innerHTML = `<div class="partybox"><div class="big">🎉</div><h2>¡Venta lista!</h2><b class="num">${fmt(sum)}</b><span>${method === 'transfer' ? '📱 Transferencia' + (receipt ? ' 🧾' : '') : method === 'credit' ? '📝 Fiado: ' + esc(who) : '💵 Billetes'}</span>${change && change.back > 0 ? `<span class="partyback">Vuelto: <b class="num">${fmt(change.back)}</b></span>` : ''}<span class="partyem">${ci.map(i => pic(i)).join(' ')}</span></div>`;
  o.addEventListener('click', () => o.remove()); document.body.appendChild(o); setTimeout(() => o.remove(), 2200);
}
function showKidDebts() {
  let o = document.getElementById('kiddebts');
  if (!o) { o = document.createElement('div'); o.className = 'overlay'; o.id = 'kiddebts';
    o.addEventListener('click', e => {
      if (e.target === o || e.target.closest('#kdclose')) { o.remove(); return; }
      const b = e.target.closest('[data-debtpay]'); if (b) payDebt(b.dataset.debtpay, b.dataset.with);
    }); document.body.appendChild(o); }
  const list = debtsOpen();
  o.innerHTML = `<div class="pinbox paybox" role="dialog" aria-label="Fiados"><h2>📝 Fiados</h2>
    <p class="muted" style="margin:0">Cuando alguien pague, toca 💵 o 📱.</p>
    <div style="text-align:left;max-height:55vh;overflow:auto">${list.length ? list.map(d => debtRow(d, true)).join('') : '<p>¡Nadie debe nada! 🎉</p>'}</div>
    <button class="btn ghost big" id="kdclose">Cerrar</button></div>`;
}
function cashSound() {
  if (!sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    [[1047, 0], [1319, .12], [1568, .24]].forEach(([f, d]) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(.16, ac.currentTime + d); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + d + .3);
      o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + d); o.stop(ac.currentTime + d + .32);
    });
  } catch (e) {}
}

// ---------- MODO PAPÁS ----------
const payOf = s => s.pay === 'transfer' ? 'transfer' : s.pay === 'credit' ? 'credit' : 'cash';
const creditTotal = sales => total(sales.filter(s => payOf(s) === 'credit'));
// Fiados: ventas que se pagan después. Quedan en 'debts' (no se borran al cerrar caja) hasta que pagan.
const debtsOpen = () => S.debts.filter(d => !d.paid);
const debtsPaidTurn = () => S.debts.filter(d => d.paid && d.paidAt >= turn().start);
const debtCash = () => debtsPaidTurn().filter(d => d.paidWith === 'cash').reduce((a, d) => a + d.total, 0);
const debtTr = () => debtsPaidTurn().filter(d => d.paidWith === 'transfer').reduce((a, d) => a + d.total, 0);
const debtTrPending = () => debtsPaidTurn().filter(d => d.paidWith === 'transfer' && !d.ok);
const ago = t => { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`; };
function debtRow(d, kid) {
  return `<div class="sale debt"><span><b>${esc(d.name)}</b> <span class="muted num">· ${ago(d.t)}</span><br>${(d.items || []).map(x => esc(x.emoji)).join(' ')}</span>
    <span class="row" style="gap:4px;flex-wrap:wrap;justify-content:flex-end"><b class="num">${fmt(d.total)}</b>
    <button class="okbtn" data-debtpay="${esc(d.id)}" data-with="cash">💵 Pagó</button><button class="okbtn" data-debtpay="${esc(d.id)}" data-with="transfer">📱 Pagó</button>
    ${kid ? '' : (confirmKey === 'deldebt:' + d.id ? `<button class="btn danger" data-deldebtyes="${esc(d.id)}">¿Borrar?</button>` : `<button data-deldebt="${esc(d.id)}">Borrar</button>`)}</span></div>`;
}
function debtPaidRow(d) {
  return `<div class="sale"><span><b>${esc(d.name)}</b> <span class="muted num">· pagó ${d.paidWith === 'transfer' ? '📱' : '💵'} ${hr(d.paidAt)}</span></span>
    <span class="row" style="gap:4px;flex-wrap:nowrap"><b class="num">${fmt(d.total)}</b>${d.paidWith === 'transfer' ? `${rcBtn(d.id, d.rc)}<button class="okbtn${d.ok ? ' on' : ''}" data-okdebt="${esc(d.id)}">${d.ok ? '✓ Llegó' : '¿Llegó?'}</button>` : ''}</span></div>`;
}
function payDebt(id, w, receipt) {
  const d = S.debts.find(x => x.id === id); if (!d || d.paid) return;
  // Si pagó por transferencia, primero la foto del comprobante.
  if (w === 'transfer' && receipt === undefined) {
    const kd = document.getElementById('kiddebts'); if (kd) kd.remove();
    askReceipt(d.total, img => payDebt(id, 'transfer', img), () => { if (kd) showKidDebts(); });
    return;
  }
  const t = Date.now(), b = writeBatch(db);
  b.update(doc(db, 'debts', id), { paid: true, paidAt: t, paidWith: w === 'transfer' ? 'transfer' : 'cash', ...(receipt ? { rc: true } : {}) });
  if (receipt) b.set(receiptDoc(id), { img: receipt, t, by: role });
  commit(b, w === 'transfer' ? 'Fiado pagado por transferencia' : 'Fiado pagado: guarda la plata en la caja'); if (sound) cashSound();
}
// Ver la foto del comprobante (solo papás). Se descarga solo cuando la tocan, para no gastar datos.
function rcBtn(id, has) { return has ? `<button class="rcbtn" data-rc="${esc(id)}" aria-label="Ver comprobante">🧾</button>` : ''; }
function showReceipt(id) {
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'rcview';
  o.innerHTML = `<div class="pinbox rcbox" role="dialog" aria-label="Comprobante"><h2>🧾 Comprobante</h2><p class="muted" id="rcmsg">Cargando…</p><div class="rcimg"></div>
    <small class="muted">Toca la foto para verla más grande.</small><button class="btn ghost big" id="rcclose">Cerrar</button></div>`;
  let un = null;
  const close = () => { if (un) un(); o.remove(); };
  o.addEventListener('click', e => {
    if (e.target === o || e.target.closest('#rcclose')) { close(); return; }
    if (e.target.tagName === 'IMG') e.target.classList.toggle('zoom');
  });
  document.body.appendChild(o);
  un = onSnapshot(receiptDoc(id), snap => {
    const m = o.querySelector('#rcmsg'), box = o.querySelector('.rcimg'); if (!m) return;
    const img = snap.exists() && snap.data().img;
    if (img && /^data:image\/jpeg;base64,/.test(img)) { m.textContent = 'Recibido ' + dt(snap.data().t); box.innerHTML = `<img src="${img}" alt="Foto del comprobante">`; }
    else if (!snap.metadata.fromCache) m.textContent = 'Esta foto ya no está guardada.';
  }, () => { const m = o.querySelector('#rcmsg'); if (m) m.textContent = 'No se pudo cargar. Revisa el internet.'; });
}
const RECEIPT_DAYS = 60;
// Comprobantes del turno (ventas por transferencia y fiados pagados por transferencia) para dejarlos en el historial.
function turnReceipts() {
  const out = [];
  tickets(S.sales).forEach((g, n) => { if (g.sales[0].rc) out.push({ id: g.id, label: 'Venta ' + (n + 1), total: total(g.sales) }); });
  debtsPaidTurn().forEach(d => { if (d.rc) out.push({ id: d.id, label: 'Fiado ' + d.name, total: d.total }); });
  return out;
}
const cashTotal = sales => total(sales.filter(s => payOf(s) === 'cash'));
const transferTotal = sales => total(sales.filter(s => payOf(s) === 'transfer'));
const pendingTransfers = sales => tickets(sales).filter(g => payOf(g.sales[0]) === 'transfer' && !g.sales.every(s => s.ok));
function transferBtn(g) {
  const ok = g.sales.every(s => s.ok);
  return `<button class="okbtn${ok ? ' on' : ''}" data-okticket="${esc(g.id)}" aria-pressed="${ok}">${ok ? '✓ Llegó' : '¿Llegó?'}</button>`;
}
function byItem(sales) {
  const m = new Map();
  sales.forEach(s => { const r = m.get(s.itemId) || { name: s.name, emoji: s.emoji, qty: 0, sum: 0 }; r.qty++; r.sum += s.price; m.set(s.itemId, r); });
  return [...m.values()].sort((a, b) => b.sum - a.sum);
}
function countedValue() { return counted === '' ? null : Number(counted) || 0; }
function denTotal() { return DENOMS.reduce((a, d) => a + d * (den[d] || 0), 0); }

function renderParent() {
  const tabs = [['hoy','Ventas de hoy'],['cierre','Cerrar caja'],['dulces','Productos'],['historial','Historial'],['ajustes','Ajustes']];
  app.innerHTML = `
  <div class="ptop"><h1>Modo papás</h1><div class="row" style="flex-wrap:nowrap"><button class="btn" id="tokid">Ver la tienda</button><button class="lockbtn" id="home" aria-label="Inicio: cambiar de usuario">🏠</button></div></div>
  <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="panel">${({ hoy: pHoy, cierre: pCierre, dulces: pDulces, historial: pHist, ajustes: pAjustes })[tab]()}</div>`;
}

const discountTotal = sales => sales.filter(x => x.promo).reduce((a, x) => { const it = itemById(x.itemId); return a + (it ? Math.max(0, it.price - x.price) : 0); }, 0);
// Ganancia = lo que se cobró menos lo que costó (solo productos con costo anotado).
function profitOf(sales) {
  let profit = 0, withCost = 0, missing = 0;
  sales.forEach(x => { const it = itemById(x.itemId); if (it && it.cost > 0) { profit += x.price - it.cost; withCost++; } else missing++; });
  return { profit, withCost, missing };
}
const profitKpi = sales => { const pf = profitOf(sales); if (!pf.withCost) return '';
  return `<div class="kpi" style="grid-column:1/-1"><span class="lbl">💰 Ganancia (vendido − costo)</span><b class="num" style="color:var(--good)">${fmt(pf.profit)}</b>${pf.missing ? `<small class="muted">${pf.missing} sin costo anotado, no se cuentan</small>` : ''}</div>`; };
function pHoy() {
  const sales = S.sales, sum = total(sales), rows = byItem(sales), tk = tickets(sales);
  return `
  <div class="card">
    <div class="lbl">Turno abierto desde ${esc(dt(turn().start))}</div>
    <div class="kpis"><div class="kpi"><span class="lbl">Vendido</span><b class="num">${fmt(sum)}</b></div>
    <div class="kpi"><span class="lbl">Ventas · productos</span><b class="num">${tk.length} · ${sales.length}</b></div>
    <div class="kpi"><span class="lbl">💵 Efectivo</span><b class="num">${fmt(cashTotal(sales))}</b></div>
    <div class="kpi"><span class="lbl">📱 Transferencias</span><b class="num">${fmt(transferTotal(sales))}</b>
      ${pendingTransfers(sales).length ? `<small class="warnt">${pendingTransfers(sales).length} por confirmar</small>` : ''}</div>
    ${creditTotal(sales) || debtsPaidTurn().length ? `<div class="kpi"><span class="lbl">📝 Fiado hoy</span><b class="num">${fmt(creditTotal(sales))}</b></div>
    <div class="kpi"><span class="lbl">Fiados que pagaron</span><b class="num">${fmt(debtCash() + debtTr())}</b></div>` : ''}${profitKpi(sales)}</div>
    ${sales.some(x => x.promo) ? `<p class="muted" style="margin:0">🎉 ${sales.filter(x => x.promo).length} unidades vendidas con promo${discountTotal(sales) ? ` (descuento dado: ${fmt(discountTotal(sales))})` : ''}</p>` : ''}
    <button class="btn big" data-tab="cierre">Cerrar caja</button>
  </div>
  ${debtsOpen().length || debtsPaidTurn().length ? `<div class="card"><h2>📝 Fiados pendientes</h2>
    ${debtsOpen().length ? `<p class="muted" style="margin:0">Deben en total <b class="num">${fmt(debtsOpen().reduce((a, d) => a + d.total, 0))}</b>. Cuando paguen, toca 💵 o 📱.</p>${debtsOpen().map(d => debtRow(d, false)).join('')}` : '<p class="muted" style="margin:0">Nadie debe nada. 🎉</p>'}
    ${debtsPaidTurn().length ? `<h3 style="margin:12px 0 0">Pagaron en este turno</h3>${debtsPaidTurn().map(debtPaidRow).join('')}` : ''}
  </div>` : ''}
  <div class="card"><h2>Por producto</h2>
    ${rows.length ? `<div class="tw"><table><thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Total</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.emoji)} ${esc(r.name)}</td><td class="r num">${r.qty}</td><td class="r num">${fmt(r.sum)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Todavía no hay ventas en este turno.</p>'}
  </div>
  <div class="card"><h2>Cada venta</h2>
    <p class="muted" style="margin:0">Si una venta quedó mal, bórrala aquí. Los productos vuelven al inventario.</p>
    ${tk.length ? tk.map((g, n) => ({ g, n: n + 1 })).reverse().map(({ g, n }) => `<div class="sale"><span><b>Venta ${n}</b> ${payOf(g.sales[0]) === 'transfer' ? '📱' : payOf(g.sales[0]) === 'credit' ? '📝 ' + esc((S.debts.find(d => d.id === g.id) || {}).name || 'Fiado') : '💵'} <span class="muted num">· ${hr(g.t)}${g.by === 'parent' ? ' · papás' : ''}</span><br>${g.sales.map(s => esc(s.emoji)).join(' ')}</span>
      <span class="row" style="gap:4px;flex-wrap:nowrap">${payOf(g.sales[0]) === 'transfer' ? rcBtn(g.id, g.sales[0].rc) + transferBtn(g) : ''}<b class="num">${fmt(total(g.sales))}</b><button data-delticket="${esc(g.id)}">Borrar</button></span></div>`).join('') : '<p class="muted">Sin ventas.</p>'}
  </div>`;
}
// Conteo de inventario: compara lo que la app espera que quede con lo que hay en físico.
// Si hay menos dulces de los esperados, salieron sin anotarse en la app.
function invRows() {
  return S.items.filter(i => inv[i.id] !== undefined && inv[i.id] !== '').map(i => {
    const real = Number(inv[i.id]) || 0, expected = i.stock;
    return { itemId: i.id, name: i.name, emoji: i.emoji, price: i.price, expected, counted: real, missing: expected - real };
  });
}
function invSummary(rows) {
  const miss = rows.filter(r => r.missing > 0), extra = rows.filter(r => r.missing < 0);
  return { rows, missUnits: miss.reduce((a, r) => a + r.missing, 0), missValue: miss.reduce((a, r) => a + r.missing * r.price, 0),
    extraUnits: extra.reduce((a, r) => a - r.missing, 0), counted: rows.length };
}
function pCierre() {
  const sales = total(S.sales), cash = cashTotal(S.sales), tr = transferTotal(S.sales), pend = pendingTransfers(S.sales);
  const cr = creditTotal(S.sales), dC = debtCash(), dT = debtTr(), dTp = debtTrPending();
  const base = turn().base || 0, expected = base + cash + dC, c = countedValue();
  let cls = 'none', title = 'Escribe cuánta plata hay', sub = '';
  if (c !== null) { const d = c - expected;
    if (d === 0) { cls = 'ok'; title = '¡Cuadra perfecto!'; sub = 'La plata coincide con las ventas.'; }
    else if (d < 0) { cls = 'bad'; title = 'Falta ' + fmt(-d); sub = 'Hay menos plata de la esperada. Revisa la lista de ventas.'; }
    else { cls = 'plus'; title = 'Sobra ' + fmt(d); sub = 'Hay más plata. Puede ser un producto que no se marcó.'; } }
  return `
  <div class="card">
    <h2>1. Sencillo inicial</h2>
    <p class="muted" style="margin:0">La plata que había en la caja al abrir (para dar vueltas). Si empezó vacía, deja 0.</p>
    <div class="field"><label class="lbl" for="base">Sencillo inicial</label><input id="base" inputmode="numeric" value="${base || ''}" placeholder="0"></div>
  </div>
  <div class="card">
    <h2>2. Cuenta la plata de la caja</h2>
    <p class="muted" style="margin:0">Solo billetes y monedas. Las transferencias se revisan aparte (paso 3). Los fiados que todavía no pagan no están en la caja.</p>
    <div class="field"><label class="lbl" for="counted">Total contado</label><input id="counted" inputmode="numeric" value="${esc(counted)}" placeholder="Ej: 12500"></div>
    <details ${denTotal() ? 'open' : ''}><summary class="lbl" style="cursor:pointer">Contar por billetes y monedas</summary>
      <div class="denoms" style="margin-top:10px">${DENOMS.map(d => `<div class="den"><span class="num">${fmt(d)}</span>
        <span class="step"><button data-den="${d}" data-dir="-1" aria-label="Quitar ${fmt(d)}">−</button><output class="num">${den[d] || 0}</output><button data-den="${d}" data-dir="1" aria-label="Agregar ${fmt(d)}">+</button></span></div>`).join('')}</div>
      <p class="muted num" style="margin:8px 0 0">Suma de billetes y monedas: <b>${fmt(denTotal())}</b></p>
    </details>
  </div>
  <div class="card">
    <h2>3. Revisa las transferencias</h2>
    ${tr ? `<p class="muted" style="margin:0">Mira en tu cuenta (Nequi, banco…) que cada una haya llegado y márcala. Toca 🧾 para ver la foto del comprobante.</p>
      ${tickets(S.sales).map((g, n) => ({ g, n: n + 1 })).filter(({ g }) => payOf(g.sales[0]) === 'transfer').map(({ g, n }) => `<div class="sale"><span><b>Venta ${n}</b> <span class="muted num">· ${hr(g.t)}</span></span>
        <span class="row" style="gap:6px;flex-wrap:nowrap"><b class="num">${fmt(total(g.sales))}</b>${rcBtn(g.id, g.sales[0].rc)}${transferBtn(g)}</span></div>`).join('')}
      ${dT ? `<p class="muted" style="margin:8px 0 0">Fiados pagados por transferencia:</p>${debtsPaidTurn().filter(d => d.paidWith === 'transfer').map(debtPaidRow).join('')}` : ''}
      <div class="diff ${pend.length + dTp.length ? 'plus' : 'ok'}"><b class="num">${pend.length + dTp.length ? `Faltan por confirmar ${pend.length + dTp.length} = ${fmt(pend.reduce((a, g) => a + total(g.sales), 0) + dTp.reduce((a, d) => a + d.total, 0))}` : `Llegaron todas: ${fmt(tr + dT)}`}</b>
        <span>${pend.length + dTp.length ? 'Si alguna no llegó, revisa con quien vendió antes de cerrar.' : 'Las transferencias cuadran.'}</span></div>`
    : dT ? `<p class="muted" style="margin:0">Fiados pagados por transferencia:</p>${debtsPaidTurn().filter(d => d.paidWith === 'transfer').map(debtPaidRow).join('')}` : '<p class="muted" style="margin:0">No hubo transferencias en este turno.</p>'}
  </div>
  <div class="card">
    <h2>4. Cuenta los productos <span class="muted" style="font-size:.9rem">(recomendado)</span></h2>
    <p class="muted" style="margin:0">Cuenta cuántos quedan de verdad de cada producto. Si hay menos de lo que dice la app, se vendieron sin anotarse.</p>
    ${(() => { const su = invSummary(invRows());
      return `<div class="invlist">${S.items.map(i => { const v = inv[i.id], has = v !== undefined && v !== '', m = has ? i.stock - (Number(v) || 0) : 0;
        return `<div class="inv"><span class="inv-n">${esc(i.emoji)} ${esc(i.name)}<small class="muted num">La app dice: ${i.stock}</small></span>
          <input id="inv-${i.id}" data-inv="${i.id}" inputmode="numeric" value="${esc(v ?? '')}" placeholder="—" aria-label="Cuántos ${esc(i.name)} hay">
          <span class="inv-d num ${!has ? '' : m > 0 ? 'bad' : m < 0 ? 'warn' : 'ok'}">${!has ? '' : m > 0 ? `Faltan ${m}` : m < 0 ? `Sobran ${-m}` : '✓'}</span></div>`; }).join('')}</div>
      ${su.counted ? `<div class="diff ${su.missUnits ? 'bad' : 'ok'}"><b class="num">${su.missUnits ? `Faltan ${su.missUnits} productos = ${fmt(su.missValue)}` : 'Los productos cuadran'}</b>
        <span>${su.missUnits ? 'Salieron productos que no se anotaron en la app (o se regalaron o dañaron).' : `Contaste ${su.counted} de ${S.items.length} productos.`}${su.extraUnits ? ` Hay ${su.extraUnits} de más: revisa si llegaron productos que no se anotaron.` : ''}</span></div>` : ''}`; })()}
  </div>
  <div class="card">
    <h2>5. Resultado</h2>
    <div class="tw"><table><tbody>
      <tr><td>Ventas del turno (${S.sales.length} productos)</td><td class="r num">${fmt(sales)}</td></tr>
      <tr><td class="muted">− 📱 Pagadas por transferencia</td><td class="r num muted">${fmt(tr)}</td></tr>
      ${cr ? `<tr><td class="muted">− 📝 Fiado (pagan después)</td><td class="r num muted">${fmt(cr)}</td></tr>` : ''}
      <tr><td>💵 Ventas en efectivo</td><td class="r num">${fmt(cash)}</td></tr>
      ${dC ? `<tr><td>+ 💵 Fiados que pagaron en efectivo</td><td class="r num">${fmt(dC)}</td></tr>` : ''}
      <tr><td>+ Sencillo inicial</td><td class="r num">${fmt(base)}</td></tr>
      <tr><td><b>Debería haber en la caja</b></td><td class="r num"><b>${fmt(expected)}</b></td></tr>
      <tr><td>Hay en la caja</td><td class="r num">${c === null ? '—' : fmt(c)}</td></tr>
    </tbody></table></div>
    <div class="diff ${cls}"><b class="num">${title}</b><span>${sub}</span></div>
    <div class="field"><label class="lbl" for="note">Nota (opcional)</label><input id="note" value="${esc(note)}" placeholder="Ej: le regaló uno a la abuela"></div>
    ${confirmKey === 'close' ? `<div class="confirm"><span>¿Cerrar el turno y empezar uno nuevo en cero?</span>
      <button class="btn" id="doclose">Sí, cerrar caja</button><button class="btn ghost" data-cancel>No</button></div>`
      : `<button class="btn big" id="close" ${c === null ? 'disabled style="opacity:.5"' : ''}>Guardar cierre y empezar de nuevo</button>`}
  </div>`;
}

function itemForm(it) {
  return `<div class="card" id="editor">
    <h2>${it.id ? 'Editar producto' : 'Nuevo producto'}</h2>
    <div class="row">
      <div class="field"><label class="lbl" for="e-name">Nombre</label><input id="e-name" value="${esc(it.name)}" maxlength="22"></div>
      <div class="field"><label class="lbl" for="e-price">Precio</label><input id="e-price" inputmode="numeric" value="${it.price || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label class="lbl" for="e-stock">Unidades en la tienda</label><input id="e-stock" inputmode="numeric" value="${it.stock ?? 0}"></div>
      <div class="field"><label class="lbl" for="e-add">Llegaron más (sumar)</label><input id="e-add" inputmode="numeric" placeholder="0" value="${esc(it.add || '')}"></div>
    </div>
    <div class="field"><label class="lbl" for="e-cost">Costo por unidad (lo que le cuesta a la tienda, opcional)</label><input id="e-cost" inputmode="numeric" placeholder="Ej: 413" value="${it.cost || ''}"></div>
    ${it.cost > 0 && it.price > 0 ? `<small class="muted num">Ganancia por unidad: ${fmt(it.price - it.cost)} (${Math.round((it.price - it.cost) / it.price * 100)}%)</small>` : ''}
    <span class="lbl">Promo por cantidad (opcional)</span>
    <div class="row promo-row"><div class="field"><label class="lbl" for="e-pq">Llevando</label><input id="e-pq" inputmode="numeric" placeholder="2" value="${it.promoQty || ''}"></div>
      <div class="field"><label class="lbl" for="e-pp">pagan en total</label><input id="e-pp" inputmode="numeric" placeholder="Ej: 800" value="${it.promoPrice || ''}"></div></div>
    <small class="muted">Ej: llevando <b>2</b> pagan <b>800</b>. Déjalo vacío si no tiene promo.</small>
    <span class="lbl">Foto o dibujo</span>
    <div class="photorow"><div class="sw big" style="--c:${esc(it.color)}">${pic(it)}</div>
      <label class="btn ghost photobtn">📷 ${it.photo ? 'Cambiar foto' : 'Tomar o escoger foto'}<input type="file" id="e-photo" accept="image/*" hidden></label>
      ${it.photo ? '<button type="button" class="btn ghost" id="e-nophoto">Quitar foto</button>' : ''}</div>
    <small class="muted">${it.photo ? 'Si tocas un dibujo, se quita la foto.' : 'O escoge un dibujo:'}</small>
    <div class="emojis">${EMOJIS.map(e => `<button type="button" data-emoji="${e}" aria-pressed="${it.emoji === e}">${e}</button>`).join('')}</div>
    <div class="field"><label class="lbl" for="e-emoji">U otro emoji</label><input id="e-emoji" value="${esc(it.emoji)}" maxlength="4"></div>
    <span class="lbl">Color</span>
    <div class="colors">${COLORS.map(c => `<button type="button" data-color="${c}" style="--c:${c}" aria-pressed="${it.color === c}" aria-label="Color ${c}"></button>`).join('')}</div>
    <label class="row"><input type="checkbox" id="e-active" ${it.active !== false ? 'checked' : ''}> Mostrar en la tienda</label>
    <div class="row">
      <button class="btn" id="e-save">Guardar</button><button class="btn ghost" id="e-cancel">Cancelar</button>
      ${it.id ? (confirmKey === 'del' ? `<span class="confirm">¿Borrar ${esc(it.name)}? <button class="btn danger" id="e-del-yes">Sí, borrar</button></span>` : '<button class="btn danger" id="e-del">Borrar</button>') : ''}
    </div>
  </div>`;
}

// ---------- agregar varios dulces de una vez ----------
// Un dulce por línea: "Chupeta, 500, 20". Sirve pegar desde Excel o Google Sheets (columnas) o desde una nota.
const KEYEMOJI = [
  [/chupet|bon ?bon|bombom|paleta(?! de agua)|lollipop/, '🍭'], [/chocola|jet|jumbo|cocosette|chocorramo/, '🍫'],
  [/galle|oreo|festival|wafer|tosh/, '🍪'], [/gomit|goma|trululu|ositos/, '🐻'], [/masmelo|malvavisc/, '🍡'],
  [/chicle|bubbalo|trident/, '🫧'], [/paleta de agua|hielo|raspado|granizado/, '🍧'], [/helad|cono/, '🍦'],
  [/ponque|ponqué|cupcake|muffin|brownie|torta|pastel/, '🧁'], [/rosquill|dona|donut/, '🍩'], [/mani|maní/, '🥜'],
  [/crispeta|palomit|popcorn/, '🍿'], [/jugo|hit|tutti|frutiño/, '🧃'], [/gaseosa|cola|soda|agua|bebida|pony|malta/, '🥤'],
  [/coca?da|coco/, '🥥'], [/bocadillo|miel|arequipe|dulce de leche|panela/, '🍯'], [/papa|chito|detodito|boliqueso|snack|tostacos|doritos/, '🥨'],
  [/fresa|barrilete/, '🍓'], [/cereza/, '🍒'], [/limon|limón|menta/, '🍋'], [/sandia|patilla/, '🍉'], [/banano|plátano|platano/, '🍌'],
  [/arepa|empanada|pan/, '🥐'], [/caramel|bianchi|colombina|dulce|confite|menta/, '🍬']
];
const plain = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
function guessEmoji(name) { const n = plain(name); for (const [re, e] of KEYEMOJI) if (re.test(n)) return e; return '🍬'; }
function parseBulk(text) {
  const rows = [], bad = [], seen = new Map();
  text.split(/\r?\n/).forEach((raw, ix) => {
    const line = raw.trim(); if (!line) return;
    let parts = line.includes('\t') ? line.split('\t') : line.includes(';') ? line.split(';') : line.split(',');
    parts = parts.map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) { // "Chupeta 500 20" (separado con espacios)
      const m = line.match(/^(.*?)\s+\$?\s*([\d.]+)(?:\s+(\d+))?\s*(?:und\.?|unidades)?$/i);
      parts = m ? [m[1], m[2], m[3]].filter(x => x !== undefined) : parts;
    }
    let name = (parts[0] || '').replace(/^["']|["']$/g, '').trim(), emoji = '';
    const em = name.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u);
    if (em) { emoji = em[1]; name = name.slice(em[0].length).trim(); }
    let promo = null; const rest = [];
    let cost = null;
    parts.slice(1).forEach(x => { const pm = x.match(/^(\d+)\s*(?:x|por)\s*\$?\s*([\d.]+)$/i), cm = x.match(/^costo\s*:?\s*\$?\s*([\d.]+)$/i);
      if (pm && !promo) promo = { q: num(pm[1]), p: num(pm[2]) }; else if (cm) cost = num(cm[1]) || null; else rest.push(x); });
    const price = num(rest[0]), stock = rest[1] !== undefined && /\d/.test(rest[1]) ? num(rest[1]) : null;
    if (promo && (promo.q < 2 || !promo.p || promo.p >= promo.q * price)) promo = null;
    if (!name || !price) { bad.push({ n: ix + 1, line }); return; }
    name = name.slice(0, 22);
    const key = plain(name);
    if (seen.has(key)) { const r = seen.get(key); r.price = price; if (promo) r.promo = promo; if (cost) r.cost = cost; if (stock !== null) r.stock = (r.stock || 0) + stock; return; }
    const ex = S.items.find(i => plain(i.name) === key);
    const r = { name, price, stock, promo, cost, emoji: emoji || (ex ? ex.emoji : guessEmoji(name)), ex };
    seen.set(key, r); rows.push(r);
  });
  return { rows, bad };
}
function bulkPreview(text) {
  const { rows, bad } = parseBulk(text);
  if (!rows.length && !bad.length) return '<p class="muted">Aquí vas a ver cómo quedan antes de guardar.</p>';
  const nNew = rows.filter(r => !r.ex).length, nOld = rows.length - nNew;
  return `<p><b>${nNew ? `${nNew} producto${nNew === 1 ? '' : 's'} nuevo${nNew === 1 ? '' : 's'}` : ''}${nNew && nOld ? ' y ' : ''}${nOld ? `${nOld} que ya existe${nOld === 1 ? '' : 'n'} (se actualiza${nOld === 1 ? '' : 'n'})` : ''}</b></p>
  ${rows.map((r, i) => `<div class="item"><div class="sw" style="--c:${r.ex ? esc(r.ex.color) : COLORS[(S.items.length + i) % COLORS.length]}">${r.ex && r.ex.photo ? pic(r.ex) : esc(r.emoji)}</div>
    <div class="t"><b>${esc(r.name)}${r.promo ? ` <span class="pill promo num">🎉 ${r.promo.q} por ${fmt(r.promo.p)}</span>` : ''}</b><small class="num">${fmt(r.price)}${r.cost ? ` (costo ${fmt(r.cost)})` : ''} · ${r.ex ? (r.stock !== null ? `ya existe: tenía ${r.ex.stock}, ahora ${r.ex.stock + r.stock}` : `ya existe: quedan ${r.ex.stock} und.`) : `${r.stock ?? 0} und.`}</small></div></div>`).join('')}
  ${bad.length ? `<div class="warnt">No entendí ${bad.length === 1 ? 'esta línea' : 'estas líneas'} (falta el nombre o el precio):<br>${bad.map(b => `<small>Línea ${b.n}: ${esc(b.line.slice(0, 40))}</small>`).join('<br>')}</div>` : ''}`;
}
function bulkSave(text) {
  const { rows } = parseBulk(text); if (!rows.length) { toast('Escribe al menos un producto con su precio'); return; }
  let k = 0; const base = Date.now();
  const ops = rows.map(r => r.ex
    ? b => b.update(doc(db, 'items', r.ex.id), { price: r.price, ...(r.promo ? { promoQty: r.promo.q, promoPrice: r.promo.p } : {}), ...(r.cost ? { cost: r.cost } : {}), ...(r.stock !== null ? { stock: increment(r.stock) } : {}) })
    : b => b.set(doc(itemsCol()), { name: r.name, emoji: r.emoji, price: r.price, color: COLORS[(S.items.length + k++) % COLORS.length], stock: r.stock ?? 0, promoQty: r.promo ? r.promo.q : null, promoPrice: r.promo ? r.promo.p : null, cost: r.cost || null, active: true, example: false, order: base + k }));
  bulk = null; render();
  runOps(ops).then(() => toast(`Listo: ${rows.length} producto${rows.length === 1 ? '' : 's'} guardado${rows.length === 1 ? '' : 's'}`),
    err => { console.error(err); toast('No se pudo guardar. Revisa el internet.'); });
}
let bulk = null;
function pDulces() {
  const ex = S.items.some(i => i.example);
  const seedCard = ex ? '' : `<div class="card" style="background:var(--soft)"><b>¿Quieren practicar primero?</b><span class="muted">Carga ${SAMPLE.length} productos de ejemplo para ver cómo funciona la tienda. Cuando estén listos, se borran con un botón y quedan solo los reales.</span>
    <button class="btn ghost" id="seed">Cargar productos de ejemplo</button></div>`;
  return `${S.items.length ? '' : seedCard}
  ${editing ? itemForm(editing) : ''}
  ${bulk !== null ? `<div class="card" id="bulk">
    <h2>Agregar varios productos</h2>
    <p class="muted">Escribe un producto por línea: <b>nombre, precio, unidades</b>. Si tiene promo o costo, agrégalos al final: <b>Chupeta, 500, 20, 2 por 800, costo 300</b>. También puedes pegar las columnas desde Excel o Google Sheets.</p>
    <textarea id="bulktext" rows="7" placeholder="Chupeta, 500, 20&#10;Chocolatina, 1500, 12&#10;Gomitas, 300, 30">${esc(bulk)}</textarea>
    <div id="bulkprev">${bulkPreview(bulk)}</div>
    <div class="row"><button class="btn" id="bulksave">Guardar todos</button><button class="btn ghost" id="bulkcancel">Cancelar</button></div>
  </div>` : ''}
  ${ex ? `<div class="card" style="background:var(--soft)"><b>Estos son productos de ejemplo.</b><span class="muted">Cambia nombres y precios por los reales, o bórralos todos y agrega los tuyos.</span>
    ${confirmKey === 'clear' ? `<div class="confirm">¿Borrar todos los productos de ejemplo? <button class="btn danger" id="clearyes">Sí, borrar</button><button class="btn ghost" data-cancel>No</button></div>` : '<button class="btn ghost" id="clear">Borrar los de ejemplo</button>'}</div>` : ''}
  <div class="card">
    <div class="row" style="justify-content:space-between"><h2>${S.items.length} productos</h2><div class="row"><button class="btn ghost" id="bulk-open">+ Agregar varios</button><button class="btn" id="add">+ Agregar producto</button></div></div>
    <div>${S.items.map(i => { const st = i.stock < 0 ? `<span class="pill out">Se vendieron ${-i.stock} de más: actualiza las unidades</span>` : i.stock === 0 ? '<span class="pill out">Agotado</span>' : i.stock <= 3 ? `<span class="pill low">Quedan ${i.stock}</span>` : `<span class="pill">${i.stock} und.</span>`;
      return `<div class="item"><div class="sw" style="--c:${esc(i.color)}">${pic(i)}</div>
      <div class="t"><b>${esc(i.name)}${i.active === false ? ' <span class="pill">oculto</span>' : ''}</b><small class="num">${fmt(i.price)}${i.cost > 0 ? ` <span class="muted">(costo ${fmt(i.cost)})</span>` : ''} · </small>${st}${hasPromo(i) ? ` <span class="pill promo num">🎉 ${promoTxt(i)}</span>` : ''}</div>
      <button class="btn ghost" data-edit="${i.id}">Editar</button></div>`; }).join('')}</div>
  </div>
  ${S.items.length ? seedCard : ''}`;
}

function pHist() {
  const cl = S.closings;
  if (!cl.length) return '<div class="card"><h2>Historial de cierres</h2><p class="muted">Aquí quedan guardados los cierres de caja. Todavía no hay ninguno.</p></div>';
  const tot = cl.reduce((a, c) => a + c.sales, 0), diffs = cl.reduce((a, c) => a + (c.counted - c.expected), 0);
  const prof = cl.reduce((a, c) => a + (c.profit || 0), 0), hasProf = cl.some(c => c.profit !== undefined);
  const missV = cl.reduce((a, c) => a + (c.missValue || 0), 0), missU = cl.reduce((a, c) => a + (c.missUnits || 0), 0);
  return `<div class="card"><div class="kpis">
    <div class="kpi"><span class="lbl">Vendido en total</span><b class="num">${fmt(tot)}</b></div>
    <div class="kpi"><span class="lbl">Diferencias</span><b class="num" style="color:${diffs === 0 ? 'var(--good)' : diffs < 0 ? 'var(--bad)' : 'var(--warn)'}">${diffs > 0 ? '+' : ''}${fmt(diffs).replace('$-', '-$')}</b></div>
    ${hasProf ? `<div class="kpi" style="grid-column:1/-1"><span class="lbl">💰 Ganancia en total</span><b class="num" style="color:var(--good)">${fmt(prof)}</b></div>` : ''}
    <div class="kpi" style="grid-column:1/-1"><span class="lbl">Productos que faltaron en los conteos</span><b class="num" style="color:${missU ? 'var(--bad)' : 'var(--good)'}">${missU ? `${missU} = ${fmt(missV)}` : '0'}</b></div></div></div>
  <div class="card"><h2>Cierres</h2>${cl.slice().reverse().map(c => { const d = c.counted - c.expected;
    return `<details class="hist"><summary><span>${esc(dt(c.end))}<br><small class="muted num">${c.count} productos · ${fmt(c.sales)}${c.profit !== undefined ? ` · ganancia ${fmt(c.profit)}` : ''}</small></span>
      <span style="display:grid;gap:4px;justify-items:end"><span class="pill ${d === 0 ? '' : d < 0 ? 'out' : 'low'} num">${d === 0 ? 'Plata cuadró' : d < 0 ? 'Faltó ' + fmt(-d) : 'Sobró ' + fmt(d)}</span>
      ${c.transferPending ? `<span class="pill out num">Transferencias sin confirmar ${fmt(c.transferPending)}</span>` : ''}
      ${c.creditSales ? `<span class="pill low num">📝 Fiado ${fmt(c.creditSales)}</span>` : ''}
      ${c.inventory ? `<span class="pill ${c.missUnits ? 'out' : ''} num">${c.missUnits ? `Faltaron ${c.missUnits} productos (${fmt(c.missValue)})` : 'Productos cuadraron'}</span>` : ''}</span></summary>
      <div class="tw"><table><tbody>
      ${c.transferSales !== undefined ? `<tr><td>💵 Efectivo</td><td class="r num">${fmt(c.cashSales)}</td></tr>${c.creditSales ? `<tr><td>📝 Fiado</td><td class="r num">${fmt(c.creditSales)}</td></tr>` : ''}${c.debtCashPaid || c.debtTransferPaid ? `<tr><td>Fiados que pagaron (💵 ${fmt(c.debtCashPaid || 0)} · 📱 ${fmt(c.debtTransferPaid || 0)})</td><td class="r num">${fmt((c.debtCashPaid || 0) + (c.debtTransferPaid || 0))}</td></tr>` : ''}<tr><td>📱 Transferencias${c.transferPending ? ` <span style="color:var(--bad)">(sin confirmar ${fmt(c.transferPending)})</span>` : ''}</td><td class="r num">${fmt(c.transferSales)}</td></tr>` : ''}
      <tr><td>Sencillo inicial</td><td class="r num">${fmt(c.base)}</td></tr><tr><td>Debía haber en la caja</td><td class="r num">${fmt(c.expected)}</td></tr>
      <tr><td>Se contó</td><td class="r num">${fmt(c.counted)}</td></tr>
      ${(c.items || []).map(r => `<tr><td class="muted">${esc(r.emoji)} ${esc(r.name)} × ${r.qty}</td><td class="r num muted">${fmt(r.sum)}</td></tr>`).join('')}
      ${(c.inventory || []).filter(r => r.missing).map(r => `<tr><td style="color:${r.missing > 0 ? 'var(--bad)' : 'var(--warn)'}">${esc(r.emoji)} ${esc(r.name)}: la app decía ${r.expected}, había ${r.counted}</td><td class="r num" style="color:${r.missing > 0 ? 'var(--bad)' : 'var(--warn)'}">${r.missing > 0 ? '-' + fmt(r.missing * r.price) : '+' + (-r.missing)}</td></tr>`).join('')}
      </tbody></table></div>${c.note ? `<p class="muted">Nota: ${esc(c.note)}</p>` : ''}
      ${(c.receipts || []).length ? `<div class="rclist"><span class="lbl">🧾 Comprobantes</span>${c.receipts.map(r => `<button class="okbtn" data-rc="${esc(r.id)}">${esc(r.label)} · ${fmt(r.total)}</button>`).join('')}</div>` : ''}</details>`; }).join('')}
    <p class="muted" style="margin:8px 0 0">Las fotos de comprobantes se guardan ${RECEIPT_DAYS} días.</p></div>`;
}

function oldLocalData() {
  try { const raw = localStorage.getItem(OLD_KEY); if (!raw) return null; const d = JSON.parse(raw); return d && d.items ? d : null; } catch (e) { return null; }
}
function backupJSON() {
  const strip = ({ id, ...rest }) => ({ id, ...rest });
  return JSON.stringify({
    items: S.items.map(strip),
    turn: { start: turn().start, base: turn().base || 0, sales: S.sales.map(s => ({ id: s.id, itemId: s.itemId, name: s.name, emoji: s.emoji, price: s.price, t: s.t, by: s.by, ticket: s.ticket || null, pay: payOf(s), ok: !!s.ok, promo: !!s.promo })) },
    closings: S.closings.map(({ id, ...c }) => c),
    debts: S.debts.map(strip)
  });
}
function pAjustes() {
  const old = oldLocalData();
  return `
  ${old ? `<div class="card" style="background:var(--soft)"><h2>Datos de la versión anterior</h2>
    <p class="muted" style="margin:0">Este celular tiene datos guardados de la app anterior (${old.items.length} productos, ${(old.closings || []).length} cierres). Puedes pasarlos a la app nueva. Esto reemplaza lo que hay ahora.</p>
    ${confirmKey === 'import' ? `<div class="confirm">¿Reemplazar los datos actuales con los de este celular? <button class="btn danger" id="importyes">Sí, pasar datos</button><button class="btn ghost" data-cancel>No</button></div>` : '<button class="btn" id="import">Pasar datos a la app nueva</button>'}
  </div>` : ''}
  <div class="card"><h2>Sonido</h2><label class="row"><input type="checkbox" id="sound" ${sound ? 'checked' : ''}> Sonar al vender (en este celular)</label></div>
  <div class="card"><h2>Copia de seguridad</h2>
    <p class="muted" style="margin:0">Los datos quedan guardados en internet y se ven en los dos celulares. Igual puedes copiar este texto y mandártelo por WhatsApp de vez en cuando. Para recuperar, pégalo aquí y toca Restaurar.</p>
    <textarea id="backup" spellcheck="false">${esc(backupJSON())}</textarea>
    <div class="row"><button class="btn" id="copy">Copiar</button>
    ${confirmKey === 'restore' ? `<span class="confirm">Se reemplaza todo con el texto. <button class="btn danger" id="restoreyes">Sí, restaurar</button><button class="btn ghost" data-cancel>No</button></span>` : '<button class="btn ghost" id="restore">Restaurar desde el texto</button>'}</div>
  </div>
  <div class="card"><h2>Empezar de cero</h2>
    ${confirmKey === 'reset' ? `<div class="confirm">Se borran los productos, las ventas y el historial, en los dos celulares. La tienda queda vacía. <button class="btn danger" id="resetyes">Sí, borrar todo</button><button class="btn ghost" data-cancel>No</button></div>` : '<p class="muted" style="margin:0">Úsalo después de practicar: borra los productos de ejemplo, las ventas y los cierres de práctica. La tienda queda vacía para poner los productos reales.</p><button class="btn danger" id="reset">Borrar todos los datos</button>'}
  </div>
  <div class="card"><h2>Face ID o huella</h2>
    ${lockOf('parent') ? `<p class="muted" style="margin:0">Activado: para entrar al modo papás desde el inicio, el celular pide Face ID, huella o su clave.</p>
      <button class="btn ghost" id="lockoff">Desactivar</button>`
    : `<p class="muted" style="margin:0">Desactivado: cada vez que vayas al inicio tendrás que escribir la contraseña de nuevo.</p>
      <button class="btn" id="lockon">Activar Face ID o huella</button>`}
  </div>
  <div class="card"><h2>Sesión</h2>
    <p class="muted" style="margin:0">Entraste como <b>${esc(user?.email || '')}</b>.</p>
    <div class="row"><button class="btn ghost" id="home2">Cambiar de usuario</button><button class="btn danger" data-logout="parent">Cerrar sesión</button></div>
  </div>`;
}

// Reemplaza todos los datos por los de una copia (formato de la app anterior o de esta).
async function replaceAll(d, seed) {
  const [it, sa, cl, de, rc] = await Promise.all([getDocs(itemsCol()), getDocs(salesCol()), getDocs(closingsCol()), getDocs(debtsCol()), getDocs(collection(db, 'receipts'))]);
  const ops = [];
  [it, sa, cl, de, rc].forEach(snap => snap.docs.forEach(x => ops.push(b => b.delete(x.ref))));
  if (seed) { ops.push(...sampleOps()); ops.push(b => b.set(turnDoc(), { start: Date.now(), base: 0 })); }
  else {
    (d.items || []).forEach((i, n) => ops.push(b => b.set(doc(db, 'items', String(i.id || uid())), {
      name: String(i.name || 'Producto'), emoji: String(i.emoji || '🍬'), price: num(i.price), color: String(i.color || COLORS[n % COLORS.length]),
      stock: Math.round(Number(i.stock) || 0), photo: typeof i.photo === 'string' && i.photo.startsWith('data:image/') ? i.photo : null, cost: num(i.cost) || null, promoQty: num(i.promoQty) >= 2 ? num(i.promoQty) : null, promoPrice: num(i.promoQty) >= 2 && num(i.promoPrice) ? num(i.promoPrice) : null, active: i.active !== false, example: !!i.example, order: typeof i.order === 'number' ? i.order : n })));
    const t = d.turn || {};
    (t.sales || []).forEach(s => ops.push(b => b.set(doc(db, 'sales', String(s.id || uid())), {
      itemId: String(s.itemId), name: String(s.name), emoji: String(s.emoji), price: num(s.price), t: Number(s.t) || Date.now(), by: s.by === 'parent' ? 'parent' : 'kid', ...(s.ticket ? { ticket: String(s.ticket) } : {}), pay: ['transfer', 'credit'].includes(s.pay) ? s.pay : 'cash', ok: !!s.ok, ...(s.promo ? { promo: true } : {}) })));
    (d.closings || []).forEach(c => ops.push(b => b.set(doc(closingsCol()), c)));
    (d.debts || []).forEach(x => ops.push(b => b.set(doc(db, 'debts', String(x.id || uid())), {
      name: String(x.name || 'Fiado').slice(0, 30), total: num(x.total), items: Array.isArray(x.items) ? x.items.map(i => ({ name: String(i.name), emoji: String(i.emoji), price: num(i.price) })) : [],
      t: Number(x.t) || Date.now(), by: x.by === 'kid' ? 'kid' : 'parent', paid: !!x.paid, ...(x.paid ? { paidAt: Number(x.paidAt) || Date.now(), paidWith: x.paidWith === 'transfer' ? 'transfer' : 'cash', ok: !!x.ok } : {}) })));
    ops.push(b => b.set(turnDoc(), { start: Number(t.start) || Date.now(), base: num(t.base) }));
  }
  await runOps(ops);
}

function render() {
  if (screen === 'boot') { app.innerHTML = '<div class="login"><div class="logo">🍭</div><p class="muted">Cargando…</p></div>'; return; }
  if (screen === 'home') { renderHome(); return; }
  if (screen === 'login') { renderLogin(); return; }
  if (screen === 'offer') { renderOffer(); return; }
  if (screen === 'unlock') { renderUnlock(); return; }
  if (!user || !role) { screen = 'home'; renderHome(); return; }
  if (fatal) {
    app.innerHTML = `<div class="login"><div class="logo">⚠️</div><h1>Algo salió mal</h1><p class="muted">${esc(fatal)}</p>
      <button class="btn big" id="reload">Intentar de nuevo</button><button class="btn ghost big" id="home">Ir al inicio</button></div>`;
    return;
  }
  if (!ready()) { app.innerHTML = '<div class="login"><div class="logo">🍭</div><p class="muted">Cargando la tienda…</p></div>'; return; }
  mode === 'kid' ? renderKid() : renderParent();
}

// Volver a dibujar cuando llegan datos nuevos, sin perder lo que se está escribiendo.
function refresh() {
  if (!user || !role || screen !== 'app') return;
  if (document.getElementById('kiddebts')) showKidDebts();
  readForm();
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  render();
  const el = id && document.getElementById(id);
  if (el && el !== document.activeElement) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
}

// ---------- eventos ----------
app.addEventListener('click', e => {
  const t = e.target.closest('button,[data-tab]'); if (!t) return;
  if (t.dataset.who) { enter(t.dataset.who); return; }
  if (t.dataset.logout) { logoutRole(t.dataset.logout); return; }
  if (t.id === 'backhome' || t.id === 'unlockhome') { loginWho = null; loginErr = ''; if (screen === 'unlock') { stopListening(); role = null; user = null; } screen = 'home'; render(); return; }
  if (t.id === 'home' || t.id === 'home2') { goHome(); return; }
  if (t.id === 'unlock') { enter(pendingRole); return; }
  if (t.id === 'lockyes' || t.id === 'lockon') { const r = t.id === 'lockon' ? 'parent' : pendingRole;
    createLock(r).then(() => { toast('Listo: Face ID o huella activado'); if (t.id === 'lockyes') activate(r); else render(); },
      err => { console.warn(err); toast('No se pudo activar. Puedes hacerlo luego.'); if (t.id === 'lockyes') activate(r); }); return; }
  if (t.id === 'lockno') { activate(pendingRole); return; }
  if (t.id === 'lockoff') { lsSet(LOCK_KEY + 'parent', null); render(); toast('Desactivado'); return; }
  if (t.id === 'reload') { location.reload(); return; }
  if (t.dataset.sell) { pick(t.dataset.sell, t); return; }
  if (t.dataset.unpick) { unpick(+t.dataset.unpick); return; }
  if (t.id === 'clearcart') { cart = []; saveCart(); renderKid(); return; }
  if (t.id === 'pay') { askPay(); return; }
  if (t.id === 'kidfiados') { showKidDebts(); return; }
  if (t.dataset.debtpay) { payDebt(t.dataset.debtpay, t.dataset.with); return; }
  if (role !== 'parent') return;
  if (t.dataset.rc) { showReceipt(t.dataset.rc); return; } // de aquí en adelante, solo papás
  if (t.id === 'toparent') { mode = 'parent'; render(); scrollTo(0, 0); return; }
  if (t.id === 'tokid') { mode = 'kid'; editing = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; editing = null; bulk = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.hasAttribute('data-cancel')) { confirmKey = null; render(); return; }
  if (t.dataset.okticket) {
    const g = tickets(S.sales).find(x => x.id === t.dataset.okticket); if (!g) return;
    const v = !g.sales.every(s => s.ok), b = writeBatch(db);
    g.sales.forEach(s => b.update(doc(db, 'sales', s.id), { ok: v }));
    commit(b, v ? 'Transferencia confirmada' : 'Marcada como no confirmada'); return;
  }
  if (t.dataset.okdebt) { const d = S.debts.find(x => x.id === t.dataset.okdebt); if (!d) return; const b = writeBatch(db); b.update(doc(db, 'debts', d.id), { ok: !d.ok }); commit(b, d.ok ? 'Marcada como no confirmada' : 'Transferencia confirmada'); return; }
  if (t.dataset.deldebt) { confirmKey = 'deldebt:' + t.dataset.deldebt; render(); return; }
  if (t.dataset.deldebtyes) { const b = writeBatch(db); b.delete(doc(db, 'debts', t.dataset.deldebtyes)); b.delete(receiptDoc(t.dataset.deldebtyes)); commit(b, 'Fiado borrado'); confirmKey = null; return; }
  if (t.dataset.delticket) {
    const g = tickets(S.sales).find(x => x.id === t.dataset.delticket); if (!g) return;
    const b = writeBatch(db), counts = new Map();
    g.sales.forEach(s => { b.delete(doc(db, 'sales', s.id)); if (itemById(s.itemId)) counts.set(s.itemId, (counts.get(s.itemId) || 0) + 1); });
    counts.forEach((n, id) => b.update(doc(db, 'items', id), { stock: increment(n) }));
    if (S.debts.some(d => d.id === g.id && !d.paid)) b.delete(doc(db, 'debts', g.id));
    if (g.sales.some(s => s.rc)) b.delete(receiptDoc(g.id));
    commit(b, 'Venta borrada'); return;
  }
  if (t.dataset.den) { const d = +t.dataset.den; den[d] = Math.max(0, (den[d] || 0) + +t.dataset.dir); counted = String(denTotal()); render(); return; }
  if (t.id === 'close') { confirmKey = 'close'; render(); return; }
  if (t.id === 'doclose') {
    const sales = total(S.sales), base = turn().base || 0, cash = cashTotal(S.sales), tr = transferTotal(S.sales);
    const pendV = pendingTransfers(S.sales).reduce((a, g) => a + total(g.sales), 0) + debtTrPending().reduce((a, d) => a + d.total, 0);
    const cr = creditTotal(S.sales), dC = debtCash(), dT = debtTr();
    const b = writeBatch(db);
    const su = invSummary(invRows());
    const pf = profitOf(S.sales);
    b.set(doc(closingsCol()), { ...(pf.withCost ? { profit: pf.profit } : {}), start: turn().start, end: Date.now(), base, sales, expected: base + cash + dC, cashSales: cash, transferSales: tr, transferPending: pendV, creditSales: cr, debtCashPaid: dC, debtTransferPaid: dT, debtsOpen: debtsOpen().reduce((a, d) => a + d.total, 0), counted: countedValue() || 0, count: S.sales.length, items: byItem(S.sales), note,
      ...(su.counted ? { inventory: su.rows, missUnits: su.missUnits, missValue: su.missValue } : {}), receipts: turnReceipts() });
    // Las fotos de comprobantes se guardan 60 días; después se borran solas para no llenar Firebase.
    S.closings.filter(c => c.end < Date.now() - RECEIPT_DAYS * 864e5 && (c.receipts || []).length).slice(0, 20).forEach(c => {
      c.receipts.forEach(r => b.delete(receiptDoc(r.id))); b.update(doc(db, 'closings', c.id), { receipts: [] }); });
    // El inventario de la app queda igual a lo contado.
    su.rows.forEach(r => { if (r.missing !== 0) b.update(doc(db, 'items', r.itemId), { stock: r.counted }); });
    S.sales.forEach(s => b.delete(doc(db, 'sales', s.id)));
    b.set(turnDoc(), { start: Date.now(), base: 0 });
    commit(b, 'Caja cerrada y guardada');
    counted = ''; den = {}; note = ''; inv = {}; confirmKey = null; tab = 'historial'; render(); return;
  }
  // dulces
  if (t.id === 'bulk-open') { bulk = ''; editing = null; confirmKey = null; render(); scrollTo(0, 0); const ta = document.getElementById('bulktext'); ta && ta.focus(); return; }
  if (t.id === 'bulkcancel') { bulk = null; render(); return; }
  if (t.id === 'bulksave') { bulkSave(bulk || ''); return; }
  if (t.id === 'add') { bulk = null; editing = { id: null, name: '', emoji: '🍬', price: 500, color: COLORS[S.items.length % COLORS.length], stock: 10, active: true }; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.edit) { editing = { ...itemById(t.dataset.edit) }; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.emoji) { readForm(); editing.emoji = t.dataset.emoji; editing.photo = null; render(); return; }
  if (t.id === 'e-nophoto') { readForm(); editing.photo = null; render(); return; }
  if (t.dataset.color) { readForm(); editing.color = t.dataset.color; render(); return; }
  if (t.id === 'e-cancel') { editing = null; confirmKey = null; render(); return; }
  if (t.id === 'e-del') { readForm(); confirmKey = 'del'; render(); return; }
  if (t.id === 'e-del-yes') { const b = writeBatch(db); b.delete(doc(db, 'items', editing.id)); commit(b, 'Producto borrado'); editing = null; confirmKey = null; render(); return; }
  if (t.id === 'e-save') { readForm();
    if (!editing.name.trim()) { toast('Ponle un nombre al producto'); return; }
    const pq = editing.promoQty || 0, pp = editing.promoPrice || 0, promoOn = pq || pp;
    if (promoOn && (pq < 2 || !pp)) { toast('En la promo pon cuántos llevan (2 o más) y cuánto pagan'); return; }
    if (promoOn && pp >= pq * editing.price) { toast(`La promo debe salir más barata que ${fmt(pq * editing.price)}`); return; }
    const data = { name: editing.name.trim(), emoji: editing.emoji || '🍬', photo: editing.photo || null, promoQty: promoOn ? pq : null, promoPrice: promoOn ? pp : null, cost: editing.cost || null, price: editing.price, color: editing.color, stock: editing.stock + num(editing.add), active: editing.active, example: false };
    const b = writeBatch(db);
    if (editing.id) b.update(doc(db, 'items', editing.id), data);
    else b.set(doc(itemsCol()), { ...data, order: Date.now() });
    commit(b, 'Guardado'); editing = null; render(); return; }
  if (t.id === 'seed') { t.disabled = true; runOps(sampleOps()).then(() => toast('Listo: productos de ejemplo cargados'), err => { console.error(err); toast('No se pudo. Revisa el internet.'); t.disabled = false; }); return; }
  if (t.id === 'clear') { confirmKey = 'clear'; render(); return; }
  if (t.id === 'clearyes') { const b = writeBatch(db); S.items.filter(i => i.example).forEach(i => b.delete(doc(db, 'items', i.id))); commit(b); confirmKey = null; render(); return; }
  // ajustes
  if (t.id === 'copy') { const ta = document.getElementById('backup'); const ok = () => toast('Copiado');
    try { navigator.clipboard.writeText(ta.value).then(ok, () => { ta.select(); toast('Texto seleccionado: cópialo'); }); } catch (err) { ta.select(); toast('Texto seleccionado: cópialo'); } return; }
  if (t.id === 'restore') {
    try { const d = JSON.parse(document.getElementById('backup').value); if (!d.items || !d.turn) throw 0; pendingRestore = d; confirmKey = 'restore'; render(); }
    catch (err) { toast('Ese texto no es una copia válida'); } return; }
  if (t.id === 'restoreyes') { const d = pendingRestore; pendingRestore = null; confirmKey = null; render();
    toast('Restaurando…'); replaceAll(d).then(() => toast('Datos restaurados'), err => { console.error(err); toast('No se pudo restaurar'); }); return; }
  if (t.id === 'import') { confirmKey = 'import'; render(); return; }
  if (t.id === 'importyes') { const d = oldLocalData(); confirmKey = null; render(); if (!d) return;
    toast('Pasando datos…'); replaceAll(d).then(() => { try { localStorage.removeItem(OLD_KEY); } catch (e) {} toast('Datos pasados a la app nueva'); render(); },
      err => { console.error(err); toast('No se pudieron pasar los datos'); }); return; }
  if (t.id === 'reset') { confirmKey = 'reset'; render(); return; }
  if (t.id === 'resetyes') { confirmKey = null; counted = ''; den = {}; render(); toast('Borrando…');
    replaceAll({ items: [], closings: [], turn: { start: Date.now(), base: 0 } }).then(() => toast('Todo borrado. Ya pueden poner los productos reales.'), err => { console.error(err); toast('No se pudo borrar'); }); return; }
});
let pendingRestore = null;
function readForm() {
  if (!editing) return; const g = id => document.getElementById(id);
  if (!g('e-name')) return;
  editing.name = g('e-name').value; editing.price = num(g('e-price').value); editing.stock = num(g('e-stock').value);
  editing.add = g('e-add').value;
  editing.cost = num(g('e-cost').value);
  editing.promoQty = num(g('e-pq').value); editing.promoPrice = num(g('e-pp').value);
  const em = g('e-emoji').value.trim(); if (em) editing.emoji = em; editing.active = g('e-active').checked;
}
let baseT;
app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'counted') { counted = t.value.replace(/[^\d]/g, ''); refresh(); }
  if (t.id === 'base') {
    const v = num(t.value); S.turn = { ...turn(), base: v }; refresh();
    clearTimeout(baseT); baseT = setTimeout(() => { const b = writeBatch(db); b.set(turnDoc(), { base: v }, { merge: true }); commit(b); }, 600);
  }
  if (t.id === 'note') { note = t.value; }
  if (t.id === 'bulktext') { bulk = t.value; const p = document.getElementById('bulkprev'); if (p) p.innerHTML = bulkPreview(bulk); }
  if (t.dataset.inv) { inv[t.dataset.inv] = t.value.replace(/[^\d]/g, ''); refresh(); }
  if (t.id === 'e-emoji') { const v = t.value.trim(); if (v && editing) { editing.emoji = v; app.querySelectorAll('[data-emoji]').forEach(b => b.setAttribute('aria-pressed', b.dataset.emoji === v)); } }
});
app.addEventListener('change', e => {
  if (e.target.id === 'e-photo' && editing && e.target.files && e.target.files[0]) {
    readForm(); toast('Preparando la foto…');
    shrinkPhoto(e.target.files[0]).then(d => { if (!editing) return; readForm(); editing.photo = d; render(); toast('Foto lista. Toca Guardar.'); },
      () => toast('No se pudo leer esa foto'));
    return;
  } if (e.target.id === 'sound') { sound = e.target.checked; try { localStorage.setItem(SOUND_KEY, sound ? '1' : '0'); } catch (err) {} } });

try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
// Busca versiones nuevas al abrir y al volver a la app; si hay una, recarga sola (una vez).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
render();
