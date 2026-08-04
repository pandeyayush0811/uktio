// LITE FEATURE — the conversational reply (text only, no correction
// analysis — that's a separate future "report" feature, generated async
// from the stored turn history, NOT on this hot path). Uses the SAME
// OPENAI_API_KEY already in your .env. Isolated: only routes/liteRoutes.js
// imports this.
//
// This is a real token-STREAMING call (stream: true), not a single
// blocking request — the caller gets a sentence the moment the model has
// finished generating it, via the onSentence callback, instead of
// waiting for the whole reply to finish. This is what lets liteRoutes.js
// kick off TTS for sentence 1 while the model is still writing sentence 2.
//
// Deliberately NOT using response_format/json_schema anymore: that mode
// only ever returns the ENTIRE JSON object in one shot (no token
// streaming with strict schemas in a way that's cheaply parseable
// mid-stream), which is exactly why the OLD version of this file — the
// one that also generated a "mistakes" array — couldn't stream at all.
// Now that mistakes generation is gone, plain streamed text is both
// simpler AND faster: shorter prompt (no mistake-analysis instructions,
// fewer input tokens), fewer output tokens (no JSON scaffolding), and
// full token-level streaming.

const OpenAI = require('openai');

const SYSTEM_PROMPT = `Tum ek friendly, patient English speaking partner ho jiska naam "Bolo" hai — is app ka lite/quick practice mode.

Tumhara kaam: user se natural spoken English mein baat karo, jaise ek dost practice karwa raha ho — casual, encouraging, curious follow-up questions ke saath.

Reply hamesha short aur conversational rakho (1-3 sentences) — ye VOICE mein bolke sunaya jaayega, isliye koi bullet points, koi markdown, koi lambi list mat likho reply mein. Bas natural bolne jaisa plain text.`;

// Hard cap on reply length. There's no schema enforcing "1-3 sentences"
// anymore (plain streamed text), so this is the safety net that keeps
// replies short — which in turn keeps LLM token cost AND total TTS time
// bounded, exactly like the old MAX_TTS_CHARS did, just applied earlier
// (during generation, not after the fact) so we also stop paying for
// tokens we'd throw away anyway.
const MAX_REPLY_CHARS = Number(process.env.LITE_MAX_REPLY_CHARS) || 280;

// Matches the first complete sentence sitting at the start of `buffer`
// (greedy up to the first ./!/? followed by whitespace or end-of-string).
const SENTENCE_RE = /^[^.!?]*[.!?]+(\s+|$)/;

// history: [{ role: 'user'|'assistant', content: string }, ...] — recent turns only.
// userText: the just-transcribed thing the user said this turn.
// onSentence(sentenceText, index): called synchronously, in order, the
// moment each sentence finishes streaming in — the caller is expected to
// kick off work (TTS) immediately without awaiting inside this callback,
// since blocking here would stall pulling further tokens off the stream.
//
// Returns { replyText } once the full reply is done streaming.
async function streamReply(history, userText, onSentence) {
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

  // Our own AbortController so we can cut the upstream generation short
  // the instant we hit MAX_REPLY_CHARS, instead of paying for (and
  // waiting on) tokens we're going to discard anyway.
  const controller = new AbortController();
  const stream = await openai.chat.completions.create(
    { model, messages, stream: true },
    { signal: controller.signal }
  );

  let buffer = '';   // not-yet-emitted tail (no sentence terminator in it yet)
  let full = '';      // everything generated so far, for persistence
  let sentenceIndex = 0;
  let hitCap = false;

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      buffer += delta;
      full += delta;

      let match;
      while ((match = buffer.match(SENTENCE_RE))) {
        const sentence = match[0].trim();
        buffer = buffer.slice(match[0].length);
        if (sentence) onSentence(sentence, sentenceIndex++);
      }

      if (full.length >= MAX_REPLY_CHARS) {
        hitCap = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // An abort() we triggered ourselves surfaces here as an AbortError —
    // that's expected and fine, NOT a real failure. Anything else (network
    // drop, OpenAI error) should still propagate to the caller.
    if (!(hitCap && (err.name === 'AbortError' || err.name === 'APIUserAbortError'))) {
      throw err;
    }
  }

  // A trailing partial sentence (no ./!/? yet) only gets flushed if the
  // stream ended naturally — if we hit the cap mid-sentence, better to
  // end clean on the last complete sentence than play/show a sentence
  // truncated mid-word.
  const leftover = buffer.trim();
  if (leftover && !hitCap) {
    onSentence(leftover, sentenceIndex++);
  }

  return { replyText: full.trim() };
}

module.exports = { streamReply, MAX_REPLY_CHARS };
