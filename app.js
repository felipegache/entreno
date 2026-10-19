/* Entreno — lógica de la app: estado, motor de progresión, temporizador y pantallas. */
'use strict';

const APP_VERSION = '1.0.0';
const STORE_KEY = 'entreno.v1';

/* ============================================================
   Utilidades
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function isoDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fmtLong(s) { const d = parseISO(s); return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`; }
function fmtShort(s) { const d = parseISO(s); return `${d.getDate()}/${d.getMonth() + 1}`; }
function fmtClock(sec) { sec = Math.max(0, Math.ceil(sec)); const m = Math.floor(sec / 60); const s = sec % 60; return m ? `${m}:${pad(s)}` : String(s); }
function fmtNum(n) { return String(n).replace('.', ','); }
function num(v) { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function uid() { return Math.random().toString(36).slice(2, 9); }

/* ============================================================
   Estado persistente
   ============================================================ */
function defaultState() {
  return {
    version: 1,
    createdAt: isoDate(),
    settings: { timerMode: 'guiado', countdown: 5, sound: true, vibrate: true },
    sessions: [],
    current: null,
    levels: {},
    streaks: {},
    totals: {},
    checkins: {},
    tests: [],
    flags: { football: false, reduced: false, footballAfter: false },
    weekAdj: 0,
    deloadLeft: 0,
    gapHandled: null,
    videos: {},
    micro: [],
    extras: [],
    chapters: [],
    active: 'fase1'
  };
}
let S = loadState();
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const st = JSON.parse(raw);
      return Object.assign(defaultState(), st, { settings: Object.assign(defaultState().settings, st.settings || {}), flags: Object.assign(defaultState().flags, st.flags || {}) });
    }
  } catch (e) { /* datos ilegibles: se arranca limpio */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast('No se pudo guardar en el teléfono. Exportá un respaldo.'); }
}
if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }

/* ============================================================
   Capítulos (programas de entrenamiento cargables)
   ============================================================ */
const BASE_EX = Object.assign({}, EX);
const BUILTIN = { id: 'fase1', name: 'Fase 1 · Reacondicionamiento', short: 'Fase 1', weeks: 6, rotation: ROTATION, days: { L: 1, M: 3, V: 5 }, preMatch: 'V', postMatch: 'L', ramp: RAMP, sessions: SESSIONS, exercises: {}, builtin: true };
function allChapters() { return [BUILTIN, ...(S.chapters || [])]; }
function prog() { return allChapters().find((c) => c.id === S.active) || BUILTIN; }
function rebuildEx() {
  Object.keys(EX).forEach((k) => { if (!BASE_EX[k]) delete EX[k]; });
  Object.assign(EX, BASE_EX);
  (S.chapters || []).forEach((c) => Object.assign(EX, c.exercises || {}));
}
function totalSessions(p = prog()) { return p.weeks * p.rotation.length; }
function sessName(s) { return s.name || (BUILTIN.sessions[s.type] || {}).name || s.type; }
function validateChapter(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['El archivo no tiene un capítulo.'];
  if (!c.id || !/^[a-z0-9_-]{2,40}$/.test(c.id)) errs.push('Falta un id válido (minúsculas, números, guiones).');
  if (c.id === 'fase1') errs.push('El id "fase1" está reservado.');
  if (!c.name) errs.push('Falta el nombre.');
  if (!Number.isInteger(c.weeks) || c.weeks < 1 || c.weeks > 52) errs.push('weeks tiene que ser un número de semanas entre 1 y 52.');
  if (!Array.isArray(c.rotation) || !c.rotation.length) errs.push('Falta la rotación de sesiones.');
  const exs = Object.assign({}, BASE_EX, c.exercises || {});
  Object.entries(c.exercises || {}).forEach(([k, e]) => { if (!e.name || !e.unit) errs.push(`El ejercicio ${k} necesita name y unit.`); });
  (c.rotation || []).forEach((k) => {
    const sd = c.sessions && c.sessions[k];
    if (!sd || !Array.isArray(sd.items)) { errs.push(`Falta la sesión ${k}.`); return; }
    sd.items.forEach((it) => { if (!exs[it.ex]) errs.push(`La sesión ${k} usa un ejercicio desconocido: ${it.ex}.`); if (it.pre && !exs[it.pre]) errs.push(`Ejercicio previo desconocido: ${it.pre}.`); });
  });
  for (let w = 1; w <= (c.weeks || 0); w++) { const r = c.ramp && c.ramp[w]; if (!r || r.sets == null) errs.push(`Falta la semana ${w} en la rampa.`); }
  return errs.slice(0, 8);
}

/* ============================================================
   Motor del plan
   ============================================================ */
function phaseSessions() { const id = prog().id; return S.sessions.filter((s) => (s.chapter || 'fase1') === id); }
function weekInfo() {
  const count = phaseSessions().length;
  const idx = Math.max(0, count - (S.weekAdj || 0));
  const P = prog(); const per = P.rotation.length; const W = P.weeks;
  const phaseDone = idx >= W * per;
  const lastNormal = (() => { for (let w = W; w >= 1; w--) if (!P.ramp[w].deload) return w; return W; })();
  let week = phaseDone ? lastNormal : Math.min(W, Math.floor(idx / per) + 1);
  const early = S.deloadLeft > 0 && !phaseDone;
  const deloadWeek = (() => { for (let w = 1; w <= W; w++) if (P.ramp[w].deload) return w; return null; })();
  const paramWeek = early && deloadWeek ? deloadWeek : week;
  const inWeek = phaseDone ? 0 : (idx % per);
  const R = Object.assign({}, P.ramp[paramWeek]);
  if (early && !deloadWeek) { R.sets = Math.max(1, Math.ceil(R.sets / 2)); R.setsArms = Math.max(1, Math.ceil((R.setsArms || R.sets) / 2)); R.deload = true; }
  return { count, idx, week, paramWeek, early, phaseDone, inWeek, R, P, total: W * per };
}
function rirMin(t) { return Number(String(t).split('-')[0]); }

function nextType() {
  if (S.current) return S.current.type;
  const last = S.sessions[S.sessions.length - 1];
  const P = prog(); const rot = P.rotation;
  const mine = phaseSessions(); const lastMine = mine[mine.length - 1];
  if (!lastMine) {
    const d = new Date().getDay();
    const days = P.days || {};
    let best = rot[0], bestGap = 8;
    rot.forEach((k) => { const g = ((days[k] ?? 1) - d + 7) % 7; if (g < bestGap) { bestGap = g; best = k; } });
    return best;
  }
  return rot[(rot.indexOf(lastMine.type) + 1) % rot.length];
}

function lastSessionDate() { const l = S.sessions[S.sessions.length - 1]; return l ? l.date : null; }

/* Regla 14: semanas perdidas */
function handleGap() {
  const last = lastSessionDate();
  if (!last || S.gapHandled === last) return null;
  const gap = daysBetween(last, isoDate());
  const wi = weekInfo();
  if (gap >= 21) {
    S.weekAdj = wi.count; S.gapHandled = last; save();
    return 'Pasaron 3 semanas o más sin entrenar: volvés a la semana 1 con los niveles que ya tenías.';
  }
  if (gap >= 8 && wi.week > 1 && !wi.phaseDone) {
    const target = (wi.week - 2) * 3;
    S.weekAdj = wi.count - target; S.gapHandled = last; save();
    return `Pasó más de una semana sin entrenar: repetís la semana ${wi.week - 1} antes de seguir.`;
  }
  return null;
}

function checkinList() { return Object.entries(S.checkins).map(([d, c]) => ({ d, ...c })).sort((a, b) => a.d < b.d ? -1 : 1); }

function ankleLevel() {
  const today = isoDate();
  let max = 0;
  checkinList().forEach((c) => { if (c.ankle != null && daysBetween(c.d, today) <= 7) max = Math.max(max, c.ankle); });
  S.sessions.forEach((s) => { if (s.ankle != null && daysBetween(s.date, today) <= 7) max = Math.max(max, s.ankle); });
  (S.extras || []).forEach((x) => { if (x.ankle != null && daysBetween(x.date, today) <= 7) max = Math.max(max, x.ankle); });
  return max;
}
function baseHr() {
  const t = S.tests.find((x) => x.values && x.values.hr);
  if (t) return t.values.hr;
  const hrs = checkinList().filter((c) => c.hr).slice(0, 3).map((c) => c.hr);
  return hrs.length === 3 ? mean(hrs) : null;
}
function hrFlag() {
  const list = checkinList().filter((c) => c.hr);
  const b = baseHr();
  if (!b || list.length < 10) return null;
  const recent = list.slice(-3).filter((c) => daysBetween(c.d, isoDate()) <= 5);
  if (recent.length < 3) return null;
  const m = mean(recent.map((c) => c.hr));
  return m >= b + 5 ? Math.round(m - b) : null;
}
function deloadSuggest() {
  const list = checkinList().slice(-3);
  if (list.length < 3 || S.deloadLeft > 0) return false;
  if (daysBetween(list[0].d, isoDate()) > 4) return false;
  return list.every((c) => c.energy != null && c.energy <= 2 && c.sleep != null && c.sleep < 6.5);
}
function weeklyLoads() {
  const map = {};
  [...S.sessions, ...(S.extras || [])].forEach((s) => {
    if (!s.rpe || !s.minutes) return;
    const d = parseISO(s.date); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
    const k = isoDate(d); map[k] = (map[k] || 0) + s.rpe * s.minutes;
  });
  return Object.entries(map).sort((a, b) => a[0] < b[0] ? -1 : 1);
}

/* Avisos para la pantalla Hoy */
function alerts() {
  const out = [];
  const wi = weekInfo();
  const ank = ankleLevel();
  if (ank >= 5) out.push({ lvl: 'danger', t: 'Molestia fuerte de tobillo', d: `Registraste ${ank}/10 en la última semana. La app saca saltos, arranques y soga. Si hay hinchazón, otra torcedura o el dolor no baja, consultá a un kinesiólogo.` });
  else if (ank >= 3) out.push({ lvl: 'warn', t: 'Tobillo con molestia', d: `Registraste ${ank}/10 en la última semana. Esta semana van sin saltos ni arranques; la fuerza y la movilidad siguen.` });
  const hr = hrFlag();
  if (hr) out.push({ lvl: 'warn', t: 'Pulso en reposo elevado', d: `Tus últimos 3 días están ${hr} latidos por encima de tu base. La próxima sesión va en versión suave.` });
  if (deloadSuggest()) out.push({ lvl: 'warn', t: 'Cansancio acumulado', d: 'Tres días seguidos con poca energía y menos de 6,5 h de sueño. Conviene adelantar la descarga.', act: 'deload', actLabel: 'Adelantar descarga' });
  if (S.deloadLeft > 0) out.push({ lvl: 'info', t: 'Descarga anticipada', d: `Quedan ${S.deloadLeft} sesiones con la mitad del volumen. Revisá comida y sueño.` });
  if (!wi.phaseDone && wi.P.ramp[wi.week].deload && !S.deloadLeft) out.push({ lvl: 'info', t: 'Semana de descarga', d: 'Mitad del volumen y tests del final de la fase. Aunque te sientas bien, respetala.' });
  if (wi.phaseDone) out.push({ lvl: 'ok', t: `${wi.P.short || wi.P.name} completo`, d: `Hacé los tests, exportá tus datos y traémelos para armar el próximo capítulo. Mientras tanto, la app repite la semana ${wi.week}.` });
  const loads = weeklyLoads();
  if (loads.length >= 2) {
    const [a, b] = [loads[loads.length - 2][1], loads[loads.length - 1][1]];
    if (a > 0 && b > a * 1.15 && !wi.P.ramp[wi.week].deload) out.push({ lvl: 'info', t: 'La carga semanal subió más de 15 %', d: 'No pasa nada por una semana, pero no la subas más la próxima.' });
  }
  return out;
}

/* Prescripción de un ítem */
function setsFor(item, R) {
  if (item.sets === 'S') return R.sets;
  if (item.sets === 'A') return R.setsArms;
  if (item.sets === 'SP') return R.deload ? 4 : (R.sprint === '85-90 %' ? 6 : 4);
  if (typeof item.sets === 'number') return item.sets;
  return EX[item.ex].sets || 1;
}

