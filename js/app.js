import { db, audio, uid, sync, runSync, onChange } from './store.js';
import { startRecording, releaseMic } from './recorder.js';
import { transcribe, compile, hasTranscription } from './pipeline.js';
import { isConnected, setBackend, disconnect, call } from './api.js';

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('back');

// ---------- עזרים ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD לפי שעון מקומי
const fmtDate = (iso) => new Date(iso + 'T12:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = (iso) => new Date(iso + 'T12:00').toLocaleDateString('he-IL');
const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2500);
}

function render(title, html, backTo) {
  $title.textContent = title;
  $back.hidden = !backTo;
  $back.onclick = () => (location.hash = backTo);
  $view.innerHTML = html;
  window.scrollTo(0, 0);
}

// איורים מספריית ה-SVG שב-index.html
const art = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const emptyState = (text) => `<div class="empty">${art('sprig')}${text}</div>`;

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'בוקר טוב';
  if (h >= 12 && h < 17) return 'צהריים טובים';
  if (h >= 17 && h < 22) return 'ערב טוב';
  return 'לילה טוב';
}

const on = (sel, ev, fn) => $view.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

// סיכום טיפול מעוצב: כותרת מודגשת לכל קטע
function summaryHTML(text) {
  if (!text) return '<span class="muted">—</span>';
  return `<div class="summary-text">${text.split('\n\n').map((block) => {
    const [head, ...rest] = block.split('\n');
    return `<b>${esc(head)}</b>${esc(rest.join('\n'))}`;
  }).join('')}</div>`;
}

function syncLine() {
  if (!isConnected()) return '<a href="#/settings" class="sync warn">לא מחובר ל-Google Drive. הנתונים נשמרים רק במכשיר הזה</a>';
  const n = sync.pending();
  if (sync.state === 'offline') return `<span class="sync warn">אין אינטרנט${n ? ` · ${n} שינויים יישלחו כשהחיבור יחזור` : ''}</span>`;
  if (sync.state === 'error') return `<span class="sync warn">⚠ ${esc(sync.error)}</span>`;
  if (sync.state === 'syncing' || n) return '<span class="sync">מסנכרן עם Google Drive…</span>';
  return '<span class="sync ok">✓ שמור ב-Google Drive</span>';
}

// ---------- מסך 1: מקומות עבודה ----------
function viewHome() {
  const ws = db.workplaces();
  render('מקומות עבודה', `
    <div class="hero">
      <div class="hello">${greeting()}, תמר</div>
      <div class="sub">${fmtDate(todayISO())}<br>${syncLine()}</div>
      ${art('sprig')}
    </div>
    <ul class="list">
      ${ws.map((w) => `<li><a href="#/w/${w.id}">${esc(w.name)}<small>${db.patientsOf(w.id).length} מטופלים</small></a></li>`).join('')}
    </ul>
    <div class="spacer"></div>
    <details>
      <summary class="muted">הוספת מקום עבודה</summary>
      <form id="add" class="row" style="margin-top:8px">
        <input name="name" placeholder="שם מקום העבודה" required>
        <button>+ הוספה</button>
      </form>
    </details>
  `);
  on('#add', 'submit', (e) => {
    e.preventDefault();
    db.addWorkplace(e.target.name.value.trim());
    viewHome();
  });
}

// ---------- מסך 2: מטופלים ----------
function viewWorkplace(id) {
  const w = db.workplace(id);
  if (!w) return (location.hash = '#/');
  const ps = db.patientsOf(id).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  render(w.name, `
    <ul class="list">
      ${ps.map((p) => {
        const last = db.lastSession(p.id);
        return `<li><a href="#/p/${p.id}">${esc(p.name)}<small>${last ? 'טיפול אחרון: ' + fmtShort(last.date) : 'אין עדיין תיעוד'}</small></a></li>`;
      }).join('')}
    </ul>
    ${ps.length ? '' : emptyState('עדיין אין מטופלים במקום הזה.')}
    <div class="spacer"></div>
    <form id="add" class="row">
      <input name="name" placeholder="מטופל חדש: ראשי תיבות (למשל נ.כ.)" required>
      <button>+ הוספה</button>
    </form>
    <div class="spacer"></div>
    <button class="secondary" id="rename">שינוי שם מקום העבודה</button>
  `, '#/');
  on('#add', 'submit', (e) => {
    e.preventDefault();
    db.addPatient(id, e.target.name.value.trim());
    viewWorkplace(id);
  });
  on('#rename', 'click', () => {
    const name = prompt('שם חדש:', w.name)?.trim();
    if (name) { db.renameWorkplace(id, name); viewWorkplace(id); }
  });
}

