// תקשורת עם Apps Script שבחשבון של תמר. הכתובת וקוד החיבור נשמרים במכשיר,
// ומגיעים מקישור החיבור (#/connect?u=...&t=...) שנפתח פעם אחת בכל מכשיר.

const KEY = 'tamar-backend';

export function backend() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export const isConnected = () => !!backend();

export function setBackend(url, token) {
  localStorage.setItem(KEY, JSON.stringify({ url, token }));
}

export function disconnect() {
  localStorage.removeItem(KEY);
}

// Content-Type מסוג text/plain כדי שהדפדפן לא ישלח בקשת preflight, ש-Apps Script לא תומך בה
export async function call(action, payload = {}) {
  const b = backend();
  if (!b) throw new Error('האפליקציה לא מחוברת ל-Google Drive');
  let res;
  try {
    res = await fetch(b.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: b.token, action, ...payload }),
    });
  } catch {
    const err = new Error('אין חיבור לאינטרנט');
    err.offline = true;
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`תשובה לא תקינה מהשרת (${res.status})`);
  }
  if (!json.ok) throw new Error(json.error || 'שגיאה בשרת');
  return json;
}
