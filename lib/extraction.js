/**
 * Simple tokenization: lowercase, split on whitespace, strip punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Remove fenced code blocks + inline code for cleaner NLP extraction.
 * @param {string} text
 * @returns {string}
 */
function stripCode(text) {
  const t = String(text || '');
  // Remove fenced blocks ```...```
  const noFences = t.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code `...`
  const noInline = noFences.replace(/`[^`]*`/g, ' ');
  return noInline.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize content for keyword extraction (drop code, heavy markdown artifacts).
 * @param {string} text
 * @returns {string}
 */
function normalizeForExtraction(text) {
  let t = stripCode(text);
  // Remove markdown headings and list markers
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');
  t = t.replace(/^\s*[-*]\s+/gm, ' ');
  // Remove URLs (often noisy)
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
  // Remove common pseudo-code arrow flows and heavy symbol runs (very noisy for decisions/topics)
  t = t.replace(/[↓→←⇒⇐]/g, ' ');
  t = t.replace(/[-=]{3,}/g, ' ');
  t = t.replace(/[|]{2,}/g, ' ');
  // Drop “looks like code/spec” fragments
  // (Many separators, braces, or too many non-letter chars)
  const parts = t.split(/\n+/g);
  const filtered = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    const letters = (s.match(/\p{L}/gu) || []).length;
    const nonLetters = s.length - letters;
    // Heuristic: if a line is mostly non-letters, it's probably code/template.
    if (s.length >= 60 && letters / Math.max(1, s.length) < 0.55) continue;
    // Heuristic: lots of braces/parens indicates code
    if ((s.match(/[{}()[\];]/g) || []).length >= 8) continue;
    filtered.push(s);
  }
  t = filtered.join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
  'the',
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'your',
  'you',
  'and',
  'for',
  'are',
  'was',
  'were',
  'been',
  'into',
  'about',
  'than',
  'then',
  'them',
  'they',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'how',
  'can',
  'could',
  'should',
  'would',
  'also',
  'just',
  'like',
  'make',
  'made',
  'some',
  'more',
  'most',
  'very',
  'only',
  'not',
  'does',
  'did',
  'done',
  'been',
  'it',
  'its',
  'our',
  'we',
  'i',
  'me',
  'my',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'as',
  'is',
  'be',
  'or',
  'vs',
  'versus',
  'option',
  // French common stopwords (minimal set)
  'avec',
  'pour',
  'dans',
  'comme',
  'plus',
  'moins',
  'aussi',
  'mais',
  'donc',
  'alors',
  'tres',
  'très',
  'tout',
  'toute',
  'tous',
  'toutes',
  'cette',
  'ceux',
  'cela',
  'ceci',
  'etre',
  'être',
  'avoir',
  'faire',
  'fait',
  'faire',
  'faut',
  // Dev / implementation noise (we don't want these as "topics")
  'const',
  'function',
  'return',
  'await',
  'async',
  'import',
  'export',
  'json',
  'javascript',
  'typescript',
  'chrome',
  'extension',
  'manifest',
  'popup',
  'content',
  'contentjs',
  'checksum',
  'sha256',
  'messages',
  'message',
  'snapshot',
  'console',
  'window',
  'document',
  'storage',
  'localstorage',
  'indexeddb',
  'mutationobserver',
  'selector',
  'selectors',
  'scraper',
  'scraping',
  'script',
  'api',
  'endpoint'
  ,
  // More dev-noise / meta
  'class',
  'chars',
  'tokens',
  'token',
  'prompt',
  'markdown',
  'regex',
  'pattern',
  'patterns',
  // Generic / meta words that often dominate long chats without adding meaning
  'question',
  'questions',
  'cours',
  'course',
  'file',
  'files',
  'fichier',
  'fichiers',
  'repo',
  'repository',
  'github',
  'pdf',
  'docs',
  'document',
  'documents',
  'user',
  'users',
  'assistant'
]);

/**
 * Extract 5-10 topics with weights based on token frequency (TF-IDF-ish).
 * @param {Array<{id:string, role:string, content:string}>} messages
 * @returns {Array<{label:string, weight:number, message_refs:string[], summary:string}>}
 */
function extractTopics(messages) {
  const docs = messages.map((m) => {
    const cleaned = normalizeForExtraction(m.content);
    return tokenize(cleaned).filter((w) => w.length >= 5 && !STOPWORDS.has(w));
  });
  const df = new Map(); // document frequency
  const tf = new Map(); // total term frequency

  for (const tokens of docs) {
    const seen = new Set();
    for (const w of tokens) {
      tf.set(w, (tf.get(w) || 0) + 1);
      if (!seen.has(w)) {
        df.set(w, (df.get(w) || 0) + 1);
        seen.add(w);
      }
    }
  }

  const N = Math.max(1, docs.length);
  const scored = [];
  for (const [w, freq] of tf.entries()) {
    const dfi = df.get(w) || 1;
    // Drop ubiquitous terms (appear in too many messages) to avoid "verbs everywhere" topics.
    // For very small conversations, this would remove everything (e.g. N=1).
    if (N >= 5 && dfi / N >= 0.6) continue;
    const idf = Math.log((N + 1) / dfi); // smooth
    const score = freq * idf;
    scored.push({ w, freq, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 7); // MAX 7 topics

  return top.map((t) => {
    const message_refs = [];
    const recentFirst = [...messages].reverse(); // recent first

    for (const m of recentFirst) {
      const cleaned = normalizeForExtraction(m.content).toLowerCase();
      if (cleaned.includes(t.w)) {
        if (message_refs.length < 3) {
          // MAX 3 refs
          message_refs.push(m.id);
        } else {
          break; // stop once we have 3
        }
      }
    }

    message_refs.reverse(); // back to chronological order
    const weight = Math.min(1000, t.freq * 100);
    return {
      label: t.w,
      weight,
      message_refs,
      summary: `"${t.w}" (${t.freq}x)`
    };
  });
}

/**
 * Detect decision-like messages and extract basic decision objects.
 * @param {Array<{id:string, role:string, content:string, timestamp?:string}>} messages
 * @returns {Array<any>}
 */
function extractDecisions(messages) {
  const decisionPatterns = [
    /option\s+[A-Z]\s+(vs|versus|or)\s+option\s+[A-Z]/i,
    /\bI\s+recommend\b/i,
    /\bWe\s+should\b/i,
    /Decision:\s+(.+)/i,
    /\bChoose\s+between\b/i,
    // French patterns
    /\bje\s+recommande\b/i,
    /\bon\s+devrait\b/i,
    /\bdécision\s*:\s*(.+)/i,
    /\bchoisi[rs]?\s+entre\b/i,
    /\bil\s+faut\b/i,
    // Commitment / plan signals (implicit decisions)
    /\bje\s+vais\b/i,
    /\bon\s+va\b/i,
    /\bobjectif\s*:/i,
    /\bgoal\s*:/i
  ];

  const out = [];
  let decIdx = 1;

  // Detect user "commit" decisions without provider-specific hacks.
  // Keep this conservative: short affirmation + direction (not code/templates).
  const looksLikeUserCommit = (text) => {
    const t = String(text || '').trim();
    if (!t) return false;
    // Avoid capturing code/log dumps as “decisions”
    if (/[{}[\];]{6,}/.test(t)) return false;
    if (/\b(import|export|const|let|var|function|class|def|async|await|return)\b/i.test(t)) return false;
    // Common commit/decision cues (FR/EN)
    return /^\s*(ok|okay|go|deal|done|let's\s+go|let's\s+do|on\s+y\s+va|on\s+fait|on\s+part|on\s+garde|on\s+pr[eé]f[eè]re|je\s+veux|je\s+pr[eé]f[eè]re)\b/i.test(
      t
    );
  };

  for (const m of messages) {
    // Important: do NOT extract decisions from code blocks / templates
    const text = normalizeForExtraction(m.content || '');
    if (!text) continue;
    // If still huge after normalization, it's likely a template/spec dump → skip
    if (text.length > 600) continue;
    // Skip if it still smells like implementation scaffolding
    if (/\b(file\s+\d+|purpose|required|methods?|snapshot schema)\b/i.test(text)) continue;
    const hit = decisionPatterns.find((re) => re.test(text));
    const role = String(m?.role || '').toLowerCase();

    // NEW: accept conservative user commit decisions even without explicit Decision:
    if (!hit) {
      if (role === 'user' && looksLikeUserCommit(text)) {
        const chosen = sanitizeChoice(text);
        if (!isValidChoice(chosen)) continue;
        out.push({
          id: `dec-${decIdx++}`,
          timestamp: m.timestamp || new Date().toISOString(),
          intent: 'decide',
          intent_text: 'User commitment detected',
          options_considered: [{ option: chosen, weight: 700, rationale: 'User commit signal.' }],
          chosen_option: chosen,
          constraints: [],
          confidence_llm: 70
        });
        continue;
      }
      continue;
    }

    // Prefer assistant-authored decisions; allow user decisions only if explicitly marked.
    if (role === 'user') {
      const explicitUserDecision = /Decision:\s+(.+)/i.test(text) || /\bdécision\s*:\s*(.+)/i.test(text);
      if (!explicitUserDecision && !looksLikeUserCommit(text)) continue;
    }

    // Very simple intent extraction
    let intent = 'decide';
    let intentText = 'Decision detected';
    if (/recommend/i.test(text)) {
      intent = 'recommend';
      intentText = 'Recommendation';
    } else if (/we\s+should/i.test(text)) {
      intent = 'propose';
      intentText = 'Proposed action';
    } else if (/decision:/i.test(text)) {
      intent = 'decide';
      intentText = 'Explicit decision';
    } else if (/je\s+recommande/i.test(text)) {
      intent = 'recommend';
      intentText = 'Recommendation (French)';
    } else if (/on\s+devrait|il\s+faut/i.test(text)) {
      intent = 'propose';
      intentText = 'Proposed action (French)';
    } else if (/décision\s*:/i.test(text)) {
      intent = 'decide';
      intentText = 'Explicit decision (French)';
    }

    const options = [];
    const explicit = text.match(/Decision:\s+(.+)/i) || text.match(/décision\s*:\s*(.+)/i);
    if (explicit && explicit[1]) {
      const opt = sanitizeChoice(explicit[1]);
      if (!isValidChoice(opt)) {
        continue;
      }
      options.push({
        option: opt,
        weight: 800,
        rationale: 'Explicitly stated as a decision.'
      });
    }
    const explicitGoal = text.match(/\b(objectif|goal)\s*:\s*(.+)/i);
    if (!options.length && explicitGoal && explicitGoal[2]) {
      const opt = sanitizeChoice(explicitGoal[2]);
      if (isValidChoice(opt)) {
        options.push({
          option: opt,
          weight: 700,
          rationale: 'Explicitly stated goal.'
        });
      }
    }

    const optMatch = text.match(/option\s+([A-Z])\s+(vs|versus|or)\s+option\s+([A-Z])/i);
    if (optMatch) {
      const a = `Option ${optMatch[1].toUpperCase()}`;
      const b = `Option ${optMatch[3].toUpperCase()}`;
      options.push(
        { option: a, weight: 500, rationale: 'Mentioned as an alternative.' },
        { option: b, weight: 500, rationale: 'Mentioned as an alternative.' }
      );
    }

    // Choose chosen_option heuristically: first option mentioned after recommend/decision
    let chosen = 'UNKNOWN';
    if (explicit && explicit[1]) chosen = sanitizeChoice(explicit[1]);
    else {
      const rec = text.match(/\b(recommend|choose|recommande|choisis|choisir|on\s+part\s+sur|on\s+garde)\b\s+(.+)/i);
      if (rec && rec[2]) chosen = sanitizeChoice(rec[2]);
    }
    if (!isValidChoice(chosen)) chosen = 'UNKNOWN';

    // Commitment heuristic: "je vais X" / "on va X"
    if (chosen === 'UNKNOWN') {
      const commit = text.match(/\b(je\s+vais|on\s+va)\s+(.+)/i);
      if (commit && commit[2]) {
        const opt = sanitizeChoice(commit[2]);
        if (isValidChoice(opt)) chosen = opt;
      }
    }

    const confidence = /must|definitely|clearly/i.test(text) ? 80 : 60;

    out.push({
      id: `dec-${decIdx++}`,
      timestamp: m.timestamp || new Date().toISOString(),
      intent,
      intent_text: intentText,
      options_considered: options.length
        ? options
        : [
            {
              option: 'UNKNOWN',
              weight: 300,
              rationale: 'Decision-like statement detected but options were not explicit.'
            }
          ],
      chosen_option: chosen,
      constraints: [],
      confidence_llm: confidence
    });
  }

  // Sort by confidence and bound to max 5
  out.sort((a, b) => (b.confidence_llm || 0) - (a.confidence_llm || 0));
  return out.slice(0, 5); // MAX 5 decisions
}

function sanitizeChoice(text, maxLen = 2000) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .trim();
  // Strip trailing junk that often comes from templates/code
  const noTicks = t
    .replace(/[↓→←⇒⇐]/g, ' ')
    .replace(/[`{}()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // IMPORTANT: do NOT aggressively truncate here; Digest/Ultra will excerpt later.
  const n = Math.max(200, Number(maxLen) || 2000);
  return noTicks.length > n ? noTicks.slice(0, Math.max(0, n - 16)) + ' ...[TRUNCATED]' : noTicks;
}

