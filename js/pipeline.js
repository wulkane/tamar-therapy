// תמלול: ההקלטה נשלחת ל-Apps Script, שם היא נשמרת בדרייב הפרטי ועוברת ל-Gemini
// לתמלול ולתיקון ניסוח קל, בקריאה אחת.

import { call, isConnected } from './api.js';
import { db } from './store.js';

export const hasTranscription = isConnected;

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ctx = { rubric, goals, date, patient }. מחזיר { raw, text, fileId }
export async function transcribe(blob, ctx) {
  const res = await call('transcribe', {
    audio: await toBase64(blob),
    mimeType: (blob.type || 'audio/webm').split(';')[0],
    glossary: db.glossary(),
    ...ctx,
  });
  return { raw: res.raw, text: res.text, fileId: res.fileId };
}

// סיכום הטיפול: המטרות לפי סדר התל"א, ובסוף "נושא נוסף"
export function compile(sections) {
  return sections
    .filter((s) => (s.text ?? '').trim())
    .map((s) => `${s.title}:\n${s.text.trim()}`)
    .join('\n\n');
}
