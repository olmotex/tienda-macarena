// La tienda de Macarena: app independiente con datos compartidos en Firebase.
// Dos usuarios: Macarena (solo vende) y Papás (todo: dulces, cierres, historial, ajustes).
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, connectAuthEmulator,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  query, orderBy, writeBatch, increment, getDocs, setDoc, connectFirestoreEmulator
} from './vendor/firebase.js';
import { firebaseConfig, USERS } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = initializeFirestore(fbApp, {}); }
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  // Pruebas locales con el emulador de Firebase.
  if (new URLSearchParams(location.search).has('emu')) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
}

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

onAuthStateChanged(auth, u => {
  unsubs.forEach(f => f()); unsubs = [];
  S.items = []; S.sales = []; S.turn = null; S.closings = []; S.loaded = { items: false, sales: false, turn: false };
  user = u; role = roleOf(u); fatal = '';
  mode = role === 'parent' ? 'parent' : 'kid'; tab = 'hoy'; editing = null; confirmKey = null;
  if (u && role) listen();
  render();
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

// ---------- LOGIN ----------
function renderLogin() {
  if (!loginWho) {
    app.innerHTML = `
    <div class="login">
      <div class="logo">🍭</div>
      <h1>La tienda de Macarena</h1>
      <p class="muted">¿Quién va a usar este celular?</p>
      <button class="who" data-who="kid"><span>👧</span><b>Soy Macarena</b><small>Para vender en la tienda</small></button>
      <button class="who" data-who="parent"><span>👪</span><b>Somos los papás</b><small>Dulces, precios, cierres e historial</small></button>
    </div>`;
    return;
  }
  const w = USERS[loginWho];
  app.innerHTML = `
  <form class="login" id="loginform">
    <div class="logo">${loginWho === 'kid' ? '👧' : '👪'}</div>
    <h1>${loginWho === 'kid' ? 'Celular de Macarena' : 'Celular de los papás'}</h1>
    <p class="muted">Escribe la contraseña de <b>${esc(w.email)}</b>. Solo se pide una vez en este celular.</p>
    <div class="field"><label class="lbl" for="pw">Contraseña</label>
      <input id="pw" type="password" autocomplete="current-password" required></div>
    ${loginErr ? `<p class="err">${esc(loginErr)}</p>` : ''}
    <button class="btn big" type="submit" ${loginBusy ? 'disabled' : ''}>${loginBusy ? 'Entrando…' : 'Entrar'}</button>
    <button class="btn ghost big" type="button" id="backwho">Volver</button>
  </form>`;
  setTimeout(() => document.getElementById('pw')?.focus(), 50);
}
app.addEventListener('submit', async e => {
  if (e.target.id !== 'loginform') return;
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  loginBusy = true; loginErr = ''; renderLogin();
  try { await signInWithEmailAndPassword(auth, USERS[loginWho].email, pw); loginWho = null; }
  catch (err) {
    const c = err && err.code || '';
    loginErr = c.includes('network') ? 'No hay internet. Conéctate e intenta de nuevo.'
      : c.includes('too-many') ? 'Demasiados intentos. Espera un rato e intenta de nuevo.'
      : 'Contraseña incorrecta.';
  }
  loginBusy = false;
  if (!user) renderLogin();
});

// ---------- MODO MACARENA ----------
function soldCount(id) { return S.sales.filter(s => s.itemId === id).length; }
function myLastSale() { for (let i = S.sales.length - 1; i >= 0; i--) if (S.sales[i].by === role) return S.sales[i]; return null; }
function renderKid() {
  const items = S.items.filter(i => i.active);
  const sum = total(S.sales);
  const last = myLastSale();
  app.innerHTML = `
  <div class="kidtop">
    <h1 id="kidtitle">La tienda de Macarena</h1>
    ${role === 'parent' ? '<button class="btn ghost" id="toparent">Modo papás</button>' : ''}
  </div>
  <div class="grid">${items.map(i => {
    const c = soldCount(i.id), out = i.stock <= 0, low = !out && i.stock <= 3;
    return `<button class="candy${out ? ' out' : ''}" data-sell="${i.id}" style="--c:${esc(i.color)}" aria-label="Vender ${esc(i.name)} a ${fmt(i.price)}">
      ${c ? `<span class="cnt num">${c}</span>` : ''}
      ${out ? '<span class="low">Se acabó</span>' : low ? `<span class="low">Quedan ${i.stock}</span>` : ''}
      <span class="em">${esc(i.emoji)}</span><span class="nm">${esc(i.name)}</span><span class="pr num">${fmt(i.price)}</span></button>`; }).join('')}
    ${items.length ? '' : '<p class="muted">No hay dulces todavía. Los papás los agregan desde su celular.</p>'}
  </div>
  <div class="bar"><div class="bar-in">
    <div class="money"><small>Plata de hoy · ${S.sales.length} dulces</small><b class="num">${fmt(sum)}</b></div>
    <button class="undo" id="undo" ${last ? '' : 'disabled'}>↩️ Deshacer</button>
  </div></div>`;
}
function sell(id, el) {
  const it = itemById(id); if (!it) return;
  if (it.stock <= 0) { toast(`No quedan ${it.name}`); return; }
  const r = el.getBoundingClientRect();
  const b = writeBatch(db);
  b.set(doc(salesCol()), { itemId: it.id, name: it.name, emoji: it.emoji, price: it.price, t: Date.now(), by: role });
  b.update(doc(db, 'items', it.id), { stock: increment(-1) });
  commit(b);
  ding();
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = '+' + fmt(it.price);
  f.style.left = (r.left + r.width / 2 - 50) + 'px'; f.style.top = (r.top + 10) + 'px'; document.body.appendChild(f); setTimeout(() => f.remove(), 900);
  setTimeout(() => { const nb = app.querySelector(`[data-sell="${id}"]`); if (nb) nb.classList.add('pop'); }, 0);
  toast(`¡Vendiste ${it.emoji} ${it.name}!`);
}
function undo() {
  const s = myLastSale(); if (!s) return;
  const b = writeBatch(db);
  b.delete(doc(db, 'sales', s.id));
  if (itemById(s.itemId)) b.update(doc(db, 'items', s.itemId), { stock: increment(1) });
  commit(b); toast(`Se quitó ${s.emoji} ${s.name}`);
}

// Cerrar sesión en el celular de Macarena: mantener presionado el título 3 segundos.
let pressT;
app.addEventListener('pointerdown', e => {
  if (e.target.id !== 'kidtitle' || role !== 'kid') return;
  pressT = setTimeout(() => {
    confirmKey = 'logout';
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="pinbox" role="dialog"><h2>¿Cerrar sesión?</h2><p class="muted">Para volver a entrar se necesita la contraseña de Macarena.</p>
      <button class="btn big" data-lo="yes">Sí, cerrar sesión</button><button class="btn ghost big" data-lo="no">No</button></div>`;
    o.addEventListener('click', ev => { const k = ev.target.closest('[data-lo]')?.dataset.lo; if (k === 'yes') signOut(auth); if (k) o.remove(); });
    document.body.appendChild(o);
  }, 3000);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => app.addEventListener(ev, () => clearTimeout(pressT)));

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
  <div class="ptop"><h1>Modo papás</h1><button class="btn" id="tokid">Ver la tienda</button></div>
  <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="panel">${({ hoy: pHoy, cierre: pCierre, dulces: pDulces, historial: pHist, ajustes: pAjustes })[tab]()}</div>`;
}

function pHoy() {
  const sales = S.sales, sum = total(sales), rows = byItem(sales);
  return `
  <div class="card">
    <div class="lbl">Turno abierto desde ${esc(dt(turn().start))}</div>
    <div class="kpis"><div class="kpi"><span class="lbl">Vendido</span><b class="num">${fmt(sum)}</b></div>
    <div class="kpi"><span class="lbl">Dulces</span><b class="num">${sales.length}</b></div></div>
    <button class="btn big" data-tab="cierre">Cerrar caja</button>
  </div>
  <div class="card"><h2>Por dulce</h2>
    ${rows.length ? `<div class="tw"><table><thead><tr><th>Dulce</th><th class="r">Cant.</th><th class="r">Total</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.emoji)} ${esc(r.name)}</td><td class="r num">${r.qty}</td><td class="r num">${fmt(r.sum)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Todavía no hay ventas en este turno.</p>'}
  </div>
  <div class="card"><h2>Cada venta</h2>
    <p class="muted" style="margin:0">Si Macarena tocó un dulce por error, bórralo aquí. El dulce vuelve al inventario.</p>
    ${sales.length ? sales.slice().reverse().map(s => `<div class="sale"><span>${esc(s.emoji)} ${esc(s.name)} <span class="muted num">· ${hr(s.t)}${s.by === 'parent' ? ' · papás' : ''}</span></span>
      <span class="row" style="gap:4px"><b class="num">${fmt(s.price)}</b><button data-delsale="${s.id}">Borrar</button></span></div>`).join('') : '<p class="muted">Sin ventas.</p>'}
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
    <div>${S.items.map(i => { const st = i.stock <= 0 ? '<span class="pill out">Agotado</span>' : i.stock <= 3 ? `<span class="pill low">Quedan ${i.stock}</span>` : `<span class="pill">${i.stock} und.</span>`;
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
    turn: { start: turn().start, base: turn().base || 0, sales: S.sales.map(s => ({ id: s.id, itemId: s.itemId, name: s.name, emoji: s.emoji, price: s.price, t: s.t, by: s.by })) },
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
  <div class="card"><h2>Sesión</h2>
    <p class="muted" style="margin:0">Entraste como <b>${esc(user?.email || '')}</b>.</p>
    <button class="btn ghost" id="logout">Cerrar sesión en este celular</button>
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
      itemId: String(s.itemId), name: String(s.name), emoji: String(s.emoji), price: num(s.price), t: Number(s.t) || Date.now(), by: s.by === 'parent' ? 'parent' : 'kid' })));
    (d.closings || []).forEach(c => ops.push(b => b.set(doc(closingsCol()), c)));
    ops.push(b => b.set(turnDoc(), { start: Number(t.start) || Date.now(), base: num(t.base) }));
  }
  await runOps(ops);
}

function render() {
  if (!user) { renderLogin(); return; }
  if (!role) {
    app.innerHTML = `<div class="login"><div class="logo">🔒</div><h1>Usuario no reconocido</h1>
      <p class="muted">${esc(user.email || '')} no es el usuario de Macarena ni el de los papás.</p>
      <button class="btn big" id="logout">Cerrar sesión</button></div>`;
    return;
  }
  if (fatal) {
    app.innerHTML = `<div class="login"><div class="logo">⚠️</div><h1>Algo salió mal</h1><p class="muted">${esc(fatal)}</p>
      <button class="btn big" id="reload">Intentar de nuevo</button><button class="btn ghost big" id="logout">Cerrar sesión</button></div>`;
    return;
  }
  if (!ready()) { app.innerHTML = '<div class="login"><div class="logo">🍭</div><p class="muted">Cargando la tienda…</p></div>'; return; }
  mode === 'kid' ? renderKid() : renderParent();
}

// Volver a dibujar cuando llegan datos nuevos, sin perder lo que se está escribiendo.
function refresh() {
  if (!user || !role) return;
  readForm();
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  render();
  const el = id && document.getElementById(id);
  if (el && el !== document.activeElement) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
}

// ---------- eventos ----------
app.addEventListener('click', e => {
  const t = e.target.closest('button,[data-tab]'); if (!t) return;
  if (t.dataset.who) { loginWho = t.dataset.who; loginErr = ''; renderLogin(); return; }
  if (t.id === 'backwho') { loginWho = null; loginErr = ''; renderLogin(); return; }
  if (t.id === 'logout') { signOut(auth); return; }
  if (t.id === 'reload') { location.reload(); return; }
  if (t.dataset.sell) { sell(t.dataset.sell, t); return; }
  if (t.id === 'undo') { undo(); return; }
  if (role !== 'parent') return; // de aquí en adelante, solo papás
  if (t.id === 'toparent') { mode = 'parent'; render(); scrollTo(0, 0); return; }
  if (t.id === 'tokid') { mode = 'kid'; editing = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; editing = null; confirmKey = null; render(); scrollTo(0, 0); return; }
  if (t.hasAttribute('data-cancel')) { confirmKey = null; render(); return; }
  if (t.dataset.delsale) {
    const s = S.sales.find(x => x.id === t.dataset.delsale); if (!s) return;
    const b = writeBatch(db); b.delete(doc(db, 'sales', s.id));
    if (itemById(s.itemId)) b.update(doc(db, 'items', s.itemId), { stock: increment(1) });
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