function buildSession(type, opt) {
  const wi = weekInfo();
  const R = wi.R;
  const ank = ankleLevel();
  const soft = !!hrFlag();
  const P = wi.P;
  const football = opt.football && type === (P.preMatch || 'V');
  const after = S.flags.footballAfter && type === (P.postMatch || 'L');
  const notes = [];
  if (opt.reduced) notes.push('Espacio reducido: sin soga ni mancuernas, solo el mat.');
  if (football) notes.push('Sábado con partido: sin potencia, una serie menos de fuerza y aeróbico suave.');
  if (after) notes.push('Después del partido del finde: la mitad de los saltos.');
  if (soft) notes.push('Versión suave por pulso elevado: una serie menos y aeróbico tranquilo.');
  if (ank >= 3) notes.push(ank >= 5 ? 'Sin impacto por molestia fuerte de tobillo.' : 'Sin saltos ni arranques por molestia de tobillo.');
  const items = [];
  P.sessions[type].items.forEach((it) => {
    let exId = it.ex;
    if (it.from && wi.paramWeek < it.from && !wi.phaseDone) {
      if (it.pre) exId = it.pre; else return;
    }
    if (it.kind === 'jump' && (ank >= 3 || football)) return;
    if (football && it.block === 'Potencia') return;
    if (exId === 'flex_explosiva' && football) return;
    if (opt.reduced && EX[exId].alt) exId = EX[exId].alt;
    if (ank >= 5 && (it.kind === 'impact' || exId === 'soga_rebote') && EX[exId].alt) exId = EX[exId].alt;
    const ex = EX[exId];
    let sets = setsFor(it, R);
    const isStrength = ['S', 'A'].includes(it.sets);
    if ((football || soft) && isStrength) sets = Math.max(1, sets - 1);
    let range = ex.range ? ex.range.slice() : null;
    if (exId === 'pogo') { const r = after ? Math.ceil(R.pogo / 2) : R.pogo; range = [r, r]; }
    const item = {
      uid: uid(), ex: exId, base: it.ex, block: it.block, g: it.g || null,
      sets, range, rest: ex.rest || 30, unit: ex.unit, perSide: !!ex.perSide,
      levelIdx: ex.levels ? (S.levels[exId] ?? defaultLevel(exId)) : null,
      rir: (isStrength || ex.hyp) && ex.levels && ex.unit === 'reps' ? (ex.hyp ? R.rirH : R.rirS) : null,
      log: { sets: [], rir: null, done: false }
    };
    if (ex.unit === 'rondas') { item.rounds = exId === 'soga_3030' || exId === 'escaladores_3030' ? R.soga : R.sombra; item.work = ex.work; item.rest = ex.rest; item.sets = 1; }
    if (ex.unit === 'min' && !ex.fixed) { item.minutes = R.aero; item.sets = 1; }
    if (ex.unit === 'min' && ex.fixed) { item.minutes = ex.fixed; item.sets = 1; }
    if (ex.unit === 'rutina' || ex.steps) { item.sets = 1; }
    if (ex.sprint) item.note = `Intensidad ${R.sprint}`;
    if (football && it.block === 'Aeróbico') item.note = 'Suave: esfuerzo 4';
    if (soft && it.block.startsWith('Aeróbico')) item.note = 'Suave: esfuerzo 3-4';
    for (let i = 0; i < item.sets; i++) item.log.sets.push({ v: null, done: false });
    items.push(item);
  });
  return {
    id: uid(), type, name: P.sessions[type].name, title: P.sessions[type].title, chapter: P.id, date: isoDate(), startedAt: Date.now(), phase: 1,
    week: wi.week, paramWeek: wi.paramWeek, early: wi.early, reduced: !!opt.reduced, football, soft,
    notes, items
  };
}
function defaultLevel(exId) {
  if (exId === 'flexiones') {
    const t = [...S.tests].reverse().find((x) => x.values && x.values.flex != null);
    if (t) { const f = t.values.flex; return f < 10 ? 0 : f < 20 ? 1 : f < 35 ? 2 : 3; }
    return 1;
  }
  return 0;
}
function levelName(item) { const ex = EX[item.ex]; return ex.levels ? ex.levels[Math.min(item.levelIdx, ex.levels.length - 1)] : null; }
function unitLabel(item) {
  if (item.unit === 'secs') return 's';
  return '';
}
function prescription(item) {
  const ex = EX[item.ex];
  if (item.unit === 'rondas') return `${item.rounds} rondas · ${item.work} s de trabajo / ${item.rest} s de pausa`;
  if (item.unit === 'min') return item.minutes >= 5 ? `${item.minutes} min · bloques de 3 min` : `${item.minutes} min`;
  if (item.unit === 'rutina' || ex.steps) { const t = (ex.steps || []).reduce((a, s) => a + s[1], 0); return `${Math.round(t / 60)} min · ${ex.steps.length} posiciones`; }
  const r = item.range[0] === item.range[1] ? `${item.range[0]}` : `${item.range[0]}-${item.range[1]}`;
  const u = item.unit === 'secs' ? ' s' : '';
  const side = item.perSide ? ' por lado' : '';
  return `${item.sets} × ${r}${u}${side}`;
}

/* Regla 1 y 3: evaluar y aplicar progresión al terminar */
function evaluate(sess) {
  const changes = [];
  sess.items.forEach((item) => {
    const ex = EX[item.ex];
    if (!ex.levels || !item.range || item.unit === 'rondas' || item.unit === 'min') return;
    if (item.ex === 'soga_3030' || item.ex === 'eq_pierna') return;
    const done = item.log.sets.filter((s) => s.done && s.v != null);
    if (done.length < item.sets) return;
    const vals = done.map((s) => s.v);
    const total = vals.reduce((a, b) => a + b, 0);
    const tot = (S.totals[item.ex] = S.totals[item.ex] || []);
    tot.push({ d: sess.date, t: total, l: item.levelIdx });
    if (tot.length > 8) tot.shift();
    const allTop = vals.every((v) => v >= item.range[1]);
    const below = vals.some((v) => v < item.range[0]);
    const target = item.rir ? rirMin(item.rir) : null;
    const rirOk = target == null || item.log.rir == null || item.log.rir >= Math.max(0, target - 1);
    const st = (S.streaks[item.ex] = S.streaks[item.ex] || { up: 0, down: 0 });
    st.up = allTop && rirOk ? st.up + 1 : 0;
    st.down = below ? st.down + 1 : 0;
    const cur = S.levels[item.ex] ?? item.levelIdx;
    if (st.up >= 2) {
      if (cur < ex.levels.length - 1) {
        S.levels[item.ex] = cur + 1;
        changes.push({ kind: 'up', name: ex.name, to: ex.levels[cur + 1] });
      } else {
        changes.push({ kind: 'max', name: ex.name, to: ex.levels[cur] });
      }
      st.up = 0; st.down = 0;
    } else if (st.down >= 2 && cur > 0) {
      S.levels[item.ex] = cur - 1;
      changes.push({ kind: 'down', name: ex.name, to: ex.levels[cur - 1] });
      st.up = 0; st.down = 0;
    } else if (allTop && rirOk) {
      changes.push({ kind: 'almost', name: ex.name, to: ex.levels[Math.min(cur + 1, ex.levels.length - 1)] });
    }
    if (S.levels[item.ex] == null) S.levels[item.ex] = cur;
  });
  return changes;
}
/* Regla 12: estancamiento */
function stagnant(exId) {
  const t = S.totals[exId];
  if (!t || t.length < 4) return false;
  const last = t.slice(-3); const ref = t[t.length - 4];
  return last.every((x) => x.l === ref.l && x.t <= ref.t);
}

/* ============================================================
   Sonido, vibración y pantalla encendida
   ============================================================ */
let actx = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function tone(freq, dur, when = 0, vol = 0.25) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  const t = a.currentTime + when;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const BEEP = {
  start() { if (S.settings.sound) { tone(988, 0.35, 0, 0.32); } vib([180]); },
  end() { if (S.settings.sound) { tone(784, 0.18, 0); tone(523, 0.32, 0.2); } vib([120, 80, 200]); },
  tick() { if (S.settings.sound) tone(660, 0.09, 0, 0.18); vib([40]); },
  warn() { if (S.settings.sound) { tone(740, 0.12, 0, 0.2); tone(740, 0.12, 0.18, 0.2); } vib([60, 60, 60]); }
};
function vib(p) { if (S.settings.vibrate && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* sin vibración */ } } }
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && T.running) keepAwake(true); });

/* ============================================================
   Temporizador
   ============================================================ */
const T = { steps: [], i: 0, phase: 'idle', remaining: 0, elapsed: 0, last: 0, running: false, open: false, raf: null, warned: 0 };

function estSecs(item) { const ex = EX[item.ex]; const reps = item.range ? item.range[1] : 10; return Math.min(90, Math.max(15, Math.round(reps * (ex.est || 3)) + 5)); }

function stepsForItem(item, setIdx) {
  const ex = EX[item.ex]; const out = [];
  const name = ex.name;
  const base = { uid: item.uid, name };
  if (ex.steps) {
    ex.steps.forEach((s, k) => {
      out.push({ ...base, type: 'work', label: s[0], detail: `${name} · ${k + 1} de ${ex.steps.length}`, secs: s[1], set: 0, last: k === ex.steps.length - 1 });
      if (k < ex.steps.length - 1) out.push({ ...base, type: 'rest', label: 'Cambiá de posición', detail: ex.steps[k + 1][0], secs: 5, short: true });
    });
    return out;
  }
  if (item.unit === 'min') {
    if (item.minutes < 5) { out.push({ ...base, type: 'work', label: name, detail: `${item.minutes} min`, secs: item.minutes * 60, set: 0, last: true }); return out; }
    const cycles = Math.max(1, Math.round(item.minutes / 3));
    const [a, b] = item.ex === 'aero_bajo' ? ['Sombra suave', 'Rodillas altas marchando'] : ['Soga suave', 'Sombra suave'];
    for (let c = 0; c < cycles; c++) {
      out.push({ ...base, type: 'work', label: a, detail: `Bloque ${c + 1} de ${cycles} · esfuerzo 3-4`, secs: 120, set: 0, cont: true });
      out.push({ ...base, type: 'work', label: b, detail: `Bloque ${c + 1} de ${cycles} · esfuerzo 3-4`, secs: 60, set: 0, cont: true, last: c === cycles - 1 });
    }
    return out;
  }
  if (item.unit === 'rondas') {
    for (let r = 0; r < item.rounds; r++) {
      out.push({ ...base, type: 'work', label: name, detail: `Ronda ${r + 1} de ${item.rounds}`, secs: item.work, set: 0, last: r === item.rounds - 1 });
      if (r < item.rounds - 1) out.push({ ...base, type: 'rest', label: 'Pausa', detail: `Sigue la ronda ${r + 2}`, secs: item.rest });
    }
    return out;
  }
  const s = setIdx;
  const tgt = item.range[0] === item.range[1] ? `${item.range[1]}` : `${item.range[0]}-${item.range[1]}`;
  const unit = item.unit === 'secs' ? ' s' : ' reps';
  const sides = item.perSide ? ['izquierda', 'derecha'] : [null];
  sides.forEach((side, k) => {
    const secs = item.unit === 'secs' ? item.range[1] : null;
    out.push({ ...base, type: 'work', label: name, detail: `Serie ${s + 1} de ${item.sets} · ${tgt}${unit}${side ? ' · ' + side : ''}`, secs, est: secs ? null : (item.perSide ? Math.round(estSecs(item) / 1.4) : estSecs(item)), set: s, last: k === sides.length - 1 });
    if (side && k === 0) out.push({ ...base, type: 'rest', label: 'Cambiá de lado', detail: 'Lado derecho', secs: 5, short: true });
  });
  return out;
}

function buildSteps(sess, fromUid) {
  const steps = [];
  const items = sess.items;
  let i = items.findIndex((x) => x.uid === fromUid); if (i < 0) i = 0;
  while (i < items.length) {
    const it = items[i];
    let group = [it];
    if (it.g) { let j = i + 1; while (j < items.length && items[j].g === it.g && items[j].block === it.block) { group.push(items[j]); j++; } }
    const maxSets = Math.max(...group.map((g) => g.sets));
    const firstPending = (g) => { const k = g.log.sets.findIndex((s) => !s.done); return k < 0 ? g.sets : k; };
    const start = Math.min(...group.map(firstPending));
    for (let s = start; s < maxSets; s++) {
      group.forEach((g, gi) => {
        if (s >= g.sets || (g.log.sets[s] && g.log.sets[s].done && !['rondas', 'min', 'rutina'].includes(g.unit))) return;
        if (['rondas', 'min', 'rutina'].includes(g.unit) || EX[g.ex].steps) { if (g.log.done) return; }
        steps.push(...stepsForItem(g, s));
        const lastOfAll = s === maxSets - 1 && gi === group.length - 1;
        const isMulti = !['rondas', 'min', 'rutina'].includes(g.unit) && !EX[g.ex].steps;
        if (isMulti && !lastOfAll) steps.push({ uid: g.uid, type: 'rest', label: 'Descanso', detail: '', secs: g.rest });
      });
    }
    i += group.length;
    if (i < items.length) steps.push({ uid: null, type: 'rest', label: 'Preparate', detail: '', secs: items[i].block === it.block ? 15 : 30, trans: true });
  }
  // completar el texto de "siguiente" en cada descanso
  steps.forEach((st, k) => {
    if (st.type === 'rest' && !st.short) { const nx = steps.slice(k + 1).find((x) => x.type === 'work'); st.detail = nx ? `Sigue: ${nx.label} · ${nx.detail}` : 'Último bloque'; }
  });
  if (steps.length && steps[steps.length - 1].type === 'rest') steps.pop();
  return steps;
}

