// LITE FEATURE — the conversational reply + inline mistake correction.
// Uses the SAME OPENAI_API_KEY already in your .env (the one that powers
// the existing session-analysis feature) — no separate account needed.
// This file is isolated: only routes/liteRoutes.js imports it.

const OpenAI = require('openai');

const SYSTEM_PROMPT = `Tum ek friendly, patient English speaking partner ho jiska naam "Bolo" hai — is app ka lite/quick practice mode.

Tumhara kaam: user se natural spoken English mein baat karo (jaise ek dost practice karwa raha ho), aur unki har baat mein agar koi English mistake ho to use politely note karo (bina flow rokke, judgemental hue bina).

Reply hamesha short aur conversational rakho (1-3 sentences) — ye VOICE mein bolke sunaya jaayega, isliye koi bullet points, koi markdown, koi lambi list mat likho reply mein. Bas natural bolne jaisa text.

Agar user ne koi genuine English mistake ki ho (grammar, word choice, sentence structure), use "mistakes" array mein daalo — har ek ke liye: jo unhone kaha (wrong), sahi tareeka (correct), aur EK chhoti si wajah (reason, max 1 line, 12-saal-ke-bacche-ko-samajh-aane-jaisi simple language mein, no grammar jargon).

Agar koi mistake nahi mili ya sentence chhota/simple tha jisme galti ki gunjaish hi nahi thi, mistakes ko khaali array chhod do — har turn mein zabardasti mistake mat dhoondo.

Ye ek VOICE-transcribed conversation hai — kabhi kabhi transcription hi thodi garbled ho sakti hai. Agar kuch clearly transcription glitch lagta hai (context mein sense hi nahi banta), use mistake mat maano.`;

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'Short, natural spoken reply to continue the conversation (1-3 sentences, no markdown).'
    },
    mistakes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wrong: { type: 'string', description: 'What the user actually said, the part that was wrong.' },
          correct: { type: 'string', description: 'The corrected version.' },
          reason: { type: 'string', description: 'One simple, jargon-free line explaining why.' }
        },
        required: ['wrong', 'correct', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['reply', 'mistakes'],
  additionalProperties: false
};

// history: [{ role: 'user'|'assistant', content: string }, ...] — recent turns only.
// userText: the just-transcribed thing the user said this turn.
async function getReplyAndCorrections(history, userText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing — this should already be set for the analysis feature.');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.LITE_LLM_MODEL || 'gpt-4.1';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: userText }
  ];

  const response = await openai.chat.completions.create({
    model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'lite_turn_reply', schema: REPLY_SCHEMA, strict: true }
    }
  });

  return JSON.parse(response.choices[0].message.content);
}

module.exports = { getReplyAndCorrections };