// ---------- מסך 3: כרטיס מטופל ----------
function viewPatient(id) {
  const p = db.patient(id);
  const draft = loadDraft(id);
  render(p.name, `
    <div class="grid4">
      <a class="tile" href="#/p/${id}/tala">${art('flower', 'petal-mark')}<span>🎯</span>תל"א</a>
      <a class="tile" href="#/p/${id}/table">${art('flower', 'petal-mark')}<span>📋</span>טבלת תיעוד כללית</a>
      <a class="tile" href="#/p/${id}/last">${art('flower', 'petal-mark')}<span>🕘</span>תיעוד אחרון</a>
      <a class="tile" href="#/p/${id}/guide">${art('flower', 'petal-mark')}<span>🤝</span>הדרכה</a>
      <a class="tile primary" href="#/p/${id}/new">${art('flower', 'petal-mark')}<span>🎙</span>${draft ? 'תיעוד חדש' : 'תיעוד טיפול חדש'}</a>
    </div>
    <div class="spacer"></div>
    <button class="secondary" id="rename">שינוי ראשי התיבות</button>
  `, `#/w/${p.workplaceId}`);
  on('#rename', 'click', () => {
    const name = prompt('ראשי תיבות:', p.name)?.trim();
    if (name) { db.renamePatient(id, name); viewPatient(id); }
  });
}

// ---------- א. תל"א ----------
// לכל מטרה כללית: כותרת, שורות פירוט ("מה בדיוק צריך לקרות") ויעדים. הכותרות מופיעות בתיעוד הטיפול.
function viewTala(id) {
  const p = db.patient(id);
  const goals = p.tala.goals.filter((g) => g.active !== false);
  const rowInput = (field, i, value, placeholder) => `
    <li class="tala-row" data-field="${field}" data-i="${i}">
      <textarea rows="1" placeholder="${placeholder}">${esc(value)}</textarea>
      <button type="button" class="danger" data-del-row aria-label="מחיקת שורה">✕</button>
    </li>`;

  render(`תל"א · ${p.name}`, `
    <p class="muted">הכותרת של כל מטרה תופיע כרובריקת הקלטה בתיעוד טיפול חדש. השינויים נשמרים אוטומטית.</p>
    <div class="stack">
      ${goals.map((g, gi) => `
        <div class="goal" data-goal="${g.id}">
          <div class="goal-head">
            <span class="goal-num">${gi + 1}</span>
            <input class="goal-title" value="${esc(g.name)}" placeholder="כותרת המטרה (למשל: אוצר מילים)">
            <button type="button" class="danger" data-del-goal aria-label="מחיקת מטרה">🗑</button>
          </div>
          <label class="sub-label">פירוט: מה בדיוק צריך לקרות</label>
          <ul class="tala-rows">${(g.details || []).map((d, i) => rowInput('details', i, d, 'שורת פירוט')).join('')}</ul>
          <button type="button" class="link-btn" data-add="details">+ שורת פירוט</button>
          <label class="sub-label">יעדים</label>
          <ul class="tala-rows">${g.objectives.filter((o) => o.active !== false).map((o) => rowInput('objectives', o.id, o.name, 'יעד')).join('')}</ul>
          <button type="button" class="link-btn" data-add="objectives">+ יעד</button>
        </div>`).join('')}
      ${goals.length ? '' : emptyState('עדיין אין מטרות. אפשר לתעד טיפולים גם בלי תל"א, ברובריקה "נושא נוסף".')}
      <button id="add-goal">+ מטרה כללית חדשה</button>
    </div>
  `, `#/p/${id}`);

  const goalOf = (el) => p.tala.goals.find((g) => g.id === el.closest('[data-goal]').dataset.goal);
  const autosize = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
  $view.querySelectorAll('.tala-row textarea').forEach(autosize);

  on('.goal-title', 'change', (e) => {
    const g = goalOf(e.target);
    db.updateTala(id, () => (g.name = e.target.value.trim()));
  });
  on('.tala-row textarea', 'input', (e) => autosize(e.target));
  on('.tala-row textarea', 'change', (e) => {
    const row = e.target.closest('.tala-row');
    const g = goalOf(row);
    const v = e.target.value.trim();
    db.updateTala(id, () => {
      if (row.dataset.field === 'details') g.details[Number(row.dataset.i)] = v;
      else g.objectives.find((o) => o.id === row.dataset.i).name = v;
    });
  });
  on('[data-add]', 'click', (e) => {
    const g = goalOf(e.target);
    const field = e.target.dataset.add;
    db.updateTala(id, () => {
      if (field === 'details') (g.details ??= []).push('');
      else g.objectives.push({ id: uid(), name: '', active: true });
    });
    viewTala(id);
    const rows = $view.querySelectorAll(`[data-goal="${g.id}"] [data-field="${field}"] textarea`);
    rows[rows.length - 1]?.focus();
  });
  // יעד שנמחק מסומן כלא פעיל, כדי שטיפולים קודמים ישמרו על ההקשר שלהם
  on('[data-del-row]', 'click', (e) => {
    const row = e.target.closest('.tala-row');
    const g = goalOf(row);
    db.updateTala(id, () => {
      if (row.dataset.field === 'details') g.details.splice(Number(row.dataset.i), 1);
      else g.objectives.find((o) => o.id === row.dataset.i).active = false;
    });
    viewTala(id);
  });
  on('[data-del-goal]', 'click', (e) => {
    const g = goalOf(e.target);
    if (!confirm(`למחוק את המטרה "${g.name || 'ללא כותרת'}"?`)) return;
    db.updateTala(id, () => (g.active = false));
    viewTala(id);
  });
  on('#add-goal', 'click', () => {
    const g = { id: uid(), name: '', details: [''], objectives: [], active: true };
    db.updateTala(id, (t) => t.goals.push(g));
    viewTala(id);
    $view.querySelector(`[data-goal="${g.id}"] .goal-title`)?.focus();
  });
}