function timerStart(fromUid) {
  if (!S.current) return;
  audio();
  T.steps = buildSteps(S.current, fromUid);
  if (!T.steps.length) { toast('No quedan series pendientes en esta sesión.'); return; }
  T.i = 0; T.open = true; T.running = true;
  enterStep(true);
  keepAwake(true);
  renderTimer(); loop();
}
function cur() { return T.steps[T.i]; }
function enterStep(fromUser) {
  const st = cur(); if (!st) return finishTimer();
  T.warned = 0; T.elapsed = 0; T.last = performance.now();
  if (st.type === 'work') {
    const guided = S.settings.timerMode === 'guiado';
    const prev = T.steps[T.i - 1];
    if (fromUser) { T.phase = 'prep'; T.remaining = S.settings.countdown; return; }
    if (guided && !st.cont && !(prev && prev.short)) { T.phase = 'waiting'; T.remaining = 0; return; }
    T.phase = 'work'; T.remaining = workSecs(st); BEEP.start();
  } else {
    T.phase = 'rest'; T.remaining = st.secs;
  }
}
function workSecs(st) { return st.secs != null ? st.secs : (S.settings.timerMode === 'continuo' ? st.est : null); }
function advance() {
  const st = cur();
  if (st && st.type === 'work') markStep(st);
  T.i++;
  if (T.i >= T.steps.length) return finishTimer();
  enterStep(false);
  renderTimer();
}
function markStep(st) {
  if (!S.current) return;
  const item = S.current.items.find((x) => x.uid === st.uid); if (!item) return;
  if (['rondas', 'min', 'rutina'].includes(item.unit) || EX[item.ex].steps) {
    if (st.last) { item.log.done = true; item.log.sets.forEach((s) => { s.done = true; }); }
  } else if (st.last) {
    const s = item.log.sets[st.set];
    if (s && !s.done) { s.done = true; if (s.v == null) s.v = item.range[1]; }
  }
  save(); if (view === 'sesion') renderSession();
}
function loop() {
  cancelAnimationFrame(T.raf);
  const tickFn = () => {
    if (!T.running) return;
    const now = performance.now(); const dt = (now - T.last) / 1000; T.last = now;
    if (T.phase === 'prep') {
      const before = Math.ceil(T.remaining); T.remaining -= dt; const after = Math.ceil(T.remaining);
      if (after !== before && after > 0) BEEP.tick();
      if (T.remaining <= 0) { T.phase = 'work'; T.elapsed = 0; T.remaining = workSecs(cur()); BEEP.start(); }
    } else if (T.phase === 'work') {
      T.elapsed += dt;
      if (T.remaining != null) {
        const before = Math.ceil(T.remaining); T.remaining -= dt; const after = Math.ceil(T.remaining);
        if (after !== before && after <= 3 && after > 0 && T.remaining > 0) BEEP.tick();
        if (T.remaining <= 0) { BEEP.end(); advance(); }
      }
    } else if (T.phase === 'rest') {
      const before = Math.ceil(T.remaining); T.remaining -= dt; const after = Math.ceil(T.remaining);
      const st = cur();
      if (!st.short && S.settings.timerMode === 'continuo' && before > 5 && after <= 5) BEEP.warn();
      if (after !== before && after <= 3 && after > 0) BEEP.tick();
      if (T.remaining <= 0) { if (st.short) BEEP.tick(); else if (S.settings.timerMode === 'guiado' || T.quick) BEEP.end(); advance(); }
    }
    paintTimer();
    T.raf = requestAnimationFrame(tickFn);
  };
  T.last = performance.now();
  T.raf = requestAnimationFrame(tickFn);
}
function timerToggle() {
  audio();
  if (T.phase === 'waiting') { T.phase = 'prep'; T.remaining = S.settings.countdown; T.running = true; T.last = performance.now(); loop(); renderTimer(); return; }
  T.running = !T.running;
  if (T.running) { keepAwake(true); loop(); } else { cancelAnimationFrame(T.raf); }
  renderTimer();
}
function timerDone() { if (T.phase === 'work') { BEEP.end(); advance(); } }
function timerSkip() { const st = cur(); if (st && st.type === 'work' && T.phase === 'work') { advance(); return; } T.i++; if (T.i >= T.steps.length) return finishTimer(); enterStep(false); renderTimer(); }
function timerBack() { T.i = Math.max(0, T.i - 1); while (T.i > 0 && cur().type !== 'work') T.i--; T.phase = 'waiting'; T.running = true; renderTimer(); }
function timerAdd(s) { if (T.remaining != null && (T.phase === 'rest' || T.phase === 'work' || T.phase === 'prep')) T.remaining += s; paintTimer(); }
function finishTimer() {
  const wasQuick = T.quick; const wasMicro = T.micro;
  T.running = false; T.phase = 'idle'; cancelAnimationFrame(T.raf); keepAwake(false);
  T.open = false; T.steps = []; T.quick = false; T.micro = false;
  if (wasMicro) { S.micro.push(isoDate()); save(); }
  renderTimer(); if (view === 'sesion') renderSession();
  toast(wasQuick ? 'Descanso terminado' : wasMicro ? 'Microsesión hecha' : 'Temporizador terminado');
}
/* Descanso rápido al marcar una serie a mano */
function quickRest(secs, next) {
  audio();
  T.steps = [{ uid: null, type: 'rest', label: 'Descanso', detail: next, secs }];
  T.i = 0; T.open = false; T.running = true; T.quick = true; T.phase = 'rest'; T.remaining = secs; T.warned = 0;
  keepAwake(true); renderMini(); loop();
}
function timerStop() { T.running = false; cancelAnimationFrame(T.raf); T.phase = 'idle'; T.steps = []; T.open = false; T.quick = false; T.micro = false; keepAwake(false); renderTimer(); }

/* ============================================================
   Íconos
   ============================================================ */
const IC = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5.5v13l9-6.5zM16 5h2.5v14H16z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5.5v13l-9-6.5zM5.5 5H8v14H5.5z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  today: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15" r="1.8" fill="currentColor"/></svg>',
  session: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4M6.5 7.5v9M17.5 7.5v9M21 10v4M6.5 12h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  progress: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 15l4-4 3 3 5-6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16 10l5-3v10l-5-3z" fill="currentColor"/></svg>',
  timer: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 13V9M9.5 3h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
};

/* ============================================================
   Navegación y hojas
   ============================================================ */
let view = 'hoy';
let pickNext = null;
function go(v) {
  view = v;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== 'v-' + v; });
  render(); window.scrollTo(0, 0);
}
function render() {
  renderHeader();
  if (view === 'hoy') renderHoy();
  if (view === 'sesion') renderSession();
  if (view === 'progreso') renderProgreso();
  if (view === 'mas') renderMas();
  renderMini();
}
function sheet(html, opts = {}) {
  const el = $('#sheet');
  $('#sheet-body').innerHTML = html;
  $('#sheet-title').textContent = opts.title || '';
  el.hidden = false; document.body.classList.add('locked');
  requestAnimationFrame(() => el.classList.add('open'));
  const first = $('#sheet-body input, #sheet-body button');
  if (opts.focus && first) first.focus();
}
function closeSheetQuiet() { if (!$('#sheet').hidden) closeSheet(); }
function closeSheet() { const el = $('#sheet'); el.classList.remove('open'); document.body.classList.remove('locked'); setTimeout(() => { el.hidden = true; }, 180); }
let toastT = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 200); }, 2600); }

/* ============================================================
   Encabezado
   ============================================================ */
function renderHeader() {
  const wi = weekInfo();
  const nm = wi.P.short || wi.P.name;
  $('#hdr-week').textContent = wi.phaseDone ? `${nm} completo` : `${nm} · Semana ${wi.week} de ${wi.P.weeks}`;
}

/* ============================================================
   Pantalla: Hoy
   ============================================================ */
function renderHoy() {
  const gapMsg = handleGap();
  const wi = weekInfo();
  const type = (!S.current && pickNext) || nextType();
  const sd = S.current ? { name: S.current.name, title: S.current.title } : wi.P.sessions[type];
  const today = isoDate();
  const ci = S.checkins[today];
  const al = alerts();
  if (gapMsg) al.unshift({ lvl: 'info', t: 'Retomás después de un parón', d: gapMsg });
  const noTests = !S.tests.length;
  const testsDue = !noTests && !wi.phaseDone && wi.P.ramp[wi.week].deload && !S.tests.some((t) => daysBetween(t.date, today) <= 7);
  const minutes = 60;
  const trainingDay = [1, 3, 5].includes(new Date().getDay());

  $('#v-hoy').innerHTML = `
    <p class="date-line">${esc(fmtLong(today))}</p>
    ${weekStrip()}

    <section class="next card" aria-labelledby="next-h">
      <div class="next-top">
        <div>
          <p class="kicker">${S.current ? 'Sesión en curso' : 'Próxima sesión'}</p>
          <h2 id="next-h">${esc(sd.name)} <span class="muted">· ${esc(sd.title)}</span></h2>
        </div>
        <span class="pill">${minutes} min</span>
      </div>
      ${S.current ? '' : `
      <div class="seg" role="group" aria-label="Elegir sesión">
        ${wi.P.rotation.map((k) => `<button type="button" class="seg-b" data-act="pick" data-k="${k}" aria-pressed="${k === type}">${esc(wi.P.sessions[k].name)}</button>`).join('')}
      </div>`}
      <p class="week-note">${esc(wi.R.note || '')}</p>
      ${S.current ? '' : `
      <div class="toggles">
        <label class="tgl"><input type="checkbox" id="tg-reduced" ${S.flags.reduced ? 'checked' : ''}><span class="tgl-ui" aria-hidden="true"></span><span><strong>Espacio reducido</strong><small>Solo el mat, sin soga ni mancuernas</small></span></label>
        <label class="tgl"><input type="checkbox" id="tg-football" ${S.flags.football ? 'checked' : ''}><span class="tgl-ui" aria-hidden="true"></span><span><strong>Juego al fútbol este sábado</strong><small>El viernes va más liviano</small></span></label>
      </div>`}
      <button type="button" class="btn primary block" data-act="${S.current ? 'resume' : 'start'}">${S.current ? 'Continuar sesión' : 'Empezar sesión'}</button>
    </section>

    ${al.length ? `<section class="alerts" aria-label="Avisos">${al.map((a) => `
      <div class="alert ${a.lvl}"><strong>${esc(a.t)}</strong><p>${esc(a.d)}</p>${a.act ? `<button type="button" class="btn small" data-act="${a.act}">${esc(a.actLabel)}</button>` : ''}</div>`).join('')}</section>` : ''}

    ${noTests ? `<section class="card tests-cta"><h3>Tests de la semana 0</h3><p>Antes de la primera sesión: tus números de partida. Unos 30 minutos.</p><button type="button" class="btn" data-act="tests">Cargar tests</button></section>` : ''}
    ${testsDue ? `<section class="card tests-cta"><h3>Tests del final de la fase</h3><p>Hacelos esta semana, después de entrar en calor.</p><button type="button" class="btn" data-act="tests">Cargar tests</button></section>` : ''}

    ${weekendPrompt()}

    <section class="card checkin">
      <div class="row-between"><h3>Cómo amaneciste</h3>${ci ? '<button type="button" class="link" data-act="checkin">Editar</button>' : ''}</div>
      ${ci ? `<dl class="ci-grid">
        ${ciCell('Pulso', ci.hr, 'lpm')}${ciCell('Peso', ci.weight, 'kg')}${ciCell('Sueño', ci.sleep, 'h')}
        ${ciCell('Energía', ci.energy, '/5')}${ciCell('Dolor muscular', ci.sore, '/5')}${ciCell('Tobillo', ci.ankle, '/10')}
      </dl>` : `<p class="muted">Menos de un minuto: pulso, sueño, energía y tobillo.</p><button type="button" class="btn" data-act="checkin">Registrar</button>`}
    </section>

    <section class="card extra">
      <div class="row-between"><div><h3>Actividad extra</h3><p class="muted">Trote, fútbol, básquet, bici o lo que hagas fuera del plan.</p></div></div>
      ${(() => { const rec = S.extras.filter((x) => daysBetween(x.date, today) <= 6).slice(-3).reverse(); return rec.length ? `<ul class="extra-list">${rec.map((x) => `<li><span>${esc(extraLabel(x))}</span><span class="muted">${fmtShort(x.date)}</span></li>`).join('')}</ul>` : ''; })()}
      <button type="button" class="btn" data-act="extra">Registrar actividad</button>
    </section>

    ${!trainingDay && !S.current ? `<section class="card micro"><div class="row-between"><div><h3>Microsesión de movilidad</h3><p class="muted">10 min para los días libres. Suma flexibilidad sin cansar.</p></div></div><button type="button" class="btn" data-act="micro">Empezar</button></section>` : ''}
  `;
}
function weekendPrompt() {
  const wd = new Date().getDay();
  if (![0, 1].includes(wd)) return '';
  const [sat, sun] = weekendDates();
  const logged = S.extras.some((x) => x.date === sat || x.date === sun);
  if (logged || S.weekendAsked === sun) return '';
  return `<section class="card prompt"><h3>¿Hiciste algo el fin de semana?</h3><p class="muted">Un partido, un trote o nada: sirve para ajustar la semana.</p><div class="sheet-actions"><button type="button" class="btn" data-act="restweekend">No, descansé</button><button type="button" class="btn primary" data-act="extra">Registrar</button></div></section>`;
}
function ciCell(l, v, u) { return `<div><dt>${l}</dt><dd>${v == null || v === '' ? '<span class="muted">—</span>' : `${fmtNum(v)}<small> ${u}</small>`}</dd></div>`; }

