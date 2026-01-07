/* global chrome */

(() => {
  const LOG_PREFIX = '[RL4]';
  const STORAGE_KEYS = {
    CURRENT_SESSION_ID: 'rl4_current_session_id',
    CURRENT_CONV_ID: 'rl4_current_conv_id',
    CURRENT_MESSAGES: 'rl4_current_messages',
    CURRENT_UPDATED_AT: 'rl4_current_updated_at',
    SESSIONS_INDEX: 'rl4_sessions_index',
    API_MESSAGES: 'rl4_api_messages',
    API_EVENTS: 'rl4_api_events'
  };

  const SELECTORS = {
    // Claude
    CLAUDE_MESSAGE_CONTAINERS: '[data-testid*="message"]',
    CLAUDE_USER_MESSAGE: '.font-user-message',
    CLAUDE_ASSISTANT_MESSAGE: '.font-claude-message',
    CLAUDE_ROLE_ATTR: '[data-is-user-message]',
    // ChatGPT
    CHATGPT_MESSAGE_NODES: '[data-message-author-role]',
    CHATGPT_ROLE_ATTR: '[data-message-author-role]',
    // Gemini (forensically validated selectors)
    // Note: Gemini often uses custom elements like <user-query> / <model-response>.
    // We support both tag + class forms to be resilient across UI variants.
    GEMINI_LOOP: '.user-query-bubble-with-background, user-query, .model-response, model-response',
    GEMINI_USER_CONTAINER: '.user-query-bubble-with-background, user-query',
    GEMINI_USER_TEXT: '.query-text',
    GEMINI_ASSISTANT_CONTAINER: '.model-response, model-response',
    GEMINI_ASSISTANT_MARKDOWN: '.markdown',
    GEMINI_THOUGHT_DISCLOSURE: '.thought-disclosure'
  };

  const OBSERVER_DEBOUNCE_MS = 250;
  const MAX_SESSIONS_TO_KEEP = 5;
  const DEEP_CAPTURE_MAX_MS = 12000;
  const DEEP_CAPTURE_STEP_RATIO = 0.8;
  // Gemini can require multiple "top hits" to load the full history; allow a longer hydration budget.
  const DEEP_HYDRATE_MAX_MS = 45000;
  const DEEP_HYDRATE_WAIT_MS = 2000;
  // chrome.storage.local quota is typically ~5MB. Keep plenty of headroom.
  // For full-fidelity share snapshots, prefer in-memory transfer to popup.
  const MAX_STORAGE_MESSAGE_CHARS = 1_800_000;
  const MAX_API_CACHE_MESSAGES = 2000; // in-memory safety cap (still large enough for most shares)

  let observer = null;
  let debounceTimer = null;
  let apiEvents = [];
  let apiMessagesCache = [];
  let lastPathname = null;

  /**
   * @param {string} msg
   * @param {any=} data
   */
  function log(msg, data) {
    if (data !== undefined) console.log(LOG_PREFIX, msg, data);
    else console.log(LOG_PREFIX, msg);
  }

  /**
   * @param {string} msg
   * @param {any=} err
   */
  function logError(msg, err) {
    console.error(LOG_PREFIX, msg, err);
  }

  function getProvider() {
    const h = (window.location.hostname || '').toLowerCase();
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('gemini.google.com') || h.includes('bard.google.com')) return 'gemini';
    return 'unknown';
  }

  /**
   * Inject the API interceptor into the page context ASAP.
   * This allows capturing the same JSON the app receives (no paid API).
   */
  function injectApiInterceptor() {
    try {
      const existing = document.getElementById('rl4-api-interceptor');
      if (existing) return;
      const script = document.createElement('script');
      script.id = 'rl4-api-interceptor';
      script.src = chrome.runtime.getURL('lib/api-interceptor.js');
      script.async = false;
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
      log('API interceptor injected');
    } catch (e) {
      logError('Failed to inject API interceptor', e);
    }
  }

  /**
   * Claude.ai is an SPA; route changes don't always reload the page.
   * We watch navigation events and reset session/messages when the conversation changes.
   */
  function installRouteChangeWatcher() {
    try {
      if (window.__RL4_ROUTE_WATCHER_INSTALLED__) return;
      window.__RL4_ROUTE_WATCHER_INSTALLED__ = true;

      const onRouteMaybeChanged = async (reason) => {
        try {
          const p = window.location.pathname || '';
          if (p === lastPathname) return;
          const prev = lastPathname;
          lastPathname = p;
          log('Route changed', { reason, from: prev, to: p });
          await ensureSessionId(); // will reset if conv changed
          await scanAndSyncMessages('route-change');
        } catch (e) {
          logError('Route change handler failed', e);
        }
      };

      // Patch history methods
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      history.pushState = function (...args) {
        const ret = originalPushState.apply(this, args);
        onRouteMaybeChanged('pushState');
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = originalReplaceState.apply(this, args);
        onRouteMaybeChanged('replaceState');
        return ret;
      };

      window.addEventListener('popstate', () => onRouteMaybeChanged('popstate'));

      // Also poll once shortly after boot (some apps update route after hydration)
      setTimeout(() => onRouteMaybeChanged('boot-timeout'), 750);
      setTimeout(() => onRouteMaybeChanged('boot-timeout-2'), 2000);

      lastPathname = window.location.pathname || '';
      log('Route watcher installed', { pathname: lastPathname });
    } catch (e) {
      logError('Failed to install route watcher', e);
    }
  }

  /**
   * Extract text content from Claude-style message shapes.
   * Improved to handle Claude.ai block format (arrays of objects with type/text).
   * @param {any} content
   * @returns {string}
   */
  function normalizeContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((x) => {
          if (typeof x === 'string') return x;
          // Claude.ai block format: { type: "text", text: "..." }
          if (x && typeof x === 'object') {
            if (typeof x.text === 'string') return x.text;
            if (x.type === 'text' && typeof x.text === 'string') return x.text;
            // Fallback: try to stringify the whole block
            if (x.content && typeof x.content === 'string') return x.content;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (typeof content === 'object') {
      // ChatGPT: { parts: ["..."] } (most common)
      if (Array.isArray(content.parts)) {
        return content.parts.filter((p) => typeof p === 'string').join('\n').trim();
      }
      // Sometimes nested: { content: { parts: [...] } }
      if (content.content && typeof content.content === 'object' && Array.isArray(content.content.parts)) {
        return content.content.parts.filter((p) => typeof p === 'string').join('\n').trim();
      }
      if (typeof content.text === 'string') return content.text;
      if (content.type === 'text' && typeof content.text === 'string') return content.text;
    }
    return '';
  }

  /**
   * Gemini/Bard UI contains lots of small interactive labels ("Show thinking", "Copy", etc.)
   * We filter these out to avoid capturing toolbars instead of real messages.
   * @param {Element} el
   * @param {string} content
   * @returns {boolean}
   */
  function isGeminiUiNoise(el, content) {
    const c = String(content || '').replace(/\s+/g, ' ').trim();
    if (!c) return true;
    const lower = c.toLowerCase();

    // Very common UI labels that are not conversation text
    const exact = new Set([
      'show thinking',
      'show reasoning',
      'hide thinking',
      'hide reasoning',
      'copy',
      'copied',
      'share',
      'edit',
      'regenerate',
      'retry',
      'stop',
      'new chat',
      'new conversation',
      'thumbs up',
      'thumbs down'
    ]);
    if (exact.has(lower)) return true;

    // Short, button-like labels
    if (c.length <= 24) {
      if (el && el.closest && el.closest('button,[role="button"],a,[aria-label]')) return true;
      if (/^(show|hide|copy|share|edit|retry|stop)\b/i.test(c)) return true;
    }

    // If it contains "thinking" but is still tiny, it's likely a toggle.
    if (lower.includes('thinking') && c.length < 60) return true;

    // Require some letters; pure icons/controls tend to be non-textual.
    if (!/[A-Za-zÀ-ÿ]/.test(c)) return true;

    return false;
  }

  /**
   * Best-effort parser for Google "batchexecute" responses (Gemini/Bard).
   * The response is often XSSI-prefixed and line-delimited. Some frames contain JSON strings.
   * @param {string} text
   * @returns {any[]|null}
   */
  function tryParseGoogleBatchExecute(text) {
    try {
      let t = String(text || '');
      // XSSI prefix
      t = t.replace(/^\)\]\}'\s*/m, '').trim();
      if (!t) return null;

      const lines = t
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const parsed = [];
      for (const line of lines) {
        // Skip length prefixes / non-JSON lines
        if (!line.startsWith('[') && !line.startsWith('{')) continue;
        try {
          const obj = JSON.parse(line);
          parsed.push(obj);
        } catch (_) {
          // ignore
        }
      }

      // Expand nested JSON strings commonly embedded in batchexecute frames
      const expanded = [];
      const stack = [...parsed];
      while (stack.length) {
        const cur = stack.pop();
        expanded.push(cur);
        if (typeof cur === 'string') {
          const s = cur.trim();
          if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
            try {
              stack.push(JSON.parse(s));
            } catch (_) {
              // ignore
            }
          }
        } else if (Array.isArray(cur)) {
          for (const v of cur) {
            if (typeof v === 'string') stack.push(v);
          }
        } else if (cur && typeof cur === 'object') {
          for (const v of Object.values(cur)) {
            if (typeof v === 'string') stack.push(v);
          }
        }
      }

      return expanded.length ? expanded : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Heuristic role normalization.
   * @param {any} role
   * @param {any} sender
   * @returns {'user'|'assistant'|null}
   */
  function normalizeRole(role, sender) {
    const r = String(role || '').toLowerCase();
    const s = String(sender || '').toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'claude' || r === 'ai') return 'assistant';
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'claude' || s === 'ai') return 'assistant';
    return null;
  }

  /**
   * Extract messages from an array of message-like objects.
   * @param {Array<any>} arr
   * @param {Set<string>} seen
   * @returns {Array<{role:'user'|'assistant', content:string, timestamp?:string}>}
   */
  function extractFromArray(arr, seen) {
    const out = [];
    for (const item of arr) {
      if (item && typeof item === 'object') {
        // ChatGPT often nests the actual message under { message: { author: { role }, content: { parts } } }
        const nestedMsg = item.message && typeof item.message === 'object' ? item.message : null;
        const nestedRole = nestedMsg && nestedMsg.author ? nestedMsg.author.role : undefined;
        const role = normalizeRole(item.role ?? nestedRole, item.sender ?? nestedRole);
        const content = normalizeContent(
          item.content ??
            item.text ??
            item.completion ??
            (nestedMsg ? nestedMsg.content ?? nestedMsg : item.message)
        );
        if (role && content && content.length > 0) {
          const sig = `${role}|${content.slice(0, 300).toLowerCase()}`;
          if (!seen.has(sig)) {
            seen.add(sig);
            out.push({
              role,
              content,
              timestamp:
                item.timestamp ||
                item.created_at ||
                item.createdAt ||
                item.updated_at ||
                item.updatedAt ||
                (nestedMsg && typeof nestedMsg.create_time === 'number'
                  ? new Date(nestedMsg.create_time * 1000).toISOString()
                  : undefined) ||
                undefined
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * Recursively walk an object to find arrays of message-like objects.
   * Improved to prioritize common Claude.ai structures (messages, chat_messages, conversation).
   * @param {any} root
   * @returns {Array<{role:'user'|'assistant', content:string, timestamp?:string}>}
   */
  function extractMessagesFromAnyJson(root) {
    const out = [];
    const seen = new Set();

    const pushOne = (role, content, timestamp) => {
      if (!role || !content) return;
      const sig = `${role}|${String(content).slice(0, 300).toLowerCase()}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ role, content: String(content), timestamp });
    };

    const tryExtractChatGPTMessageObject = (node) => {
      if (!node || typeof node !== 'object') return;
      // Direct message object: { author:{role}, content:{parts:[...]}, create_time }
      if (node.author && node.content) {
        const authorRole = node.author && typeof node.author === 'object' ? node.author.role : undefined;
        const role = normalizeRole(authorRole, authorRole);
        const content = normalizeContent(node.content ?? node);
        if (role && content) {
          const ts =
            typeof node.create_time === 'number' ? new Date(node.create_time * 1000).toISOString() : undefined;
          pushOne(role, content, ts);
        }
      }
      // Wrapper shape: { message: { author:{role}, content:{parts:[...]} } }
      if (node.message && typeof node.message === 'object') {
        tryExtractChatGPTMessageObject(node.message);
      }
    };

    // ChatGPT full conversation format: { mapping: { nodeId: { message: { author:{role}, content:{parts} } } } }
    if (root && typeof root === 'object' && root.mapping && typeof root.mapping === 'object') {
      try {
        const nodes = Object.values(root.mapping);
        const extracted = [];
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          if (!n.message || typeof n.message !== 'object') continue;
          const authorRole = n.message.author ? n.message.author.role : undefined;
          const role = normalizeRole(authorRole, authorRole);
          const content = normalizeContent(n.message.content ?? n.message);
          if (!role || !content) continue;
          extracted.push({
            role,
            content,
            timestamp:
              typeof n.message.create_time === 'number'
                ? new Date(n.message.create_time * 1000).toISOString()
                : undefined
          });
        }
        // stable ordering
        extracted.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        const asArray = extractFromArray(extracted, seen);
        if (asArray.length > 0) {
          log('Found ChatGPT mapping structure', { count: asArray.length });
          out.push(...asArray);
        }
      } catch (_) {
        // ignore
      }
    }

    // First pass: look for common Claude.ai structures
    if (root && typeof root === 'object') {
      const commonKeys = ['messages', 'chat_messages', 'conversation', 'items', 'chat', 'data'];
      for (const key of commonKeys) {
        if (!Array.isArray(root[key])) continue;
        log(`Found common structure: ${key}`, { count: root[key].length });
        const extracted = extractFromArray(root[key], seen);
        if (extracted.length > 0) {
          out.push(...extracted);
          log(`Extracted ${extracted.length} messages from ${key}`, { totalSoFar: out.length });
        }
      }
    }

    // Fallback: recursive walk
    const visit = (node, depth) => {
      if (!node || depth > 8) return; // Increased depth limit
      if (Array.isArray(node)) {
        const extracted = extractFromArray(node, seen);
        if (extracted.length > 0) {
          out.push(...extracted);
        }
        // Continue visiting for nested structures
        for (const item of node) {
          visit(item, depth + 1);
        }
        return;
      }
      if (typeof node === 'object') {
        // ChatGPT SSE / backend frames often contain a single "message" object (not in arrays)
        tryExtractChatGPTMessageObject(node);
        for (const k of Object.keys(node)) {
          visit(node[k], depth + 1);
        }
      }
    };

    visit(root, 0);

    // Final pass: de-dup again (across key-based + recursive extraction)
    const uniq = [];
    const sigSeen = new Set();
    for (const m of out) {
      const sig = `${m.role}|${(m.content || '').slice(0, 300).toLowerCase()}`;
      if (sigSeen.has(sig)) continue;
      sigSeen.add(sig);
      uniq.push(m);
    }

    return uniq;
  }

  /**
   * Handle API response events coming from the injected interceptor.
   * Stores a derived message list in chrome.storage.local.
   * @param {any} payload
   */
  async function onApiEvent(payload) {
    try {
      if (!payload || !payload.body) return;
      const url = String(payload.url || '');
      // Keep events bounded
      apiEvents.push({ ...payload, url, receivedAt: Date.now() });
      if (apiEvents.length > 50) apiEvents = apiEvents.slice(-50);

      // Try parse JSON bodies only
      let json = null;
      try {
        json = JSON.parse(payload.body);
      } catch (_) {
        // Gemini/Bard: /batchexecute responses are not clean JSON; try best-effort parsing.
        if (url.includes('/batchexecute') || url.includes('/_/BardChatUi/')) {
          const parsed = tryParseGoogleBatchExecute(payload.body);
          if (parsed && parsed.length) {
            json = parsed;
          }
        }
        if (json) {
          // continue below
        } else {
        // Some responses are newline-delimited JSON; try best-effort per-line parsing.
        const lines = String(payload.body || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length <= 1) return;
        const parsed = [];
        for (const line of lines) {
          try {
            parsed.push(JSON.parse(line));
          } catch (_) {
            // ignore
          }
        }
        if (!parsed.length) return;
        json = parsed;
        }
      }

      const extracted = extractMessagesFromAnyJson(json);
      if (!extracted.length) return;

      const sessionId = await ensureSessionId();
      // Merge into cache with de-dup
      const existingSig = new Set(apiMessagesCache.map((m) => signature(m.role, m.content)));
      for (const m of extracted) {
        const sig = signature(m.role, m.content);
        if (existingSig.has(sig)) continue;
        existingSig.add(sig);
        apiMessagesCache.push({
          id: `msg-${apiMessagesCache.length + 1}`,
          role: m.role,
          content: m.content,
          timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date().toISOString(),
          session_id: sessionId,
          captured_at: Date.now(),
          source: 'api',
          source_url: url
        });
      }

      // Cap in-memory cache to avoid runaway memory on long sessions.
      if (apiMessagesCache.length > MAX_API_CACHE_MESSAGES) {
        apiMessagesCache = apiMessagesCache.slice(-MAX_API_CACHE_MESSAGES);
      }

      // Persist a bounded subset for popup retrieval / debugging (avoid quota errors).
      // Full-fidelity retrieval should use in-memory cache via sendMessage (see getMessages handler).
      const approxChars = apiMessagesCache.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
      const bounded = approxChars > MAX_STORAGE_MESSAGE_CHARS ? apiMessagesCache.slice(-300) : apiMessagesCache;
      await chrome.storage.local.set({
        [STORAGE_KEYS.API_MESSAGES]: bounded,
        [STORAGE_KEYS.API_EVENTS]: apiEvents
      });
    } catch (e) {
      logError('Failed to process API event', e);
    }
  }

  /**
   * Directly fetch a public share snapshot JSON (best source of truth).
   * Improved to try multiple endpoints and better handle Claude.ai format.
   * This is NOT a paid API call; it's the same endpoint the share page uses.
   * @param {string} shareId
   * @returns {Promise<Array<any>>} messages in extension format
   */
  async function fetchShareSnapshotMessages(shareId) {
    try {
      if (!shareId) {
        logError('fetchShareSnapshotMessages: no shareId provided');
        return [];
      }

      // Try multiple endpoints (Claude.ai may use different ones)
      const endpoints = [
        `/api/chat_snapshots/${shareId}?rendering_mode=messages&render_all_tools=true`,
        `/api/chat_snapshots/${shareId}?rendering_mode=messages`,
        `/api/chat_snapshots/${shareId}`,
        `/api/shares/${shareId}`,
        `/backend-api/chat_snapshots/${shareId}`
      ];

      const tryFetch = async (endpoint, credentials) => {
        try {
          const url = `${location.origin}${endpoint}`;
          log('Trying endpoint', { endpoint, credentials });
          const res = await fetch(url, {
            credentials,
            headers: {
              Accept: 'application/json'
            }
          });
          return { ok: res.ok, res, url };
        } catch (e) {
          logError('Fetch error', { endpoint, error: e.message });
          return { ok: false, res: null, url: null };
        }
      };

      let json = null;
      let successfulUrl = null;

      // Try each endpoint with both credential modes
      for (const endpoint of endpoints) {
        for (const creds of ['include', 'omit']) {
          const { ok, res, url } = await tryFetch(endpoint, creds);
          if (ok && res) {
            try {
              json = await res.json();
              successfulUrl = url;
              log('✅ Successfully fetched share snapshot', { url, structure: Object.keys(json) });
              break;
            } catch (e) {
              logError('Failed to parse JSON', { url, error: e.message });
              continue;
            }
          }
        }
        if (json) break;
      }

      if (!json) {
        logError('All endpoints failed for share snapshot', { shareId });
        return [];
      }

      // Extract messages with improved logic
      const extracted = extractMessagesFromAnyJson(json);
      log('Extracted messages from share snapshot', { 
        count: extracted.length, 
        structure: Object.keys(json),
        url: successfulUrl
      });

      if (!extracted.length) {
        // Debug: log the structure to help diagnose
        logError('Share snapshot fetched but no messages extracted', {
          url: successfulUrl,
          topLevelKeys: Object.keys(json),
          sample: JSON.stringify(json).substring(0, 1000),
          fullStructure: JSON.stringify(json, null, 2).substring(0, 2000)
        });
        
        // Try one more aggressive extraction pass
        const aggressiveExtract = (obj, depth = 0) => {
          if (depth > 12) return [];
          const found = [];
          
          if (Array.isArray(obj)) {
            for (const item of obj) {
              if (item && typeof item === 'object') {
                const role = String(item.role || item.sender || item.type || '').toLowerCase();
                let content = '';
                
                if (Array.isArray(item.content)) {
                  content = item.content
                    .map(b => typeof b === 'string' ? b : (b?.text || b?.content || ''))
                    .filter(Boolean)
                    .join('\n');
                } else if (typeof item.content === 'string') {
                  content = item.content;
                } else if (item.text) {
                  content = item.text;
                }
                
                if ((role === 'user' || role === 'assistant' || role === 'human' || role === 'claude') && content && content.trim()) {
                  found.push({
                    role: role === 'human' ? 'user' : (role === 'claude' ? 'assistant' : role),
                    content: content.trim()
                  });
                }
              }
              if (item && typeof item === 'object') {
                found.push(...aggressiveExtract(item, depth + 1));
              }
            }
          } else if (typeof obj === 'object' && obj !== null) {
            for (const [k, v] of Object.entries(obj)) {
              found.push(...aggressiveExtract(v, depth + 1));
            }
          }
          
          return found;
        };
        
        const aggressive = aggressiveExtract(json);
        if (aggressive.length > 0) {
          log('Aggressive extraction found messages', { count: aggressive.length });
          const deduped = [];
          const seen = new Set();
          for (const m of aggressive) {
            const sig = `${m.role}|${m.content.slice(0, 200).toLowerCase()}`;
            if (!seen.has(sig)) {
              seen.add(sig);
              deduped.push(m);
            }
          }
          if (deduped.length > 0) {
            extracted.push(...deduped);
            log('Using aggressively extracted messages', { count: deduped.length });
          }
        }
        
        if (!extracted.length) {
          return [];
        }
      }

      const sessionId = await ensureSessionId();
      const out = [];
      for (const m of extracted) {
        out.push({
          id: `msg-${out.length + 1}`,
          role: m.role,
          content: m.content,
          timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date().toISOString(),
          session_id: sessionId,
          captured_at: Date.now(),
          source: 'share_api',
          source_url: successfulUrl
        });
      }

      // Keep in memory for perfect retrieval (avoid chrome.storage quota).
      apiMessagesCache = out;
      if (apiMessagesCache.length > MAX_API_CACHE_MESSAGES) {
        apiMessagesCache = apiMessagesCache.slice(-MAX_API_CACHE_MESSAGES);
      }

      // Persist only a bounded subset for debugging (optional)
      const approxChars = apiMessagesCache.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
      const bounded = approxChars > MAX_STORAGE_MESSAGE_CHARS ? apiMessagesCache.slice(-300) : apiMessagesCache;
      await chrome.storage.local.set({
        [STORAGE_KEYS.API_MESSAGES]: bounded,
        [STORAGE_KEYS.API_EVENTS]: apiEvents
      });

      log('Share snapshot loaded (in-memory)', { messages: out.length, stored: bounded.length, approxChars });
      return out;
    } catch (e) {
      logError('fetchShareSnapshotMessages failed', e);
      return [];
    }
  }

  // Listen to events from page context
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'RL4_API_RESPONSE') return;
      onApiEvent(data.payload).catch((e) => logError('onApiEvent failed', e));
    } catch (e) {
      logError('window message handler failed', e);
    }
  });

  /**
   * Best-effort conversation id extraction from URL.
   * claude.ai typically uses /chat/<id> or /share/<id>.
   * chatgpt.com typically uses /c/<id> or /share/<id>.
   * @returns {string}
   */
  function getConversationIdFromUrl() {
    try {
      const href = window.location.href || '';
      const path = window.location.pathname || '';
      const provider = getProvider();

      // Priority 1: UUID anywhere in URL (most reliable)
      const uuid =
        href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i) ||
        path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
      if (uuid && uuid[0]) {
        log('Extracted UUID from URL', { uuid: uuid[0], path });
        return uuid[0];
      }

      // Priority 2: /share/<id> or /chat/<id>
      const parts = path.split('/').filter(Boolean);
      const shareIdx = parts.findIndex((p) => p === 'share');
      if (shareIdx >= 0 && parts[shareIdx + 1]) {
        log('Extracted share ID from path', { shareId: parts[shareIdx + 1] });
        return parts[shareIdx + 1];
      }
      if (provider === 'claude') {
        const chatIdx = parts.findIndex((p) => p === 'chat');
        if (chatIdx >= 0 && parts[chatIdx + 1]) {
          log('Extracted chat ID from path', { chatId: parts[chatIdx + 1] });
          return parts[chatIdx + 1];
        }
      }
      if (provider === 'chatgpt') {
        const cIdx = parts.findIndex((p) => p === 'c');
        if (cIdx >= 0 && parts[cIdx + 1]) {
          log('Extracted chatgpt conversation ID from path', { id: parts[cIdx + 1] });
          return parts[cIdx + 1];
        }
      }
      if (provider === 'gemini') {
        // Gemini/Bard often uses /app or /app/<id>. Keep stable-ish id when present.
        const appIdx = parts.findIndex((p) => p === 'app');
        if (appIdx >= 0 && parts[appIdx + 1]) {
          log('Extracted gemini conversation ID from path', { id: parts[appIdx + 1] });
          return parts[appIdx + 1];
        }
      }

      // Fallback: stable hash of pathname (so never "unknown")
      if (path && path !== '/') {
        const h = Array.from(path).reduce((acc, c) => (Math.imul(31, acc) + c.charCodeAt(0)) | 0, 0);
        const hashId = `hash-${(h >>> 0).toString(16)}`;
        log('Using hash fallback for conversation ID', { path, hashId });
        return hashId;
      }

      const timestampId = `timestamp-${Date.now()}`;
      log('Using timestamp fallback for conversation ID', { timestampId });
      return timestampId;
    } catch (e) {
      logError('Failed to parse conversation id from URL', e);
      return `timestamp-${Date.now()}`;
    }
  }

  /**
   * Compute a deterministic session id for current tab instance.
   * @returns {string}
   */
  function computeSessionId() {
    const convId = getConversationIdFromUrl();
    const ts = new Date().toISOString();
    return `conv-${convId}-${ts}`;
  }

  /**
   * @returns {Promise<string>}
   */
  async function ensureSessionId() {
    const convId = getConversationIdFromUrl();
    const existing = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_SESSION_ID, STORAGE_KEYS.CURRENT_CONV_ID]);
    const current = existing && existing[STORAGE_KEYS.CURRENT_SESSION_ID] ? existing[STORAGE_KEYS.CURRENT_SESSION_ID] : null;
    const currentConv = existing && existing[STORAGE_KEYS.CURRENT_CONV_ID] ? existing[STORAGE_KEYS.CURRENT_CONV_ID] : null;

    // Migration safety: older versions stored CURRENT_SESSION_ID but not CURRENT_CONV_ID.
    // If the stored session id doesn't match the current URL convId, reset.
    if (current && !currentConv) {
      const m = String(current).match(/^conv-(.+?)-/);
      const storedConvFromSession = m && m[1] ? m[1] : null;
      if (storedConvFromSession && storedConvFromSession !== convId) {
        log('Migration detected (no CURRENT_CONV_ID) + conv mismatch → resetting session', {
          storedConvFromSession,
          convId
        });
        const fresh = computeSessionId();
        apiEvents = [];
        apiMessagesCache = [];
        await chrome.storage.local.set({
          [STORAGE_KEYS.CURRENT_CONV_ID]: convId,
          [STORAGE_KEYS.CURRENT_SESSION_ID]: fresh,
          [STORAGE_KEYS.CURRENT_MESSAGES]: [],
          [STORAGE_KEYS.CURRENT_UPDATED_AT]: Date.now(),
          [STORAGE_KEYS.API_MESSAGES]: [],
          [STORAGE_KEYS.API_EVENTS]: []
        });
        await updateSessionsIndex(fresh);
        return fresh;
      }
    }

    // If we navigated to a different conversation, reset session + caches.
    if (currentConv && currentConv !== convId) {
      log('Conversation changed → resetting session', { from: currentConv, to: convId });
      const fresh = computeSessionId();
      apiEvents = [];
      apiMessagesCache = [];
      await chrome.storage.local.set({
        [STORAGE_KEYS.CURRENT_CONV_ID]: convId,
        [STORAGE_KEYS.CURRENT_SESSION_ID]: fresh,
        [STORAGE_KEYS.CURRENT_MESSAGES]: [],
        [STORAGE_KEYS.CURRENT_UPDATED_AT]: Date.now(),
        [STORAGE_KEYS.API_MESSAGES]: [],
        [STORAGE_KEYS.API_EVENTS]: []
      });
      await updateSessionsIndex(fresh);
      return fresh;
    }

    // First run: persist current conv id.
    if (!currentConv) {
      await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_CONV_ID]: convId });
    }

    const sessionId = computeSessionId();

    // If we previously stored an unknown conv id but now can detect one, upgrade session id.
    if (current && /^conv-unknown-/.test(current) && !/^conv-unknown-/.test(sessionId)) {
      await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_SESSION_ID]: sessionId });
      await updateSessionsIndex(sessionId);
      return sessionId;
    }

    if (current) return current;

    await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_SESSION_ID]: sessionId });
    await updateSessionsIndex(sessionId);
    return sessionId;
  }

  /**
   * Keep a short index of recent session ids (for cleanup).
   * @param {string} sessionId
   */
  async function updateSessionsIndex(sessionId) {
    try {
      const res = await chrome.storage.local.get([STORAGE_KEYS.SESSIONS_INDEX]);
      const list = Array.isArray(res[STORAGE_KEYS.SESSIONS_INDEX]) ? res[STORAGE_KEYS.SESSIONS_INDEX] : [];
      const next = [sessionId, ...list.filter((x) => x !== sessionId)].slice(0, MAX_SESSIONS_TO_KEEP);
      await chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS_INDEX]: next });
    } catch (e) {
      logError('Failed to update sessions index', e);
    }
  }

  /**
   * Extract message nodes in document order with role inference.
   * Prefer explicit per-message nodes (.font-user-message/.font-claude-message or [data-is-user-message]).
   * @returns {Array<{el: Element, role: 'user'|'assistant'|null}>}
   */
  function getMessageNodes() {
    const provider = getProvider();

    if (provider === 'chatgpt') {
      const nodes = Array.from(document.querySelectorAll(SELECTORS.CHATGPT_MESSAGE_NODES));
      return nodes.map((el) => ({ el, role: detectRole(el) }));
    }
    if (provider === 'gemini') {
      const nodes = Array.from(document.querySelectorAll(SELECTORS.GEMINI_LOOP));
      return nodes.map((el) => ({ el, role: detectRole(el) }));
    }

    // Best signal: actual message text nodes (not the whole container)
    const combined = Array.from(
      document.querySelectorAll(
        `${SELECTORS.CLAUDE_USER_MESSAGE}, ${SELECTORS.CLAUDE_ASSISTANT_MESSAGE}, ${SELECTORS.CLAUDE_ROLE_ATTR}`
      )
    );

    if (combined.length) {
      return combined.map((el) => ({ el, role: detectRole(el) }));
    }

    // Fallback: message containers
    const containers = Array.from(document.querySelectorAll(SELECTORS.CLAUDE_MESSAGE_CONTAINERS));
    if (containers.length) {
      // If containers exist but class/attr selectors didn't match, try to extract message-like descendants
      // from inside containers to avoid capturing the whole chat as a single "message".
      const inner = [];
      for (const c of containers) {
        const descendants = Array.from(
          c.querySelectorAll(
            `${SELECTORS.CLAUDE_USER_MESSAGE}, ${SELECTORS.CLAUDE_ASSISTANT_MESSAGE}, ${SELECTORS.CLAUDE_ROLE_ATTR}`
          )
        );
        if (descendants.length) inner.push(...descendants);
      }
      if (inner.length) {
        // Dedup while preserving order
        const seen = new Set();
        const uniq = inner.filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        });
        return uniq.map((el) => ({ el, role: detectRole(el) }));
      }

      return containers.map((el) => ({ el, role: detectRole(el) }));
    }

    // Last resort: streaming/complete nodes.
    const fallback = Array.from(document.querySelectorAll('[data-is-streaming], [data-is-complete]'));
    return fallback.map((el) => ({ el, role: detectRole(el) }));
  }

  /**
   * Extract plain text content from a message element.
   * @param {Element} el
   * @returns {string}
   */
  function extractText(el) {
    // Prefer innerText for line breaks; fallback to textContent.
    const txt = (el && (el.innerText || el.textContent) ? (el.innerText || el.textContent) : '') || '';
    return txt.replace(/\u00A0/g, ' ').trim();
  }

  /**
   * Determine role from element using known selectors + heuristics.
   * @param {Element} el
   * @returns {'user'|'assistant'|null}
   */
  function detectRole(el) {
    try {
      if (!el) return null;
      const provider = getProvider();

      if (provider === 'chatgpt') {
        const r = el.getAttribute && el.getAttribute('data-message-author-role');
        if (r === 'user') return 'user';
        if (r === 'assistant') return 'assistant';
      }
      if (provider === 'gemini') {
        // Use closest() so we can pass either container or descendants.
        if (el.closest?.(SELECTORS.GEMINI_USER_CONTAINER)) return 'user';
        if (el.closest?.(SELECTORS.GEMINI_ASSISTANT_CONTAINER)) return 'assistant';
      }

      const attr = el.getAttribute && el.getAttribute('data-is-user-message');
      if (attr === 'true') return 'user';
      if (attr === 'false') return 'assistant';

      // IMPORTANT: use matches() only to avoid misclassifying containers that contain both roles
      if (el.matches?.(SELECTORS.CLAUDE_USER_MESSAGE)) return 'user';
      if (el.matches?.(SELECTORS.CLAUDE_ASSISTANT_MESSAGE)) return 'assistant';

      // aria-label heuristic
      const aria = el.getAttribute?.('aria-label') || '';
      if (/user/i.test(aria)) return 'user';
      if (/assistant|claude/i.test(aria)) return 'assistant';

      // Heuristic: message containers often alternate; if unknown, infer from nearby known.
      return null;
    } catch (e) {
      logError('Failed to detect role', e);
      return null;
    }
  }

  /**
   * Parse a message element into the message format.
   * The id is assigned later based on index, to allow streaming updates.
   * @param {Element} el
   * @returns {{role: 'user'|'assistant', content: string}|null}
   */
  function parseMessageElement(el) {
    const provider = getProvider();

    if (provider === 'gemini') {
      // A. User messages
      if (el.matches?.(SELECTORS.GEMINI_USER_CONTAINER) || el.closest?.(SELECTORS.GEMINI_USER_CONTAINER)) {
        const container = el.matches?.(SELECTORS.GEMINI_USER_CONTAINER) ? el : el.closest?.(SELECTORS.GEMINI_USER_CONTAINER);
        const content = (
          container?.querySelector?.(SELECTORS.GEMINI_USER_TEXT)?.innerText ||
          container?.innerText ||
          el.innerText ||
          ''
        ).trim();
        if (!content) return null;
        if (isGeminiUiNoise(el, content)) return null;
        return { role: 'user', content };
      }

      // B. Assistant messages
      if (el.matches?.(SELECTORS.GEMINI_ASSISTANT_CONTAINER) || el.closest?.(SELECTORS.GEMINI_ASSISTANT_CONTAINER)) {
        const container = el.matches?.(SELECTORS.GEMINI_ASSISTANT_CONTAINER)
          ? el
          : el.closest?.(SELECTORS.GEMINI_ASSISTANT_CONTAINER);
        const md = container?.querySelector?.(SELECTORS.GEMINI_ASSISTANT_MARKDOWN);
        const node = md || container || el;
        const clone = node && node.cloneNode ? node.cloneNode(true) : null;
        const root = clone || node;
        if (!root) return null;

        try {
          root.querySelectorAll?.(SELECTORS.GEMINI_THOUGHT_DISCLOSURE).forEach((n) => n.remove());
          root.querySelectorAll?.('button,[role="button"]').forEach((n) => n.remove());
        } catch (_) {
          // ignore
        }

        const content = (root.innerText || root.textContent || '').trim();
        if (!content) return null;
        if (isGeminiUiNoise(el, content)) return null;
        return { role: 'assistant', content };
      }

      // Fallback (should be rare)
      const fallback = (el.innerText || el.textContent || '').trim();
      if (!fallback) return null;
      if (isGeminiUiNoise(el, fallback)) return null;
      return { role: null, content: fallback };
    }

    const content = extractText(el);
    if (!content) return null;

    const role = detectRole(el);
    if (role) return { role, content };

    // If we can't detect, keep content and let the caller infer role to avoid returning 0 messages.
    return { role: null, content };
  }

  /**
   * Cheap stable signature for de-dup (no crypto). Lowercase + first chars.
   * @param {string} role
   * @param {string} content
   * @returns {string}
   */
  function signature(role, content) {
    const c = (content || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return `${role || 'unknown'}|${c.slice(0, 300)}`;
  }

  /**
   * Best-effort update for streaming: if last message same role and content grows, update instead of adding.
   * @param {any[]} existing
   * @param {{role:string, content:string}} incoming
   * @returns {boolean} true if updated
   */
  function tryUpdateLastStreaming(existing, incoming) {
    if (!existing.length) return false;
    const last = existing[existing.length - 1];
    if (!last || !incoming || !incoming.role) return false;
    if (last.role !== incoming.role) return false;
    const prev = (last.content || '').trim();
    const next = (incoming.content || '').trim();
    if (!prev || !next) return false;
    // If content changed by extension (streaming), update last
    if (next.startsWith(prev) || prev.startsWith(next)) {
      last.content = next;
      last.captured_at = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Parse DOM on load.
   * @returns {Promise<void>}
   */
  async function extractExistingMessages() {
    await scanAndSyncMessages('initial');
  }

  /**
   * Sync messages from DOM into storage, keeping stable ids by index.
   * This approach handles assistant streaming: same index content updates → update record.
   * @param {string} reason
   */
  async function scanAndSyncMessages(reason, options = {}) {
    const sessionId = await ensureSessionId();
    const nodes = getMessageNodes();
    const parsed = [];
    let unknownCount = 0;
    for (const node of nodes) {
      const msg = parseMessageElement(node.el);
      if (!msg) continue;
      if (!msg.role) unknownCount++;
      parsed.push(msg);
    }

    if (!parsed.length) {
      log('No messages detected during scan', { reason });
      return;
    }

    // Infer roles for unknowns by looking at nearest known roles or alternating pattern.
    // This is intentionally simple to avoid breaking when Claude.ai DOM changes.
    let lastKnown = null;
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i].role) {
        lastKnown = parsed[i].role;
        continue;
      }
      if (lastKnown) {
        parsed[i].role = lastKnown === 'user' ? 'assistant' : 'user';
        lastKnown = parsed[i].role;
      } else {
        // Default first message to user.
        parsed[i].role = i % 2 === 0 ? 'user' : 'assistant';
        lastKnown = parsed[i].role;
      }
    }

    const stored = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
    const existing = Array.isArray(stored[STORAGE_KEYS.CURRENT_MESSAGES]) ? stored[STORAGE_KEYS.CURRENT_MESSAGES] : [];

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // Two modes:
    // - default: replace-like (good for normal chat pages)
    // - append: accumulate unique messages across scroll/virtualization (good for share pages)
    if (!options.append) {
      const next = [];
      for (let i = 0; i < parsed.length; i++) {
        const prev = existing[i];
        const p = parsed[i];
        const id = `msg-${i + 1}`;
        if (prev && prev.role === p.role) {
          // Update in place if content changed (streaming).
          if (prev.content !== p.content) {
            next.push({
              ...prev,
              content: p.content,
              captured_at: nowMs
            });
          } else {
            next.push(prev);
          }
        } else {
          next.push({
            id,
            role: p.role,
            content: p.content,
            timestamp: nowIso,
            session_id: sessionId,
            captured_at: nowMs
          });
        }
      }
      await saveToStorage(next);
      log('Messages synced', { reason, sessionId, total: next.length, unknownRolesInParse: unknownCount });
      return;
    }

    const seen = new Set(existing.map((m) => signature(m.role, m.content)));
    const next = [...existing];
    let added = 0;
    for (const p of parsed) {
      // Try streaming update before adding
      if (tryUpdateLastStreaming(next, p)) continue;

      const sig = signature(p.role, p.content);
      if (seen.has(sig)) continue;
      seen.add(sig);
      added++;
      next.push({
        id: `msg-${next.length + 1}`,
        role: p.role,
        content: p.content,
        timestamp: nowIso,
        session_id: sessionId,
        captured_at: nowMs
      });
    }

    await saveToStorage(next);
    log('Messages appended', { reason, sessionId, added, total: next.length, unknownRolesInParse: unknownCount });
  }

  /**
   * Deep capture for share pages / virtualized history: scroll and accumulate unique messages.
   * @returns {Promise<void>}
   */
  async function deepCaptureConversation() {
    const start = Date.now();
    const provider = getProvider();
    const scroller = getConversationScrollContainer(provider);
    const startY = scroller ? scroller.scrollTop : window.scrollY;
    let lastAdded = -1;
    let stableIters = 0;

    const maxY = () =>
      scroller
        ? Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const viewportH = () => (scroller ? scroller.clientHeight : window.innerHeight);
    const step = () => Math.max(200, Math.floor(viewportH() * DEEP_CAPTURE_STEP_RATIO));

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Go to top first (share pages are long)
    if (scroller) scroller.scrollTo(0, 0);
    else window.scrollTo(0, 0);
    await sleep(350);
    await scanAndSyncMessages('deep-top', { append: true });

    while (Date.now() - start < DEEP_CAPTURE_MAX_MS) {
      const y = scroller ? scroller.scrollTop : window.scrollY;
      const my = maxY();
      if (y >= my - 2) {
        stableIters++;
      }

      // Try scan at current position
      const before = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
      const prevLen = Array.isArray(before[STORAGE_KEYS.CURRENT_MESSAGES]) ? before[STORAGE_KEYS.CURRENT_MESSAGES].length : 0;

      await scanAndSyncMessages('deep-scan', { append: true });

      const after = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
      const nextLen = Array.isArray(after[STORAGE_KEYS.CURRENT_MESSAGES]) ? after[STORAGE_KEYS.CURRENT_MESSAGES].length : 0;
      const added = nextLen - prevLen;

      if (added === 0 && lastAdded === 0) stableIters++;
      else stableIters = 0;
      lastAdded = added;

      if (stableIters >= 3) break;

      const nextY = Math.min(my, y + step());
      if (nextY === y) {
        await sleep(250);
        continue;
      }
      if (scroller) scroller.scrollTo(0, nextY);
      else window.scrollTo(0, nextY);
      await sleep(300);
    }

    // Restore scroll position
    if (scroller) scroller.scrollTo(0, startY);
    else window.scrollTo(0, startY);
  }

  /**
   * Try to find the actual scroll container for the conversation.
   * Gemini frequently uses an internal overflow container; scrolling the window does nothing.
   * @param {'claude'|'chatgpt'|'gemini'|'unknown'} provider
   * @returns {HTMLElement|null}
   */
  function getConversationScrollContainer(provider) {
    try {
      // Preferred: pick a scroll container that actually contains message nodes.
      const best = findChatScrollContainer(provider);
      if (best) return best;

      // Fallback to document scrolling element if it actually scrolls.
      const se = document.scrollingElement;
      if (se && se instanceof HTMLElement && se.scrollHeight - se.clientHeight > 240) return se;
    } catch (_) {
      // ignore
    }
    return null;
  }

  function isScrollableEl(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const sh = el.scrollHeight || 0;
    const ch = el.clientHeight || 0;
    if (!sh || !ch) return false;
    if (sh - ch < 240) return false;
    const style = window.getComputedStyle(el);
    const oy = style && style.overflowY ? style.overflowY : '';
    // Some browsers report 'overlay' for scroll containers.
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  /**
   * Find a scrollable ancestor of a node (best signal for modern chat apps).
   * @param {Element|null} node
   * @returns {HTMLElement|null}
   */
  function findScrollableAncestor(node) {
    try {
      let el = node && node instanceof HTMLElement ? node : null;
      for (let i = 0; i < 30 && el; i++) {
        if (isScrollableEl(el)) return el;
        el = el.parentElement;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Find the best chat scroll container on the page.
   * Heuristic:
   * - Must be scrollable (overflowY auto/scroll) and have hidden content
   * - Must contain message-like descendants (provider selectors)
   * - Prefer the container with the highest score (messages * 1e6 + scrollHeight)
   * @returns {HTMLElement|null}
   */
  function findChatScrollContainer(provider) {
    try {
      const sel =
        provider === 'gemini'
          ? SELECTORS.GEMINI_LOOP
          : provider === 'chatgpt'
            ? SELECTORS.CHATGPT_MESSAGE_NODES
            : provider === 'claude'
              ? SELECTORS.CLAUDE_MESSAGE_CONTAINERS
              : null;

      // 1) Strongest signal: walk up from the first detected message node.
      if (sel) {
        const firstMsg = document.querySelector(sel);
        const anc = findScrollableAncestor(firstMsg);
        if (anc) return anc;
      }

      // 2) Fallback: scan many elements (not only divs) because frameworks often use custom tags.
      const nodes = document.querySelectorAll('*');
      let best = null;
      let bestScore = 0;
      let scanned = 0;

      for (const el of nodes) {
        scanned++;
        if (scanned > 6000) break;
        if (!(el instanceof HTMLElement)) continue;
        if (!isScrollableEl(el)) continue;

        let msgCount = 0;
        if (sel) {
          try {
            msgCount = el.querySelectorAll(sel).length;
          } catch (_) {
            msgCount = 0;
          }
        }

        // Prefer containers that actually include messages.
        // Weight messages heavily to avoid picking sidebars.
        const score = msgCount * 1_000_000 + sh;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }

      // If we couldn't find anything with messages, fall back to "largest scrollHeight" container.
      if (!best) {
        let fallback = null;
        let maxH = 0;
        scanned = 0;
        for (const el of nodes) {
          scanned++;
          if (scanned > 6000) break;
          if (!(el instanceof HTMLElement)) continue;
          if (!isScrollableEl(el)) continue;
          const sh = el.scrollHeight || 0;
          if (sh > maxH) {
            maxH = sh;
            fallback = el;
          }
        }
        return fallback;
      }

      return best;
    } catch (_) {
      return null;
    }
  }

  /**
   * Recursive hydration loop:
   * Some UIs only load earlier history when repeatedly scrolling to the top ("infinite scroll reverse").
   * We pump until scrollHeight stops increasing, then restore to bottom for stable rendering.
   * @param {HTMLElement|null} scroller
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async function hydrateChatHistory(scroller, reason = 'hydrate') {
    const start = Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitMs = DEEP_HYDRATE_WAIT_MS;
    const maxNoGrowth = 4;
    let noGrowth = 0;

    const getScrollHeight = () =>
      scroller ? Number(scroller.scrollHeight || 0) : Number(document.documentElement.scrollHeight || 0);
    const getScrollTop = () => (scroller ? Number(scroller.scrollTop || 0) : Number(window.scrollY || 0));
    const dispatchWheel = (target, deltaY) => {
      try {
        const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
      } catch (_) {
        // ignore
      }
    };

    const scrollUpPulse = () => {
      // More human-like: step upward a bit many times (triggers "reverse infinite scroll" reliably)
      const target = scroller || window;
      const getY = () => (scroller ? scroller.scrollTop : window.scrollY);
      const setY = (y) => {
        if (scroller) scroller.scrollTo(0, y);
        else window.scrollTo(0, y);
      };
      const viewportH = scroller ? scroller.clientHeight : window.innerHeight;
      const step = Math.max(220, Math.floor(viewportH * 0.6));

      for (let k = 0; k < 8; k++) {
        const y = getY();
        const nextY = Math.max(0, y - step);
        setY(nextY);
        dispatchWheel(target, -step);
      }
      // Ensure we actually touch the top boundary
      setY(0);
      dispatchWheel(target, -400);
    };
    const scrollToBottom = () => {
      if (scroller) scroller.scrollTo(0, scroller.scrollHeight || 0);
      else window.scrollTo(0, document.documentElement.scrollHeight || 0);
    };

    const getStoredCount = async () => {
      try {
        const res = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
        const msgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];
        return msgs.length;
      } catch (_) {
        return 0;
      }
    };

    let prevH = getScrollHeight();
    let prevChildCount = scroller ? scroller.childElementCount : document.documentElement.childElementCount;
    let prevMsgCount = await getStoredCount();
    log('Hydration start', {
      reason,
      provider: getProvider(),
      hasScroller: !!scroller,
      scrollerTag: scroller ? scroller.tagName : 'WINDOW',
      scrollerClass: scroller ? scroller.className : '',
      prevH,
      prevChildCount,
      prevMsgCount
    });

    while (Date.now() - start < DEEP_HYDRATE_MAX_MS && noGrowth < maxNoGrowth) {
      scrollUpPulse();
      // Wait for DOM mutation (better than fixed sleep). Fallback to timeout.
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            obs.disconnect();
          } catch (_) {}
          resolve();
        }, waitMs);

        const target = scroller || document.documentElement;
        let obs;
        try {
          obs = new MutationObserver(() => {
            clearTimeout(timeout);
            try {
              obs.disconnect();
            } catch (_) {}
            resolve();
          });
          obs.observe(target, { childList: true, subtree: true });
        } catch (_) {
          clearTimeout(timeout);
          resolve();
        }
      });

      await scanAndSyncMessages(`${reason}-top`, { append: true });

      const nextH = getScrollHeight();
      const nextChildCount = scroller ? scroller.childElementCount : document.documentElement.childElementCount;
      const nextMsgCountPromise = getStoredCount();
      const nextMsgCount = await nextMsgCountPromise;
      const grew = nextMsgCount > prevMsgCount || nextH > prevH + 50 || nextChildCount > prevChildCount;
      log('Hydration tick', {
        reason,
        scrollTop: getScrollTop(),
        prevH,
        nextH,
        prevChildCount,
        nextChildCount,
        prevMsgCount,
        nextMsgCount,
        grew,
        noGrowth
      });
      if (grew) {
        log('Hydration chunk loaded', {
          prevH,
          nextH,
          prevChildCount,
          nextChildCount,
          prevMsgCount,
          nextMsgCount
        });
        prevH = nextH;
        prevChildCount = nextChildCount;
        prevMsgCount = nextMsgCount;
        noGrowth = 0;
      } else {
        noGrowth++;
      }

      // If we're at top and not growing, we're probably fully hydrated.
      if (getScrollTop() <= 2 && noGrowth >= maxNoGrowth) break;
    }

    // Restore to bottom to ensure latest messages are rendered (some UIs virtualize the bottom too).
    scrollToBottom();
    await sleep(500);
    await scanAndSyncMessages(`${reason}-bottom`, { append: true });
    log('Hydration done', { reason, finalH: getScrollHeight(), finalMsgCount: await getStoredCount() });
  }

  /**
   * Deep capture for Gemini non-share pages:
   * Gemini often virtualizes history and loads older messages ONLY when scrolling up.
   * This routine scrolls upward in steps and appends newly discovered messages.
   * @returns {Promise<void>}
   */
  async function deepCaptureConversationUp() {
    const start = Date.now();
    const provider = getProvider();
    const scroller = getConversationScrollContainer(provider);
    const startY = scroller ? scroller.scrollTop : window.scrollY;
    let lastAdded = -1;
    let stableIters = 0;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const viewportH = () => (scroller ? scroller.clientHeight : window.innerHeight);
    const step = () => Math.max(240, Math.floor(viewportH() * DEEP_CAPTURE_STEP_RATIO));

    // Start from current position (often bottom) and walk upward.
    await scanAndSyncMessages('deep-up-start', { append: true });

    while (Date.now() - start < DEEP_CAPTURE_MAX_MS) {
      const y = scroller ? scroller.scrollTop : window.scrollY;
      if (y <= 2) {
        stableIters++;
      }

      const before = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
      const prevLen = Array.isArray(before[STORAGE_KEYS.CURRENT_MESSAGES]) ? before[STORAGE_KEYS.CURRENT_MESSAGES].length : 0;

      const nextY = Math.max(0, y - step());
      if (nextY !== y) {
        if (scroller) scroller.scrollTo(0, nextY);
        else window.scrollTo(0, nextY);
        await sleep(350);
      } else {
        await sleep(250);
      }

      await scanAndSyncMessages('deep-up-scan', { append: true });

      const after = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
      const nextLen = Array.isArray(after[STORAGE_KEYS.CURRENT_MESSAGES]) ? after[STORAGE_KEYS.CURRENT_MESSAGES].length : 0;
      const added = nextLen - prevLen;

      if (added === 0 && lastAdded === 0) stableIters++;
      else stableIters = 0;
      lastAdded = added;

      // If we're at the top and nothing new appears for a few scans, we're done.
      if (stableIters >= 3) break;
    }

    // Restore scroll position
    if (scroller) scroller.scrollTo(0, startY);
    else window.scrollTo(0, startY);
  }

  /**
   * Persist messages in chrome.storage.local and keep updated_at.
   * @param {Array<any>} messages
   */
  async function saveToStorage(messages) {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.CURRENT_MESSAGES]: messages,
        [STORAGE_KEYS.CURRENT_UPDATED_AT]: Date.now()
      });
    } catch (e) {
      const msg = `${e && e.message ? e.message : e}`;
      // Handle quota exceeded gracefully.
      if (/quota/i.test(msg)) {
        logError('Storage quota exceeded. Consider clearing old snapshots/messages.', e);
      } else {
        logError('Failed to save messages to storage', e);
      }
    }
  }

  /**
   * Watch for new messages in real-time (debounced full rescan).
   */
  function setupObserver() {
    if (observer) return;

    try {
      observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          scanAndSyncMessages('mutation').catch((e) => logError('scanAndSyncMessages failed', e));
        }, OBSERVER_DEBOUNCE_MS);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      log('MutationObserver enabled');
    } catch (e) {
      logError('Failed to setup MutationObserver', e);
    }
  }

  /**
   * Message handler for popup -> content script communication.
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      if (!request || !request.action) return;
      if (request.action === 'ping') {
        sendResponse({
          ok: true,
          provider: getProvider(),
          pathname: window.location.pathname || ''
        });
        return false;
      }
      if (request.action === 'getMessages') {
        const isShare = window.location.pathname.startsWith('/share/');
        const wantsDeep = !!request.deep;
        const provider = getProvider();

        // Share pages: fetch the same API endpoint the page uses (most reliable).
        // IMPORTANT: do NOT rely on chrome.storage for full share history (quota). Return messages directly.
        if (isShare) {
          const shareId = (window.location.pathname.split('/')[2] || '').trim();
          // ChatGPT share pages: we don't have stable public JSON endpoints here; rely on DOM deep capture.
          if (provider === 'chatgpt') {
            (async () => {
              try {
                const hasApi = Array.isArray(apiMessagesCache) && apiMessagesCache.length > 0;
                const sessionId = await ensureSessionId();

                // Fast path: if we don't need deep capture, return API cache immediately (best signal).
                if (hasApi && !wantsDeep) {
                  log('ChatGPT share detected → using API cache (fast)', { shareId, messages: apiMessagesCache.length });
                  sendResponse({
                    ok: true,
                    session_id: sessionId,
                    messages: apiMessagesCache.map((m) => ({ ...m, session_id: sessionId }))
                  });
                  return;
                }

                // Deep capture (scroll) then merge API + DOM to maximize full history fidelity.
                log('ChatGPT share detected → capturing (deep merge)', { shareId, hasApi, wantsDeep });
                if (wantsDeep) await deepCaptureConversation();
                else await scanAndSyncMessages('share-dom');
                const res = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES, STORAGE_KEYS.CURRENT_SESSION_ID]);
                const domMsgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];
                if (!domMsgs.length && !hasApi) {
                  sendResponse({
                    ok: false,
                    error: {
                      type: 'error',
                      code: 'SHARE_DOM_EMPTY',
                      message: 'No messages detected on ChatGPT share page.',
                      recovery: 'Scroll the page to load more messages, then retry.'
                    }
                  });
                  return;
                }

                // Merge API + DOM, de-dup by signature, keep stable sequential ids
                const merged = [];
                const seen = new Set();
                const push = (m) => {
                  if (!m || !m.role || !m.content) return;
                  const sig = signature(m.role, m.content);
                  if (seen.has(sig)) return;
                  seen.add(sig);
                  merged.push(m);
                };
                if (hasApi) {
                  for (const m of apiMessagesCache) push(m);
                }
                for (const m of domMsgs) push(m);

                const out = merged.map((m, idx) => ({
                  ...m,
                  id: `msg-${idx + 1}`,
                  session_id: sessionId
                }));
                apiMessagesCache = out;

                sendResponse({
                  ok: true,
                  session_id: sessionId,
                  messages: out
                });
              } catch (e) {
                logError('ChatGPT share DOM capture failed', e);
                sendResponse({
                  ok: false,
                  error: {
                    type: 'error',
                    code: 'SHARE_DOM_FAILED',
                    message: 'Failed to capture messages from ChatGPT share page.',
                    recovery: 'Reload the page and try again.'
                  }
                });
              }
            })();
            return true;
          }

          // Gemini/Bard share pages: prefer API cache, else deep DOM capture, then merge.
          if (provider === 'gemini') {
            (async () => {
              try {
                const hasApi = Array.isArray(apiMessagesCache) && apiMessagesCache.length > 0;
                const sessionId = await ensureSessionId();

                // Fast path: if we don't need deep capture, return API cache immediately (best signal).
                if (hasApi && !wantsDeep) {
                  log('Gemini share detected → using API cache (fast)', { shareId, messages: apiMessagesCache.length });
                  sendResponse({
                    ok: true,
                    session_id: sessionId,
                    messages: apiMessagesCache.map((m) => ({ ...m, session_id: sessionId }))
                  });
                  return;
                }

                // Deep capture (scroll) then merge API + DOM to maximize full history fidelity.
                log('Gemini share detected → capturing (deep merge)', { shareId, hasApi, wantsDeep });
                if (wantsDeep) await deepCaptureConversation();
                else await scanAndSyncMessages('share-dom');

                const res = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES, STORAGE_KEYS.CURRENT_SESSION_ID]);
                const domMsgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];

                if (!domMsgs.length && !hasApi) {
                  sendResponse({
                    ok: false,
                    error: {
                      type: 'error',
                      code: 'GEMINI_SHARE_EMPTY',
                      message: 'No messages detected on Gemini share page.',
                      recovery: 'Scroll the page to load more messages, then retry.'
                    }
                  });
                  return;
                }

                // Merge API + DOM, de-dup by signature, keep stable sequential ids
                const merged = [];
                const seen = new Set();
                const push = (m) => {
                  if (!m || !m.role || !m.content) return;
                  const sig = signature(m.role, m.content);
                  if (seen.has(sig)) return;
                  seen.add(sig);
                  merged.push(m);
                };
                if (hasApi) {
                  for (const m of apiMessagesCache) push(m);
                }
                for (const m of domMsgs) push(m);

                const out = merged.map((m, idx) => ({
                  ...m,
                  id: `msg-${idx + 1}`,
                  session_id: sessionId
                }));
                apiMessagesCache = out;

                sendResponse({
                  ok: true,
                  session_id: sessionId,
                  messages: out
                });
              } catch (e) {
                logError('Gemini share capture failed', e);
                sendResponse({
                  ok: false,
                  error: {
                    type: 'error',
                    code: 'GEMINI_SHARE_FAILED',
                    message: 'Failed to capture messages from Gemini share page.',
                    recovery: 'Reload the page and try again.'
                  }
                });
              }
            })();
            return true;
          }

          log('Share page detected, fetching snapshot', { shareId, pathname: window.location.pathname, provider });
          
          fetchShareSnapshotMessages(shareId)
            .then(async (messages) => {
              const sessionId = await ensureSessionId();
              log('Share snapshot fetch completed', { 
                messagesCount: messages ? messages.length : 0,
                sessionId 
              });
              
              if (!messages || !messages.length) {
                // Fallback: deep DOM capture if requested (CTA uses deep:true)
                if (wantsDeep) {
                  log('Share API empty → attempting deep DOM capture fallback');
                  try {
                    await deepCaptureConversation();
                    const res = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES, STORAGE_KEYS.CURRENT_SESSION_ID]);
                    const domMsgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];
                    if (domMsgs.length) {
                      log('Deep DOM fallback succeeded on share page', { count: domMsgs.length });
                      sendResponse({
                        ok: true,
                        session_id: res[STORAGE_KEYS.CURRENT_SESSION_ID] || sessionId,
                        messages: domMsgs
                      });
                      return;
                    }
                  } catch (e) {
                    logError('Deep DOM fallback failed on share page', e);
                  }
                }

                logError('Share snapshot empty (API + fallback)', { shareId });
                sendResponse({
                  ok: false,
                  error: {
                    type: 'error',
                    code: 'SHARE_SNAPSHOT_EMPTY',
                    message: 'Share snapshot fetched but no messages were extracted.',
                    recovery: 'Reload the /share/ page and try again. The share format may have changed.'
                  }
                });
                return;
              }
              
              log('Sending share messages to popup', { count: messages.length });
              sendResponse({
                ok: true,
                session_id: sessionId,
                messages
              });
            })
            .catch((e) => {
              logError('Share capture failed', { error: e, shareId, stack: e.stack });
              // Fallback: deep DOM capture if requested
              if (wantsDeep) {
                (async () => {
                  try {
                    log('Share API fetch failed → attempting deep DOM capture fallback');
                    await deepCaptureConversation();
                    const res = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES, STORAGE_KEYS.CURRENT_SESSION_ID]);
                    const domMsgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];
                    if (domMsgs.length) {
                      log('Deep DOM fallback succeeded after API failure', { count: domMsgs.length });
                      sendResponse({
                        ok: true,
                        session_id: res[STORAGE_KEYS.CURRENT_SESSION_ID] || (await ensureSessionId()),
                        messages: domMsgs
                      });
                      return;
                    }
                  } catch (e2) {
                    logError('Deep DOM fallback failed after API failure', e2);
                  }

                  sendResponse({
                    ok: false,
                    error: {
                      type: 'error',
                      code: 'SHARE_SNAPSHOT_FETCH_FAILED',
                      message: `Failed to fetch share snapshot messages: ${e.message || 'Unknown error'}`,
                      recovery: 'Reload the /share/ page and try again.'
                    }
                  });
                })();
                return;
              }

              sendResponse({
                ok: false,
                error: {
                  type: 'error',
                  code: 'SHARE_SNAPSHOT_FETCH_FAILED',
                  message: `Failed to fetch share snapshot messages: ${e.message || 'Unknown error'}`,
                  recovery: 'Reload the /share/ page and try again.'
                }
              });
            });
          return true;
        }

        // Non-share pages: optionally deep capture (scroll) or normal scan (uses storage + interceptor cache).
        const capturePromise = wantsDeep
          ? (async () => {
              // Hydrate first for reverse infinite scroll UIs (Gemini + ChatGPT).
              const scroller = getConversationScrollContainer(provider);
              if (provider === 'gemini' || provider === 'chatgpt') {
                await hydrateChatHistory(scroller, 'hydrate');
              }
              // Then do a full pass capture (top -> bottom) to accumulate DOM-virtualized slices.
              await deepCaptureConversation();
            })()
          : scanAndSyncMessages('getMessages');

        capturePromise
          .catch((e) => logError('On-demand scan failed', e))
          .then(() => chrome.storage.local.get([STORAGE_KEYS.CURRENT_SESSION_ID, STORAGE_KEYS.CURRENT_MESSAGES]))
          .then((res) => {
            // Prefer in-memory API-derived messages if richer than DOM capture
            const domMsgs = Array.isArray(res[STORAGE_KEYS.CURRENT_MESSAGES]) ? res[STORAGE_KEYS.CURRENT_MESSAGES] : [];
            const apiMsgs = Array.isArray(apiMessagesCache) ? apiMessagesCache : [];
            const messages = apiMsgs.length >= domMsgs.length ? apiMsgs : domMsgs;
            sendResponse({
              ok: true,
              session_id: res[STORAGE_KEYS.CURRENT_SESSION_ID] || null,
              messages
            });
          })
          .catch((e) => {
            sendResponse({
              ok: false,
              error: {
                type: 'error',
                code: 'STORAGE_READ_FAILED',
                message: 'Could not read messages from storage.',
                recovery: 'Reload Claude.ai and try again.'
              }
            });
            logError('Failed to read messages from storage', e);
          });
        return true; // async response
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: {
          type: 'error',
          code: 'CONTENT_SCRIPT_ERROR',
          message: 'Unexpected error in content script.',
          recovery: 'Reload Claude.ai and try again.'
        }
      });
      logError('onMessage handler error', e);
      return false;
    }
  });

  // Boot
  injectApiInterceptor();
  installRouteChangeWatcher();
  ensureSessionId()
    .then(() => extractExistingMessages())
    .then(() => setupObserver())
    .catch((e) => {
      logError('Initialization failed', e);
      // Debug helper if DOM changed significantly.
      try {
        log('DOM structure (first 500 chars):', document.body.innerHTML.substring(0, 500));
      } catch (_) {
        // ignore
      }
    });
})();


