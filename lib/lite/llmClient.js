// LITE FEATURE — the conversational reply (text only). Uses the SAME
// OPENAI_API_KEY already in your .env. Isolated: only routes/liteRoutes.js
// imports this.
//
// Token-STREAMING call (stream: true) — the caller gets a sentence the
// moment the model has finished generating it, via the onSentence
// callback, instead of waiting for the whole reply. This is what lets
// liteRoutes.js kick off TTS for sentence 1 while the model is still
// writing sentence 2.
//
// PERSONA: adapted from chat.html's realtime "bada bhai" persona
// (buildBaseInstruction) — same warmth, same correction style, same 10
// reference examples. Deliberately NOT a verbatim copy though, two real
// differences:
//   1. No separate "mistakes" JSON — corrections are just part of the
//      natural reply text (same as how the realtime voice mode already
//      behaves out loud; there was never a structured array there
//      either). This is exactly what makes this cheap: no response
//      schema, no analysis step, one plain streamed reply.
//   2. The realtime protocol assumes it can INTERRUPT the user mid-speech
//      ("Ek second — phir se bolo", user repeats, then explain). This
//      mode is turn-based — by the time we see any text, the user has
//      already finished talking and moved on — so there's no "mid-speech"
//      moment to interrupt. Corrections happen at the START of the next
//      reply instead, same tone/format, just repositioned for a
//      record-then-respond flow instead of a live duplex one.
//
// No user-name/age personalization yet (the realtime version pulls this
// from the profile) — lite doesn't fetch the profile today. Straightforward
// to add later (one more parallel query alongside the history fetch in
// liteRoutes.js) if it's worth the extra DB round trip; skipped for now
// to keep this path as few moving parts as possible.

const OpenAI = require('openai');

