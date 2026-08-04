// LITE FEATURE — speech-to-text via Gemini's audio-understanding
// (generateContent with inline audio), NOT the realtime Live API.
// Swapped in from Groq Whisper for better Hindi/Hinglish accuracy —
// Whisper is pure phonetic ASR, Gemini actually understands the audio,
// which matters for code-switched speech.
// Isolated on purpose, same as sttClient.js: nothing outside lib/lite/
// or routes/liteRoutes.js imports this.

// NOTE: gemini-2.5-flash was the original default here, but Google has
// been progressively blocking older model generations for NEW API keys
// (404 "no longer available to new users") even while the model stays
// listed/working for existing accounts. 3.1 Flash-Lite is current-gen,
// audio-capable, and cheap — safe default for a freshly created key.
// Override via env if your key does have 2.5-flash access and you'd
// rather use it (slightly better quality on some accents).
const GEMINI_MODEL = process.env.LITE_GEMINI_STT_MODEL || 'gemini-3.1-flash-lite';

// Reuses the same Google AI Studio key as the TTS client by default —
// it's the same account/key type. Set LITE_GEMINI_STT_KEY separately
// only if you want to split billing/quota between STT and TTS.
const API_KEY = process.env.LITE_GEMINI_STT_KEY || process.env.LITE_GEMINI_TTS_KEY;

const TRANSCRIBE_PROMPT = `Transcribe this audio exactly as spoken, word for word.

Rules:
- If the speaker is speaking Hindi, transcribe it in Devanagari script.
- If the speaker mixes in English words (Hinglish), keep those words in Roman/English script exactly as spoken — this is normal code-switching, not a mistake to fix.
- If the speaker is speaking English, transcribe it in English.
- Do NOT translate anything. Do NOT correct grammar. Do NOT add punctuation the speaker didn't imply. Do NOT add any commentary, labels, or quotes around the text.
- Output ONLY the raw transcription text, nothing else. If there's no audible speech, output nothing.`;

// audioBuffer: raw audio bytes (Buffer, decoded from the base64 the app sent).
// mimeType: whatever the browser/app recorded with, e.g. 'audio/webm;codecs=opus'.
async function transcribeAudio(audioBuffer, mimeType) {
  if (!API_KEY) {
    throw new Error('LITE_GEMINI_STT_KEY (or LITE_GEMINI_TTS_KEY) missing — add it to .env for the lite feature to work.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
          { text: TRANSCRIBE_PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0, // transcription should be deterministic, not creative
        responseModalities: ['TEXT']
      }
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini STT failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  console.log(`Lite STT (Gemini): text="${text.trim().slice(0, 80)}"`);
  return text.trim();
}

module.exports = { transcribeAudio };