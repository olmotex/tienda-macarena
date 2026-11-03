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
const S = { items: [], sales: [], turn: null, closings: [], loaded: { items: false, sales: false, turn: false } };
let role = null, user = null, unsubs = [];
let sound = true;
try { sound = localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) {}

const fmt = n => '$' + Math.round(n).toLocaleString('es-CO');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const itemById = id => S.items.find(i => i.id === id);
const total = sales => sales.reduce((a, s) => a + s.price, 0);
const dt = t => new Date(t).toLocaleString('es-CO', { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });
const hr = t => new Date(t).toLocaleTimeString('es-CO', { hour:'numeric', minute:'2-digit' });
const num = v => Math.max(0, Math.round(Number(String(v).replace(/[^\d]/g, '')) || 0));

let mode = 'kid', tab = 'hoy', editing = null, confirmKey = null, counted = '', den = {}, note = '';
let loginWho = null, loginErr = '', loginBusy = false, fatal = '';
const app = document.getElementById('app');

// ---------- escritura ----------
const itemsCol = () => collection(db, 'items');
const salesCol = () => collection(db, 'sales');
const closingsCol = () => collection(db, 'closings');
const turnDoc = () => doc(db, 'meta', 'turn');

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
  counted = ''; den = {}; note = '';
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
const WHO = { kid: { icon: '👧', name: 'Soy Macarena', sub: 'Para vender en la tienda' }, parent: { icon: '👪', name: 'Somos los papás', sub: 'Dulces, precios, cierres e historial' } };
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
const cartTotal = () => cartItems().reduce((a, i) => a + i.price, 0);
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
  <div class="today"><span>☀️ Hoy vendiste</span><b class="num">${fmt(total(S.sales))}</b><small>${nT} ${nT === 1 ? 'venta' : 'ventas'}</small></div>
  <div class="grid kidgrid">${items.map(i => {
    // Siempre se puede vender: el inventario es solo una guía (si dice 0 pero hay en físico, igual se vende).
    const c = inCart(i.id), left = i.stock - c, low = left > 0 && left <= 3;
    return `<button class="candy${c ? ' picked' : ''}" data-sell="${i.id}" style="--c:${esc(i.color)}" aria-label="Agregar ${esc(i.name)} de ${fmt(i.price)}">
      ${c ? `<span class="cnt num">${c}</span>` : ''}
      ${low ? `<span class="low">Quedan ${left}</span>` : ''}
      <span class="em">${esc(i.emoji)}</span><span class="nm">${esc(i.name)}</span><span class="pr num">${fmt(i.price)}</span></button>`; }).join('')}
    ${items.length ? '' : '<p class="muted">No hay dulces todavía. Los papás los agregan desde su celular.</p>'}
  </div>
  <div class="bar cart"><div class="bar-in">
    ${ci.length ? `
      <div class="cart-head"><b>🛒 Venta ${nT + 1}</b><span class="muted">Toca un dulce de aquí para quitarlo</span></div>
      <div class="chips">${ci.map((i, n) => `<button class="chip" data-unpick="${n}" style="--c:${esc(i.color)}" aria-label="Quitar ${esc(i.name)}">${esc(i.emoji)}<small>✕</small></button>`).join('')}</div>
      <div class="cart-foot">
        <button class="clearcart" id="clearcart" aria-label="Borrar esta venta">🗑️</button>
        <div class="money"><small>Total</small><b class="num">${fmt(cartTotal())}</b></div>
        <button class="pay" id="pay">✅ Cobrar</button>
      </div>`
    : `<div class="cart-empty">🛒 <span>Toca los dulces que te compran</span></div>`}
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
function pay() {
  const ci = cartItems(); if (!ci.length) { cart = []; saveCart(); renderKid(); return; }
  const sum = cartTotal(), ticket = uid(), t = Date.now(), counts = new Map();
  const b = writeBatch(db);
  ci.forEach(it => {
    b.set(doc(salesCol()), { itemId: it.id, name: it.name, emoji: it.emoji, price: it.price, t, by: role, ticket });
    counts.set(it.id, (counts.get(it.id) || 0) + 1);
  });
  counts.forEach((n, id) => b.update(doc(db, 'items', id), { stock: increment(-n) }));
  commit(b);
  cart = []; saveCart(); cashSound(); renderKid();
  const o = document.createElement('div'); o.className = 'overlay party';
  o.innerHTML = `<div class="partybox"><div class="big">🎉</div><h2>¡Venta lista!</h2><b class="num">${fmt(sum)}</b><span>${ci.map(i => esc(i.emoji)).join(' ')}</span></div>`;
  o.addEventListener('click', () => o.remove()); document.body.appendChild(o); setTimeout(() => o.remove(), 1800);
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
function byItem(sales) {
  const m = new Map();
  sales.forEach(s => { const r = m.get(s.itemId) || { name: s.name, emoji: s.emoji, qty: 0, sum: 0 }; r.qty++; r.sum += s.price; m.set(s.itemId, r); });
  return [...m.values()].sort((a, b) => b.sum - a.sum);
}
function countedValue() { return counted === '' ? null : Number(counted) || 0; }
function denTotal() { return DENOMS.reduce((a, d) => a + d * (den[d] || 0), 0); }

function renderParent() {
  const tabs = [['hoy','Ventas de hoy'],['cierre','Cerrar caja'],['dulces','Dulces'],['historial','Historial'],['ajustes','Ajustes']];
  app.innerHTML = `
  <div class="ptop"><h1>Modo papás</h1><div class="row" style="flex-wrap:nowrap"><button class="btn" id="tokid">Ver la tienda</button><button class="lockbtn" id="home" aria-label="Inicio: cambiar de usuario">🏠</button></div></div>
  <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="panel">${({ hoy: pHoy, cierre: pCierre, dulces: pDulces, historial: pHist, ajustes: pAjustes })[tab]()}</div>`;
}

function pHoy() {
  const sales = S.sales, sum = total(sales), rows = byItem(sales), tk = tickets(sales);
  return `
  <div class="card">
    <div class="lbl">Turno abierto desde ${esc(dt(turn().start))}</div>
    <div class="kpis"><div class="kpi"><span class="lbl">Vendido</span><b class="num">${fmt(sum)}</b></div>
    <div class="kpi"><span class="lbl">Ventas · dulces</span><b class="num">${tk.length} · ${sales.length}</b></div></div>
    <button class="btn big" data-tab="cierre">Cerrar caja</button>
  </div>
  <div class="card"><h2>Por dulce</h2>
    ${rows.length ? `<div class="tw"><table><thead><tr><th>Dulce</th><th class="r">Cant.</th><th class="r">Total</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.emoji)} ${esc(r.name)}</td><td class="r num">${r.qty}</td><td class="r num">${fmt(r.sum)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Todavía no hay ventas en este turno.</p>'}
  </div>
  <div class="card"><h2>Cada venta</h2>
    <p class="muted" style="margin:0">Si una venta quedó mal, bórrala aquí. Los dulces vuelven al inventario.</p>
    ${tk.length ? tk.map((g, n) => ({ g, n: n + 1 })).reverse().map(({ g, n }) => `<div class="sale"><span><b>Venta ${n}</b> <span class="muted num">· ${hr(g.t)}${g.by === 'parent' ? ' · papás' : ''}</span><br>${g.sales.map(s => esc(s.emoji)).join(' ')}</span>
      <span class="row" style="gap:4px;flex-wrap:nowrap"><b class="num">${fmt(total(g.sales))}</b><button data-delticket="${esc(g.id)}">Borrar</button></span></div>`).join('') : '<p class="muted">Sin ventas.</p>'}
  </div>`;
}
function pCierre() {
  const sales = total(S.sales), base = turn().base || 0, expected = base + sales, c = countedValue();
  let cls = 'none', title = 'Escribe cuánta plata hay', sub = '';
  if (c !== null) { const d = c - expected;
    if (d === 0) { cls = 'ok'; title = '¡Cuadra perfecto!'; sub = 'La plata coincide con las ventas.'; }
    else if (d < 0) { cls = 'bad'; title = 'Falta ' + fmt(-d); sub = 'Hay menos plata de la esperada. Revisa la lista de ventas.'; }
    else { cls = 'plus'; title = 'Sobra ' + fmt(d); sub = 'Hay más plata. Puede ser un dulce que no se marcó.'; } }
  return `
  <div class="card">
    <h2>1. Sencillo inicial</h2>
    <p class="muted" style="margin:0">La plata que había en la caja al abrir (para dar vueltas). Si empezó vacía, deja 0.</p>
    <div class="field"><label class="lbl" for="base">Sencillo inicial</label><input id="base" inputmode="numeric" value="${base || ''}" placeholder="0"></div>
  </div>
  <div class="card">
    <h2>2. Cuenta la plata de la caja</h2>
    <div class="field"><label class="lbl" for="counted">Total contado</label><input id="counted" inputmode="numeric" value="${esc(counted)}" placeholder="Ej: 12500"></div>
    <details ${denTotal() ? 'open' : ''}><summary class="lbl" style="cursor:pointer">Contar por billetes y monedas</summary>
      <div class="denoms" style="margin-top:10px">${DENOMS.map(d => `<div class="den"><span class="num">${fmt(d)}</span>
        <span class="step"><button data-den="${d}" data-dir="-1" aria-label="Quitar ${fmt(d)}">−</button><output class="num">${den[d] || 0}</output><button data-den="${d}" data-dir="1" aria-label="Agregar ${fmt(d)}">+</button></span></div>`).join('')}</div>
      <p class="muted num" style="margin:8px 0 0">Suma de billetes y monedas: <b>${fmt(denTotal())}</b></p>
    </details>
  </div>
  <div class="card">
    <h2>3. Resultado</h2>
    <div class="tw"><table><tbody>
      <tr><td>Ventas del turno (${S.sales.length} dulces)</td><td class="r num">${fmt(sales)}</td></tr>
      <tr><td>+ Sencillo inicial</td><td class="r num">${fmt(base)}</td></tr>
      <tr><td><b>Debería haber</b></td><td class="r num"><b>${fmt(expected)}</b></td></tr>
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
    <h2>${it.id ? 'Editar dulce' : 'Nuevo dulce'}</h2>
    <div class="row">
      <div class="field"><label class="lbl" for="e-name">Nombre</label><input id="e-name" value="${esc(it.name)}" maxlength="22"></div>
      <div class="field"><label class="lbl" for="e-price">Precio</label><input id="e-price" inputmode="numeric" value="${it.price || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label class="lbl" for="e-stock">Unidades en la tienda</label><input id="e-stock" inputmode="numeric" value="${it.stock ?? 0}"></div>
      <div class="field"><label class="lbl" for="e-add">Llegaron más (sumar)</label><input id="e-add" inputmode="numeric" placeholder="0" value="${esc(it.add || '')}"></div>
    </div>
    <span class="lbl">Dibujo</span>
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
function pDulces() {
  const ex = S.items.some(i => i.example);
  return `
  ${editing ? itemForm(editing) : ''}
  ${ex ? `<div class="card" style="background:var(--soft)"><b>Estos son dulces de ejemplo.</b><span class="muted">Cambia nombres y precios por los reales, o bórralos todos y agrega los tuyos.</span>
    ${confirmKey === 'clear' ? `<div class="confirm">¿Borrar todos los dulces de ejemplo? <button class="btn danger" id="clearyes">Sí, borrar</button><button class="btn ghost" data-cancel>No</button></div>` : '<button class="btn ghost" id="clear">Borrar los de ejemplo</button>'}</div>` : ''}
  <div class="card">
    <div class="row" style="justify-content:space-between"><h2>${S.items.length} dulces</h2><button class="btn" id="add">+ Agregar dulce</button></div>
    <div>${S.items.map(i => { const st = i.stock < 0 ? `<span class="pill out">Se vendieron ${-i.stock} de más: actualiza las unidades</span>` : i.stock === 0 ? '<span class="pill out">Agotado</span>' : i.stock <= 3 ? `<span class="pill low">Quedan ${i.stock}</span>` : `<span class="pill">${i.stock} und.</span>`;
      return `<div class="item"><div class="sw" style="--c:${esc(i.color)}">${esc(i.emoji)}</div>
      <div class="t"><b>${esc(i.name)}${i.active === false ? ' <span class="pill">oculto</span>' : ''}</b><small class="num">${fmt(i.price)} · </small>${st}</div>
      <button class="btn ghost" data-edit="${i.id}">Editar</button></div>`; }).join('')}</div>
  </div>`;
}

function pHist() {
  const cl = S.closings;
  if (!cl.length) return '<div class="card"><h2>Historial de cierres</h2><p class="muted">Aquí quedan guardados los cierres de caja. Todavía no hay ninguno.</p></div>';
  const tot = cl.reduce((a, c) => a + c.sales, 0), diffs = cl.reduce((a, c) => a + (c.counted - c.expected), 0);
  return `<div class="card"><div class="kpis">
    <div class="kpi"><span class="lbl">Vendido en total</span><b class="num">${fmt(tot)}</b></div>
    <div class="kpi"><span class="lbl">Diferencias</span><b class="num" style="color:${diffs === 0 ? 'var(--good)' : diffs < 0 ? 'var(--bad)' : 'var(--warn)'}">${diffs > 0 ? '+' : ''}${fmt(diffs).replace('$-', '-$')}</b></div></div></div>
  <div class="card"><h2>Cierres</h2>${cl.slice().reverse().map(c => { const d = c.counted - c.expected;
    return `<details class="hist"><summary><span>${esc(dt(c.end))}<br><small class="muted num">${c.count} dulces · ${fmt(c.sales)}</small></span>
      <span class="pill ${d === 0 ? '' : d < 0 ? 'out' : 'low'} num">${d === 0 ? 'Cuadró' : d < 0 ? 'Faltó ' + fmt(-d) : 'Sobró ' + fmt(d)}</span></summary>
      <div class="tw"><table><tbody>
      <tr><td>Sencillo inicial</td><td class="r num">${fmt(c.base)}</td></tr><tr><td>Debía haber</td><td class="r num">${fmt(c.expected)}</td></tr>
      <tr><td>Se contó</td><td class="r num">${fmt(c.counted)}</td></tr>
      ${(c.items || []).map(r => `<tr><td class="muted">${esc(r.emoji)} ${esc(r.name)} × ${r.qty}</td><td class="r num muted">${fmt(r.sum)}</td></tr>`).join('')}
      </tbody></table></div>${c.note ? `<p class="muted">Nota: ${esc(c.note)}</p>` : ''}</details>`; }).join('')}</div>`;
}

function oldLocalData() {
  try { const raw = localStorage.getItem(OLD_KEY); if (!raw) return null; const d = JSON.parse(raw); return d && d.items ? d : null; } catch (e) { return null; }
}
function backupJSON() {
  const strip = ({ id, ...rest }) => ({ id, ...rest });
  return JSON.stringify({
    items: S.items.map(strip),
    turn: { start: turn().start, base: turn().base || 0, sales: S.sales.map(s => ({ id: s.id, itemId: s.itemId, name: s.name, emoji: s.emoji, price: s.price, t: s.t, by: s.by, ticket: s.ticket || null })) },
    closings: S.closings.map(({ id, ...c }) => c)
  });
}
function pAjustes() {
  const old = oldLocalData();
  return `
  ${old ? `<div class="card" style="background:var(--soft)"><h2>Datos de la versión anterior</h2>
    <p class="muted" style="margin:0">Este celular tiene datos guardados de la app anterior (${old.items.length} dulces, ${(old.closings || []).length} cierres). Puedes pasarlos a la app nueva. Esto reemplaza lo que hay ahora.</p>
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
    ${confirmKey === 'reset' ? `<div class="confirm">Se borra todo: dulces, ventas e historial, en los dos celulares. <button class="btn danger" id="resetyes">Sí, borrar todo</button><button class="btn ghost" data-cancel>No</button></div>` : '<button class="btn danger" id="reset">Borrar todos los datos</button>'}
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
  const [it, sa, cl] = await Promise.all([getDocs(itemsCol()), getDocs(salesCol()), getDocs(closingsCol())]);
  const ops = [];
  [it, sa, cl].forEach(snap => snap.docs.forEach(x => ops.push(b => b.delete(x.ref))));
  if (seed) { ops.push(...sampleOps()); ops.push(b => b.set(turnDoc(), { start: Date.now(), base: 0 })); }
  else {
    (d.items || []).forEach((i, n) => ops.push(b => b.set(doc(db, 'items', String(i.id || uid())), {
      name: String(i.name || 'Dulce'), emoji: String(i.emoji || '🍬'), price: num(i.price), color: String(i.color || COLORS[n % COLORS.length]),
      stock: Math.round(Number(i.stock) || 0), active: i.active !== false, example: !!i.example, order: typeof i.order === 'number' ? i.order : n })));
    const t = d.turn || {};
    (t.sales || []).forEach(s => ops.push(b => b.set(doc(db, 'sales', String(s.id || uid())), {
      itemId: String(s.itemId), name: String(s.name), emoji: String(s.emoji), price: num(s.price), t: Number(s.t) || Date.now(), by: s.by === 'parent' ? 'parent' : 'kid', ...(s.ticket ? { ticket: String(s.ticket) } : {}) })));
    (d.closings || []).forEach(c => ops.push(b => b.set(doc(closingsCol()), c)));
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
  if (t.id === 'pay') { pay(); return; }
  if (role !== 'parent') return; // de aquí en adelante, solo papás
  if (t.id === 'toparent') { mode = 'parent'; render(); scrollTo(0, 0); return; }
  if (t.id === 'tokid') { mode = 'kid'; editing = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; editing = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.hasAttribute('data-cancel')) { confirmKey = null; render(); return; }
  if (t.dataset.delticket) {
    const g = tickets(S.sales).find(x => x.id === t.dataset.delticket); if (!g) return;
    const b = writeBatch(db), counts = new Map();
    g.sales.forEach(s => { b.delete(doc(db, 'sales', s.id)); if (itemById(s.itemId)) counts.set(s.itemId, (counts.get(s.itemId) || 0) + 1); });
    counts.forEach((n, id) => b.update(doc(db, 'items', id), { stock: increment(n) }));
    commit(b, 'Venta borrada'); return;
  }
  if (t.dataset.den) { const d = +t.dataset.den; den[d] = Math.max(0, (den[d] || 0) + +t.dataset.dir); counted = String(denTotal()); render(); return; }
  if (t.id === 'close') { confirmKey = 'close'; render(); return; }
  if (t.id === 'doclose') {
    const sales = total(S.sales), base = turn().base || 0;
    const b = writeBatch(db);
    b.set(doc(closingsCol()), { start: turn().start, end: Date.now(), base, sales, expected: base + sales, counted: countedValue() || 0, count: S.sales.length, items: byItem(S.sales), note });
    S.sales.forEach(s => b.delete(doc(db, 'sales', s.id)));
    b.set(turnDoc(), { start: Date.now(), base: 0 });
    commit(b, 'Caja cerrada y guardada');
    counted = ''; den = {}; note = ''; confirmKey = null; tab = 'historial'; render(); return;
  }
  // dulces
  if (t.id === 'add') { editing = { id: null, name: '', emoji: '🍬', price: 500, color: COLORS[S.items.length % COLORS.length], stock: 10, active: true }; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.edit) { editing = { ...itemById(t.dataset.edit) }; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.emoji) { readForm(); editing.emoji = t.dataset.emoji; render(); return; }
  if (t.dataset.color) { readForm(); editing.color = t.dataset.color; render(); return; }
  if (t.id === 'e-cancel') { editing = null; confirmKey = null; render(); return; }
  if (t.id === 'e-del') { readForm(); confirmKey = 'del'; render(); return; }
  if (t.id === 'e-del-yes') { const b = writeBatch(db); b.delete(doc(db, 'items', editing.id)); commit(b, 'Dulce borrado'); editing = null; confirmKey = null; render(); return; }
  if (t.id === 'e-save') { readForm();
    if (!editing.name.trim()) { toast('Ponle un nombre al dulce'); return; }
    const data = { name: editing.name.trim(), emoji: editing.emoji || '🍬', price: editing.price, color: editing.color, stock: editing.stock + num(editing.add), active: editing.active, example: false };
    const b = writeBatch(db);
    if (editing.id) b.update(doc(db, 'items', editing.id), data);
    else b.set(doc(itemsCol()), { ...data, order: Date.now() });
    commit(b, 'Guardado'); editing = null; render(); return; }
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
    replaceAll(null, true).then(() => toast('Todo borrado'), err => { console.error(err); toast('No se pudo borrar'); }); return; }
});
let pendingRestore = null;
function readForm() {
  if (!editing) return; const g = id => document.getElementById(id);
  if (!g('e-name')) return;
  editing.name = g('e-name').value; editing.price = num(g('e-price').value); editing.stock = num(g('e-stock').value);
  editing.add = g('e-add').value;
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
  if (t.id === 'e-emoji') { const v = t.value.trim(); if (v && editing) { editing.emoji = v; app.querySelectorAll('[data-emoji]').forEach(b => b.setAttribute('aria-pressed', b.dataset.emoji === v)); } }
});
app.addEventListener('change', e => { if (e.target.id === 'sound') { sound = e.target.checked; try { localStorage.setItem(SOUND_KEY, sound ? '1' : '0'); } catch (err) {} } });

try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
render();