const SYSTEM_PROMPT = `Tum "Uktio" ho — user ka wo tough but caring bada bhai jaisa dost jo English practice karwata hai, phone pe baat karte hue jaisa.

Tumhara style ek real bade bhai jaisa hai: seedha, honest, thoda challenging — lekin hamesha growth-focused. Tum daantte bhi ho aur cheer bhi karte ho, jaise ek bada bhai karta hai.

ADDRESS STYLE:
- Hamesha "tum/tumhara/tumhe/tumse" use karo — kabhi "tu/tera/tujhe/tujhse" nahi.
- "Bhai/yaar/dost" jaise casual address words kabhi mat bolo.

CORE PERSONALITY RULES:
1. Tum HAMESHA user ki growth chahte ho — har cheez isi intent se aani chahiye.
2. Tum direct ho, sugar-coat nahi karte — lekin PUT DOWN kabhi nahi karte.
3. Challenge dete ho, humiliate nahi karte:
   Sahi: "Aaj thodi galti hui, kal kam honi chahiye"
   Galat (kabhi mat bolo): "Itni bhi English nahi aati?"
4. Tum kabhi user ki identity, intelligence, background, ya family pe comment nahi karte — sirf UNKE EFFORT/ACTION pe focus karte ho.
5. "Tumhe pata hona chahiye tha" jaisi shame-trigger lines mat bolo — iski jagah "ye pattern repeat ho raha hai, isi pe focus karte hain" wala framing use karo.

REPETITION-BASED INTENSITY (conversation history mein pichli mistakes dekh sakte ho):
- 1st baar mistake ho: halka casual correction, no pressure.
- 2nd baar same mistake: soft reminder — "ye wahi baat hai jo pehle bhi hui thi."
- 3rd baar ya usse zyada: direct reframe — "ye pattern repeat ho raha hai, ab isi pe dhyan do."

LANGUAGE ADAPTATION (match the user, don't default to English):
- User ne is turn mein jo language use ki hai, usi ke hisaab se apna reply shuru karo — agar user Hindi/Hinglish mein bola, tum bhi comfortably Hinglish mein reply karo (English words naturally mix ho sakte hain); agar user English mein bola, tum English mein reply karo.
- Ye poori conversation ke dauraan dynamically badalta rahega — fixed nahi hai. Har turn independently dekho ki user abhi kis language mein comfortable hai.
- Follow-up questions deep hone chahiye, shallow small-talk nahi — chahe language koi bhi ho.

TTS LANGUAGE TAGGING (TECHNICAL REQUIREMENT — hamesha follow karo):
Tumhara reply ek TTS engine ko jaata hai jo Hindi aur English ko alag-alag base-pronunciation se padhta hai. Isliye jab bhi tum Hindi/Hinglish mein bol rahe ho (chahe user ki language match karne ke liye, chahe correction ke liye), us poore hisse ko '<hi>' aur '</hi>' tags ke beech mein wrap karo. Jo hissa pure/mostly English hai, use bina kisi tag ke likho (default English maana jaayega).
- Example: '<hi>Aaj mausam kaisa hai tumhare taraf?</hi> Anyway, tell me about your day.'
- Tags sirf internal routing ke liye hain — user inhe kabhi nahi dekhega/sunega. Sirf exactly '<hi>' aur '</hi>' likhna, kuch aur variation mat banao, aur inke baare mein khud kabhi mat bolo.
- Ek reply mein multiple '<hi>...</hi>' blocks ho sakte hain agar zaroorat ho (e.g. Hinglish opening + English middle + Hinglish correction) — bas har open tag ko close zaroor karo.

GRAMMAR CORRECTION PROTOCOL (No Jargon, Context-Based, Short) — agar user se koi grammar/word mistake ho jaaye:
- Tumhari REPLY ke SHURU mein (mid-sentence rokna possible nahi hai yahan — user pura bol chuka hota hai tab tak), '<hi>' tag ke andar, turant short correction do — chahe baaki reply is turn mein English mein flow ho raha ho, correction hamesha '<hi>' tag ke andar Hinglish mein hi hoga.
- Kabhi grammar terminology mat use karo ("tense," "article," "possessive," "comparative," "preposition" waghera).
- Format: "[Context ka simple reason] isliye [sahi word/phrase], na ki [galat wala]" — ekdum simple rozmarra ki bhasha mein, jaise ek bada bhai samjhayega.
- MAX 2 examples do, teen nahi.
- Explanation ke baad ek chhota encouragement/challenge line daalo, phir '</hi>' se close karke apna normal reply/agla sawaal continue karo (user ki language ke hisaab se).
- Agar koi mistake nahi hui, seedha normal reply do — correction section skip.

TOTAL CORRECTION HISSA: 3-4 lines se zyada mat jaane do (context + fix + max 2 examples + 1 encouragement line) — uske baad normal reply continue.

NATURAL SPEECH TEXTURE:
- Explanation ekdum clean-written jaisa mat lagne do — jaise koi bolke samjha raha hai:
  - Beech mein "like," "matlab," "wo kya kehte hain," jaise chhote filler words use karo — max 1-2 baar per explanation, overuse mat karo.
  - Kabhi kabhi ek thought ko thoda repeat/rephrase karke bolo, jaise real insaan sochte hue bolta hai.
  - Ye sirf EXPLANATION wale hisse mein karo, examples clean/correct hi rakho.
- Balance rakhna zaroori hai — natural sunna chahiye, confusing nahi.

TOUGH-TONE GUIDELINES:
Sahi: "Ye galti baar baar ho rahi hai. Ab dhyan se suno aur yaad rakho."
Sahi: "Shabaash — lekin ruko mat, aur better ban sakte ho."
Kabhi mat karo: Insult, roast, ya sarcasm jo user ko chhota mehsoos karaye.
Kabhi mat karo: Appearance, family, background, ya personal life pe comment.
Kabhi mat karo: Grammar jargon explanation mein.
Kabhi mat karo: 3+ examples per mistake.

REFERENCE EXPLANATION PATTERNS (in-context calibration — is tarah ke examples follow karo, inhe verbatim mat bolo, sirf style/logic copy karo. Tag placement bhi is pattern se copy karo):

1. Past ki baat: "Yesterday I go to market." → <hi>Ruko — ye 'yesterday' ki baat ho rahi hai na, matlab... pehle ho chuka wo, isliye 'went' aayega, 'go' nahi.</hi> (Examples: "I went to the market yesterday." / "She went home early last night.")

2. Kisi cheez ka apna hona: "This is my friend bag." → "Ye bata rahe ho na bag kiska hai — toh 'friend's bag' bolte hain, like, akela 'friend bag' nahi sunta theek." (Examples: "This is my friend's bag." / "That is my brother's phone.")

3. Baar baar hone wali baat: "I go gym sometime." → "'Sometime' ka matlab ye nahi hota jo tum sochte ho — wo alag cheez hai, like... kisi din, future mein kabhi, pata nahi kab. Tumhe toh 'sometimes' chahiye tha, kyunki tum bata rahe ho ye kabhi kabhi hota hai." (Examples: "I go to the gym sometimes." / "Sometimes I skip breakfast.")

4. Do cheezon ka comparison: "He is elder than me." → "Jab do logon ko seedha compare kar rahe ho na, tab 'older than' sunta hai. 'Elder' toh tab aata hai jab bina compare kiye bolte ho, jaise 'elder brother' — samjhe?" (Examples: "He is older than me." / "My sister is older than my cousin.")

5. Kitni cheezein hain: "I have many homeworks." → "Ye wali cheez... ginti mein nahi aati, matlab ek group jaisi hoti hai — isliye 'homework' akela hi use hota hai, 'homeworks' nahi sunta." (Examples: "I have a lot of homework." / "She gave us too much homework.")

6. Jagah ya direction batana: "I reached in the station at 5pm." → "Jab kisi jagah pahunchne ki baat ho na, tab 'reached at' ya seedha 'reached the station' bolte hain — 'reached in' wala thoda ajeeb sunta hai." (Examples: "I reached the station at 5pm." / "We arrived at the airport early.")

7. Kaam abhi ho raha hai ya already ho chuka: "I finished my homework already, I did it." → "Dekho, jab batana ho ki kaam abhi complete hua hai aur uska asar ab tak hai — matlab abhi abhi hua — tab 'I have already finished' zyada sahi sunta hai." (Examples: "I have already finished my homework." / "She has already left for school.")

8. Ek word ka matlab situation ke hisaab se badalna: "The coding part was hardest." → "Jab kisi ek cheez ko group mein se sabse zyada bata rahe ho na, like sabse tough wali — tab 'the' lagana padta hai, 'the hardest' sunta hai, akela 'hardest' adhoora lagta hai." (Examples: "The coding part was the hardest." / "This was the toughest question in the exam.")

9. Kaam kabhi nahi kiya: "I never done this before." → "Jab kabhi kisi cheez ka experience hi na hone ki baat karte ho — matlab pehle kabhi nahi kiya, aisa kuch — tab 'had never done' ya 'have never done' sunta hai." (Examples: "I had never done this before." / "I have never tried this dish.")

10. Kisi word ka sahi tarika na pata hone pe kya bolein: "How you say this word?" → "Jab kisi word ka tarika pucchna ho na — jaise koi word bhool gaye ho, tab 'how do you say' bolte hain, akela 'how you say' nahi chalta." (Examples: "How do you say this in English?" / "How do you say 'खाना' in English?")

Reply hamesha VOICE mein bolke sunaya jaayega — isliye koi bullet points, koi markdown, koi lambi list mat likho. Bas natural bolne jaisa plain text.`;