/* ============================================================
   Pantalla: Sesión
   ============================================================ */
function renderSession() {
  const el = $('#v-sesion');
  const sess = S.current;
  if (!sess) {
    const type = nextType();
    const sx = prog().sessions[type];
    el.innerHTML = `<div class="empty"><h2>No hay una sesión en curso</h2><p>La próxima es <strong>${esc(sx.name)}</strong>: ${esc(sx.title.toLowerCase())}.</p><button type="button" class="btn primary" data-act="start">Empezar sesión</button></div>`;
    return;
  }
  const sd = { name: sessName(sess), title: sess.title || '' };
  const doneCount = sess.items.filter(itemDone).length;
  const blocks = [];
  sess.items.forEach((it) => { let b = blocks.find((x) => x.name === it.block); if (!b) { b = { name: it.block, items: [] }; blocks.push(b); } b.items.push(it); });
  el.innerHTML = `
    <header class="sess-h">
      <div>
        <p class="kicker">Semana ${sess.week}${sess.early ? ' · descarga anticipada' : ''}${sess.reduced ? ' · espacio reducido' : ''}</p>
        <h2>${esc(sd.name)} <span class="muted">· ${esc(sd.title)}</span></h2>
      </div>
      <div class="sess-progress" aria-label="Ejercicios completos">${doneCount}/${sess.items.length}</div>
    </header>
    ${sess.notes.length ? `<ul class="sess-notes">${sess.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="mode-row">
      <span>Temporizador</span>
      <div class="seg small" role="group" aria-label="Modo del temporizador">
        <button type="button" class="seg-b" data-act="mode" data-m="guiado" aria-pressed="${S.settings.timerMode === 'guiado'}">Guiado</button>
        <button type="button" class="seg-b" data-act="mode" data-m="continuo" aria-pressed="${S.settings.timerMode === 'continuo'}">Continuo</button>
      </div>
    </div>
    <p class="mode-help">${S.settings.timerMode === 'guiado' ? 'Le das play a cada serie; los descansos corren solos.' : 'Corre todo seguido: series, descansos y avisos, hasta el final.'}</p>
    ${blocks.map((b) => `
      <section class="ex-block">
        <h3 class="block-h">${esc(b.name)}</h3>
        ${b.items.map((it) => exCard(it)).join('')}
      </section>`).join('')}
    <div class="finish-wrap">
      <button type="button" class="btn primary block" data-act="finish">Terminar sesión</button>
      <button type="button" class="link danger-link" data-act="discard">Descartar esta sesión</button>
    </div>`;
}
function itemDone(it) { return ['rondas', 'min', 'rutina'].includes(it.unit) || EX[it.ex].steps ? it.log.done : it.log.sets.every((s) => s.done); }
function exCard(it) {
  const ex = EX[it.ex];
  const done = itemDone(it);
  const lv = levelName(it);
  const multi = !(['rondas', 'min', 'rutina'].includes(it.unit) || ex.steps);
  const gtag = it.g ? `<span class="gtag" title="Superserie">${it.g}</span>` : '';
  const stuck = ex.levels && stagnant(it.ex);
  return `
  <article class="ex ${done ? 'is-done' : ''}" data-uid="${it.uid}">
    <div class="ex-top">
      ${gtag}
      <button type="button" class="ex-name" data-act="ficha" data-ex="${it.ex}" data-lv="${it.levelIdx ?? ''}">${esc(ex.name)}</button>
      <button type="button" class="icon-btn play" data-act="play" data-uid="${it.uid}" aria-label="Iniciar temporizador desde ${esc(ex.name)}">${IC.play}</button>
    </div>
    <p class="ex-rx">${esc(prescription(it))}${it.rir ? ` · <abbr data-act="term" data-t="RIR">RIR ${esc(it.rir)}</abbr>` : ''}${it.unit !== 'rutina' && !ex.steps && it.rest && multi ? ` · pausa ${it.rest} s` : ''}</p>
    ${lv ? `<p class="ex-lv">Nivel: ${esc(lv)}</p>` : ''}
    ${it.note ? `<p class="ex-lv">${esc(it.note)}</p>` : ''}
    ${stuck ? '<p class="ex-stuck">Hace 3 semanas que no mejora: cambiá una sola cosa, como bajada más lenta o una pausa.</p>' : ''}
    ${multi ? `<div class="sets">${it.log.sets.map((s, k) => `<button type="button" class="set ${s.done ? 'done' : ''}" data-act="set" data-uid="${it.uid}" data-k="${k}" aria-label="Serie ${k + 1}${s.done ? ', hecha: ' + s.v : ''}">${s.done ? `<b>${s.v}</b>${it.unit === 'secs' ? '<small>s</small>' : ''}` : `<span>${k + 1}</span>`}</button>`).join('')}</div>`
      : `<div class="sets"><button type="button" class="set wide ${done ? 'done' : ''}" data-act="blockdone" data-uid="${it.uid}">${done ? `${IC.check} Hecho` : 'Marcar como hecho'}</button></div>`}
    ${it.rir && it.log.sets.some((s) => s.done) ? `<div class="rir"><span>¿Cuántas te quedaban?</span><div class="rir-b">${[0, 1, 2, 3, 4, 5].map((n) => `<button type="button" data-act="rir" data-uid="${it.uid}" data-n="${n}" aria-pressed="${it.log.rir === n}">${n === 5 ? '5+' : n}</button>`).join('')}</div></div>` : ''}
  </article>`;
}

function startSession(type) {
  S.current = buildSession(type || nextType(), { reduced: S.flags.reduced, football: S.flags.football });
  save(); go('sesion');
}
function setSheet(uid, k) {
  const it = S.current.items.find((x) => x.uid === uid); const s = it.log.sets[k]; const ex = EX[it.ex];
  const val = s.v ?? it.range[1];
  const unit = it.unit === 'secs' ? 'segundos' : 'repeticiones';
  sheet(`
    <p class="muted">${esc(ex.name)} · serie ${k + 1} de ${it.sets}${it.perSide ? ' (el lado más flojo)' : ''}</p>
    <div class="stepper" role="group" aria-label="${unit}">
      <button type="button" class="step-b" data-act="stepv" data-d="-1" aria-label="Restar">−</button>
      <output id="set-v" aria-live="polite">${val}</output>
      <button type="button" class="step-b" data-act="stepv" data-d="1" aria-label="Sumar">+</button>
    </div>
    <p class="center muted">${unit} · objetivo ${it.range[0] === it.range[1] ? it.range[1] : it.range[0] + '-' + it.range[1]}</p>
    <div class="sheet-actions">
      ${s.done ? `<button type="button" class="btn" data-act="setundo" data-uid="${uid}" data-k="${k}">Desmarcar</button>` : ''}
      <button type="button" class="btn primary" data-act="setsave" data-uid="${uid}" data-k="${k}">Guardar serie</button>
    </div>`, { title: 'Registrar serie' });
}

function finishSheet() {
  const sess = S.current;
  const mins = Math.min(120, Math.max(10, Math.round((Date.now() - sess.startedAt) / 60000)));
  const pending = sess.items.filter((x) => !itemDone(x)).length;
  sheet(`
    ${pending ? `<p class="note-warn">Quedan ${pending} ejercicios sin marcar. Lo que no marques no cuenta para subir de nivel.</p>` : ''}
    <label class="field"><span>Esfuerzo de toda la sesión (RPE)</span>
      <input type="range" id="f-rpe" min="1" max="10" step="1" value="6"><output id="f-rpe-o" class="range-o">6 · Moderado-duro</output></label>
    <label class="field"><span>Minutos totales</span><input type="number" id="f-min" inputmode="numeric" value="${mins}" min="5" max="180"></label>
    <label class="field"><span>Molestia de tobillo (0 = nada, 10 = máxima)</span>
      <input type="range" id="f-ank" min="0" max="10" step="1" value="0"><output id="f-ank-o" class="range-o">0</output></label>
    <label class="field"><span>Notas (opcional)</span><textarea id="f-notes" rows="2" placeholder="Algo para recordar en la revisión"></textarea></label>
    <button type="button" class="btn primary block" data-act="finishsave">Guardar sesión</button>`, { title: 'Terminar sesión' });
}
const RPE_TXT = ['', 'Muy fácil', 'Fácil', 'Fácil', 'Moderado', 'Moderado', 'Moderado-duro', 'Duro', 'Muy duro', 'Durísimo', 'Máximo'];
function finishSave() {
  const sess = S.current;
  sess.rpe = Number($('#f-rpe').value);
  sess.minutes = num($('#f-min').value) || 60;
  sess.ankle = Number($('#f-ank').value);
  sess.notes2 = $('#f-notes').value.trim();
  sess.finishedAt = Date.now();
  const changes = evaluate(sess);
  sess.changes = changes;
  S.sessions.push(sess);
  const P = prog();
  if (sess.type === (P.preMatch || 'V') && sess.football) { S.flags.football = false; S.flags.footballAfter = true; }
  else if (sess.type === (P.postMatch || 'L')) S.flags.footballAfter = false;
  S.flags.reduced = false;
  if (S.deloadLeft > 0) S.deloadLeft--;
  S.current = null;
  if (T.steps.length) timerStop();
  save();
  const up = changes.filter((c) => c.kind === 'up'); const down = changes.filter((c) => c.kind === 'down'); const almost = changes.filter((c) => c.kind === 'almost'); const max = changes.filter((c) => c.kind === 'max');
  sheet(`
    <p class="big-ok">${IC.check}<span>Sesión guardada</span></p>
    <p class="center muted">Carga de la sesión: ${sess.rpe * sess.minutes} (esfuerzo ${sess.rpe} × ${sess.minutes} min)</p>
    ${up.length ? `<h4>Subís de nivel</h4><ul class="chg up">${up.map((c) => `<li><strong>${esc(c.name)}</strong> → ${esc(c.to)}</li>`).join('')}</ul>` : ''}
    ${almost.length ? `<h4>A una sesión de subir</h4><ul class="chg">${almost.map((c) => `<li>${esc(c.name)}</li>`).join('')}</ul>` : ''}
    ${down.length ? `<h4>Volvés al nivel anterior</h4><ul class="chg down">${down.map((c) => `<li><strong>${esc(c.name)}</strong> → ${esc(c.to)}, con bajada lenta</li>`).join('')}</ul>` : ''}
    ${max.length ? `<h4>Último nivel de la fase</h4><ul class="chg">${max.map((c) => `<li>${esc(c.name)}: lo ajustamos en la revisión</li>`).join('')}</ul>` : ''}
    ${!changes.length ? '<p class="center">Sin cambios de nivel esta vez. La regla pide dos sesiones seguidas en el tope del rango.</p>' : ''}
    ${sess.ankle >= 3 ? '<p class="note-warn">Registraste molestia de tobillo: la próxima semana va sin saltos.</p>' : ''}
    <button type="button" class="btn primary block" data-act="closego" data-v="hoy">Listo</button>`, { title: 'Resumen' });
}

/* ============================================================
   Ficha de ejercicio y glosario
   ============================================================ */
function ficha(exId) {
  const ex = EX[exId];
  const cur = S.levels[exId] ?? (ex.levels ? defaultLevel(exId) : null);
  const vid = S.videos[exId];
  const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.q || ex.name);
  sheet(`
    <p class="ficha-cat">${esc(ex.cat)}</p>
    <h3 class="ficha-name">${esc(ex.name)}</h3>
    <p>${esc(ex.desc)}</p>
    ${ex.cues && ex.cues.length ? `<h4>Puntos clave</h4><ul class="dots">${ex.cues.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${ex.errors && ex.errors.length ? `<h4>Errores comunes</h4><ul class="dots warn">${ex.errors.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${ex.steps ? `<h4>Secuencia</h4><ol class="steps">${ex.steps.map((s) => `<li><span>${esc(s[0])}</span><span class="muted">${s[1]} s</span></li>`).join('')}</ol>` : ''}
    ${ex.levels ? `<h4>Niveles</h4><ol class="levels">${ex.levels.map((l, i) => `<li class="${i === cur ? 'cur' : i < cur ? 'past' : ''}"><span>${esc(l)}</span>${i === cur ? '<em>Tu nivel</em>' : ''}</li>`).join('')}</ol>
      <div class="lv-adjust"><span class="muted">Ajustar a mano</span><button type="button" class="btn small" data-act="lv" data-ex="${exId}" data-d="-1" ${cur <= 0 ? 'disabled' : ''}>Bajar</button><button type="button" class="btn small" data-act="lv" data-ex="${exId}" data-d="1" ${cur >= ex.levels.length - 1 ? 'disabled' : ''}>Subir</button></div>` : ''}
    <h4>Video</h4>
    <a class="btn block video" href="${esc(vid || search)}" target="_blank" rel="noopener">${IC.video}<span>${vid ? 'Ver mi video guardado' : 'Ver cómo se hace en YouTube'}</span></a>
    <label class="field compact"><span>Guardar un video propio (link)</span>
      <div class="inline"><input type="url" id="vid-url" inputmode="url" placeholder="https://youtu.be/…" value="${esc(vid || '')}"><button type="button" class="btn small" data-act="vidsave" data-ex="${exId}">Guardar</button></div></label>
    ${vid ? `<button type="button" class="link" data-act="viddel" data-ex="${exId}">Volver a la búsqueda de YouTube</button>` : ''}
    ${ex.alt ? `<p class="muted small-note">En espacio reducido se reemplaza por: ${esc(EX[ex.alt].name)}.</p>` : ''}
  `, { title: 'Ejercicio' });
}
function term(t) {
  const g = GLOSS.find((x) => x[1].toLowerCase() === t.toLowerCase());
  if (!g) return;
  sheet(`<h3 class="ficha-name">${esc(g[1])}</h3><p>${esc(g[2])}</p><p class="muted">Ejemplo: ${esc(g[3])}</p>`, { title: 'Glosario' });
}

/* ============================================================
   Registro diario y tests
   ============================================================ */
function checkinSheet() {
  const today = isoDate(); const c = S.checkins[today] || {};
  const scale = (id, n, v, lo, hi) => `<div class="scale" role="group" aria-label="${lo} a ${hi}">${Array.from({ length: n }, (_, i) => i + 1).map((k) => `<button type="button" data-act="scale" data-id="${id}" data-n="${k}" aria-pressed="${v === k}">${k}</button>`).join('')}</div><div class="scale-l"><span>${lo}</span><span>${hi}</span></div>`;
  sheet(`
    <div class="grid2">
      <label class="field"><span>Pulso en reposo</span><div class="unit-in"><input type="number" id="c-hr" inputmode="numeric" value="${c.hr ?? ''}" placeholder="—"><em>lpm</em></div></label>
      <label class="field"><span>Peso</span><div class="unit-in"><input type="number" id="c-weight" inputmode="decimal" step="0.1" value="${c.weight ?? ''}" placeholder="—"><em>kg</em></div></label>
      <label class="field"><span>Horas de sueño</span><div class="unit-in"><input type="number" id="c-sleep" inputmode="decimal" step="0.5" value="${c.sleep ?? ''}" placeholder="—"><em>h</em></div></label>
      <div class="field"><span>Calidad del sueño</span>${scale('sleepq', 5, c.sleepq, 'Mala', 'Muy buena')}</div>
    </div>
    <div class="field"><span>Energía</span>${scale('energy', 5, c.energy, 'Sin energía', 'A full')}</div>
    <div class="field"><span>Dolor muscular</span>${scale('sore', 5, c.sore, 'Nada', 'Mucho')}</div>
    <label class="field"><span>Molestia de tobillo</span><input type="range" id="c-ank" min="0" max="10" value="${c.ankle ?? 0}"><output id="c-ank-o" class="range-o">${c.ankle ?? 0} de 10</output></label>
    <p class="muted small-note">Pulso: 60 s contando, acostado, apenas te despertás. Peso: en ayunas, después del baño.</p>
    <button type="button" class="btn primary block" data-act="cisave">Guardar</button>`, { title: 'Cómo amaneciste' });
  sheetScale = { sleepq: c.sleepq ?? null, energy: c.energy ?? null, sore: c.sore ?? null };
}
let sheetScale = {};
function checkinSave() {
  const today = isoDate();
  S.checkins[today] = {
    hr: num($('#c-hr').value), weight: num($('#c-weight').value), sleep: num($('#c-sleep').value),
    sleepq: sheetScale.sleepq, energy: sheetScale.energy, sore: sheetScale.sore, ankle: Number($('#c-ank').value)
  };
  save(); closeSheet(); render(); toast('Registro guardado');
}
function testsSheet() {
  const last = S.tests[S.tests.length - 1];
  sheet(`
    <p class="muted">Siempre en las mismas condiciones: misma hora, mismo calzado, después de entrar en calor. Dejá vacío lo que no midas.</p>
    <label class="field"><span>Fecha</span><input type="date" id="t-date" value="${isoDate()}"></label>
    ${TESTS.map((t) => `<label class="field test-f"><span>${esc(t.label)}${t.hint ? `<small>${esc(t.hint)}</small>` : ''}</span><div class="unit-in"><input type="number" id="t-${t.id}" inputmode="decimal" step="${t.step || 1}" placeholder="${last && last.values[t.id] != null ? 'antes: ' + fmtNum(last.values[t.id]) : '—'}"><em>${esc(t.unit)}</em></div></label>`).join('')}
    <p class="muted small-note">${esc(CAIT_INFO)}</p>
    <button type="button" class="btn primary block" data-act="testsave">Guardar tests</button>`, { title: 'Tests' });
}
function testsSave() {
  const values = {};
  TESTS.forEach((t) => { const v = num($('#t-' + t.id).value); if (v != null) values[t.id] = v; });
  if (!Object.keys(values).length) { toast('Cargá al menos un valor'); return; }
  const first = !S.tests.length;
  S.tests.push({ date: $('#t-date').value || isoDate(), values });
  if (values.flex != null && (first || S.levels.flexiones == null)) S.levels.flexiones = defaultLevel('flexiones');
  save(); closeSheet(); render(); toast('Tests guardados');
}

/* ============================================================
   Actividades extra (fines de semana u otros días)
   ============================================================ */
let exState = { type: 'trote', date: null };
function weekendDates() {
  const d = new Date(); const wd = d.getDay();
  const sat = new Date(d); sat.setDate(d.getDate() - ((wd + 1) % 7));
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
  return [isoDate(sat), isoDate(sun)];
}
function extraSheet(pre) {
  exState = { type: pre || 'trote', date: isoDate() };
  drawExtraSheet();
}
function drawExtraSheet() {
  const A = ACTIVITIES[exState.type];
  const today = isoDate();
  const y = new Date(); y.setDate(y.getDate() - 1); const yy = isoDate(y);
  const y2 = new Date(); y2.setDate(y2.getDate() - 2); const yy2 = isoDate(y2);
  const quick = [[today, 'Hoy'], [yy, 'Ayer'], [yy2, DIAS[y2.getDay()].replace(/^./, (c) => c.toUpperCase())]];
  sheet(`
    <div class="field"><span>Actividad</span>
      <div class="chips" role="group">${Object.entries(ACTIVITIES).map(([k, a]) => `<button type="button" class="chip" data-act="exttype" data-k="${k}" aria-pressed="${k === exState.type}">${esc(a.name)}</button>`).join('')}</div></div>
    <div class="field"><span>Día</span>
      <div class="seg small" role="group">${quick.map(([d, l]) => `<button type="button" class="seg-b" data-act="extdate" data-d="${d}" aria-pressed="${exState.date === d}">${l}</button>`).join('')}</div></div>
    ${A.rest ? '<p class="muted">Un día de descanso también cuenta: la app sabe que no hubo carga extra.</p>' : `
    ${A.label ? `<label class="field"><span>Qué hiciste</span><input type="text" id="x-label" placeholder="Ej.: natación, escalada"></label>` : ''}
    <div class="grid2">
      ${A.min ? `<label class="field"><span>Duración</span><div class="unit-in"><input type="number" id="x-min" inputmode="numeric" value="${A.def || ''}" placeholder="—"><em>min</em></div></label>` : ''}
      ${A.km ? `<label class="field"><span>Distancia</span><div class="unit-in"><input type="number" id="x-km" inputmode="decimal" step="0.1" placeholder="—"><em>km</em></div></label>` : ''}
    </div>
    <label class="field"><span>Esfuerzo (RPE)</span><input type="range" id="x-rpe" min="1" max="10" value="5"><output id="x-rpe-o" class="range-o">5 · Moderado</output></label>
    <label class="field"><span>Molestia de tobillo</span><input type="range" id="x-ank" min="0" max="10" value="0"><output id="x-ank-o" class="range-o">0 de 10</output></label>
    <label class="field"><span>Notas (opcional)</span><input type="text" id="x-notes" placeholder="Superficie, cómo te sentiste…"></label>`}
    <button type="button" class="btn primary block" data-act="extsave">Guardar actividad</button>`, { title: 'Actividad extra' });
}
function extraSave() {
  const A = ACTIVITIES[exState.type];
  const x = { id: uid(), date: exState.date, type: exState.type };
  if (!A.rest) {
    x.minutes = num($('#x-min') && $('#x-min').value);
    x.km = A.km ? num($('#x-km').value) : null;
    x.rpe = Number($('#x-rpe').value);
    x.ankle = Number($('#x-ank').value);
    x.notes = $('#x-notes').value.trim();
    if (A.label) x.label = $('#x-label').value.trim();
    if (!x.minutes && !x.km) { toast('Cargá la duración o los kilómetros'); return; }
  }
  const msgs = [];
  if (A.km && x.km) {
    const prev = S.extras.filter((e) => e.type === x.type && e.km && daysBetween(e.date, x.date) <= 30 && daysBetween(e.date, x.date) >= 0);
    const best = prev.length ? Math.max(...prev.map((e) => e.km)) : null;
    if (best && x.km > best * 1.1) msgs.push(`Superaste en más de 10 % tu ${A.name.toLowerCase()} más largo del último mes (${fmtNum(best)} km). Los picos aislados son lo que más lesiona: la próxima vez subí de a poco.`);
    if (!best && x.type === 'trote') msgs.push('Primer trote registrado: la app va a comparar los próximos con este.');
  }
  if (A.cuts && daysBetween(x.date, isoDate()) <= 2) { S.flags.footballAfter = true; msgs.push('La próxima sesión de lunes va con la mitad de los saltos.'); }
  if (x.ankle >= 3) msgs.push('Registraste molestia de tobillo: la semana va sin saltos ni arranques.');
  S.extras.push(x); S.extras.sort((a, b) => (a.date < b.date ? -1 : 1));
  save();
  if (msgs.length) sheet(`<p class="big-ok">${IC.check}<span>Actividad guardada</span></p>${msgs.map((m) => `<p class="note-warn">${esc(m)}</p>`).join('')}<button type="button" class="btn primary block" data-act="closesheet">Listo</button>`, { title: 'Actividad extra' });
  else { closeSheet(); toast('Actividad guardada'); }
  render();
}
function extraLabel(x) {
  const A = ACTIVITIES[x.type]; if (!A) return x.type;
  if (A.rest) return 'Descanso';
  const parts = [x.label || A.name]; if (x.km) parts.push(`${fmtNum(x.km)} km`); if (x.minutes) parts.push(`${x.minutes} min`);
  return parts.join(' · ');
}

/* Tira de la semana (lunes a domingo) */
function weekStrip() {
  const P = prog(); const now = new Date(); const wd = (now.getDay() + 6) % 7;
  const mon = new Date(now); mon.setDate(now.getDate() - wd);
  const byDay = {}; Object.entries(P.days || {}).forEach(([k, d]) => { byDay[d] = k; });
  const letters = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  return `<div class="strip" role="list" aria-label="Tu semana">${Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon); d.setDate(mon.getDate() + i); const iso = isoDate(d); const jsDay = d.getDay();
    const planned = byDay[jsDay];
    const done = S.sessions.find((s) => s.date === iso);
    const ex = S.extras.filter((x) => x.date === iso);
    const isToday = iso === isoDate();
    const rest = ex.some((x) => x.type === 'descanso');
    const extraNames = ex.filter((x) => x.type !== 'descanso').map((x) => ACTIVITIES[x.type] ? (x.label || ACTIVITIES[x.type].name) : x.type);
    const state = done ? 'done' : planned ? (iso < isoDate() ? 'missed' : 'plan') : ex.length ? 'extra' : 'free';
    return `<div class="sd ${state} ${isToday ? 'today' : ''}" role="listitem" aria-label="${DIAS[jsDay]} ${d.getDate()}${done ? ', sesión hecha' : planned ? ', sesión planificada' : ''}${extraNames.length ? ', ' + extraNames.join(', ') : ''}">
      <span class="sd-l">${letters[i]}</span>
      <span class="sd-c">${done ? IC.check : planned ? esc(P.sessions[planned] ? P.sessions[planned].name.slice(0, 3) : '') : d.getDate()}</span>
      <span class="sd-x">${extraNames.length ? esc(extraNames[0].slice(0, 7)) : rest ? 'Desc.' : ''}</span>
    </div>`; }).join('')}</div>`;
}

/* ============================================================
   Capítulos: pantalla, importar y exportar
   ============================================================ */
function renderChapters(el) {
  const act = prog().id;
  el.innerHTML = backBar('Capítulos') + `
    <p class="muted">Cada capítulo es un programa de entrenamiento. Tus niveles, registros y tests se mantienen al cambiar de capítulo.</p>
    <ul class="chap-list">${allChapters().map((c) => {
      const n = S.sessions.filter((x) => (x.chapter || 'fase1') === c.id).length;
      return `<li class="card chap ${c.id === act ? 'on' : ''}">
        <div class="row-between"><div><h3>${esc(c.name)}</h3><p class="muted">${c.weeks} semanas · ${c.rotation.length} sesiones por semana · ${n} hechas</p></div>${c.id === act ? '<span class="pill">Activo</span>' : ''}</div>
        ${c.desc ? `<p>${esc(c.desc)}</p>` : ''}
        <div class="chap-actions">
          ${c.id !== act ? `<button type="button" class="btn small primary" data-act="chapon" data-id="${esc(c.id)}">Activar</button>` : ''}
          ${!c.builtin && c.id !== act ? `<button type="button" class="btn small" data-act="chapdel" data-id="${esc(c.id)}">Quitar</button>` : ''}
        </div></li>`; }).join('')}</ul>
    <section class="card">
      <h3>Cargar un capítulo nuevo</h3>
      <p class="muted">Elegí el archivo .json que te pasé en el chat.</p>
      <label class="btn primary block file-btn">Elegir archivo de capítulo<input type="file" id="chap-imp" accept=".json,application/json"></label>
      <button type="button" class="btn block" data-act="chapexport">Exportar el capítulo activo</button>
    </section>`;
}
let pendingChapter = null;
function importChapter(file) {
  const r = new FileReader();
  r.onload = () => {
    let c; try { c = JSON.parse(r.result); if (c.chapter) c = c.chapter; } catch (e) { toast('Ese archivo no es un capítulo válido.'); return; }
    const errs = validateChapter(c);
    if (errs.length) { sheet(`<p>El capítulo tiene errores y no se cargó:</p><ul class="dots warn">${errs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><button type="button" class="btn block" data-act="closesheet">Cerrar</button>`, { title: 'Capítulo con errores' }); return; }
    pendingChapter = c;
    const exists = (S.chapters || []).some((x) => x.id === c.id);
    sheet(`<h3 class="ficha-name">${esc(c.name)}</h3>${c.desc ? `<p>${esc(c.desc)}</p>` : ''}<p class="muted">${c.weeks} semanas · ${c.rotation.length} sesiones por semana · ${Object.keys(c.exercises || {}).length} ejercicios nuevos</p>${exists ? '<p class="note-warn">Ya tenés un capítulo con este id: se reemplaza por esta versión. Tu historial no se toca.</p>' : ''}
      <div class="sheet-actions"><button type="button" class="btn" data-act="chapadd" data-on="0">Solo guardar</button><button type="button" class="btn primary" data-act="chapadd" data-on="1">Guardar y activar</button></div>`, { title: 'Nuevo capítulo' });
  };
  r.readAsText(file);
}
function exportChapter() {
  const P = prog();
  const out = { id: P.id, name: P.name, short: P.short, desc: P.desc || '', weeks: P.weeks, rotation: P.rotation, days: P.days, preMatch: P.preMatch, postMatch: P.postMatch, ramp: P.ramp, sessions: P.sessions, exercises: P.exercises || {} };
  deliver(`capitulo-${P.id}.json`, JSON.stringify({ chapter: out }, null, 1), 'application/json');
}

/* ============================================================
   Pantalla: Progreso
   ============================================================ */
function spark(points, unit, better) {
  if (points.length < 2) return '<p class="muted small-note">Faltan datos: aparece con dos registros o más.</p>';
  const w = 300, h = 84, p = 8;
  const ys = points.map((x) => x.v); const min = Math.min(...ys), max = Math.max(...ys); const span = max - min || 1;
  const X = (i) => p + (i * (w - 2 * p)) / (points.length - 1); const Y = (v) => h - p - ((v - min) * (h - 2 * p)) / span;
  const d = points.map((pt, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(pt.v).toFixed(1)}`).join(' ');
  const area = `${d} L${X(points.length - 1).toFixed(1)},${h - p} L${X(0).toFixed(1)},${h - p} Z`;
  const lastPt = points[points.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Evolución"><path d="${area}" class="spark-a"/><path d="${d}" class="spark-l"/><circle cx="${X(points.length - 1)}" cy="${Y(lastPt.v)}" r="3.5" class="spark-p"/></svg>
    <div class="spark-meta"><span>${fmtShort(points[0].d)}: ${fmtNum(points[0].v)} ${unit}</span><span>${fmtShort(lastPt.d)}: <strong>${fmtNum(lastPt.v)} ${unit}</strong></span></div>`;
}
function renderProgreso() {
  const wi = weekInfo();
  const ci = checkinList();
  const weights = ci.filter((c) => c.weight).map((c) => ({ d: c.d, v: c.weight }));
  const hrs = ci.filter((c) => c.hr).map((c) => ({ d: c.d, v: c.hr }));
  const per = wi.P.rotation.length;
  const segs = Array.from({ length: wi.P.weeks }, (_, k) => { const doneInWeek = Math.max(0, Math.min(per, wi.idx - k * per)); return `<div class="wk ${k + 1 === wi.week && !wi.phaseDone ? 'now' : ''}"><div class="wk-bar">${Array.from({ length: per }, (_, n) => `<i class="${n < doneInWeek ? 'on' : ''}"></i>`).join('')}</div><span>${k + 1}${wi.P.ramp[k + 1].deload ? 'D' : ''}</span></div>`; }).join('');
  const lvRows = Object.keys(EX).filter((k) => EX[k].levels && (S.levels[k] != null)).map((k) => { const i = S.levels[k]; return `<li><button type="button" class="lv-row" data-act="ficha" data-ex="${k}"><span>${esc(EX[k].name)}</span><span class="lv-v">${esc(EX[k].levels[i])}<em>${i + 1}/${EX[k].levels.length}</em></span></button></li>`; }).join('');
  const t0 = S.tests[0], tl = S.tests[S.tests.length - 1];
  const tRows = t0 ? TESTS.filter((t) => t0.values[t.id] != null || (tl && tl.values[t.id] != null)).map((t) => {
    const a = t0.values[t.id], b = tl.values[t.id];
    let cls = ''; if (S.tests.length > 1 && a != null && b != null && a !== b) cls = (t.better === 'low' ? b < a : b > a) ? 'up' : t.better ? 'down' : '';
    return `<tr><th scope="row">${esc(t.label)}</th><td>${a != null ? fmtNum(a) : '—'}</td>${S.tests.length > 1 ? `<td class="${cls}">${b != null ? fmtNum(b) : '—'}</td>` : ''}<td class="u">${esc(t.unit)}</td></tr>`;
  }).join('') : '';
  const allH = [...S.sessions.map((s) => ({ d: s.date, k: 's', s })), ...S.extras.map((x) => ({ d: x.date, k: 'x', x }))].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 40);
  const hist = allH.map((h) => h.k === 's'
    ? `<li><span class="h-d">${fmtShort(h.d)}</span><span class="h-t">${esc(sessName(h.s))}<small>Semana ${h.s.week}${h.s.reduced ? ' · reducido' : ''}${h.s.football ? ' · partido' : ''}</small></span><span class="h-l">${h.s.rpe ? h.s.rpe * h.s.minutes : '—'}<small>carga</small></span></li>`
    : `<li class="h-x"><span class="h-d">${fmtShort(h.d)}</span><span class="h-t">${esc(extraLabel(h.x))}<small>Actividad extra</small></span><span class="h-l">${h.x.rpe && h.x.minutes ? h.x.rpe * h.x.minutes : '—'}<small>carga</small></span></li>`).join('');
  $('#v-progreso').innerHTML = `
    <section class="card">
      <div class="row-between"><h3>${esc(wi.P.name)}</h3><span class="muted">${Math.min(wi.idx, wi.total)} de ${wi.total} sesiones</span></div>
      <div class="weeks" aria-label="Semanas de la fase">${segs}</div>
      <p class="muted small-note">Cada barra es una semana de 3 sesiones. D = descarga.</p>
    </section>
    <section class="card"><h3>Tus niveles</h3>${lvRows ? `<ul class="lv-list">${lvRows}</ul>` : '<p class="muted">Aparecen a medida que completás sesiones.</p>'}</section>
    <section class="card"><h3>Tests</h3>${t0 ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>${fmtShort(t0.date)}</th>${S.tests.length > 1 ? `<th>${fmtShort(tl.date)}</th>` : ''}<th></th></tr></thead><tbody>${tRows}</tbody></table></div>` : '<p class="muted">Todavía no cargaste tests.</p>'}<button type="button" class="btn small" data-act="tests">Cargar tests</button></section>
    <section class="card"><h3>Peso</h3>${spark(weights, 'kg')}</section>
    <section class="card"><h3>Pulso en reposo</h3>${spark(hrs, 'lpm')}</section>
    <section class="card"><h3>Historial</h3>${hist ? `<ul class="hist">${hist}</ul>` : '<p class="muted">Tus sesiones aparecen acá.</p>'}</section>`;
}

/* ============================================================
   Pantalla: Más
   ============================================================ */
let masSub = null;
function renderMas() {
  const el = $('#v-mas');
  if (masSub === 'ejercicios') return renderCatalog(el);
  if (masSub === 'glosario') return renderGloss(el);
  if (masSub === 'ajustes') return renderSettings(el);
  if (masSub === 'respaldo') return renderBackup(el);
  if (masSub === 'plan') return renderPlan(el);
  if (masSub === 'capitulos') return renderChapters(el);
  el.innerHTML = `
    <ul class="menu">
      ${menuRow('capitulos', 'Capítulos', `Programa activo: ${esc(prog().name)}`)}
      ${menuRow('ejercicios', 'Ejercicios', 'Fichas, niveles y videos de cada ejercicio')}
      ${menuRow('glosario', 'Glosario', 'Qué significa RIR, tempo, descarga y el resto')}
      ${menuRow('plan', 'Cómo funciona el plan', 'Fases, rampa semanal y reglas de la app')}
      <li><button type="button" class="menu-r" data-act="tests"><span><strong>Tests</strong><small>Cargar una medición nueva</small></span>${IC.chev}</button></li>
      <li><button type="button" class="menu-r" data-act="micro"><span><strong>Microsesión de movilidad</strong><small>10 minutos para los días libres</small></span>${IC.chev}</button></li>
      ${menuRow('ajustes', 'Temporizador y sonido', 'Modo, cuenta regresiva, pitidos y vibración')}
      ${menuRow('respaldo', 'Exportar y respaldo', 'Archivo para la revisión, copia de seguridad, restaurar')}
    </ul>
    <p class="muted small-note center">Entreno ${APP_VERSION} · tus datos se guardan solo en este teléfono</p>`;
}
function menuRow(k, t, d) { return `<li><button type="button" class="menu-r" data-act="sub" data-k="${k}"><span><strong>${t}</strong><small>${d}</small></span>${IC.chev}</button></li>`; }
function backBar(t) { return `<div class="subbar"><button type="button" class="link" data-act="sub" data-k="">‹ Más</button><h2>${t}</h2></div>`; }
function renderCatalog(el) {
  const cats = [];
  Object.entries(EX).forEach(([k, e]) => { let c = cats.find((x) => x.n === e.cat); if (!c) { c = { n: e.cat, l: [] }; cats.push(c); } c.l.push([k, e]); });
  el.innerHTML = backBar('Ejercicios') + cats.map((c) => `<section class="card flat"><h3>${esc(c.n)}</h3><ul class="cat-list">${c.l.map(([k, e]) => `<li><button type="button" class="cat-r" data-act="ficha" data-ex="${k}"><span>${esc(e.name)}</span>${e.levels && S.levels[k] != null ? `<em>Nivel ${S.levels[k] + 1}</em>` : ''}${IC.chev}</button></li>`).join('')}</ul></section>`).join('');
}
function renderGloss(el) {
  el.innerHTML = backBar('Glosario') + `<label class="field"><span class="sr">Buscar</span><input type="search" id="g-q" placeholder="Buscar término" autocomplete="off"></label><div id="g-list"></div>`;
  drawGloss('');
}
function drawGloss(q) {
  const ql = q.trim().toLowerCase();
  const groups = [];
  GLOSS.filter((g) => !ql || (g[1] + ' ' + g[2]).toLowerCase().includes(ql)).forEach((g) => { let x = groups.find((y) => y.n === g[0]); if (!x) { x = { n: g[0], l: [] }; groups.push(x); } x.l.push(g); });
  $('#g-list').innerHTML = groups.length ? groups.map((gr) => `<section class="card flat"><h3>${esc(gr.n)}</h3><dl class="gloss">${gr.l.map((g) => `<div><dt>${esc(g[1])}</dt><dd>${esc(g[2])}<span>Ejemplo: ${esc(g[3])}</span></dd></div>`).join('')}</dl></section>`).join('') : '<p class="muted center">Sin resultados.</p>';
}
function renderSettings(el) {
  const st = S.settings;
  el.innerHTML = backBar('Temporizador y sonido') + `
    <section class="card">
      <h3>Modo por defecto</h3>
      <div class="seg" role="group"><button type="button" class="seg-b" data-act="mode" data-m="guiado" aria-pressed="${st.timerMode === 'guiado'}">Guiado</button><button type="button" class="seg-b" data-act="mode" data-m="continuo" aria-pressed="${st.timerMode === 'continuo'}">Continuo</button></div>
      <p class="muted small-note"><strong>Guiado:</strong> le das play a cada serie, hay una cuenta regresiva, y al pitido arrancás; los descansos corren solos. <strong>Continuo:</strong> corre todo seguido, con pitido de inicio, de fin, descanso y aviso 5 s antes de la siguiente actividad. En series por repeticiones usa un tiempo estimado.</p>
    </section>
    <section class="card">
      <h3>Cuenta regresiva antes de cada serie</h3>
      <div class="seg" role="group">${[3, 5, 10].map((n) => `<button type="button" class="seg-b" data-act="cd" data-n="${n}" aria-pressed="${st.countdown === n}">${n} s</button>`).join('')}</div>
    </section>
    <section class="card">
      <label class="tgl"><input type="checkbox" id="st-sound" ${st.sound ? 'checked' : ''}><span class="tgl-ui" aria-hidden="true"></span><span><strong>Pitidos</strong><small>Inicio, fin y últimos 3 segundos</small></span></label>
      <label class="tgl"><input type="checkbox" id="st-vib" ${st.vibrate ? 'checked' : ''}><span class="tgl-ui" aria-hidden="true"></span><span><strong>Vibración</strong><small>Acompaña cada pitido</small></span></label>
      <button type="button" class="btn small" data-act="testsound">Probar sonido</button>
    </section>`;
}
function renderBackup(el) {
  el.innerHTML = backBar('Exportar y respaldo') + `
    <section class="card">
      <h3>Para la revisión con Claude</h3>
      <p class="muted">Un archivo con todo tu historial. Subilo en el chat cuando quieras ajustar el plan.</p>
      <button type="button" class="btn primary block" data-act="export">Exportar para revisión</button>
      <button type="button" class="btn block" data-act="csv">Exportar tabla de series (CSV)</button>
      <button type="button" class="btn block" data-act="copysum">Copiar resumen como texto</button>
    </section>
    <section class="card">
      <h3>Restaurar un respaldo</h3>
      <p class="muted">Reemplaza todos los datos de este teléfono por los del archivo.</p>
      <label class="btn block file-btn">Elegir archivo de respaldo<input type="file" id="imp" accept=".json,application/json"></label>
    </section>
    <section class="card">
      <h3>Borrar todo</h3>
      <p class="muted">Elimina sesiones, niveles, registros y tests de este teléfono. Exportá antes.</p>
      <button type="button" class="btn danger" data-act="wipe">Borrar todos los datos</button>
    </section>`;
}
function renderPlan(el) {
  el.innerHTML = backBar('Cómo funciona el plan') + `
    <section class="card"><h3>Rampa de ${esc(prog().short || prog().name)}</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sem.</th><th>Series</th><th>RIR fuerza</th><th>RIR músculo</th><th>Aeróbico mié.</th></tr></thead><tbody>
      ${Array.from({ length: prog().weeks }, (_, i) => i + 1).map((w) => { const r = prog().ramp[w]; return `<tr><th scope="row">${w}${r.deload ? ' (descarga)' : ''}</th><td>${r.sets}</td><td>${esc(r.rirS ?? '—')}</td><td>${esc(r.rirH ?? '—')}</td><td>${r.aero != null ? r.aero + ' min' : '—'}</td></tr>`; }).join('')}
    </tbody></table></div></section>
    <section class="card"><h3>Cuándo subís de nivel</h3><p>Cuando completás todas las series en el tope del rango, con el RIR indicado, dos sesiones seguidas. Si dos sesiones seguidas no llegás al mínimo, volvés al nivel anterior.</p></section>
    <section class="card"><h3>Lo que la app ajusta sola</h3><ul class="dots">
      <li>Partido el sábado: viernes sin potencia y con una serie menos; lunes con la mitad de los saltos.</li>
      <li>Tobillo con 3/10 o más en la última semana: sin saltos ni arranques. Con 5/10 o más, sin impacto y aviso de consulta.</li>
      <li>Pulso en reposo 5 latidos sobre tu base, 3 días seguidos: versión suave (desde la semana 4, cuando ya conoce tu base).</li>
      <li>Tres días con poca energía y poco sueño: sugiere adelantar la descarga.</li>
      <li>Más de una semana sin entrenar: repetís la semana anterior. Tres semanas o más: volvés a la semana 1.</li>
      <li>Un ejercicio sin mejorar en 3 semanas: te sugiere cambiar una sola variable.</li>
    </ul></section>
    <section class="card"><h3>Orden de cada sesión</h3><p>Tobillo y calentamiento, potencia, fuerza, aeróbico, estiramiento. Así los saltos se hacen frescos y la fuerza no se mezcla con el cansancio del aeróbico.</p></section>`;
}

/* ============================================================
   Exportar e importar
   ============================================================ */
async function deliver(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Archivo descargado');
}
function exportJSON() {
  const data = { app: 'entreno', version: APP_VERSION, exportedAt: new Date().toISOString(), summary: summaryText(), state: S };
  deliver(`entreno-${isoDate()}.json`, JSON.stringify(data, null, 1), 'application/json');
}
function exportCSV() {
  const rows = [['fecha', 'sesion', 'semana', 'ejercicio', 'nivel', 'serie', 'valor', 'unidad', 'rir', 'rpe_sesion', 'minutos', 'tobillo', 'reducido', 'partido']];
  S.sessions.forEach((s) => s.items.forEach((it) => {
    const ex = EX[it.ex]; const lv = ex.levels ? ex.levels[Math.min(it.levelIdx, ex.levels.length - 1)] : '';
    if (it.log.sets.length && !['rondas', 'min', 'rutina'].includes(it.unit) && !ex.steps) it.log.sets.forEach((st, k) => rows.push([s.date, s.type, s.week, ex.name, lv, k + 1, st.done ? st.v : '', it.unit === 'secs' ? 's' : 'reps', it.log.rir ?? '', s.rpe ?? '', s.minutes ?? '', s.ankle ?? '', s.reduced ? 1 : 0, s.football ? 1 : 0]));
    else rows.push([s.date, s.type, s.week, ex.name, '', '', it.log.done ? 'hecho' : '', it.unit, '', s.rpe ?? '', s.minutes ?? '', s.ankle ?? '', s.reduced ? 1 : 0, s.football ? 1 : 0]);
  }));
  S.extras.forEach((x) => rows.push([x.date, 'extra', '', extraLabel(x), '', '', x.km ?? '', x.km ? 'km' : '', '', x.rpe ?? '', x.minutes ?? '', x.ankle ?? '', '', '']));
  const csv = rows.map((r) => r.map((v) => { const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  deliver(`entreno-series-${isoDate()}.csv`, '﻿' + csv, 'text/csv');
}
function summaryText() {
  const wi = weekInfo();
  const lines = [`Entreno · resumen al ${isoDate()}`, `${wi.P.name}, semana ${wi.week} (${wi.idx} de ${wi.total} sesiones)`];
  lines.push('Niveles: ' + Object.keys(S.levels).map((k) => `${EX[k].name}: ${EX[k].levels[S.levels[k]]}`).join('; '));
  const ci = checkinList().slice(-7);
  if (ci.length) lines.push('Últimos registros: ' + ci.map((c) => `${fmtShort(c.d)} pulso ${c.hr ?? '-'}, peso ${c.weight ?? '-'}, sueño ${c.sleep ?? '-'}, energía ${c.energy ?? '-'}, tobillo ${c.ankle ?? '-'}`).join(' | '));
  S.sessions.slice(-6).forEach((s) => lines.push(`${s.date} ${sessName(s)}: RPE ${s.rpe}, ${s.minutes} min, tobillo ${s.ankle}${s.notes2 ? ', nota: ' + s.notes2 : ''}`));
  const ex = S.extras.slice(-8); if (ex.length) lines.push('Actividades extra: ' + ex.map((x) => `${x.date} ${extraLabel(x)}${x.rpe ? ' RPE ' + x.rpe : ''}`).join(' | '));
  if (S.tests.length) lines.push('Tests: ' + S.tests.map((t) => `${t.date} ` + Object.entries(t.values).map(([k, v]) => `${k}=${v}`).join(' ')).join(' | '));
  return lines.join('\n');
}
async function copySummary() {
  const txt = summaryText();
  try { await navigator.clipboard.writeText(txt); toast('Resumen copiado'); }
  catch (e) { sheet(`<p class="muted">No se pudo copiar solo. Mantené apretado el texto para copiarlo.</p><textarea class="copy-area" rows="10" readonly>${esc(txt)}</textarea>`, { title: 'Resumen' }); }
}
function importFile(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      const st = data.state || data;
      if (!st || !Array.isArray(st.sessions)) throw new Error('formato');
      sheet(`<p>El archivo tiene <strong>${st.sessions.length} sesiones</strong> y ${(st.tests || []).length} tests${data.exportedAt ? `, exportado el ${esc(data.exportedAt.slice(0, 10))}` : ''}.</p><p>Restaurarlo reemplaza todo lo que hay ahora en este teléfono.</p><div class="sheet-actions"><button type="button" class="btn" data-act="closesheet">Cancelar</button><button type="button" class="btn primary" data-act="impok">Restaurar</button></div>`, { title: 'Restaurar respaldo' });
      pendingImport = st;
    } catch (e) { toast('Ese archivo no es un respaldo de Entreno.'); }
  };
  r.readAsText(file);
}
let pendingImport = null;

/* ============================================================
   Microsesión (días libres)
   ============================================================ */
function startMicro() {
  if (S.current) { toast('Terminá la sesión en curso primero.'); return; }
  const item = { uid: uid(), ex: 'micro', base: 'micro', block: 'Movilidad', g: null, sets: 1, range: null, rest: 0, unit: 'rutina', perSide: false, levelIdx: null, rir: null, log: { sets: [{ v: null, done: false }], rir: null, done: false } };
  T.steps = buildSteps({ items: [item] }, item.uid);
  T.i = 0; T.open = true; T.running = true; T.micro = true; T.quick = false;
  audio(); enterStep(true); keepAwake(true); renderTimer(); loop();
}

/* ============================================================
   Vista del temporizador
   ============================================================ */
function renderTimer() {
  const ov = $('#timer');
  if (!T.open) { ov.hidden = true; document.body.classList.remove('locked-t'); renderMini(); return; }
  ov.hidden = false; document.body.classList.add('locked-t');
  paintTimer(); renderMini();
}
function paintTimer() {
  if (!T.open) { renderMini(); return; }
  const st = cur(); if (!st) return;
  const ov = $('#timer');
  const ph = T.phase;
  ov.dataset.phase = ph;
  const next = T.steps.slice(T.i + 1).find((x) => x.type === 'work');
  const label = ph === 'waiting' ? 'Listo para arrancar' : ph === 'prep' ? 'Preparate' : ph === 'rest' ? (st.short ? st.label : st.trans ? 'Cambio de ejercicio' : 'Descanso') : 'Ahora';
  $('#t-phase').textContent = label;
  const nx = T.steps.slice(T.i + 1).find((x) => x.type === 'work');
  $('#t-name').textContent = ph === 'rest' ? (st.short ? st.detail : nx ? `Sigue: ${nx.label}` : st.label) : st.label;
  $('#t-detail').textContent = ph === 'rest' ? (st.short ? '' : nx ? nx.detail : '') : st.detail;
  const manual = ph === 'work' && T.remaining == null;
  $('#t-clock').textContent = ph === 'waiting' ? '▶' : manual ? fmtClock(T.elapsed) : fmtClock(T.remaining);
  $('#t-clock').classList.toggle('counting-up', manual);
  $('#t-hint').textContent = ph === 'waiting' ? 'Tocá play: cuenta regresiva y pitido de inicio' : manual ? 'Hacé las repeticiones y tocá Listo' : ph === 'prep' ? 'Arranca con el pitido' : '';
  $('#t-done').hidden = !(ph === 'work');
  $('#t-done').textContent = manual ? 'Listo' : 'Terminar ya';
  $('#t-toggle').innerHTML = (T.running && ph !== 'waiting') ? IC.pause : IC.play;
  $('#t-toggle').setAttribute('aria-label', (T.running && ph !== 'waiting') ? 'Pausar' : 'Seguir');
  $('#t-next').textContent = next && ph !== 'rest' ? `Después: ${next.label} · ${next.detail}` : (ph === 'rest' ? '' : 'Último paso');
  const total = T.steps.filter((x) => x.type === 'work').length; const doneW = T.steps.slice(0, T.i).filter((x) => x.type === 'work').length;
  $('#t-bar').style.width = `${total ? (doneW / total) * 100 : 0}%`;
  $('#t-mode').textContent = S.settings.timerMode === 'guiado' ? 'Modo guiado' : 'Modo continuo';
  renderMini();
}
function renderMini() {
  const m = $('#mini');
  if (!T.steps.length || T.open) { m.hidden = true; return; }
  const st = cur(); if (!st) { m.hidden = true; return; }
  m.hidden = false;
  $('#mini-t').textContent = T.phase === 'work' && T.remaining == null ? fmtClock(T.elapsed) : T.phase === 'waiting' ? '▶' : fmtClock(T.remaining);
  $('#mini-l').textContent = T.phase === 'rest' ? 'Descanso' : st.label;
}

/* ============================================================
   Eventos
   ============================================================ */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  switch (a) {
    case 'tab': go(b.dataset.view); break;
    case 'pick': pickNext = b.dataset.k; renderHoy(); break;
    case 'start': startSession(pickNext || nextType()); pickNext = null; break;
    case 'resume': go('sesion'); break;
    case 'play': if (S.current) timerStart(b.dataset.uid); break;
    case 'mode': S.settings.timerMode = b.dataset.m; save(); render(); if (T.open) paintTimer(); break;
    case 'cd': S.settings.countdown = Number(b.dataset.n); save(); render(); break;
    case 'testsound': audio(); BEEP.tick(); setTimeout(BEEP.start, 400); setTimeout(BEEP.warn, 1000); setTimeout(BEEP.end, 1600); break;
    case 'set': {
      const it = S.current.items.find((x) => x.uid === b.dataset.uid); const k = Number(b.dataset.k); const s0 = it.log.sets[k];
      if (s0.done) { setSheet(it.uid, k); break; }
      s0.done = true; s0.v = it.range[1]; save(); renderSession();
      toast(`Serie ${k + 1}: ${s0.v}${it.unit === 'secs' ? ' s' : ''}. Tocala para corregir.`);
      const more = it.log.sets.some((x) => !x.done);
      if (!T.steps.length && it.rest) quickRest(it.rest, more ? `Sigue la serie ${k + 2}` : 'Siguiente ejercicio');
      break;
    }
    case 'stepv': { const o = $('#set-v'); o.textContent = Math.max(0, Number(o.textContent) + Number(b.dataset.d)); break; }
    case 'setsave': { const it = S.current.items.find((x) => x.uid === b.dataset.uid); const s = it.log.sets[Number(b.dataset.k)]; s.v = Number($('#set-v').textContent); s.done = true; save(); closeSheet(); renderSession(); break; }
    case 'setundo': { const it = S.current.items.find((x) => x.uid === b.dataset.uid); const s = it.log.sets[Number(b.dataset.k)]; s.done = false; s.v = null; save(); closeSheet(); renderSession(); break; }
    case 'blockdone': { const it = S.current.items.find((x) => x.uid === b.dataset.uid); it.log.done = !it.log.done; it.log.sets.forEach((s) => { s.done = it.log.done; }); save(); renderSession(); break; }
    case 'rir': { const it = S.current.items.find((x) => x.uid === b.dataset.uid); const n = Number(b.dataset.n); it.log.rir = it.log.rir === n ? null : n; save(); renderSession(); break; }
    case 'ficha': ficha(b.dataset.ex); break;
    case 'term': term(b.dataset.t); break;
    case 'lv': { const ex = EX[b.dataset.ex]; const c = S.levels[b.dataset.ex] ?? defaultLevel(b.dataset.ex); S.levels[b.dataset.ex] = Math.max(0, Math.min(ex.levels.length - 1, c + Number(b.dataset.d))); S.streaks[b.dataset.ex] = { up: 0, down: 0 }; if (S.current) S.current.items.forEach((it) => { if (it.ex === b.dataset.ex) it.levelIdx = S.levels[b.dataset.ex]; }); save(); ficha(b.dataset.ex); render(); break; }
    case 'vidsave': { const v = $('#vid-url').value.trim(); if (!/^https?:\/\//.test(v)) { toast('Pegá un link que empiece con https://'); break; } S.videos[b.dataset.ex] = v; save(); ficha(b.dataset.ex); toast('Video guardado'); break; }
    case 'viddel': delete S.videos[b.dataset.ex]; save(); ficha(b.dataset.ex); break;
    case 'finish': finishSheet(); break;
    case 'finishsave': finishSave(); render(); break;
    case 'discard': sheet('<p>Se borra lo registrado en esta sesión. No cuenta para la semana.</p><div class="sheet-actions"><button type="button" class="btn" data-act="closesheet">Volver</button><button type="button" class="btn danger" data-act="discardok">Descartar</button></div>', { title: 'Descartar sesión' }); break;
    case 'discardok': S.current = null; if (T.open || T.steps.length) timerStop(); save(); closeSheet(); go('hoy'); break;
    case 'checkin': checkinSheet(); break;
    case 'scale': sheetScale[b.dataset.id] = Number(b.dataset.n); b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); break;
    case 'cisave': checkinSave(); break;
    case 'tests': testsSheet(); break;
    case 'testsave': testsSave(); break;
    case 'deload': S.deloadLeft = 3; save(); render(); toast('Las próximas 3 sesiones van con la mitad del volumen'); break;
    case 'micro': closeSheetQuiet(); startMicro(); break;
    case 'sub': masSub = b.dataset.k || null; renderMas(); window.scrollTo(0, 0); break;
    case 'export': exportJSON(); break;
    case 'csv': exportCSV(); break;
    case 'copysum': copySummary(); break;
    case 'impok': if (pendingImport) { S = Object.assign(defaultState(), pendingImport); pendingImport = null; rebuildEx(); save(); closeSheet(); go('hoy'); toast('Respaldo restaurado'); } break;
    case 'wipe': sheet('<p>Se borran todas las sesiones, niveles, registros y tests de este teléfono. No se puede deshacer.</p><div class="sheet-actions"><button type="button" class="btn" data-act="closesheet">Cancelar</button><button type="button" class="btn danger" data-act="wipeok">Borrar todo</button></div>', { title: 'Borrar todos los datos' }); break;
    case 'wipeok': S = defaultState(); rebuildEx(); save(); closeSheet(); go('hoy'); toast('Datos borrados'); break;
    case 'closesheet': closeSheet(); break;
    case 'extra': extraSheet(); break;
    case 'exttype': exState.type = b.dataset.k; drawExtraSheet(); break;
    case 'extdate': exState.date = b.dataset.d; b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); break;
    case 'extsave': extraSave(); break;
    case 'restweekend': { const [, sun] = weekendDates(); S.extras.push({ id: uid(), date: sun, type: 'descanso' }); S.weekendAsked = sun; save(); render(); toast('Anotado: fin de semana de descanso'); break; }
    case 'chapon': if (S.current) { toast('Terminá o descartá la sesión en curso antes de cambiar de capítulo.'); break; } S.active = b.dataset.id; S.weekAdj = 0; S.deloadLeft = 0; S.gapHandled = null; pickNext = null; save(); renderMas(); renderHeader(); toast('Capítulo activado'); break;
    case 'chapdel': S.chapters = S.chapters.filter((c) => c.id !== b.dataset.id); rebuildEx(); save(); renderMas(); break;
    case 'chapadd': { const c = pendingChapter; if (!c) break; S.chapters = (S.chapters || []).filter((x) => x.id !== c.id); S.chapters.push(c); rebuildEx(); if (b.dataset.on === '1' && !S.current) { S.active = c.id; S.weekAdj = 0; S.deloadLeft = 0; S.gapHandled = null; } pendingChapter = null; save(); closeSheet(); renderMas(); renderHeader(); toast(b.dataset.on === '1' ? 'Capítulo cargado y activado' : 'Capítulo guardado'); break; }
    case 'chapexport': exportChapter(); break;
    case 'closego': closeSheet(); go(b.dataset.v); break;
    case 't-toggle': timerToggle(); break;
    case 't-done': timerDone(); break;
    case 't-skip': timerSkip(); break;
    case 't-back': timerBack(); break;
    case 't-add': timerAdd(Number(b.dataset.s)); break;
    case 't-min': T.open = false; renderTimer(); break;
    case 't-stop': timerStop(); if (view === 'sesion') renderSession(); break;
    case 'mini': T.open = true; renderTimer(); break;
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'tg-reduced') { S.flags.reduced = t.checked; save(); }
  if (t.id === 'tg-football') { S.flags.football = t.checked; save(); }
  if (t.id === 'st-sound') { S.settings.sound = t.checked; save(); }
  if (t.id === 'st-vib') { S.settings.vibrate = t.checked; save(); }
  if (t.id === 'imp' && t.files[0]) importFile(t.files[0]);
  if (t.id === 'chap-imp' && t.files[0]) importChapter(t.files[0]);
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'f-rpe') $('#f-rpe-o').textContent = `${t.value} · ${RPE_TXT[t.value]}`;
  if (t.id === 'f-ank') $('#f-ank-o').textContent = t.value;
  if (t.id === 'c-ank') $('#c-ank-o').textContent = `${t.value} de 10`;
  if (t.id === 'x-rpe') $('#x-rpe-o').textContent = `${t.value} · ${RPE_TXT[t.value]}`;
  if (t.id === 'x-ank') $('#x-ank-o').textContent = `${t.value} de 10`;
  if (t.id === 'g-q') drawGloss(t.value);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(); else if (T.open) { T.open = false; renderTimer(); } } });

