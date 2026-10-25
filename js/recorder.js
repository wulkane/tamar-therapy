// הקלטה מהמיקרופון. מחזיר Blob כשמסיימים.

let stream = null;

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

export async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('הדפדפן לא תומך בהקלטה. צריך לפתוח בכתובת מאובטחת (https) או ב-localhost.');
  }
  stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const startedAt = Date.now();
  rec.start();

  return {
    startedAt,
    stop: () => new Promise((resolve) => {
      rec.onstop = () => resolve({ blob: new Blob(chunks, { type: rec.mimeType }), durationMs: Date.now() - startedAt });
      rec.stop();
    }),
  };
}

// משחרר את המיקרופון (כדי שהנורית בטלפון תכבה) כשיוצאים ממסך ההקלטה
export function releaseMic() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
