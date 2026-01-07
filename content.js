/* global chrome */

(() => {
  const LOG_PREFIX = '[RL4]';
  // Tell the background worker which provider tab we are (so RL4 UI can target the right page even
  // when opened in a detached window).
  try {
    chrome.runtime.sendMessage({ action: 'rl4_supported_tab_ping', url: location.href }, () => {});
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ action: 'rl4_supported_tab_ping', url: location.href }, () => {});
      } catch (_) {}
    }, 1500);
  } catch (_) {}
  const STORAGE_KEYS = {
    CURRENT_SESSION_ID: 'rl4_current_session_id',
    CURRENT_CONV_ID: 'rl4_current_conv_id',
    CURRENT_MESSAGES: 'rl4_current_messages',
    CURRENT_UPDATED_AT: 'rl4_current_updated_at',
    SESSIONS_INDEX: 'rl4_sessions_index',
    API_MESSAGES: 'rl4_api_messages',
    API_EVENTS: 'rl4_api_events',
    CAPTURE_PROGRESS: 'rl4_capture_progress_v1',
    LAST_SNAPSHOT: 'rl4_last_snapshot_v1',
    // RL4 Blocks Encoder capture (semi-assisted workflow)
    RL4_BLOCKS: 'rl4_blocks_v1',
    RL4_BLOCKS_STATUS: 'rl4_blocks_status_v1'
  };

  const SELECTORS = {
    // Claude
    CLAUDE_MESSAGE_CONTAINERS: '[data-testid*="message"]',
    CLAUDE_USER_MESSAGE: '.font-user-message',
    CLAUDE_ASSISTANT_MESSAGE: '.font-claude-message',
    CLAUDE_ROLE_ATTR: '[data-is-user-message]',
    // ChatGPT
    // ChatGPT UI variants:
    // - Modern: elements with data-message-author-role
    // - Some variants wrap turns in <article data-testid="conversation-turn-*">
    CHATGPT_MESSAGE_NODES: '[data-message-author-role], article[data-testid^="conversation-turn-"]',
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
  const MAX_API_CACHE_MESSAGES = 50_000; // fidelity-first: allow very large chats (guarded below)
  const MAX_API_CACHE_TOTAL_CHARS = 12_000_000; // stop accumulating beyond ~12MB of message text
  const MAX_SINGLE_MESSAGE_CHARS = 30_000; // per-message cap to avoid runaway memory

  let observer = null;
  let debounceTimer = null;
  let apiEvents = [];
  let apiMessagesCache = [];
  let lastPathname = null;
  let deepCaptureInProgress = false;
  let captureIdActive = null;
  let chatgptChunkSeen = new Set();
  let lastProgressWriteAt = 0;
  let snapshotJobRunning = false;
  let jobTabId = null;
  let jobStrategy = null; // 'chatgpt_surgical' | 'dom'
  let progressHeartbeatTimer = null;
  let inpageUiMounted = false;
  let inpageUiOpen = false;

  function startProgressHeartbeat() {
    stopProgressHeartbeat();
    progressHeartbeatTimer = setInterval(() => {
      // Keep CAPTURE_PROGRESS.updatedAt moving even if the UI isn't adding messages every tick.
      if (!captureIdActive) return;
      setCaptureProgress({}).catch(() => {});
    }, 2000);
  }

  function stopProgressHeartbeat() {
    if (progressHeartbeatTimer) clearInterval(progressHeartbeatTimer);
    progressHeartbeatTimer = null;
  }

  function mountInpageWidget() {
    try {
      if (inpageUiMounted) return;
      if (!document || !document.documentElement) return;

      const root = document.createElement('div');
      root.id = 'rl4-inpage-root';
      root.style.position = 'fixed';
      root.style.right = '16px';
      root.style.bottom = '16px';
      root.style.zIndex = '2147483647';
      root.style.fontFamily =
        'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

      const launcher = document.createElement('button');
      launcher.type = 'button';
      launcher.setAttribute('aria-label', 'Open RL4');
      launcher.style.all = 'unset';
      launcher.style.cursor = 'pointer';
      launcher.style.width = '48px';
      launcher.style.height = '48px';
      launcher.style.borderRadius = '999px';
      launcher.style.display = 'grid';
      launcher.style.placeItems = 'center';
      // Match popup branding: full round background in #F2E7E5.
      // Use setProperty(..., 'important') to resist aggressive host page CSS.
      launcher.style.setProperty('background', '#F2E7E5', 'important');
      launcher.style.setProperty('background-color', '#F2E7E5', 'important');
      launcher.style.backdropFilter = 'blur(10px)';
      launcher.style.boxShadow =
        '0 10px 30px rgba(0,0,0,.25), 0 0 0 1px rgba(15,23,42,.10), 0 0 28px rgba(99,102,241,.22)';
      launcher.style.border = '1px solid rgba(15,23,42,.10)';
      launcher.style.userSelect = 'none';
      launcher.style.transition = 'transform .12s ease, box-shadow .2s ease';

      // Subtle glow / pulse to make it feel "alive" (CSM-style).
      const styleId = 'rl4-inpage-style';
      if (!document.getElementById(styleId)) {
        const st = document.createElement('style');
        st.id = styleId;
        st.textContent =
          '@keyframes rl4Pulse{0%{box-shadow:0 10px 30px rgba(0,0,0,.25),0 0 0 1px rgba(15,23,42,.10),0 0 22px rgba(99,102,241,.20)}50%{box-shadow:0 10px 30px rgba(0,0,0,.25),0 0 0 1px rgba(15,23,42,.12),0 0 34px rgba(99,102,241,.38)}100%{box-shadow:0 10px 30px rgba(0,0,0,.25),0 0 0 1px rgba(15,23,42,.10),0 0 22px rgba(99,102,241,.20)}}';
        document.documentElement.appendChild(st);
      }
      launcher.style.animation = 'rl4Pulse 2.2s ease-in-out infinite';

      // Wrap the logo to protect it from host page CSS (some sites apply aggressive img rules).
      const iconWrap = document.createElement('div');
      iconWrap.style.width = '30px';
      iconWrap.style.height = '30px';
      iconWrap.style.display = 'grid';
      iconWrap.style.placeItems = 'center';
      iconWrap.style.borderRadius = '8px';
      iconWrap.style.overflow = 'hidden';

      const img = document.createElement('img');
      img.alt = 'RL4';
      const rawIconUrl = chrome.runtime.getURL('assets/rl4-launcher.png');
      img.src = rawIconUrl;
      // Force square box + keep aspect ratio (prevents "squashed" rendering).
      img.style.setProperty('width', '30px', 'important');
      img.style.setProperty('height', '30px', 'important');
      img.style.setProperty('object-fit', 'contain', 'important');
      img.style.setProperty('object-position', 'center', 'important');
      img.style.setProperty('display', 'block', 'important');
      img.style.setProperty('max-width', '30px', 'important');
      img.style.setProperty('max-height', '30px', 'important');
      img.style.setProperty('background', 'transparent', 'important');

      iconWrap.appendChild(img);
      launcher.appendChild(iconWrap);

      const panel = document.createElement('div');
      panel.id = 'rl4-inpage-panel';
      panel.style.position = 'fixed';
      panel.style.right = '16px';
      panel.style.bottom = '76px';
      panel.style.width = '420px';
      panel.style.height = '720px';
      panel.style.maxWidth = 'min(92vw, 520px)';
      panel.style.maxHeight = 'min(88vh, 820px)';
      panel.style.background = 'transparent';
      panel.style.borderRadius = '16px';
      panel.style.overflow = 'hidden';
      panel.style.boxShadow = '0 20px 60px rgba(0,0,0,.30)';
      panel.style.display = 'none';

      const iframe = document.createElement('iframe');
      iframe.title = 'RL4';
      iframe.src = chrome.runtime.getURL('popup.html');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.borderRadius = '16px';
      iframe.setAttribute('allow', 'clipboard-write');
      panel.appendChild(iframe);

      const setOpen = (open) => {
        inpageUiOpen = !!open;
        panel.style.display = inpageUiOpen ? 'block' : 'none';
      };

      launcher.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!inpageUiOpen);
      });
      launcher.addEventListener('mouseenter', () => {
        launcher.style.transform = 'translateY(-1px) scale(1.03)';
        launcher.style.boxShadow =
          '0 14px 36px rgba(0,0,0,.28), 0 0 0 1px rgba(15,23,42,.12), 0 0 38px rgba(99,102,241,.42)';
      });
      launcher.addEventListener('mouseleave', () => {
        launcher.style.transform = 'none';
        launcher.style.boxShadow =
          '0 10px 30px rgba(0,0,0,.25), 0 0 0 1px rgba(15,23,42,.10), 0 0 28px rgba(99,102,241,.22)';
      });

      root.appendChild(panel);
      root.appendChild(launcher);
      document.documentElement.appendChild(root);
      inpageUiMounted = true;
      inpageUiOpen = false;
    } catch (_) {
      // ignore
    }
  }

  function openInpagePanel() {
    mountInpageWidget();
    try {
      const panel = document.getElementById('rl4-inpage-panel');
      if (panel) panel.style.display = 'block';
      inpageUiOpen = true;
    } catch (_) {}
  }

  // --- RL4 Blocks capture (semi-assisted, cross-LLM safe) ---
  let rl4BlocksArmed = false;
  let rl4BlocksCaptured = false;
  let lastRl4BlocksScanAt = 0;

  async function setCaptureProgress(patch) {
    try {
      const prevRes = await chrome.storage.local.get([STORAGE_KEYS.CAPTURE_PROGRESS]);
      const prev = prevRes && prevRes[STORAGE_KEYS.CAPTURE_PROGRESS] && typeof prevRes[STORAGE_KEYS.CAPTURE_PROGRESS] === 'object'
        ? prevRes[STORAGE_KEYS.CAPTURE_PROGRESS]
        : {};
      const next = {
        ...prev,
        ...patch,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.CAPTURE_PROGRESS]: next });
    } catch (_) {
      // ignore
    }
  }

  async function emitCaptureProgress(patch, force = false) {
    const now = Date.now();
    if (!force && now - lastProgressWriteAt < 250) return;
    lastProgressWriteAt = now;
    await setCaptureProgress(patch);
  }

  async function clearCaptureProgress() {
    try {
      await chrome.storage.local.remove([STORAGE_KEYS.CAPTURE_PROGRESS]);
    } catch (_) {
      // ignore
    }
  }

  async function saveLastSnapshot(snapshot) {
    try {
      if (!snapshot || typeof snapshot !== 'object') return;
      // Avoid storing huge payloads (e.g., full transcripts on big chats)
      const s = JSON.stringify(snapshot);
      if (s.length > 1_500_000) return;
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SNAPSHOT]: snapshot });
    } catch (_) {
      // ignore
    }
  }

  // --- Device-only tamper seal (copied from popup.js to allow background jobs) ---
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function sha256HexBytes(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const arr = Array.from(new Uint8Array(hash));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function openKeyDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('rl4_device_keys', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
  }

  async function idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
    });
  }

  async function idbPut(db, storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));
    });
  }

  async function getOrCreateDeviceSigningKey() {
    const db = await openKeyDb();
    const rec = await idbGet(db, 'keys', 'device_signing_v1');
    if (rec && rec.privateKey && rec.keyId && rec.publicKeySpkiB64) {
      return { privateKey: rec.privateKey, keyId: rec.keyId, publicKeySpkiB64: rec.publicKeySpkiB64 };
    }

    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    let publicKeySpkiB64 = '';
    let keyId = 'unknown';
    try {
      const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
      publicKeySpkiB64 = arrayBufferToBase64(spki);
      keyId = await sha256HexBytes(new Uint8Array(spki));
    } catch (_) {
      // ignore
    }
    await idbPut(db, 'keys', { id: 'device_signing_v1', privateKey: kp.privateKey, keyId, publicKeySpkiB64 });
    return { privateKey: kp.privateKey, keyId, publicKeySpkiB64 };
  }

  async function signChecksumDeviceOnly(checksumHex) {
    const checksum = String(checksumHex || '').trim();
    if (!checksum) throw new Error('Missing checksum for signature.');
    const { privateKey, keyId, publicKeySpkiB64 } = await getOrCreateDeviceSigningKey();
    const payload = `checksum:${checksum}`;
    const data = new TextEncoder().encode(payload);
    const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    const sigB64 = arrayBufferToBase64(sigBuf);
    return {
      type: 'device_integrity_v1',
      algo: 'ECDSA_P256_SHA256',
      key_id: keyId,
      public_key_spki: publicKeySpkiB64,
      signed_payload: payload,
      value: sigB64
    };
  }

  async function runSnapshotJob(options) {
    const provider = getProvider();
    const outputMode = options && typeof options.outputMode === 'string' ? options.outputMode : 'digest';
    const wantsSeal = !!(options && options.wantsIntegritySeal);

    // Guardrail: never include transcript in ultra modes, and auto-disable for huge chats.
    let includeTranscript = !!(options && options.includeTranscript);
    if (outputMode === 'ultra' || outputMode === 'ultra_plus') includeTranscript = false;

    snapshotJobRunning = true;
    startProgressHeartbeat();
    try {
      await emitCaptureProgress(
        { captureId: captureIdActive, tabId: jobTabId, provider, phase: 'starting', status: 'starting', startedAt: Date.now() },
        true
      );

      // Capture messages (same logic as getMessages deep capture, but decoupled from popup)
      deepCaptureInProgress = true;
      try {
        if (provider === 'chatgpt') {
          // Prefer Surgical Fetch for XXL chats: fastest + returns exact total for % progress.
          const convId = getConversationIdFromUrl();
          const surgical = await tryFetchChatGPTConversation(convId);
          if (surgical && surgical.length) {
            jobStrategy = 'chatgpt_surgical';
            await emitCaptureProgress(
              {
                captureId: captureIdActive,
                tabId: jobTabId,
                provider,
                strategy: jobStrategy,
                phase: 'fetch',
                phaseIndex: 1,
                phaseTotal: 2,
                status: 'capturing',
                receivedMessages: surgical.length,
                totalMessages: surgical.length
              },
              true
            );
            log('ChatGPT: using surgical fetch path', { messages: surgical.length });
          } else {
            // Fallbacks: embedded state + page-context request
            jobStrategy = 'dom';
          const embedded = await tryExtractChatGPTEmbeddedState();
          if (!embedded || !embedded.length) {
            await requestChatGPTConversationViaPageContext(convId);
            const started = Date.now();
            const before = Array.isArray(apiMessagesCache) ? apiMessagesCache.length : 0;
            while (Date.now() - started < 12000) {
              const nowLen = Array.isArray(apiMessagesCache) ? apiMessagesCache.length : 0;
              if (nowLen > before + 50) break;
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          }
        } else {
          jobStrategy = 'dom';
        }

        // Hydrate virtualized UIs for Gemini + ChatGPT (and still safe for others)
        const scroller = getConversationScrollContainer(provider);
        if (jobStrategy !== 'chatgpt_surgical') {
          if (provider === 'gemini' || provider === 'chatgpt') {
            // Phase 1/3 (DOM strategy): hydrate
            await emitCaptureProgress(
              {
                captureId: captureIdActive,
                tabId: jobTabId,
                provider,
                strategy: jobStrategy,
                phase: 'hydrate',
                phaseIndex: 1,
                phaseTotal: 3,
                status: 'capturing'
              },
              true
            );
            await hydrateChatHistory(scroller, 'hydrate');
          }

          // Phase 2/3 (DOM strategy): scan (scroll + accumulate)
          await emitCaptureProgress(
            {
              captureId: captureIdActive,
              tabId: jobTabId,
              provider,
              strategy: jobStrategy,
              phase: 'scan',
              phaseIndex: 2,
              phaseTotal: 3,
              status: 'capturing'
            },
            true
          );
          await deepCaptureConversation();
        }

      } finally {
        deepCaptureInProgress = false;
      }

      // Pick best message source
      const stored = await chrome.storage.local.get([STORAGE_KEYS.CURRENT_MESSAGES]);
      const domMsgs = Array.isArray(stored[STORAGE_KEYS.CURRENT_MESSAGES]) ? stored[STORAGE_KEYS.CURRENT_MESSAGES] : [];
      const apiMsgs = Array.isArray(apiMessagesCache) ? apiMessagesCache : [];
      const messages = apiMsgs.length >= domMsgs.length ? apiMsgs : domMsgs;

      // Auto-disable transcript for huge captures
      try {
        const approxChars = messages.reduce((acc, m) => acc + (m && m.content ? String(m.content).length : 0), 0);
        if (messages.length > 1500 || approxChars > 1_200_000) includeTranscript = false;
      } catch (_) {
        includeTranscript = false;
      }

      const phaseTotal = jobStrategy === 'chatgpt_surgical' ? 2 : 3;
      const phaseIndex = jobStrategy === 'chatgpt_surgical' ? 2 : 3;
      await emitCaptureProgress(
        {
          captureId: captureIdActive,
          tabId: jobTabId,
          provider,
          strategy: jobStrategy,
          phase: 'snapshot',
          phaseIndex,
          phaseTotal,
          status: 'generating',
          receivedMessages: messages.length
        },
        true
      );

      if (typeof RL4SnapshotGenerator !== 'function') {
        throw new Error('Snapshot generator not available in content script. Reload extension.');
      }
      const generator = new RL4SnapshotGenerator(messages, {}, { includeTranscript, outputMode });
      const snapshot = await generator.generate();
      // Attach capture provenance (debug/UX; does not change semantic content)
      if (!snapshot.metadata || typeof snapshot.metadata !== 'object') snapshot.metadata = {};
      snapshot.metadata.capture_provider = provider;
      snapshot.metadata.capture_strategy = jobStrategy || 'unknown';
      snapshot.checksum = await calculateChecksum(snapshot);
      if (wantsSeal) snapshot.signature = await signChecksumDeviceOnly(snapshot.checksum);

      await saveLastSnapshot(snapshot);
      await emitCaptureProgress(
        {
          captureId: captureIdActive,
          tabId: jobTabId,
          provider,
          strategy: jobStrategy,
          phase: 'done',
          status: 'done',
          totalMessages: messages.length,
          receivedMessages: messages.length,
          completedAt: Date.now()
        },
        true
      );
      log('Snapshot job done', { provider, messages: messages.length, outputMode });
    } catch (e) {
      await emitCaptureProgress(
        {
          captureId: captureIdActive,
          tabId: jobTabId,
          provider: getProvider(),
          strategy: jobStrategy,
          phase: 'error',
          status: 'error',
          error: String(e && e.message ? e.message : e)
        },
        true
      );
      logError('Snapshot job failed', e);
    } finally {
      snapshotJobRunning = false;
      stopProgressHeartbeat();
    }
  }

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
    const m = String(err && err.message ? err.message : err || '');
    // Expected during dev reload/update: old content-script contexts can throw on any chrome.* call.
    if (/Extension context invalidated/i.test(m)) return;
    console.error(LOG_PREFIX, msg, err);
  }

  let rl4ContextInvalidated = false;
  function isExtensionContextAlive() {
    try {
      if (rl4ContextInvalidated) return false;
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return false;
      if (!chrome.storage || !chrome.storage.local) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function softShutdown(reason) {
    try {
      rl4ContextInvalidated = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (observer) observer.disconnect();
      observer = null;
      if (progressHeartbeatTimer) clearInterval(progressHeartbeatTimer);
      progressHeartbeatTimer = null;
      log('Soft shutdown', { reason });
    } catch (_) {
      // ignore
    }
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
          if (!isExtensionContextAlive()) return;
          const p = window.location.pathname || '';
          if (p === lastPathname) return;
          const prev = lastPathname;
          lastPathname = p;
          log('Route changed', { reason, from: prev, to: p });
          await ensureSessionId(); // will reset if conv changed
          await scanAndSyncMessages('route-change');
        } catch (e) {
          const m = String(e && e.message ? e.message : e || '');
          if (/Extension context invalidated/i.test(m)) {
            softShutdown('context_invalidated_route');
            return;
          }
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
        return content.parts
          .map((p) => {
            if (typeof p === 'string') return p;
            // Some ChatGPT payloads include structured parts: { type:'text', text:'...' } / { text:'...' }
            if (p && typeof p === 'object') {
              if (typeof p.text === 'string') return p.text;
              if (p.type === 'text' && typeof p.text === 'string') return p.text;
              if (typeof p.content === 'string') return p.content;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      // Sometimes nested: { content: { parts: [...] } }
      if (content.content && typeof content.content === 'object' && Array.isArray(content.content.parts)) {
        return content.content.parts
          .map((p) => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object') {
              if (typeof p.text === 'string') return p.text;
              if (p.type === 'text' && typeof p.text === 'string') return p.text;
              if (typeof p.content === 'string') return p.content;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
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
          const sig = signature(role, content);
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
      const sig = signature(role, String(content));
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

    // ChatGPT full conversation format: { mapping: { nodeId: { parent, message } }, current_node: "<nodeId>" }
    // IMPORTANT: mapping is a graph. The "real conversation" is the path root -> current_node (not Object.values(mapping)).
    if (root && typeof root === 'object' && root.mapping && typeof root.mapping === 'object') {
      try {
        const mapping = root.mapping;
        const currentNode =
          (typeof root.current_node === 'string' && root.current_node) ||
          (typeof root.currentNode === 'string' && root.currentNode) ||
          '';

        const chainIds = [];
        if (currentNode && mapping[currentNode]) {
          let cur = currentNode;
          const guard = new Set();
          while (cur && mapping[cur] && !guard.has(cur) && chainIds.length < 100_000) {
            guard.add(cur);
            chainIds.push(cur);
            cur = mapping[cur] && typeof mapping[cur] === 'object' ? mapping[cur].parent : null;
          }
          chainIds.reverse();
        }

        const extracted = [];
        const idsToUse = chainIds.length ? chainIds : Object.keys(mapping);
        for (const id of idsToUse) {
          const node = mapping[id];
          const msg = node && typeof node === 'object' ? node.message : null;
          if (!msg || typeof msg !== 'object') continue;

          const authorRole = msg.author && typeof msg.author === 'object' ? msg.author.role : undefined;
          const role = normalizeRole(authorRole, authorRole);
          if (role !== 'user' && role !== 'assistant') continue;

          // Skip non-conversation blobs and hidden items
          const c = msg.content && typeof msg.content === 'object' ? msg.content : null;
          const ctype = c && typeof c.content_type === 'string' ? c.content_type : '';
          if (ctype === 'user_editable_context') continue;
          const md = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : null;
          if (md && md.is_visually_hidden_from_conversation) continue;

          const content = normalizeContent(c ?? msg);
          if (!content) continue;

          extracted.push({
            role,
            content,
            timestamp:
              typeof msg.create_time === 'number'
                ? new Date(msg.create_time * 1000).toISOString()
                : undefined
          });
        }

        const asArray = extractFromArray(extracted, seen);
        if (asArray.length > 0) {
          log('Found ChatGPT mapping structure', { count: asArray.length, usedPath: !!chainIds.length });
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
      const sig = signature(m.role, m.content || '');
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
      if (!payload) return;

      // ChatGPT conversation chunks (from page-context interceptor): fidelity-first, no raw body needed.
      if (payload.kind === 'chatgpt_conversation_chunk' && Array.isArray(payload.messages)) {
        const url = String(payload.url || '');
        const sessionId = await ensureSessionId();
        if (!Array.isArray(apiMessagesCache)) apiMessagesCache = [];

        // Progress init / update
        if (!captureIdActive) captureIdActive = `cap-${Date.now()}`;
        const totalChunks = typeof payload.totalChunks === 'number' ? payload.totalChunks : null;
        const totalMessages = typeof payload.totalMessages === 'number' ? payload.totalMessages : null;
        const chunkIndex = typeof payload.chunkIndex === 'number' ? payload.chunkIndex : null;
        if (typeof chunkIndex === 'number' && !chatgptChunkSeen.has(chunkIndex)) chatgptChunkSeen.add(chunkIndex);

        // Budget tracking
        let totalChars = apiMessagesCache.reduce((acc, m) => acc + (m && m.content ? m.content.length : 0), 0);
        const existingSig = new Set(apiMessagesCache.map((m) => signature(m.role, m.content)));

        let budgetReached = false;
        for (const raw of payload.messages) {
          const role = normalizeRole(raw && raw.role, raw && raw.role);
          let content = normalizeContent(raw && raw.content);
          if (!role || !content) continue;
          if (content.length > MAX_SINGLE_MESSAGE_CHARS) {
            content = content.slice(0, MAX_SINGLE_MESSAGE_CHARS) + '\n[RL4_TRUNCATED_MESSAGE]';
          }

          const sig = signature(role, content);
          if (existingSig.has(sig)) continue;
          existingSig.add(sig);

          totalChars += content.length;
          if (totalChars > MAX_API_CACHE_TOTAL_CHARS || apiMessagesCache.length >= MAX_API_CACHE_MESSAGES) {
            // Stop accumulating; keep what we have. Caller may switch to Ultra/Ultra+.
            log('API cache budget reached; stopping accumulation', {
              messages: apiMessagesCache.length,
              totalChars,
              maxChars: MAX_API_CACHE_TOTAL_CHARS,
              maxMessages: MAX_API_CACHE_MESSAGES
            });
            budgetReached = true;
            break;
          }

          apiMessagesCache.push({
            id: `msg-${apiMessagesCache.length + 1}`,
            role,
            content,
            timestamp:
              typeof raw.timestamp === 'number'
                ? new Date(raw.timestamp * 1000).toISOString()
                : new Date().toISOString(),
            session_id: sessionId,
            captured_at: Date.now(),
            source: 'chatgpt_conversation_api',
            source_url: url
          });
        }

        // Persist bounded subset for debugging only
        const approxChars = apiMessagesCache.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
        const bounded = approxChars > MAX_STORAGE_MESSAGE_CHARS ? apiMessagesCache.slice(-300) : apiMessagesCache;
        await chrome.storage.local.set({
          [STORAGE_KEYS.API_MESSAGES]: bounded,
          [STORAGE_KEYS.API_EVENTS]: apiEvents
        });

        await setCaptureProgress({
          captureId: captureIdActive,
          provider: 'chatgpt',
          phase: 'api_capture',
          status: budgetReached ? 'partial_budget_reached' : 'capturing',
          totalChunks,
          receivedChunks: chatgptChunkSeen.size,
          totalMessages,
          receivedMessages: apiMessagesCache.length,
          approxChars
        });
        return;
      }

      if (!payload.body) return;
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
      // For generic API events we still cap hard (to avoid memory blowups); ChatGPT conversation uses its own budget.
      if (apiMessagesCache.length > MAX_API_CACHE_MESSAGES) apiMessagesCache = apiMessagesCache.slice(-MAX_API_CACHE_MESSAGES);

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
   * Best-effort direct fetch for ChatGPT conversation JSON.
   * This is often the most reliable way to get the full history without DOM scrolling.
   * Uses same-origin credentials (no paid API).
   * @param {string} convId
   * @returns {Promise<Array<any>>} messages in extension format
   */
  async function tryFetchChatGPTConversation(convId) {
    try {
      const id = String(convId || '').trim();
      if (!id) return [];
      const provider = getProvider();
      if (provider !== 'chatgpt') return [];

      const extractFromMapping = (json) => {
        const out = [];
        const mapping = json && typeof json === 'object' ? json.mapping : null;
        if (!mapping || typeof mapping !== 'object') return out;

        const currentNode =
          (json && typeof json === 'object' && typeof json.current_node === 'string' && json.current_node) ||
          (json && typeof json === 'object' && typeof json.currentNode === 'string' && json.currentNode) ||
          '';

        // Follow the real conversation path: root -> current_node
        const chainIds = [];
        if (currentNode && mapping[currentNode]) {
          let cur = currentNode;
          const guard = new Set();
          while (cur && mapping[cur] && !guard.has(cur) && chainIds.length < 100_000) {
            guard.add(cur);
            chainIds.push(cur);
            cur = mapping[cur] && typeof mapping[cur] === 'object' ? mapping[cur].parent : null;
          }
          chainIds.reverse();
        }

        const idsToUse = chainIds.length ? chainIds : Object.keys(mapping);
        for (const id of idsToUse) {
          const node = mapping[id];
          const msg = node && typeof node === 'object' ? node.message : null;
          if (!msg || typeof msg !== 'object') continue;

          const role = msg.author && typeof msg.author === 'object' ? msg.author.role : null;
          if (role !== 'user' && role !== 'assistant') continue;

          const content = msg.content && typeof msg.content === 'object' ? msg.content : null;
          const ctype = content && typeof content.content_type === 'string' ? content.content_type : '';
          if (ctype === 'user_editable_context') continue;

          const md = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : null;
          if (md && md.is_visually_hidden_from_conversation) continue;

          let text = normalizeContent(content ?? msg);
          if (!text) continue;

          out.push({
            role,
            content: text,
            timestamp: typeof msg.create_time === 'number' ? msg.create_time : null
          });
        }
        return out;
      };

      const convUrl = `${location.origin}/backend-api/conversation/${encodeURIComponent(id)}`;

      // 0) Surgical Fetch (cookie-first): often works without any token header, and is the safest/most universal.
      try {
        log('ChatGPT surgical fetch (cookie): trying', { url: convUrl });
        const res = await fetch(convUrl, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (res && res.ok) {
          const json = await res.json();
          const mapped = extractFromMapping(json);
          if (mapped && mapped.length) {
            const sessionId = await ensureSessionId();
            const out = mapped.map((m, idx) => ({
              id: `msg-${idx + 1}`,
              role: normalizeRole(m.role, m.role),
              content: normalizeContent(m.content),
              timestamp:
                typeof m.timestamp === 'number'
                  ? new Date(m.timestamp * 1000).toISOString()
                  : new Date().toISOString(),
              session_id: sessionId,
              captured_at: Date.now(),
              source: 'chatgpt_surgical_fetch_cookie',
              source_url: convUrl
            }));
            apiMessagesCache = out;
            await emitCaptureProgress(
              {
                captureId: captureIdActive,
                tabId: jobTabId,
                provider,
                strategy: 'chatgpt_surgical',
                phase: 'fetch',
                phaseIndex: 1,
                phaseTotal: 2,
                status: 'capturing',
                receivedMessages: out.length,
                totalMessages: out.length
              },
              true
            );
            log('ChatGPT surgical fetch (cookie): success', { messages: out.length });
            return out;
          }
          log('ChatGPT surgical fetch (cookie): mapping parsed 0 messages', {
            hasMapping: !!(json && typeof json === 'object' && json.mapping)
          });
        } else {
          log('ChatGPT surgical fetch (cookie): not ok', { status: res ? res.status : 'unknown' });
        }
      } catch (e) {
        log('ChatGPT surgical fetch (cookie): failed (fallback)', { error: e?.message || String(e) });
      }

      // 1) Surgical Fetch (token): some deployments require Bearer token.
      try {
        const sessRes = await fetch(`${location.origin}/api/auth/session`, { credentials: 'include' });
        if (sessRes && sessRes.ok) {
          const sess = await sessRes.json();
          const token =
            (sess && typeof sess === 'object' && typeof sess.accessToken === 'string' && sess.accessToken) ||
            (sess && typeof sess === 'object' && typeof sess.access_token === 'string' && sess.access_token) ||
            (sess && typeof sess === 'object' && typeof sess.token === 'string' && sess.token) ||
            '';
          if (token) {
            log('ChatGPT surgical fetch (token): trying', { url: convUrl });
            const res = await fetch(convUrl, {
              credentials: 'include',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
              }
            });
            if (res && res.ok) {
              const json = await res.json();
              const mapped = extractFromMapping(json);
              if (mapped && mapped.length) {
                const sessionId = await ensureSessionId();
                const out = mapped.map((m, idx) => ({
                  id: `msg-${idx + 1}`,
                  role: normalizeRole(m.role, m.role),
                  content: normalizeContent(m.content),
                  timestamp:
                    typeof m.timestamp === 'number'
                      ? new Date(m.timestamp * 1000).toISOString()
                      : new Date().toISOString(),
                  session_id: sessionId,
                  captured_at: Date.now(),
                  source: 'chatgpt_surgical_fetch_token',
                  source_url: convUrl
                }));
                apiMessagesCache = out;
                await emitCaptureProgress(
                  {
                    captureId: captureIdActive,
                    tabId: jobTabId,
                    provider,
                    strategy: 'chatgpt_surgical',
                    phase: 'fetch',
                    phaseIndex: 1,
                    phaseTotal: 2,
                    status: 'capturing',
                    receivedMessages: out.length,
                    totalMessages: out.length
                  },
                  true
                );
                log('ChatGPT surgical fetch (token): success', { messages: out.length });
                return out;
              }
              log('ChatGPT surgical fetch (token): mapping parsed 0 messages', {
                hasMapping: !!(json && typeof json === 'object' && json.mapping)
              });
            } else {
              log('ChatGPT surgical fetch (token): not ok', { status: res ? res.status : 'unknown' });
            }
          } else {
            log('ChatGPT surgical fetch (token): no token in session payload', {
              keys: sess && typeof sess === 'object' ? Object.keys(sess).slice(0, 20) : []
            });
          }
        } else {
          log('ChatGPT surgical fetch (token): session endpoint not ok', { status: sessRes ? sessRes.status : 'unknown' });
        }
      } catch (e) {
        log('ChatGPT surgical fetch (token): failed (fallback)', { error: e?.message || String(e) });
      }

      const endpoints = [
        `/backend-api/conversation/${encodeURIComponent(id)}`,
        `/backend-api/conversation/${encodeURIComponent(id)}/`,
        `/backend-api/conversation/${encodeURIComponent(id)}?include=all`,
        `/backend-api/conversation/${encodeURIComponent(id)}?include_history=true`
      ];

      // ChatGPT often requires extra headers that the webapp sets (device id / sentinel token).
      // Best-effort: read from localStorage if present. If missing, we still try.
      const headers = { Accept: 'application/json' };
      try {
        const deviceId =
          window.localStorage?.getItem?.('oai-device-id') ||
          window.localStorage?.getItem?.('oai_device_id') ||
          window.localStorage?.getItem?.('OAI_DEVICE_ID') ||
          '';
        if (deviceId) headers['oai-device-id'] = deviceId;
      } catch (_) {}
      try {
        const sentinel =
          window.localStorage?.getItem?.('openai-sentinel-chat-requirements-token') ||
          window.localStorage?.getItem?.('OPENAI_SENTINEL_CHAT_REQUIREMENTS_TOKEN') ||
          '';
        if (sentinel) headers['openai-sentinel-chat-requirements-token'] = sentinel;
      } catch (_) {}

      for (const ep of endpoints) {
        try {
          const url = `${location.origin}${ep}`;
          log('ChatGPT deep fetch: trying endpoint', { url });
          const res = await fetch(url, {
            credentials: 'include',
            headers
          });
          if (!res.ok) {
            log('ChatGPT deep fetch: endpoint not ok', { url, status: res.status });
            continue;
          }
          const json = await res.json();
          const extracted = extractMessagesFromAnyJson(json);
          if (!extracted.length) {
            // Minimal forensic breadcrumbs (no content): helps adapt parsers when ChatGPT payload shape changes.
            try {
              const topKeys = json && typeof json === 'object' ? Object.keys(json).slice(0, 30) : [];
              log('ChatGPT deep fetch: no messages extracted', {
                url,
                topKeys,
                hasMapping: !!(json && typeof json === 'object' && json.mapping),
                hasMessagesArray: !!(json && typeof json === 'object' && Array.isArray(json.messages))
              });
            } catch (_) {
              log('ChatGPT deep fetch: no messages extracted', { url });
            }
            continue;
          }

          const sessionId = await ensureSessionId();
          const nowIso = new Date().toISOString();
          const out = extracted.map((m, idx) => ({
            id: `msg-${idx + 1}`,
            role: m.role,
            content: m.content,
            timestamp: typeof m.timestamp === 'string' ? m.timestamp : nowIso,
            session_id: sessionId,
            captured_at: Date.now(),
            source: 'chatgpt_backend_api',
            source_url: url
          }));

          // Cache in memory (best fidelity, avoids storage quota).
          apiMessagesCache = out;
          if (apiMessagesCache.length > MAX_API_CACHE_MESSAGES) {
            apiMessagesCache = apiMessagesCache.slice(-MAX_API_CACHE_MESSAGES);
          }

          // Store a bounded subset for debugging.
          const approxChars = apiMessagesCache.reduce((acc, mm) => acc + (mm.content ? mm.content.length : 0), 0);
          const bounded = approxChars > MAX_STORAGE_MESSAGE_CHARS ? apiMessagesCache.slice(-300) : apiMessagesCache;
          await chrome.storage.local.set({
            [STORAGE_KEYS.API_MESSAGES]: bounded,
            [STORAGE_KEYS.API_EVENTS]: apiEvents
          });

          log('ChatGPT deep fetch: success', { messages: out.length, stored: bounded.length, approxChars });
          return out;
        } catch (e) {
          logError('ChatGPT deep fetch: endpoint failed', { endpoint: ep, error: e?.message || String(e) });
          // try next endpoint
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  async function requestChatGPTConversationViaPageContext(convId) {
    try {
      const id = String(convId || '').trim();
      if (!id) return false;
      if (getProvider() !== 'chatgpt') return false;
      window.postMessage(
        {
          type: 'RL4_API_REQUEST',
          payload: { action: 'fetch_chatgpt_conversation', conversationId: id }
        },
        '*'
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * ChatGPT is a Next.js app; conversation state is often present in embedded JSON (e.g. __NEXT_DATA__).
   * This is usually faster + more complete than DOM scrolling for huge chats.
   * @returns {Promise<Array<any>>} messages in extension format (or [])
   */
  async function tryExtractChatGPTEmbeddedState() {
    try {
      if (getProvider() !== 'chatgpt') return [];

      const candidates = [];

      // A) window.__NEXT_DATA__ (when available)
      try {
        if (window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === 'object') {
          candidates.push({ source: 'window.__NEXT_DATA__', value: window.__NEXT_DATA__ });
        }
      } catch (_) {}

      // B) <script id="__NEXT_DATA__" type="application/json">...</script>
      try {
        const el = document.querySelector('script#__NEXT_DATA__');
        const txt = el && el.textContent ? el.textContent.trim() : '';
        if (txt && txt.length > 1000) {
          candidates.push({ source: 'script#__NEXT_DATA__', value: JSON.parse(txt) });
        }
      } catch (_) {}

      // C) Other large JSON scripts (best-effort)
      try {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const s of scripts) {
          const txt = s && s.textContent ? s.textContent.trim() : '';
          if (!txt || txt.length < 5000) continue;
          // quick heuristic to avoid parsing unrelated configs
          if (!/conversation|mapping|message|messages|author|content/i.test(txt)) continue;
          try {
            candidates.push({ source: 'script[type=application/json]', value: JSON.parse(txt) });
          } catch (_) {
            // ignore parse failures
          }
          // cap parsing work
          if (candidates.length >= 6) break;
        }
      } catch (_) {}

      if (!candidates.length) return [];

      // Extract messages from each candidate, pick the largest.
      let best = [];
      let bestSource = '';
      for (const c of candidates) {
        try {
          const extracted = extractMessagesFromAnyJson(c.value);
          if (extracted && extracted.length > best.length) {
            best = extracted;
            bestSource = c.source;
          }
        } catch (_) {}
      }

      if (!best.length) return [];

      const sessionId = await ensureSessionId();
      const nowIso = new Date().toISOString();
      const out = best.map((m, idx) => ({
        id: `msg-${idx + 1}`,
        role: m.role,
        content: m.content,
        timestamp: typeof m.timestamp === 'string' ? m.timestamp : nowIso,
        session_id: sessionId,
        captured_at: Date.now(),
        source: 'embedded_state',
        source_url: bestSource
      }));

      // Cache in memory for perfect retrieval (avoid storage quota).
      apiMessagesCache = out;
      if (apiMessagesCache.length > MAX_API_CACHE_MESSAGES) {
        apiMessagesCache = apiMessagesCache.slice(-MAX_API_CACHE_MESSAGES);
      }

      log('ChatGPT embedded state extraction: success', { source: bestSource, messages: out.length });
      return out;
    } catch (e) {
      logError('ChatGPT embedded state extraction failed', e);
      return [];
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

  // --- RL4 Blocks Encoder capture ---
  function extractRl4BlocksFromText(text) {
    let t = String(text || '');
    if (!t) return null;

    // If the encoder included an explicit end marker, ignore everything after it.
    if (t.includes('<RL4-END/>')) {
      t = t.split('<RL4-END/>')[0];
    }

    const get = (tag) => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const m = t.match(re);
      return m && m[0] ? m[0].trim() : '';
    };

    const arch = get('RL4-ARCH');
    const layers = get('RL4-LAYERS');
    const topics = get('RL4-TOPICS');
    const timeline = get('RL4-TIMELINE');
    const decisions = get('RL4-DECISIONS');
    const insights = get('RL4-INSIGHTS');

    // Best-effort HUMAN SUMMARY: capture text after "HUMAN SUMMARY" heading when present.
    let human_summary = '';
    const hm1 = t.match(/##\s*📋\s*HUMAN\s+SUMMARY[\s\S]*?\n([\s\S]{10,4000})$/i);
    const hm2 = t.match(/HUMAN\s+SUMMARY[\s\S]*?\n([\s\S]{10,4000})$/i);
    const rawHm = (hm1 && hm1[1]) ? hm1[1] : (hm2 && hm2[1]) ? hm2[1] : '';
    if (rawHm) {
      // Stop at common separators or a new unrelated section (to avoid “extra recommendations”).
      const cut = String(rawHm)
        .split(/\n-{3,}\n/)[0]
        .split(/\n_{3,}\n/)[0]
        .split(/\n###\s+/)[0]
        .trim();
      // Keep bounded: first 12 lines max.
      const lines = cut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      human_summary = lines.slice(0, 12).join('\n');
    }

    const found = [arch, layers, topics, timeline, decisions, insights].filter(Boolean).length;
    if (found < 4) return null; // avoid false positives

    // Guardrail: reject obviously truncated captures like "<RL4-ARCH> ... </RL4-ARCH>"
    // Some UIs collapse long blocks and inject ellipses; prefer manual paste in that case.
    const innerLen = (tagText, tagName) => {
      const open = new RegExp(`^<${tagName}>`, 'i');
      const close = new RegExp(`<\\/${tagName}>$`, 'i');
      const inner = String(tagText || '').replace(open, '').replace(close, '').trim();
      return inner.length;
    };
    const suspiciousEllipsis = (tagText, tagName) => {
      const open = new RegExp(`^<${tagName}>`, 'i');
      const close = new RegExp(`<\\/${tagName}>$`, 'i');
      const inner = String(tagText || '').replace(open, '').replace(close, '').trim();
      return inner === '...' || inner === '…' || (inner.includes('...') && inner.length < 60);
    };

    const anySuspicious =
      (arch && suspiciousEllipsis(arch, 'RL4-ARCH')) ||
      (layers && suspiciousEllipsis(layers, 'RL4-LAYERS')) ||
      (topics && suspiciousEllipsis(topics, 'RL4-TOPICS')) ||
      (timeline && suspiciousEllipsis(timeline, 'RL4-TIMELINE')) ||
      (decisions && suspiciousEllipsis(decisions, 'RL4-DECISIONS')) ||
      (insights && suspiciousEllipsis(insights, 'RL4-INSIGHTS'));

    // Require at least one “substantial” block body (keep tolerant: some encoders output very compact blocks).
    const hasSubstantial =
      innerLen(arch, 'RL4-ARCH') > 20 ||
      innerLen(timeline, 'RL4-TIMELINE') > 40 ||
      innerLen(decisions, 'RL4-DECISIONS') > 40 ||
      innerLen(insights, 'RL4-INSIGHTS') > 40;

    if (anySuspicious || !hasSubstantial) return null;

    return {
      arch,
      layers,
      topics,
      timeline,
      decisions,
      insights,
      human_summary,
      found_blocks: found
    };
  }

  async function sealRl4BlocksIntoSnapshot(blocksPayload) {
    try {
      const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT]);
      const last = res && res[STORAGE_KEYS.LAST_SNAPSHOT] && typeof res[STORAGE_KEYS.LAST_SNAPSHOT] === 'object'
        ? res[STORAGE_KEYS.LAST_SNAPSHOT]
        : null;
      if (!last) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.RL4_BLOCKS_STATUS]: { status: 'error', error: 'No snapshot found to seal into.', updatedAt: Date.now() }
        });
        return;
      }

      const next = {
        ...last,
        rl4_blocks: blocksPayload
      };

      // Recompute checksum and re-sign if snapshot was previously sealed.
      next.checksum = await calculateChecksum(next);
      if (next.signature && typeof next.signature === 'object') {
        next.signature = await signChecksumDeviceOnly(next.checksum);
      }

      await saveLastSnapshot(next);
      await chrome.storage.local.set({
        [STORAGE_KEYS.RL4_BLOCKS_STATUS]: {
          status: 'sealed',
          found_blocks: typeof blocksPayload?.blocks?.found_blocks === 'number' ? blocksPayload.blocks.found_blocks : undefined,
          updatedAt: Date.now()
        }
      });
    } catch (e) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.RL4_BLOCKS_STATUS]: { status: 'error', error: String(e?.message || e), updatedAt: Date.now() }
      });
    }
  }

  async function scanForRl4Blocks(reason = 'scan') {
    if (!rl4BlocksArmed) return;
    if (rl4BlocksCaptured) return;

    try {
      const candidates = [];

      // 1) Prefer API event bodies (often contains full assistant text even if DOM is collapsed)
      try {
        const apiText = (Array.isArray(apiEvents) ? apiEvents : [])
          .slice(-30)
          .map((e) => (e && typeof e.body === 'string' ? e.body : ''))
          .filter((s) => s && s.includes('<RL4-'))
          .join('\n\n');
        if (apiText) candidates.push(apiText);
      } catch (_) {}

      // 2) Try API messages cache (assistant outputs)
      try {
        const cacheText = (Array.isArray(apiMessagesCache) ? apiMessagesCache : [])
          .slice(-60)
          .filter((m) => String(m?.role || '') === 'assistant')
          .map((m) => String(m?.content || ''))
          .filter((s) => s && s.includes('<RL4-'))
          .join('\n\n');
        if (cacheText) candidates.push(cacheText);
      } catch (_) {}

      // 3) Fallback: DOM last visible nodes (can be collapsed → may contain "...")
      const nodes = getMessageNodes();
      if (nodes && nodes.length) {
        const tail = nodes.slice(-30);
        let combined = '';
        for (const n of tail) {
          const el = n && n.el ? n.el : null;
          const txt = el ? (el.innerText || el.textContent || '') : '';
          if (!txt) continue;
          if (!txt.includes('<RL4-')) continue;
          combined += `\n\n${txt}`;
        }
        if (combined) candidates.push(combined);
      }

      // Pick the best candidate (most blocks)
      let best = null;
      for (const c of candidates) {
        const b = extractRl4BlocksFromText(c);
        if (!b) continue;
        if (!best || (b.found_blocks || 0) > (best.found_blocks || 0)) best = b;
      }

      if (!best) {
        // Keep awaiting; user can paste manually.
        await chrome.storage.local.set({
          [STORAGE_KEYS.RL4_BLOCKS_STATUS]: {
            status: 'awaiting',
            provider: getProvider(),
            convId: getConversationIdFromUrl(),
            updatedAt: Date.now(),
            hint: 'Auto-capture did not find complete RL4 blocks. Paste reply manually to finalize.'
          }
        });
        return;
      }

      rl4BlocksCaptured = true;
      const payload = {
        capturedAt: Date.now(),
        provider: getProvider(),
        convId: getConversationIdFromUrl(),
        reason,
        blocks: best
      };

      await chrome.storage.local.set({
        [STORAGE_KEYS.RL4_BLOCKS]: payload,
        [STORAGE_KEYS.RL4_BLOCKS_STATUS]: {
          status: 'captured',
          found_blocks: best.found_blocks,
          updatedAt: Date.now()
        }
      });

      // Auto-seal into the latest snapshot so the exported JSON contains the “intelligence”.
      await sealRl4BlocksIntoSnapshot(payload);
    } catch (e) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.RL4_BLOCKS_STATUS]: { status: 'error', error: String(e?.message || e), updatedAt: Date.now() }
      });
    }
  }

  function maybeScanRl4Blocks(reason = 'mutation') {
    const now = Date.now();
    if (now - lastRl4BlocksScanAt < 750) return;
    lastRl4BlocksScanAt = now;
    scanForRl4Blocks(reason).catch(() => {});
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
        // Direct attribute
        const r = el.getAttribute && el.getAttribute('data-message-author-role');
        if (r === 'user') return 'user';
        if (r === 'assistant') return 'assistant';
        // Wrapped turn (<article ...>) → find a descendant with the role attribute
        const inner = el.querySelector?.(SELECTORS.CHATGPT_ROLE_ATTR);
        const r2 = inner && inner.getAttribute ? inner.getAttribute('data-message-author-role') : null;
        if (r2 === 'user') return 'user';
        if (r2 === 'assistant') return 'assistant';
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
   * Cheap stable signature for de-dup (no crypto).
   * IMPORTANT: do NOT use only the prefix, as many LLM messages share long identical starts.
   * We use: normalized prefix + normalized suffix + length.
   * @param {string} role
   * @param {string} content
   * @returns {string}
   */
  function signature(role, content) {
    const c = (content || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const len = c.length;
    const head = c.slice(0, 220);
    const tail = len > 220 ? c.slice(Math.max(0, len - 220)) : '';
    return `${role || 'unknown'}|${len}|${head}|${tail}`;
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
    if (!isExtensionContextAlive()) return;
    try {
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
      emitCaptureProgress({
        captureId: captureIdActive,
        provider: getProvider(),
        phase: 'scan',
        status: 'no_messages',
        receivedMessages: 0
      }).catch(() => {});
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
      emitCaptureProgress({
        captureId: captureIdActive,
        provider: getProvider(),
        phase: 'scan',
        status: 'capturing',
        receivedMessages: next.length
      }).catch(() => {});
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
      emitCaptureProgress({
        captureId: captureIdActive,
        provider: getProvider(),
        phase: 'scan_append',
        status: 'capturing',
        receivedMessages: next.length
      }).catch(() => {});
    } catch (e) {
      const m = String(e && e.message ? e.message : e || '');
      if (/Extension context invalidated/i.test(m)) {
        softShutdown('context_invalidated_scan');
        return;
      }
      throw e;
    }
  }

  /**
   * Deep capture for share pages / virtualized history: scroll and accumulate unique messages.
   * @returns {Promise<void>}
   */
  async function deepCaptureConversation() {
    const start = Date.now();
    const provider = getProvider();
    const maxMs = provider === 'chatgpt' ? Math.max(DEEP_CAPTURE_MAX_MS, 60000) : DEEP_CAPTURE_MAX_MS;
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
    emitCaptureProgress({
      captureId: captureIdActive,
      provider,
      phase: 'deep_scan',
      status: 'capturing'
    }).catch(() => {});
    await scanAndSyncMessages('deep-top', { append: true });

    while (Date.now() - start < maxMs) {
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
      emitCaptureProgress({
        captureId: captureIdActive,
        provider,
        phase: 'deep_scan',
        status: 'capturing',
        receivedMessages: nextLen
      }).catch(() => {});

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

        const sh = el.scrollHeight || 0;
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
    const provider = getProvider();
    const waitMs = provider === 'chatgpt' ? Math.max(DEEP_HYDRATE_WAIT_MS, 2500) : DEEP_HYDRATE_WAIT_MS;
    const maxNoGrowth = provider === 'chatgpt' ? 25 : 4;
    const maxMs = provider === 'chatgpt' ? Math.max(DEEP_HYDRATE_MAX_MS, 420000) : DEEP_HYDRATE_MAX_MS; // up to 7 min
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

    const scrollUpPulse = async () => {
      // More human-like: step upward a bit many times (triggers "reverse infinite scroll" reliably)
      const target = scroller || window;
      const getY = () => (scroller ? scroller.scrollTop : window.scrollY);
      const setY = (y) => {
        if (scroller) scroller.scrollTo(0, y);
        else window.scrollTo(0, y);
      };
      const viewportH = scroller ? scroller.clientHeight : window.innerHeight;
      const step = Math.max(220, Math.floor(viewportH * 0.6));

      // ChatGPT: slower pulses seem to trigger chunk loading more reliably than instant "teleport to 0".
      const pulses = provider === 'chatgpt' ? 14 : 8;
      for (let k = 0; k < pulses; k++) {
        const y = getY();
        const nextY = Math.max(0, y - step);
        setY(nextY);
        // Dispatch on both container and document to maximize handler coverage.
        dispatchWheel(target, -step);
        try {
          if (provider === 'chatgpt') dispatchWheel(document, -step);
        } catch (_) {}
        if (provider === 'chatgpt') await sleep(90);
      }
      // Ensure we actually touch the top boundary
      setY(0);
      dispatchWheel(target, -400);
      try {
        if (provider === 'chatgpt') dispatchWheel(document, -400);
      } catch (_) {}
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

    const getApiCount = () => {
      try {
        return Array.isArray(apiMessagesCache) ? apiMessagesCache.length : 0;
      } catch (_) {
        return 0;
      }
    };

    const selForProvider =
      provider === 'chatgpt'
        ? SELECTORS.CHATGPT_MESSAGE_NODES
        : provider === 'gemini'
          ? SELECTORS.GEMINI_LOOP
          : SELECTORS.CLAUDE_MESSAGE_CONTAINERS;
    const countMsgsIn = (root) => {
      try {
        if (!root) return 0;
        return root.querySelectorAll ? root.querySelectorAll(selForProvider).length : 0;
      } catch (_) {
        return 0;
      }
    };

    let prevH = getScrollHeight();
    let prevDomMsgCount = countMsgsIn(scroller || document);
    let prevMsgCount = await getStoredCount();
    let prevApiCount = getApiCount();
    log('Hydration start', {
      reason,
      provider: getProvider(),
      hasScroller: !!scroller,
      scrollerTag: scroller ? scroller.tagName : 'WINDOW',
      scrollerClass: scroller ? scroller.className : '',
      prevH,
      prevDomMsgCount,
      prevMsgCount,
      prevApiCount
    });
    emitCaptureProgress({
      captureId: captureIdActive,
      provider,
      phase: 'hydrate',
      status: 'capturing',
      receivedMessages: Math.max(prevMsgCount, prevApiCount)
    }).catch(() => {});

    while (Date.now() - start < maxMs && noGrowth < maxNoGrowth) {
      await scrollUpPulse();

      const apiEventsBefore = apiEvents.length;
      const apiCountBefore = getApiCount();

      // Wait for DOM mutation or API event (better than fixed sleep). Fallback to timeout.
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            obs.disconnect();
          } catch (_) {}
          resolve();
        }, waitMs);

        // ChatGPT often mutates outside the scroll container (react portals). Observe documentElement.
        const target = provider === 'chatgpt' ? document.documentElement : (scroller || document.documentElement);
        let obs;
        try {
          obs = new MutationObserver(() => {
            clearTimeout(timeout);
            try {
              obs.disconnect();
            } catch (_) {}
            resolve();
          });
          obs.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
        } catch (_) {
          clearTimeout(timeout);
          resolve();
        }
      });

      // If API events are flowing, give it a tiny bit of extra time (ChatGPT can be delayed).
      if (provider === 'chatgpt') {
        const apiEventsAfter = apiEvents.length;
        const apiCountAfter = getApiCount();
        const apiMoved = apiEventsAfter > apiEventsBefore || apiCountAfter > apiCountBefore;
        if (apiMoved) await sleep(650);
      }

      await scanAndSyncMessages(`${reason}-top`, { append: true });

      const nextH = getScrollHeight();
      const nextDomMsgCount = countMsgsIn(scroller || document);
      const nextMsgCountPromise = getStoredCount();
      const nextMsgCount = await nextMsgCountPromise;
      const nextApiCount = getApiCount();
      const grew =
        nextMsgCount > prevMsgCount ||
        nextApiCount > prevApiCount ||
        nextH > prevH + 50 ||
        nextDomMsgCount > prevDomMsgCount;
      log('Hydration tick', {
        reason,
        scrollTop: getScrollTop(),
        prevH,
        nextH,
        prevDomMsgCount,
        nextDomMsgCount,
        prevMsgCount,
        nextMsgCount,
        prevApiCount,
        nextApiCount,
        grew,
        noGrowth
      });
      emitCaptureProgress({
        captureId: captureIdActive,
        provider,
        phase: 'hydrate',
        status: grew ? 'capturing' : 'waiting',
        receivedMessages: Math.max(nextMsgCount, nextApiCount)
      }).catch(() => {});
      if (grew) {
        log('Hydration chunk loaded', {
          prevH,
          nextH,
          prevDomMsgCount,
          nextDomMsgCount,
          prevMsgCount,
          nextMsgCount,
          prevApiCount,
          nextApiCount
        });
        prevH = nextH;
        prevDomMsgCount = nextDomMsgCount;
        prevMsgCount = nextMsgCount;
        prevApiCount = nextApiCount;
        noGrowth = 0;
      } else {
        noGrowth++;
      }

      // If we're at top and not growing, we're probably fully hydrated.
      if (getScrollTop() <= 2 && noGrowth >= maxNoGrowth) break;

      // ChatGPT: jitter at the top to re-trigger "load older" sentinel logic.
      if (provider === 'chatgpt' && getScrollTop() <= 2 && noGrowth > 0 && noGrowth % 3 === 0) {
        try {
          if (scroller) scroller.scrollTo(0, Math.min(180, scroller.scrollHeight || 0));
          else window.scrollTo(0, 180);
        } catch (_) {}
        await sleep(180);
        try {
          if (scroller) scroller.scrollTo(0, 0);
          else window.scrollTo(0, 0);
        } catch (_) {}
        await sleep(220);
      }
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
        // IMPORTANT: During deep capture/hydration we use append-mode accumulation.
        // A replace-mode mutation scan would overwrite the accumulated history with only visible DOM nodes.
        if (deepCaptureInProgress) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          scanAndSyncMessages('mutation').catch((e) => logError('scanAndSyncMessages failed', e));
        }, OBSERVER_DEBOUNCE_MS);

        // RL4 Blocks capture: if armed, scan for <RL4-...> tags in recent assistant output.
        if (rl4BlocksArmed && !rl4BlocksCaptured) {
          maybeScanRl4Blocks('mutation');
        }
      });

      // document.body can be null very early; fallback to document.documentElement.
      const target = document.body instanceof Node ? document.body : document.documentElement;
      observer.observe(target, {
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
      if (request.action === 'armRl4BlocksCapture') {
        rl4BlocksArmed = true;
        rl4BlocksCaptured = false;
        lastRl4BlocksScanAt = 0;

        // Reset stored blocks and status for a fresh encode flow.
        chrome.storage.local
          .remove([STORAGE_KEYS.RL4_BLOCKS])
          .catch(() => {});
        chrome.storage.local
          .set({
            [STORAGE_KEYS.RL4_BLOCKS_STATUS]: {
              status: 'awaiting',
              provider: getProvider(),
              convId: getConversationIdFromUrl(),
              tabId: typeof request.tabId === 'number' ? request.tabId : null,
              startedAt: Date.now(),
              updatedAt: Date.now()
            }
          })
          .catch(() => {});

        // Best-effort immediate scan (in case blocks are already visible).
        scanForRl4Blocks('arm').catch(() => {});

        sendResponse({ ok: true, armed: true });
        return false;
      }
      if (request.action === 'finalizeRl4BlocksManual') {
        try {
          const raw = typeof request.text === 'string' ? request.text : '';
          const blocks = extractRl4BlocksFromText(raw);
          if (!blocks) {
            sendResponse({ ok: false, error: 'Could not find complete <RL4-...> blocks in pasted text.' });
            return false;
          }
          rl4BlocksArmed = true;
          rl4BlocksCaptured = true;

          const payload = {
            capturedAt: Date.now(),
            provider: getProvider(),
            convId: getConversationIdFromUrl(),
            reason: 'manual',
            blocks
          };

          chrome.storage.local
            .set({
              [STORAGE_KEYS.RL4_BLOCKS]: payload,
              [STORAGE_KEYS.RL4_BLOCKS_STATUS]: {
                status: 'captured',
                found_blocks: blocks.found_blocks,
                updatedAt: Date.now()
              }
            })
            .then(() => sealRl4BlocksIntoSnapshot(payload))
            .catch(() => {});

          sendResponse({ ok: true, finalized: true });
          return false;
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
          return false;
        }
      }
      if (request.action === 'startSnapshotJob') {
        const provider = getProvider();
        const cap = typeof request.captureId === 'string' && request.captureId.trim()
          ? request.captureId.trim()
          : `cap-${Date.now()}`;

        if (snapshotJobRunning) {
          sendResponse({
            ok: false,
            error: {
              type: 'error',
              code: 'JOB_ALREADY_RUNNING',
              message: 'A snapshot job is already running on this tab.'
            }
          });
          return false;
        }

        captureIdActive = cap;
        chatgptChunkSeen = new Set();
        jobTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
        jobStrategy = null;
        clearCaptureProgress().catch(() => {});
        emitCaptureProgress({ captureId: captureIdActive, tabId: jobTabId, provider, phase: 'starting', status: 'starting' }, true).catch(() => {});

        // Fire-and-forget: job continues even if popup closes.
        runSnapshotJob(request.options || {}).catch((e) => logError('runSnapshotJob failed', e));

        sendResponse({ ok: true, started: true, captureId: captureIdActive, provider });
        return false;
      }
      if (request.action === 'openRl4InpagePanel') {
        openInpagePanel();
        sendResponse({ ok: true, opened: true });
        return false;
      }
      if (request.action === 'getMessages') {
        const isShare = window.location.pathname.startsWith('/share/');
        const wantsDeep = !!request.deep;
        const provider = getProvider();
        captureIdActive = typeof request.captureId === 'string' && request.captureId.trim() ? request.captureId.trim() : `cap-${Date.now()}`;
        chatgptChunkSeen = new Set();

        // Reset progress for this run
        clearCaptureProgress().catch(() => {});
        setCaptureProgress({
          captureId: captureIdActive,
          provider,
          phase: wantsDeep ? 'starting_deep' : 'starting',
          status: 'starting',
          startedAt: Date.now()
        }).catch(() => {});

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
              deepCaptureInProgress = true;
              try {
                // ChatGPT: first try direct backend conversation fetch (often returns full history instantly).
                if (provider === 'chatgpt') {
                  // Fastest: embedded state (Next.js) when present.
                  const embedded = await tryExtractChatGPTEmbeddedState();
                  if (embedded && embedded.length) return;

                  const convId = getConversationIdFromUrl();
                  // Prefer page-context fetch via interceptor (more reliable than content-script fetch; avoids CORS/404 traps).
                  const before = Array.isArray(apiMessagesCache) ? apiMessagesCache.length : 0;
                  await requestChatGPTConversationViaPageContext(convId);
                  const started = Date.now();
                  while (Date.now() - started < 8000) {
                    const nowLen = Array.isArray(apiMessagesCache) ? apiMessagesCache.length : 0;
                    if (nowLen > before + 50) {
                      log('ChatGPT page-context fetch yielded messages', { before, nowLen });
                      setCaptureProgress({
                        captureId: captureIdActive,
                        provider: 'chatgpt',
                        phase: 'api_capture',
                        status: 'done'
                      }).catch(() => {});
                      return;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                  }

                  // Fallback: direct content-script fetch (may 404 depending on deployment / cookies).
                  log('ChatGPT deep capture: starting backend fetch attempt (fallback)', { convId });
                  const direct = await tryFetchChatGPTConversation(convId);
                  log('ChatGPT deep capture: backend fetch result (fallback)', { messages: direct ? direct.length : 0 });
                  if (direct && direct.length) return;
                }

                // Hydrate first for reverse infinite scroll UIs (Gemini + ChatGPT).
                const scroller = getConversationScrollContainer(provider);
                if (provider === 'gemini' || provider === 'chatgpt') {
                  await hydrateChatHistory(scroller, 'hydrate');
                }

                // Then do a full pass capture (top -> bottom) to accumulate DOM-virtualized slices.
                await deepCaptureConversation();
              } finally {
                deepCaptureInProgress = false;
              }
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
            setCaptureProgress({
              captureId: captureIdActive,
              provider,
              phase: 'done',
              status: 'done',
              totalMessages: Array.isArray(messages) ? messages.length : null,
              receivedMessages: Array.isArray(messages) ? messages.length : 0
            }).catch(() => {});
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
    .then(() => {
      // On supported sites, show a Crisp-like RL4 launcher (bottom-right).
      // If the user prefers Side Panel, they can still use it when available.
      mountInpageWidget();
    })
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