function isValidChoice(text) {
  const t = String(text || '').trim();
  if (!t || t === 'UNKNOWN') return false;
  // Require some letters (avoid junk like Y") or symbols-only
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 8) return false;
  // Avoid single generic verbs / too-short choices (e.g., "utiliser")
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 && t.length < 16) return false;
  // Avoid “looks like code”
  if ((t.match(/[{}()[\];]/g) || []).length >= 3) return false;
  return true;
}

/**
 * Extract key insights based on marker patterns in sentences.
 * @param {Array<{content:string}>} messages
 * @returns {string[]}
 */
function extractInsights(messages) {
  const insightPatterns = [
    /Critical:/i,
    /Important:/i,
    /Key\s+insight:/i,
    /Remember:/i,
    /Note:/i,
    // French markers
    /Critique\s*:/i,
    /Important\s*:/i,
    /Point\s+clé\s*:/i,
    /À\s+retenir\s*:/i,
    /Note\s*:/i
  ];

  const insights = [];
  for (const m of messages) {
    const text = normalizeForExtraction(m.content || '');
    if (!text) continue;
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const str = s.trim();
      if (!str) continue;
      // Avoid swallowing long “spec/template” sentences
      if (str.length > 280) continue;
      if (insightPatterns.some((re) => re.test(str))) {
        insights.push(str.length > 240 ? str.slice(0, 237) + '...' : str);
        if (insights.length >= 10) return insights; // MAX 10 insights
      }
      // Heuristic insights for short conversations (implicit “state”)
      if (insights.length < 10) {
        if (/^\s*(je\s+veux|objectif\s*:|goal\s*:|il\s+faut|we\s+need\s+to)\b/i.test(str) && str.length <= 200) {
          insights.push(str);
        }
      }
    }
  }
  return insights;
}

// Expose globally for popup.html simple script loading (no bundler).
// eslint-disable-next-line no-undef
if (typeof window !== 'undefined') {
  window.extractTopics = extractTopics;
  window.extractDecisions = extractDecisions;
  window.extractInsights = extractInsights;
}