/* ============================================================
   Inicio
   ============================================================ */
function init() {
  document.querySelectorAll('.tab').forEach((b) => { b.querySelector('.tab-i').innerHTML = IC[b.dataset.icon]; });
  $('#t-toggle').innerHTML = IC.play; $('#t-skip').innerHTML = IC.next; $('#t-back').innerHTML = IC.prev; $('#t-min').innerHTML = IC.down; $('#mini-i').innerHTML = IC.timer;
  rebuildEx();
  if (!allChapters().some((c) => c.id === S.active)) S.active = 'fase1';
  go('hoy');
  handleLaunchAction();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) { $('#update').hidden = false; } });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
  $('#update-b').addEventListener('click', () => { navigator.serviceWorker.getRegistration().then((r) => { if (r && r.waiting) r.waiting.postMessage('skip'); else location.reload(); }); });
}
/* Accesos directos del ícono (mantener apretado) */
function handleLaunchAction() {
  let a = null;
  try { a = new URLSearchParams(location.search).get('a'); } catch (e) { a = null; }
  if (!a) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* sin historial */ }
  if (a === 'sesion') { if (!S.current) startSession(nextType()); else go('sesion'); toast('Tocá play en el primer ejercicio para arrancar'); }
  if (a === 'actividad') extraSheet();
  if (a === 'registro') checkinSheet();
  if (a === 'micro') { go('hoy'); sheet(`<p>Movilidad de 10 minutos con temporizador.</p><button type="button" class="btn primary block" data-act="micro">Empezar</button>`, { title: 'Microsesión' }); }
}
document.addEventListener('DOMContentLoaded', init);