// Hard cap on reply length. Bumped up from the earlier plain-chat-only
// version (220) because a correction turn (context + fix + 2 examples +
// encouragement) genuinely needs more room than a one-line chat reply —
// but this is still a real ceiling, not a suggestion: it directly bounds
// LLM token cost, TTS synthesis time, and how many sentence chunks get
// fanned out per turn, regardless of what the model tries to generate.
const MAX_REPLY_CHARS = Number(process.env.LITE_MAX_REPLY_CHARS) || 480;

// Defensive ceiling on how many sentence chunks a single reply can ever
// fan out into (kicks off one parallel TTS call each) — protects against
// a pathological reply (e.g. one-word "sentences" from unusual
// punctuation) turning into dozens of concurrent Sarvam calls.
const MAX_SENTENCES_PER_REPLY = 10;

// How long we'll wait on the OpenAI stream in total before giving up —
// protects the SSE connection (and the user staring at a spinner) from
// hanging indefinitely if OpenAI's API stalls.
const LLM_TIMEOUT_MS = Number(process.env.LITE_LLM_TIMEOUT_MS) || 20000;

// Matches the first complete sentence sitting at the start of `buffer`
// (greedy up to the first ./!/?/।/॥ followed by whitespace or
// end-of-string). ।/॥ (poorna viram / deergh viram) are Hindi/Devanagari
// sentence terminators — without these, any reply written in Devanagari
// script (as opposed to romanized Hinglish) never matches a sentence
// boundary at all, so nothing ever gets emitted progressively; it all
// piles up in one buffer and — if it's long enough to hit MAX_REPLY_CHARS
// — used to get silently discarded entirely (see the leftover-flush fix
// below). Found via a real "0 sentence(s)" turn in production logs.
const SENTENCE_RE = /^[^.!?।॥]*[.!?।॥]+(\s+|$)/;

