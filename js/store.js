// שכבת הנתונים. עותק מלא נשמר במכשיר (localStorage), כך שהאפליקציה עובדת גם בלי אינטרנט.
// כל שינוי נכנס לתור יוצא ונשלח ל-Google Sheets כשיש חיבור. אחרי השליחה טוענים מהגיליון,
// שהוא מקור האמת, כדי שטלפון ומחשב יראו אותו דבר.

import { call, isConnected } from './api.js';

const KEY = 'tamar-therapy-data-v2';
const OUTBOX = 'tamar-outbox';

// מזהים קבועים, זהים לאלה שבשרת, כדי שלא ייווצרו כפילויות בסנכרון הראשון
const DEFAULT_WORKPLACES = [
  { id: 'w-breuer', name: 'ברויאר' },
  { id: 'w-petachia', name: 'פתחיה' },
];

const empty = () => ({
  workplaces: DEFAULT_WORKPLACES.map((w) => ({ ...w })),
  patients: [],   // { id, workplaceId, name, createdAt, tala: { goals: [ { id, name, details: [str], objectives: [ { id, name, active } ], active } ] } }
  sessions: [],   // { id, patientId, date, sections: [ { kind, goalId, title, text, raw, fileIds } ], summary, nextNotes, createdAt }
  guidance: [],   // { id, patientId, date, audience, text, fileIds, createdAt }
  glossary: ['תל"א (מתומלל לפעמים כ"תעלה")', 'מורפולוגיה', 'הטיה', 'הפקה', 'פעלים', 'אוצר מילים', 'שיום', 'תחביר', 'פונולוגיה', 'הבנה', 'מיומנויות חברתיות'],
});

let data = load();
let outbox = JSON.parse(localStorage.getItem(OUTBOX) || '[]');
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- סנכרון ----------
export const sync = { state: 'idle', error: null, pending: () => outbox.length };

function enqueue(op) {
  // שינוי חדש לאותו פריט מחליף שינוי קודם שעוד לא נשלח
  const k = (o) => o.action + ':' + o.kind + ':' + (o.item?.id ?? o.id ?? '');
  outbox = outbox.filter((o) => k(o) !== k(op));
  outbox.push(op);
  localStorage.setItem(OUTBOX, JSON.stringify(outbox));
  scheduleSync();
}

let timer = null;
function scheduleSync(ms = 400) {
  clearTimeout(timer);
  timer = setTimeout(runSync, ms);
}

let running = null;
export function runSync() {
  if (!isConnected()) return Promise.resolve();
  running ??= (async () => {
    sync.state = 'syncing';
    notify('status');
    try {
      while (outbox.length) {
        const op = outbox[0];
        await call(op.action, op);
        outbox.shift();
        localStorage.setItem(OUTBOX, JSON.stringify(outbox));
      }
      const { data: remote } = await call('load');
      data = { ...empty(), ...remote, workplaces: remote.workplaces.length ? remote.workplaces : data.workplaces };
      persist();
      sync.state = 'ok';
      sync.error = null;
      notify('data');
    } catch (err) {
      sync.state = err.offline ? 'offline' : 'error';
      sync.error = err.message;
      notify('status');
      scheduleSync(30000); // ניסיון נוסף בעוד חצי דקה
    } finally {
      running = null;
    }
  })();
  return running;
}

export function onChange(fn) {
  listeners.add(fn);
}
function notify(what) {
  listeners.forEach((fn) => fn(what));
}

window.addEventListener('online', () => scheduleSync(0));
setInterval(() => isConnected() && scheduleSync(0), 120000); // טעינה תקופתית של שינויים ממכשיר אחר

// ---------- גישה לנתונים ----------
const save = (kind, item) => {
  persist();
  enqueue({ action: 'save', kind, item });
};
const remove = (kind, id) => {
  persist();
  enqueue({ action: 'delete', kind, id });
};

export const db = {
  workplaces: () => data.workplaces,
  workplace: (id) => data.workplaces.find((w) => w.id === id),
  addWorkplace(name) {
    const w = { id: uid(), name };
    data.workplaces.push(w);
    save('workplace', w);
    return w;
  },
  renameWorkplace(id, name) {
    const w = db.workplace(id);
    w.name = name;
    save('workplace', w);
  },

  patientsOf: (workplaceId) => data.patients.filter((p) => p.workplaceId === workplaceId),
  patient: (id) => data.patients.find((p) => p.id === id),
  addPatient(workplaceId, name) {
    const p = { id: uid(), workplaceId, name, createdAt: new Date().toISOString(), tala: { goals: [] } };
    data.patients.push(p);
    save('patient', p);
    return p;
  },
  renamePatient(id, name) {
    const p = db.patient(id);
    p.name = name;
    save('patient', p);
  },

  // תל"א: הפונקציה מקבלת מוטציה ושומרת את כל המטופל
  updateTala(patientId, fn) {
    const p = db.patient(patientId);
    fn(p.tala);
    save('patient', p);
  },
  activeGoals: (patientId) => db.patient(patientId).tala.goals.filter((g) => g.active !== false && g.name),

  sessionsOf: (patientId) =>
    data.sessions.filter((s) => s.patientId === patientId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
  lastSession: (patientId) => db.sessionsOf(patientId)[0],
  addSession(s) {
    data.sessions.push(s);
    save('session', s);
  },

  guidanceOf: (patientId) =>
    data.guidance.filter((g) => g.patientId === patientId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
  addGuidance(g) {
    data.guidance.push(g);
    save('guidance', g);
  },
  deleteGuidance(id) {
    data.guidance = data.guidance.filter((g) => g.id !== id);
    remove('guidance', id);
  },

  glossary: () => data.glossary,
  setGlossary(list) {
    data.glossary = list;
    persist();
    enqueue({ action: 'setGlossary', kind: 'glossary', list });
  },

  exportJSON: () => JSON.stringify(data, null, 2),
};

// ---------- קבצי שמע במכשיר (IndexedDB) ----------
// ההקלטה נשמרת במכשיר עד שהיא מתומללת, כדי שלא תלך לאיבוד אם אין אינטרנט
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open('tamar-audio', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('audio');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tx(mode, fn) {
  return dbp.then((idb) => new Promise((resolve, reject) => {
    const t = idb.transaction('audio', mode);
    const r = fn(t.objectStore('audio'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}

export const audio = {
  put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
};
