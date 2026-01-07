/**
 * RL4 API Interceptor (page context)
 * Hooks fetch + XMLHttpRequest to mirror Claude.ai + ChatGPT API responses to the extension.
 *
 * No paid API usage: this only observes requests the page already makes.
 */
(function () {
  if (window.__RL4_API_INTERCEPTOR_INSTALLED__) return;
  window.__RL4_API_INTERCEPTOR_INSTALLED__ = true;

  const MAX_BODY_CHARS = 800_000; // cap to avoid huge memory usage
  const MAX_SSE_CHARS = 600_000; // cap streaming capture (ChatGPT)
  const MAX_SSE_MS = 10_000; // stop reading after 10s to avoid infinite streams
  const MAX_CHATGPT_MESSAGES_PER_CHUNK = 250;
  const MAX_CHATGPT_MSG_CHARS = 30_000; // per-message cap in page context to avoid huge postMessage payloads

  const shouldCaptureUrl = (url) => {
    if (!url) return false;
    // Claude typically uses /api/ for convo loading/streaming.
    // ChatGPT typically uses /backend-api/ for conversation fetch/stream.
    // Gemini/Bard often uses /batchexecute or /_/BardChatUi/ style endpoints.
    // We keep this broad but same-origin.
    try {
      const u = new URL(url);

      // Allow same-origin always.
      const sameOrigin = u.origin === location.origin;

      // ChatGPT sometimes uses a cross-origin gateway (still first-party).
      // If the page can fetch it (CORS allowed), we can observe it here.
      const host = (u.hostname || '').toLowerCase();
      const isOpenAiGateway =
        host.endsWith('.api.openai.com') ||
        host.includes('chat.gateway.unified') ||
        host.includes('chat-gateway') ||
        host.includes('gateway.unified');

      if (!sameOrigin && !isOpenAiGateway) return false;

      return (
        u.pathname.includes('/api/') ||
        u.pathname.includes('/backend-api/') ||
        u.pathname.includes('/batchexecute') ||
        u.pathname.includes('/_/BardChatUi/')
      );
    } catch (_) {
      // Fallback for non-absolute URLs
      return (
        url.includes('/api/') ||
        url.includes('/backend-api/') ||
        url.includes('/batchexecute') ||
        url.includes('/_/BardChatUi/')
      );
    }
  };

  const normalizeUrl = (url) => {
    try {
      if (!url) return '';
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('/')) return `${location.origin}${url}`;
      return url;
    } catch (_) {
      return String(url || '');
    }
  };

  const safeTruncate = (text) => {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_BODY_CHARS) return text;
    return text.slice(0, MAX_BODY_CHARS) + '\n[RL4_TRUNCATED]';
  };

  const post = (payload) => {
    try {
      window.postMessage(
        {
          type: 'RL4_API_RESPONSE',
          payload
        },
        '*'
      );
    } catch (_) {
      // ignore
    }
  };

  const isChatGPT = () => {
    const h = (location.hostname || '').toLowerCase();
    return h.includes('chatgpt.com') || h.includes('chat.openai.com');
  };

  const isChatGPTConversationUrl = (url) => {
    try {
      const u = new URL(url);
      return isChatGPT() && u.origin === location.origin && u.pathname.startsWith('/backend-api/conversation/');
    } catch (_) {
      return isChatGPT() && String(url || '').includes('/backend-api/conversation/');
    }
  };

  const normalizePartText = (p) => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      if (typeof p.text === 'string') return p.text;
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (typeof p.content === 'string') return p.content;
    }
    return '';
  };

  const extractChatGPTConversationMessages = (json) => {
    const out = [];
    const mapping = json && typeof json === 'object' ? json.mapping : null;
    if (!mapping || typeof mapping !== 'object') return out;

    const currentNode =
      (typeof json.current_node === 'string' && json.current_node) ||
      (typeof json.currentNode === 'string' && json.currentNode) ||
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

      let text = '';
      if (content && Array.isArray(content.parts)) {
        text = content.parts.map(normalizePartText).filter(Boolean).join('\n').trim();
      }
      if (!text) continue;
      if (text.length > MAX_CHATGPT_MSG_CHARS) {
        text = text.slice(0, MAX_CHATGPT_MSG_CHARS) + '\n[RL4_TRUNCATED_MESSAGE]';
      }

      out.push({
        role,
        content: text,
        // keep numeric create_time (seconds) to reduce payload size; content.js will iso-normalize.
        timestamp: typeof msg.create_time === 'number' ? msg.create_time : null
      });
    }
    return out;
  };

  const postChatGPTConversationChunks = (meta, messages) => {
    const total = Array.isArray(messages) ? messages.length : 0;
    if (!total) return;
    const totalChunks = Math.ceil(total / MAX_CHATGPT_MESSAGES_PER_CHUNK);
    for (let i = 0; i < total; i += MAX_CHATGPT_MESSAGES_PER_CHUNK) {
      const chunkIndex = Math.floor(i / MAX_CHATGPT_MESSAGES_PER_CHUNK);
      post({
        ...meta,
        kind: 'chatgpt_conversation_chunk',
        chunkIndex,
        totalChunks,
        totalMessages: total,
        messages: messages.slice(i, i + MAX_CHATGPT_MESSAGES_PER_CHUNK),
        capturedAt: Date.now()
      });
    }
  };

  const safeTruncateStream = (text) => {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_SSE_CHARS) return text;
    return text.slice(0, MAX_SSE_CHARS) + '\n[RL4_TRUNCATED_SSE]';
  };

  async function readSSE(clone, meta) {
    try {
      if (!clone.body || !clone.body.getReader) return;
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let total = 0;
      const start = Date.now();

      while (Date.now() - start < MAX_SSE_MS && total < MAX_SSE_CHARS) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        total += chunk.length;
        buf += chunk;

        // Process full lines
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const l = line.trimEnd();
          if (!l.startsWith('data:')) continue;
          const data = l.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          // forward each data frame (often JSON)
          post({
            ...meta,
            via: 'fetch_sse',
            body: safeTruncateStream(data),
            capturedAt: Date.now()
          });
        }
      }
    } catch (_) {
      // ignore
    }
  }

  // Hook fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const init = args[1] || {};
      const rawUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const url = normalizeUrl(rawUrl);
      if (!shouldCaptureUrl(url)) return res;

      const method =
        (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
      const clone = res.clone();
      const contentType = (clone.headers && clone.headers.get && clone.headers.get('content-type')) || '';

      // ChatGPT conversation JSON can be huge; avoid truncating the raw body.
      // Instead, parse JSON in page context and stream only the extracted messages to the extension.
      if (
        isChatGPTConversationUrl(url) &&
        clone.status === 200 &&
        contentType.includes('application/json')
      ) {
        try {
          const json = await clone.json();
          const messages = extractChatGPTConversationMessages(json);
          if (messages && messages.length) {
            postChatGPTConversationChunks(
              {
                via: 'fetch_chatgpt_conversation',
                url,
                method: String(method || 'GET').toUpperCase(),
                status: clone.status,
                contentType
              },
              messages
            );
          } else {
            post({
              via: 'fetch_chatgpt_conversation',
              url,
              method: String(method || 'GET').toUpperCase(),
              status: clone.status,
              contentType,
              kind: 'chatgpt_conversation_empty',
              capturedAt: Date.now()
            });
          }
        } catch (_) {
          // If parsing fails, fallback to generic capture below (may truncate).
        }
        return res;
      }

      // ChatGPT streams as text/event-stream; capture SSE frames (bounded).
      if (contentType.includes('text/event-stream')) {
        if (isChatGPT() && shouldCaptureUrl(url)) {
          readSSE(clone, {
            url,
            method: String(method || 'GET').toUpperCase(),
            status: clone.status,
            contentType
          });
        }
        return res;
      }

      // Only try to read likely-text bodies.
      if (
        !contentType.includes('application/json') &&
        !contentType.includes('text/') &&
        !contentType.includes('application/graphql')
      ) {
        return res;
      }

      const text = safeTruncate(await clone.text());
      post({
        via: 'fetch',
        url,
        method: String(method || 'GET').toUpperCase(),
        status: clone.status,
        contentType,
        body: text,
        capturedAt: Date.now()
      });
    } catch (_) {
      // ignore
    }
    return res;
  };

  // Allow content script to request a page-context fetch (more reliable than content-script fetch for ChatGPT).
  window.addEventListener('message', async (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'RL4_API_REQUEST') return;
      const payload = data.payload || {};
      if (!payload || payload.action !== 'fetch_chatgpt_conversation') return;
      if (!isChatGPT()) return;

      const convId = String(payload.conversationId || '').trim();
      if (!convId) return;

      const url = `${location.origin}/backend-api/conversation/${encodeURIComponent(convId)}`;
      const res = await originalFetch(url, { credentials: 'include' });
      const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (!res.ok || !contentType.includes('application/json')) {
        post({
          via: 'page_fetch_request',
          url,
          method: 'GET',
          status: res.status,
          contentType,
          kind: 'chatgpt_conversation_fetch_failed',
          capturedAt: Date.now()
        });
        return;
      }

      const json = await res.json();
      const messages = extractChatGPTConversationMessages(json);
      postChatGPTConversationChunks(
        {
          via: 'page_fetch_request',
          url,
          method: 'GET',
          status: res.status,
          contentType
        },
        messages
      );
    } catch (_) {
      // ignore
    }
  });

  // Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__rl4_url = normalizeUrl(url);
      this.__rl4_method = String(method || 'GET').toUpperCase();
    } catch (_) {
      // ignore
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__rl4_url;
      if (shouldCaptureUrl(url)) {
        this.addEventListener('load', () => {
          try {
            const contentType = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            if (contentType && contentType.includes('text/event-stream')) return;
            const body = safeTruncate(String(this.responseText || ''));
            post({
              via: 'xhr',
              url,
              method: this.__rl4_method || 'GET',
              status: this.status,
              contentType,
              body,
              capturedAt: Date.now()
            });
          } catch (_) {
            // ignore
          }
        });
      }
    } catch (_) {
      // ignore
    }
    return originalSend.apply(this, args);
  };
})();