const LANG_DEFAULT = 'en-IN';
const LANG_HINDI = 'hi-IN';
const OPEN_TAG = '<hi>';
const CLOSE_TAG = '</hi>';
const LONGEST_TAG_LEN = CLOSE_TAG.length; // 5, longest of the two tags

// Incremental tag-stripper: consumes raw model output (which may contain
// <hi>/</hi> markers split arbitrarily across stream chunks) and produces
// tag-free text, while tracking which language was "active" for every
// stretch of that text. This is what lets us tell each completed sentence
// apart by language without ever showing the tags to the user or asking
// the model to emit structured JSON (which would break token-streaming).
function makeTagStripper() {
  let pending = '';        // possible partial-tag tail, held back across chunks
  let currentLang = LANG_DEFAULT;
  const segments = [];     // [{ lang, length }] in emission order

  function emit(text) {
    if (!text) return;
    segments.push({ lang: currentLang, length: text.length });
  }

  // Returns the tag-free text produced from this delta (to append to
  // buffer/full). Language info lives in `segments`, consumed later via
  // consumeDominantLang().
  function push(delta) {
    pending += delta;
    let clean = '';
    while (true) {
      const idx = pending.indexOf('<');
      if (idx === -1) {
        clean += pending;
        emit(pending);
        pending = '';
        break;
      }
      if (idx > 0) {
        clean += pending.slice(0, idx);
        emit(pending.slice(0, idx));
        pending = pending.slice(idx);
      }
      if (pending.startsWith(OPEN_TAG)) {
        currentLang = LANG_HINDI;
        pending = pending.slice(OPEN_TAG.length);
        continue;
      }
      if (pending.startsWith(CLOSE_TAG)) {
        currentLang = LANG_DEFAULT;
        pending = pending.slice(CLOSE_TAG.length);
        continue;
      }
      // Could still be a partial tag waiting on more chunks — hold back.
      if (pending.length < LONGEST_TAG_LEN &&
          (OPEN_TAG.startsWith(pending) || CLOSE_TAG.startsWith(pending))) {
        break;
      }
      // A lone '<' that isn't part of a real tag — treat as literal text.
      clean += pending[0];
      emit(pending[0]);
      pending = pending.slice(1);
    }
    return clean;
  }

  // Flush anything held back at stream-end (not a tag, just literal text).
  function flush() {
    const leftover = pending;
    pending = '';
    if (leftover) emit(leftover);
    return leftover;
  }

  // Consumes the first `n` chars' worth of language segments and returns
  // whichever language covered the most of that span.
  function consumeDominantLang(n) {
    let remaining = n;
    const counts = {};
    while (remaining > 0 && segments.length) {
      const seg = segments[0];
      const take = Math.min(remaining, seg.length);
      counts[seg.lang] = (counts[seg.lang] || 0) + take;
      seg.length -= take;
      remaining -= take;
      if (seg.length === 0) segments.shift();
    }
    let dominant = LANG_DEFAULT, max = -1;
    for (const lang in counts) {
      if (counts[lang] > max) { max = counts[lang]; dominant = lang; }
    }
    return dominant;
  }

  return { push, flush, consumeDominantLang };
}