// ---------- ב. טבלת תיעוד כללית ----------
function viewTable(id) {
  const p = db.patient(id);
  const ss = db.sessionsOf(id);
  render(`תיעוד כללי · ${p.name}`, ss.length ? `
    <div class="table-wrap">
      <table>
        <thead><tr><th>תאריך</th><th>מה היה בטיפול</th><th>הערות לפעם הבאה</th></tr></thead>
        <tbody>
          ${ss.map((s) => `<tr><td class="date">${fmtShort(s.date)}</td><td>${summaryHTML(s.summary)}</td><td>${esc(s.nextNotes) || '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : emptyState('עדיין לא תועדו טיפולים.'), `#/p/${id}`);
}

// ---------- ג. תיעוד אחרון ----------
function viewLast(id) {
  const p = db.patient(id);
  const s = db.lastSession(id);
  render(`תיעוד אחרון · ${p.name}`, s ? `
    <div class="card stack flowered">
      ${art('flower', 'corner')}
      <div><label>תאריך</label>${fmtDate(s.date)}</div>
      <div><label>מה היה בטיפול</label>${summaryHTML(s.summary)}</div>
      <div class="divider">${art('leaf')}</div>
      <div><label>הערות לפעם הבאה</label>${esc(s.nextNotes) || '<span class="muted">—</span>'}</div>
    </div>` : emptyState('עדיין לא תועדו טיפולים.'), `#/p/${id}`);
}

// ---------- ד. הדרכה ----------
// תיעוד הדרכות להורים או לצוות: תאריך, למי, ומה נאמר (בהקלדה או בהקלטה שמתומללת)
const AUDIENCES = ['הורים', 'צוות חינוכי', 'אחר'];
let guideRec = null; // הקלטה פעילה במסך ההדרכה

function viewGuide(id) {
  const p = db.patient(id);
  const list = db.guidanceOf(id);
  render(`הדרכה · ${p.name}`, `
    <form id="add" class="card stack">
      <h2 style="margin:0">הדרכה חדשה</h2>
      <div>
        <label for="g-date">תאריך</label>
        <input type="date" id="g-date" value="${todayISO()}" max="${todayISO()}" required>
      </div>
      <div>
        <label>למי</label>
        <div class="row">
          ${AUDIENCES.map((a, i) => `<label class="chip"><input type="radio" name="aud" value="${a}" ${i === 0 ? 'checked' : ''}> ${a}</label>`).join('')}
        </div>
        <input id="g-other" placeholder="למי? (למשל: סייעת, גננת)" hidden style="margin-top:8px">
      </div>
      <div>
        <label for="g-text">מה נאמר בהדרכה</label>
        <textarea id="g-text" placeholder="אפשר להקליד, או ללחוץ על הקלטה ולספר"></textarea>
      </div>
      <div class="row">
        <button type="button" class="secondary" id="g-rec">🎙 הקלטה</button>
        <span class="muted" id="g-status"></span>
      </div>
      <button>💾 שמירת ההדרכה</button>
    </form>
    <h2>הדרכות קודמות</h2>
    ${list.length ? `<div class="stack">${list.map((g) => `
      <div class="card" data-id="${g.id}">
        <div class="row" style="justify-content:space-between">
          <b>${fmtShort(g.date)} · ${esc(g.audience)}</b>
          <button type="button" class="danger" data-del aria-label="מחיקת הדרכה">🗑</button>
        </div>
        <div class="summary-text">${esc(g.text)}</div>
      </div>`).join('')}</div>` : emptyState('עדיין לא תועדו הדרכות.')}
  `, `#/p/${id}`);

  const fileIds = [];
  const $text = $view.querySelector('#g-text');
  const $status = $view.querySelector('#g-status');
  const $recBtn = $view.querySelector('#g-rec');

  function selectedAudience() {
    const v = $view.querySelector('input[name="aud"]:checked').value;
    return v === 'אחר' ? ($view.querySelector('#g-other').value.trim() || 'אחר') : v;
  }

  on('input[name="aud"]', 'change', (e) => {
    $view.querySelector('#g-other').hidden = e.target.value !== 'אחר';
  });

  on('#g-rec', 'click', async () => {
    if (!guideRec) {
      try {
        guideRec = await startRecording();
        $recBtn.textContent = '⏹ עצירה';
        $recBtn.classList.add('recording-btn');
        $status.textContent = 'מקליטה…';
      } catch (err) {
        toast(err.message || 'אין גישה למיקרופון');
      }
      return;
    }
    const { blob, durationMs } = await guideRec.stop();
    guideRec = null;
    releaseMic();
    $recBtn.textContent = '🎙 הקלטה';
    $recBtn.classList.remove('recording-btn');
    if (durationMs < 500) { $status.textContent = ''; return; }
    if (!hasTranscription()) { $status.textContent = 'האפליקציה לא מחוברת ל-Google Drive, אז צריך להקליד.'; return; }
    $status.textContent = 'מתמללת…';
    try {
      const r = await transcribe(blob, { rubric: 'הדרכה ל' + selectedAudience(), date: $view.querySelector('#g-date').value, patient: p.name });
      fileIds.push(r.fileId);
      $text.value = [$text.value.trim(), r.text].filter(Boolean).join('\n\n');
      $status.textContent = '✓ התמלול נוסף, אפשר לתקן לפני השמירה';
    } catch (err) {
      $status.textContent = '⚠ ' + err.message;
    }
  });

  on('#add', 'submit', (e) => {
    e.preventDefault();
    if (guideRec) { toast('צריך לעצור את ההקלטה לפני השמירה'); return; }
    const text = $text.value.trim();
    if (!text) { toast('אין עדיין תוכן להדרכה'); return; }
    db.addGuidance({
      id: uid(), patientId: id, date: $view.querySelector('#g-date').value || todayISO(),
      audience: selectedAudience(), text, fileIds, createdAt: new Date().toISOString(),
    });
    toast('🌸 ההדרכה נשמרה');
    viewGuide(id);
  });

  on('[data-del]', 'click', (e) => {
    const gid = e.currentTarget.closest('[data-id]').dataset.id;
    if (!confirm('למחוק את ההדרכה?')) return;
    db.deleteGuidance(gid);
    viewGuide(id);
  });
}

// ---------- ה. תיעוד טיפול חדש ----------
// הטיוטה נשמרת ב-localStorage כדי שהקלטות לא ילכו לאיבוד אם הדף נטען מחדש.
// עותק אחד בזיכרון לכל מטופל, כדי שהתמלול ברקע והעריכה של תמר יעבדו על אותו אובייקט.
const drafts = {};
const draftKey = (pid) => `tamar-draft-${pid}`;
const loadDraft = (pid) => {
  if (!(pid in drafts)) {
    const d = JSON.parse(localStorage.getItem(draftKey(pid)) || 'null');
    drafts[pid] = d?.v === 2 ? d : null; // מתעלמים מטיוטה במבנה הישן
  }
  return drafts[pid];
};
const saveDraft = (d) => { drafts[d.patientId] = d; localStorage.setItem(draftKey(d.patientId), JSON.stringify(d)); };
const clearDraft = (pid) => { delete drafts[pid]; localStorage.removeItem(draftKey(pid)); };

// רובריקות לפי הסדר: מטרה כללית אחת לכל רובריקה (כותרת בלבד), אחריהן נושא נוסף, ובסוף הערות לפעם הבאה
function newDraft(pid) {
  const items = db.activeGoals(pid).map((g) => ({ key: g.id, kind: 'goal', goalId: g.id, title: g.name, clips: [], text: '' }));
  items.push({ key: 'extra', kind: 'extra', title: 'נושא נוסף', clips: [], text: '' });
  items.push({ key: 'notes', kind: 'notes', title: 'הערות לפעם הבאה', clips: [], text: '' });
  return { v: 2, patientId: pid, step: 'date', date: null, items };
}

let current = null; // הקלטה פעילה: { pid, key, handle, timer }

// עוצר את ההקלטה הפעילה, שומר אותה במכשיר ושולח לתמלול ברקע. מחזיר את המפתח של הרובריקה שנעצרה.
async function stopActive() {
  if (!current) return null;
  const { pid, key, handle, timer } = current;
  clearInterval(timer);
  current = null;
  const { blob, durationMs } = await handle.stop();
  const d = loadDraft(pid);
  const it = d?.items.find((x) => x.key === key);
  if (it && durationMs >= 500) { // מתעלמים מלחיצה מקרית
    const audioId = uid();
    await audio.put(audioId, blob);
    it.clips.push({ audioId, durationMs, status: 'pending' });
    saveDraft(d);
    processQueue(d);
  }
  return key;
}

// תור תמלול: הקלטה אחת בכל פעם, כדי לא לחרוג ממגבלת הבקשות של Gemini
const processing = new Set();
async function processQueue(d) {
  if (processing.has(d.patientId) || !hasTranscription()) return;
  processing.add(d.patientId);
  try {
    const goals = d.items.filter((x) => x.kind === 'goal').map((x) => x.title);
    const patient = db.patient(d.patientId)?.name;
    for (;;) {
      const it = d.items.find((x) => x.clips.some((c) => c.status === 'pending' || c.status === 'working'));
      if (!it) break;
      const clip = it.clips.find((c) => c.status === 'pending' || c.status === 'working');
      clip.status = 'working';
      saveDraft(d);
      updateItemDOM(d, it);
      try {
        const blob = await audio.get(clip.audioId);
        const r = await transcribe(blob, { rubric: it.title, goals, date: d.date, patient });
        Object.assign(clip, { status: 'done', raw: r.raw, text: r.text, fileId: r.fileId });
        it.text = [it.text.trim(), r.text.trim()].filter(Boolean).join(' ');
        await audio.del(clip.audioId); // ההקלטה כבר בדרייב
      } catch (err) {
        clip.status = err.offline ? 'pending' : 'error';
        clip.error = err.message;
        saveDraft(d);
        updateItemDOM(d, it);
        if (err.offline) break; // ננסה שוב כשהחיבור יחזור
        continue;
      }
      saveDraft(d);
      updateItemDOM(d, it);
    }
  } finally {
    processing.delete(d.patientId);
  }
}
window.addEventListener('online', () => Object.values(drafts).forEach((d) => d && processQueue(d)));

const busy = (it) => it.clips.some((c) => c.status === 'pending' || c.status === 'working');

function itemStatus(it) {
  if (it.clips.some((c) => c.status === 'working')) return '<span class="st working">מתמללת…</span>';
  if (it.clips.some((c) => c.status === 'pending')) return `<span class="st working">${hasTranscription() ? 'ממתין לתמלול' : 'נשמר במכשיר'}</span>`;
  if (it.clips.some((c) => c.status === 'error')) return '<span class="st err">⚠ התמלול נכשל</span>';
  if (it.clips.length) return '<span class="st ok">✓ תומלל</span>';
  return '';
}

// עדכון רובריקה אחת בלי לרנדר את כל המסך, כדי לא להפריע להקלדה
function updateItemDOM(d, it) {
  if (location.hash !== `#/p/${d.patientId}/new`) return;
  const box = $view.querySelector(`[data-item="${it.key}"]`);
  if (!box) return;
  box.querySelector('.status').innerHTML = itemStatus(it);
  const ta = box.querySelector('textarea');
  ta.hidden = !it.clips.length && !it.text;
  if (document.activeElement !== ta) ta.value = it.text;
  const err = it.clips.find((c) => c.status === 'error');
  box.querySelector('.err-line').innerHTML = err ? `${esc(err.error)} <button type="button" class="link-btn" data-retry>ניסיון חוזר</button>` : '';
  box.querySelector('[data-retry]')?.addEventListener('click', () => {
    it.clips.forEach((c) => c.status === 'error' && (c.status = 'pending'));
    saveDraft(d);
    updateItemDOM(d, it);
    processQueue(d);
  });
  const saveBtn = $view.querySelector('#save');
  if (saveBtn) saveBtn.disabled = d.items.some(busy);
}

function viewNew(pid) {
  const p = db.patient(pid);
  const d = loadDraft(pid) || newDraft(pid);
  saveDraft(d);
  const back = `#/p/${pid}`;
  const title = `טיפול חדש · ${p.name}`;

  if (d.step === 'date') {
    render(title, `
      <h2>מתי היה הטיפול?</h2>
      <div class="stack">
        <button id="today">היום · ${fmtDate(todayISO())}</button>
        <div class="card stack">
          <label for="other">יום אחר</label>
          <input type="date" id="other" max="${todayISO()}">
          <button class="secondary" id="other-ok">המשך עם התאריך הזה</button>
        </div>
        <button class="danger" id="discard">ביטול הטיפול</button>
      </div>`, back);
    const go = (date) => { d.date = date; d.step = 'record'; saveDraft(d); viewNew(pid); };
    on('#today', 'click', () => go(todayISO()));
    on('#other-ok', 'click', () => {
      const v = $view.querySelector('#other').value;
      v ? go(v) : toast('צריך לבחור תאריך');
    });
    on('#discard', 'click', () => discard(d));
    return;
  }

  // מסך אחד: מקליטים, ובזמן שמקליטים את הרובריקה הבאה הקודמת כבר מתומללת ומופיעה לעריכה
  const goals = d.items.filter((it) => it.kind === 'goal');
  const block = (it) => `
    <div class="segment rubric ${it.kind}" data-item="${it.key}">
      <button type="button" class="rec-item">
        <span class="mic">🎙</span>
        <span class="label"><b>${esc(it.title)}</b></span>
        <span class="timer"></span>
        <span class="status">${itemStatus(it)}</span>
      </button>
      <textarea data-text rows="3" placeholder="התמלול יופיע כאן, ואפשר לתקן" ${it.clips.length || it.text ? '' : 'hidden'}>${esc(it.text)}</textarea>
      <div class="raw err-line"></div>
    </div>`;

  render(title, `
    <p class="muted">${fmtDate(d.date)} · <a href="#" id="change-date">שינוי תאריך</a></p>
    <p class="hint">לוחצים על רובריקה כדי להקליט ולוחצים שוב כדי לעצור. אפשר לדלג על רובריקות. בלי שמות בהקלטות.</p>
    ${goals.length ? `<h2>מטרות התל"א</h2><div class="stack">${goals.map(block).join('')}</div>` : '<p class="muted">עדיין אין תל"א למטופל, ולכן מוצגים רק נושא נוסף והערות.</p>'}
    <div class="divider">${art('leaf')}</div>
    <div class="stack">${block(d.items.find((x) => x.key === 'extra'))}</div>
    <h2>להמשך</h2>
    <div class="stack">${block(d.items.find((x) => x.key === 'notes'))}</div>
    <div class="spacer"></div>
    ${hasTranscription() ? '' : '<p class="hint warn">האפליקציה לא מחוברת ל-Google Drive, ולכן אין תמלול. אפשר להקליד בתיבות.</p>'}
    <div class="row">
      <button id="save" ${d.items.some(busy) ? 'disabled' : ''}>💾 שמירת הטיפול</button>
      <button class="danger" id="discard">ביטול</button>
    </div>`, back);

  d.items.forEach((it) => updateItemDOM(d, it));
  if (!hasTranscription()) $view.querySelectorAll('[data-text]').forEach((t) => (t.hidden = false));

  on('#change-date', 'click', async (e) => {
    e.preventDefault();
    await stopActive();
    d.step = 'date';
    saveDraft(d);
    viewNew(pid);
  });
  on('[data-text]', 'input', (e) => {
    const it = d.items.find((x) => x.key === e.target.closest('[data-item]').dataset.item);
    it.text = e.target.value;
    saveDraft(d);
  });
  on('.rec-item', 'click', async (e) => {
    const key = e.currentTarget.closest('[data-item]').dataset.item;
    const btnOf = (k) => $view.querySelector(`[data-item="${k}"] .rec-item`);
    const prevKey = current?.key;
    const prevBtn = prevKey && btnOf(prevKey);
    if (prevBtn) {
      prevBtn.classList.remove('recording');
      prevBtn.querySelector('.timer').textContent = '';
    }
    const stopped = await stopActive();
    if (stopped === key) return;
    try {
      const handle = await startRecording();
      const btn = btnOf(key);
      btn.classList.add('recording');
      const timerEl = btn.querySelector('.timer');
      const timer = setInterval(() => (timerEl.textContent = fmtTime(Date.now() - handle.startedAt)), 250);
      current = { pid, key, handle, timer };
    } catch (err) {
      toast(err.message || 'אין גישה למיקרופון');
    }
  });
  on('#save', 'click', async () => {
    await stopActive();
    releaseMic();
    if (d.items.some(busy)) { toast('מחכה לסיום התמלול'); return; }
    const sections = d.items
      .filter((it) => it.kind !== 'notes' && it.text.trim())
      .map((it) => ({
        kind: it.kind, goalId: it.goalId ?? null, title: it.title, text: it.text.trim(),
        raw: it.clips.map((c) => c.raw).filter(Boolean).join(' '),
        fileIds: it.clips.map((c) => c.fileId).filter(Boolean),
      }));
    const notes = d.items.find((x) => x.key === 'notes');
    if (!sections.length && !notes.text.trim()) { toast('אין עדיין תוכן לשמירה'); return; }
    db.addSession({
      id: uid(), patientId: pid, date: d.date, sections,
      summary: compile(sections), nextNotes: notes.text.trim(),
      nextNotesFileIds: notes.clips.map((c) => c.fileId).filter(Boolean),
      createdAt: new Date().toISOString(),
    });
    clearDraft(pid);
    toast('🌸 הטיפול נשמר');
    location.hash = `#/p/${pid}/last`;
  });
  on('#discard', 'click', () => discard(d));

  processQueue(d); // ממשיך תמלול שלא הסתיים, גם אחרי טעינה מחדש של הדף
}

async function discard(d) {
  if (!confirm('לבטל את הטיפול? ההקלטות שעוד לא תומללו יימחקו.')) return;
  await stopActive();
  for (const it of d.items) for (const c of it.clips) await audio.del(c.audioId);
  clearDraft(d.patientId);
  location.hash = `#/p/${d.patientId}`;
}

// ---------- הגדרות ----------
function viewSettings() {
  render('הגדרות', `
    <div class="stack">
      <div class="card stack">
        <label>חיבור ל-Google Drive</label>
        <p style="margin:0">${syncLine()}</p>
        ${isConnected() ? `
          <div class="row">
            <button class="secondary" id="sync-now">סנכרון עכשיו</button>
            <button class="secondary" id="test">בדיקת חיבור</button>
            <button class="danger" id="disconnect">ניתוק המכשיר</button>
          </div>` : `
          <p class="muted" style="margin:0">הדרך הפשוטה: לפתוח במכשיר הזה את קישור החיבור שנוצר בהגדרה. או להדביק כאן:</p>
          <input id="b-url" dir="ltr" placeholder="https://script.google.com/macros/s/.../exec">
          <input id="b-token" dir="ltr" placeholder="קוד חיבור">
          <button id="connect">חיבור</button>`}
      </div>
      <div class="card stack">
        <label for="gl">מילון מונחים מקצועיים (מונח בכל שורה)</label>
        <p class="muted" style="margin:0">המונחים עוזרים ל-Gemini לזהות מילים מקצועיות בתמלול.</p>
        <textarea id="gl">${esc(db.glossary().join('\n'))}</textarea>
        <button id="save-gl">שמירת המילון</button>
      </div>
      <div class="card stack">
        <label>גיבוי</label>
        <p class="muted" style="margin:0">כל הנתונים נמצאים בגיליון בדרייב. אפשר גם לשמור עותק כקובץ.</p>
        <button class="secondary" id="export">ייצוא גיבוי</button>
      </div>
    </div>`, '#/');
  on('#connect', 'click', () => connect($view.querySelector('#b-url').value.trim(), $view.querySelector('#b-token').value.trim()));
  on('#sync-now', 'click', async () => { await runSync(); viewSettings(); });
  on('#test', 'click', async () => {
    try {
      await call('ping');
      toast('✓ החיבור תקין');
    } catch (err) {
      toast('⚠ ' + err.message);
    }
  });
  on('#disconnect', 'click', () => {
    if (!confirm('לנתק את המכשיר הזה? הנתונים בדרייב נשארים.')) return;
    disconnect();
    viewSettings();
  });
  on('#save-gl', 'click', () => {
    db.setGlossary($view.querySelector('#gl').value.split('\n').map((x) => x.trim()).filter(Boolean));
    toast('המילון נשמר');
  });
  on('#export', 'click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([db.exportJSON()], { type: 'application/json' }));
    a.download = `גיבוי-תיעוד-${todayISO()}.json`;
    a.click();
  });
}

async function connect(url, token) {
  // כתובת מקומית מותרת לבדיקות בלבד
  if (!/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/(localhost|127\.0\.0\.1):)/.test(url) || !token) {
    toast('הכתובת או הקוד לא תקינים');
    return;
  }
  setBackend(url, token);
  try {
    await call('ping');
  } catch (err) {
    disconnect();
    toast('⚠ ' + err.message);
    return;
  }
  toast('✓ מחובר ל-Google Drive');
  location.hash = '#/';
  runSync();
}

// ---------- ניתוב ----------
async function route() {
  if (await stopActive()) toast('ההקלטה נעצרה ונשמרה'); // יציאה ממסך ההקלטה באמצע הקלטה
  if (guideRec) { await guideRec.stop(); guideRec = null; toast('הקלטת ההדרכה בוטלה'); }
  if (!location.hash.endsWith('/new')) releaseMic();

  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [a, id, sub] = path.split('/');
  if (a === 'connect') {
    const q = new URLSearchParams(query);
    return connect(q.get('u') || '', q.get('t') || '');
  }
  if (a === 'w' && id) return viewWorkplace(id);
  if (a === 'p' && id) {
    if (!db.patient(id)) return (location.hash = '#/');
    if (sub === 'tala') return viewTala(id);
    if (sub === 'table') return viewTable(id);
    if (sub === 'last') return viewLast(id);
    if (sub === 'guide') return viewGuide(id);
    if (sub === 'new') return viewNew(id);
    return viewPatient(id);
  }
  if (a === 'settings') return viewSettings();
  viewHome();
}

// אחרי סנכרון: מרעננים את המסך, אלא אם תמר באמצע הקלדה או הקלטה
onChange(() => {
  const typing = $view.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (typing || current || guideRec || location.hash.endsWith('/new')) return;
  route();
});

window.addEventListener('hashchange', route);
route();
runSync();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