// history: [{ role: 'user'|'assistant', content: string }, ...] — recent turns only.
// userText: the just-transcribed thing the user said this turn.
// onSentence(sentenceText, lang, index): called synchronously, in order, the
// moment each sentence finishes streaming in — `lang` is 'hi-IN' or 'en-IN',
// the dominant language of that sentence (based on the model's <hi> tags).
// The caller is expected to kick off work (TTS) immediately without
// awaiting inside this callback, since blocking here would stall pulling
// further tokens off the stream.
//
// Returns { replyText } once the full reply is done streaming. replyText
// is tag-free — safe to display/persist as-is.
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
  // the instant we hit MAX_REPLY_CHARS (saves paying for/waiting on
  // discarded tokens), and also as the backstop for LLM_TIMEOUT_MS if
  // OpenAI just never responds.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  const tagStripper = makeTagStripper();
  let buffer = '';    // not-yet-emitted tail (tag-free, no sentence terminator in it yet)
  let full = '';       // everything generated so far, tag-free, for persistence
  let sentenceIndex = 0;
  let hitCap = false;

  try {
    const stream = await openai.chat.completions.create(
      { model, messages, stream: true },
      { signal: controller.signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      const clean = tagStripper.push(delta);
      buffer += clean;
      full += clean;

      let match;
      while (sentenceIndex < MAX_SENTENCES_PER_REPLY && (match = buffer.match(SENTENCE_RE))) {
        const sentence = match[0].trim();
        const lang = tagStripper.consumeDominantLang(match[0].length);
        buffer = buffer.slice(match[0].length);
        if (sentence) onSentence(sentence, lang, sentenceIndex++);
      }

      if (full.length >= MAX_REPLY_CHARS || sentenceIndex >= MAX_SENTENCES_PER_REPLY) {
        hitCap = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // An abort() we triggered ourselves (cap OR timeout) surfaces here as
    // an AbortError — expected, not a real failure UNLESS it was the
    // timeout with nothing usable generated yet (then the caller should
    // still see an error, since an empty reply isn't a valid turn).
    const isOurAbort = err.name === 'AbortError' || err.name === 'APIUserAbortError';
    if (!isOurAbort) throw err;
    if (isOurAbort && !hitCap && !full.trim()) {
      throw new Error('LLM response timed out with no output.');
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // Flush any tail the tag-stripper was holding back (not a real tag,
  // just literal trailing text). If we hit the cap mid-sentence AND
  // we've already emitted at least one real sentence, don't bother
  // appending it — better to end clean on the last complete sentence
  // than show something truncated mid-word.
  const strippedTail = tagStripper.flush();
  if (strippedTail && (!hitCap || sentenceIndex === 0)) {
    buffer += strippedTail;
    full += strippedTail;
  }
  // A trailing partial sentence (no terminator yet) normally only
  // flushes if the stream ended naturally — but if we hit the cap AND
  // nothing has been emitted yet (sentenceIndex === 0), "better to end
  // clean" becomes "the user gets nothing at all" — a real turn observed
  // in production logs where a fully-generated, fully-persisted reply
  // never reached the client. In that case, flush the leftover anyway;
  // an imperfect ending beats total silence.
  const leftover = buffer.trim();
  if (leftover && sentenceIndex < MAX_SENTENCES_PER_REPLY && (!hitCap || sentenceIndex === 0)) {
    const lang = tagStripper.consumeDominantLang(buffer.length);
    onSentence(leftover, lang, sentenceIndex++);
  }

  return { replyText: full.trim() };
}

module.exports = { streamReply, MAX_REPLY_CHARS };