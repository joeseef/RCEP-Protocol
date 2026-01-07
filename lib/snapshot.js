/* global calculateChecksum, extractTopics, extractDecisions, extractInsights, canonicalize */

/**
 * Transform raw messages into a structured RL4 snapshot.
 */
class RL4SnapshotGenerator {
  /**
   * @param {Array<{id:string, role:'user'|'assistant', content:string, timestamp?:string, session_id?:string}>} messages
   * @param {Object} budget
   * @param {Object} options
   */
  constructor(messages, budget = {}, options = {}) {
    this.messages = Array.isArray(messages) ? messages : [];
    const now = Date.now();
    this.budget = {
      deadline: budget.deadline || now + 2000, // 2s max
      maxTopics: budget.maxTopics || 7,
      maxDecisions: budget.maxDecisions || 5,
      maxInsights: budget.maxInsights || 10
    };
    this.options = {
      includeTranscript: options.includeTranscript !== undefined ? !!options.includeTranscript : true,
      // digest: current default (RCEP_v1), ultra: aggressive size cut (RCEP_v2_Ultra)
      outputMode: options.outputMode === 'ultra' || options.outputMode === 'ultra_plus' ? options.outputMode : 'digest'
    };
  }

  /**
   * Check if deadline exceeded
   * @returns {boolean}
   */
  _checkDeadline() {
    return Date.now() > this.budget.deadline;
  }

  /**
   * Pick a stable session_id from captured messages.
   * Prefers a non-unknown conv id when present.
   * @param {string} nowIso
   * @returns {string}
   */
  _pickSessionId(nowIso) {
    const nonUnknown = this.messages.find((m) => m.session_id && !/^conv-unknown-/.test(m.session_id))?.session_id;
    if (nonUnknown) return nonUnknown;

    const any = this.messages.find((m) => m.session_id)?.session_id;
    if (any) {
      const match = any.match(/^conv-(.+?)-/);
      if (match && match[1] && match[1] !== 'unknown') return `conv-${match[1]}-${nowIso}`;
    }

    return `conv-hash-${Date.now().toString(16)}-${nowIso}`;
  }

  /**
   * Main entry point.
   * @returns {Promise<any>}
   */
  async generate() {
    const nowIso = new Date().toISOString();
    const sessionId = this._pickSessionId(nowIso);

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded');
    }

    const topics = this.extractTopics().slice(0, this.budget.maxTopics);

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded', { topics });
    }

    const decisions = this.extractDecisions().slice(0, this.budget.maxDecisions);

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded', { topics, decisions });
    }

    const insights = this.extractInsights().slice(0, this.budget.maxInsights);
    const contextSummary = this.generateSummary({ topics, decisions });

    // Deduplicate messages (remove exact duplicates and system messages)
    const deduplicatedMessages = this._deduplicateMessages(this.messages, topics, decisions);
    // Normalize messages so all carry the chosen sessionId (avoid mixed/unknown ids)
    const normalizedMessages = deduplicatedMessages.map((m) => ({
      ...m,
      session_id: sessionId
    }));

    const originalSize = this.messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);

    // RCEP-style digest:
    // - No full transcript in the clipboard JSON (to avoid token explosion)
    // - Keep verifiability: include a fingerprint of the FULL transcript (SHA-256 of a compact transcript string)
    const transcriptCompact = this._encodeMessagesCompact(normalizedMessages);
    const transcriptSha256 = await this._sha256Hex(transcriptCompact);
    const timelineMacro = this._timelineMacro(normalizedMessages, { maxPhases: 6 });
    const cognitiveSpine = this._digestCognitiveSpine({
      digestTopics: topics,
      digestDecisions: decisions,
      digestInsights: insights,
      timeline_macro: timelineMacro,
      messages: normalizedMessages
    });
    const portableMemory = this._portableMemory({
      messages: normalizedMessages,
      topics,
      decisions,
      timeline_macro: timelineMacro,
      mode: this.options.outputMode
    });

    // Digest without transcript (pure “analysis” compression target)
    const digestWithoutTranscript = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        notice: 'RCEP™ is a trademark claim. Do not remove this header.',
        mode: 'digest'
      },
      protocol: 'RCEP_v1',
      version: '0.3.0-digest',
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        generator: 'rl4-snapshot-extension',
        mode: 'digest'
      },
      session_id: sessionId,
      timestamp: nowIso,
      context_state: {
        core_subject: 'RL4 Snapshot (Browser Chat)',
        current_goal: 'Capture → Compress → Seal',
        status: 'Digest generated'
      },
      topics,
      decisions,
      insights,
      context_summary: contextSummary,
      timeline_macro: timelineMacro,
      cognitive_spine: cognitiveSpine,
      portable_memory: portableMemory,
      conversation_fingerprint: {
        algorithm: 'sha256',
        transcript_format: 'ROLE:\\nCONTENT (messages separated by \\n\\n<|RL4_MSG|>\\n\\n)',
        sha256: transcriptSha256
      },
      metadata: {
        messages: normalizedMessages.length,
        messages_original: this.messages.length,
        original_size_chars: originalSize,
        digest_size_chars: 0,
        compression_digest: '0x',
        generated_at: nowIso
      },
      checksum: ''
    };

    // Final digest copied by the CTA (still small)
    const digest = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        notice: 'RCEP™ is a trademark claim. Do not remove this header.',
        mode: 'digest'
      },
      protocol: 'RCEP_v1',
      version: '0.3.0-digest',
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        generator: 'rl4-snapshot-extension',
        mode: 'digest'
      },
      session_id: sessionId,
      timestamp: nowIso,
      context_state: {
        core_subject: 'RL4 Snapshot (Browser Chat)',
        current_goal: 'Capture → Compress → Seal',
        status: 'Digest generated'
      },
      topics,
      decisions,
      insights,
      // Keep a short summary only (LLMs can reconstruct reasoning from structured fields)
      context_summary: contextSummary,
      // Keep a minimal “timeline” (heuristic) without inventing content
      timeline_summary: this._timelineSummary(normalizedMessages),
      // NEW: macro timeline (bounded, keyword-based, non-inventive)
      timeline_macro: timelineMacro,
      // NEW: always-on cognitive spine (compact, derived from messages+topics+decisions)
      cognitive_spine: cognitiveSpine,
      // NEW: consumer-grade “memory handoff” (portable, cross-LLM)
      portable_memory: portableMemory,
      conversation_fingerprint: {
        algorithm: 'sha256',
        transcript_format: 'ROLE:\\nCONTENT (messages separated by \\n\\n<|RL4_MSG|>\\n\\n)',
        sha256: transcriptSha256
      },
      metadata: {
        messages: normalizedMessages.length,
        messages_original: this.messages.length,
        original_size_chars: originalSize,
        digest_size_chars: 0,
        bundle_size_chars: 0,
        compression_digest: '0x',
        compression_bundle: '0x',
        generated_at: nowIso
      },
      checksum: '' // computed later
    };

    // Optional: include full-fidelity transcript (no loss of context, but more tokens).
    if (this.options.includeTranscript && this.options.outputMode !== 'ultra' && this.options.outputMode !== 'ultra_plus') {
      digest.transcript_compact = transcriptCompact;
      digest.transcript_format = 'ROLE:\\nCONTENT (messages separated by \\n\\n<|RL4_MSG|>\\n\\n)';
    }

    // Compression metric: original conversation chars / digest-without-transcript chars (10–20x goal)
    const canonicalNoTranscript =
      typeof canonicalize === 'function' ? canonicalize(digestWithoutTranscript) : digestWithoutTranscript;
    const jsonNoTranscript = JSON.stringify(canonicalNoTranscript);

    const canonicalDigest = typeof canonicalize === 'function' ? canonicalize(digest) : digest;
    const digestJson = JSON.stringify(canonicalDigest);

    digest.metadata.digest_size_chars = digestJson.length;
    digest.metadata.compression_digest = this.calculateCompressionRatio(originalSize, jsonNoTranscript.length);
    digest.metadata.bundle_size_chars = digestJson.length;
    digest.metadata.compression_bundle = this.calculateCompressionRatio(originalSize, digestJson.length);

    // If ultra mode requested, emit an even smaller payload (lossy on non-critical fields).
    if (this.options.outputMode === 'ultra' || this.options.outputMode === 'ultra_plus') {
      // Pre-compute stable hashes for decision choices (without storing full text in Ultra/Ultra+).
      const decision_choice_sha256 = {};
      try {
        for (const d of Array.isArray(digest.decisions) ? digest.decisions : []) {
          const id = String(d?.id || '');
          if (!id) continue;
          const full = String(d?.chosen_option || '');
          if (!full) continue;
          decision_choice_sha256[id] = await this._sha256Hex(full);
        }
      } catch (_) {
        // If hashing fails, proceed without hashes (best effort).
      }

      const ultra = this._buildUltraSnapshot({
        digest,
        originalSize,
        transcriptSha256,
        messages: normalizedMessages,
        semanticHints: this.options.outputMode === 'ultra_plus',
        decision_choice_sha256
      });
      const canonicalUltra = typeof canonicalize === 'function' ? canonicalize(ultra) : ultra;
      ultra.checksum = await calculateChecksum(canonicalUltra);
      return ultra;
    }

    digest.checksum = await calculateChecksum(digest);
    return digest;
  }

  /**
   * Build an ultra-compressed, LLM-safe context package.
   * Goals:
   * - Remove transcript/messages arrays entirely
   * - Drop message_refs (space waste)
   * - Keep only high-weight topics and high-confidence/critical decisions
   * - Replace timeline_summary with 5–7 macro phases (non-semantic, no hallucination)
   *
   * @param {{digest:any, originalSize:number, transcriptSha256:string, messages:Array<any>}} input
   * @returns {any}
   */
  _buildUltraSnapshot(input) {
    const digest = input && input.digest ? input.digest : {};
    const msgs = Array.isArray(input?.messages) ? input.messages : [];
    const originalSize = typeof input?.originalSize === 'number' ? input.originalSize : 0;
    const nowIso = digest.timestamp || new Date().toISOString();
    const semanticHints = !!input?.semanticHints;
    const decisionChoiceSha = input?.decision_choice_sha256 && typeof input.decision_choice_sha256 === 'object'
      ? input.decision_choice_sha256
      : {};

    // 1) Prune topics: keep only strong topics and drop message_refs arrays.
    const topics = Array.isArray(digest.topics) ? digest.topics : [];
    const prunedTopics = topics
      .filter((t) => (t && typeof t.weight === 'number' ? t.weight : 0) > 700)
      .map((t) => ({
        label: t.label,
        weight: t.weight,
        summary: t.summary
      }));

    // 2) Prune decisions: keep only high confidence OR critical intents (structural, not semantic).
    const criticalIntents = new Set(['decide', 'recommend']);
    const decisions = Array.isArray(digest.decisions) ? digest.decisions : [];
    const prunedDecisions = decisions
      .filter((d) => {
        const c = typeof d?.confidence_llm === 'number' ? d.confidence_llm : 0;
        const intent = String(d?.intent || '');
        return c > 80 || criticalIntents.has(intent);
      })
      .map((d) => ({
        id: d.id,
        intent: d.intent,
        // Keep enough to be actionable (still bounded), plus a hash of the full choice for integrity.
        choice: this._excerpt(d.chosen_option || '', 240),
        choice_sha256: decisionChoiceSha[String(d.id || '')] || '',
        rationale: this._excerpt(d.intent_text || '', 140)
      }));

    // 3) Macro timeline: 5–7 entries max, grouped by message ranges only (no semantic labeling).
    const timeline_macro = this._timelineMacro(msgs, { maxPhases: 6 });
    const portable_memory = this._portableMemory({
      messages: msgs,
      topics: Array.isArray(digest.topics) ? digest.topics : [],
      decisions: Array.isArray(digest.decisions) ? digest.decisions : [],
      timeline_macro,
      mode: semanticHints ? 'ultra_plus' : 'ultra'
    });

    const ultraProtocol = semanticHints ? 'RCEP_v2_UltraPlus' : 'RCEP_v2_Ultra';
    const ultra = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        notice: 'RCEP™ is a trademark claim. Do not remove this header.',
        mode: semanticHints ? 'ultra_plus' : 'ultra'
      },
      protocol: ultraProtocol,
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RCEP™',
        generator: 'rl4-snapshot-extension',
        mode: semanticHints ? 'ultra_plus' : 'ultra'
      },
      session_id: digest.session_id || `conv-${Date.now().toString(16)}`,
      timestamp: nowIso,
      context_state: {
        ...(digest.context_state || {}),
        status: semanticHints ? 'Ultra+ generated' : 'Ultra generated'
      },
      topics: prunedTopics,
      decisions: prunedDecisions,
      timeline_macro,
      portable_memory,
      ...(semanticHints
        ? this._ultraSemanticHints({
            digest,
            prunedTopics,
            prunedDecisions,
            rawDecisions: Array.isArray(digest.decisions) ? digest.decisions : [],
            timeline_macro,
            messages: msgs
          })
        : {}),
      conversation_fingerprint: {
        algorithm: 'sha256',
        sha256: String(input?.transcriptSha256 || '')
      },
      metadata: {
        total_messages: msgs.length,
        generated_at: nowIso,
        compression_ratio: '0x'
      },
      checksum: ''
    };

    const ultraJson = JSON.stringify(typeof canonicalize === 'function' ? canonicalize(ultra) : ultra);
    ultra.metadata.compression_ratio = this.calculateCompressionRatio(originalSize, ultraJson.length);
    return ultra;
  }

  /**
   * Minimal semantic hints for Ultra mode (no transcript).
   * Must be non-inventive: derived only from existing fields (topics/decisions/timeline/context_state).
   * @param {{digest:any, prunedTopics:any[], prunedDecisions:any[], timeline_macro:any[]}} input
   * @returns {{context_summary_ultra:string, validation_checklist:string[], unknowns:Array<{term:string, reason:string}>}}
   */
  _ultraSemanticHints(input) {
    const digest = input && input.digest ? input.digest : {};
    const topics = Array.isArray(input?.prunedTopics) ? input.prunedTopics : [];
    const decisions = Array.isArray(input?.prunedDecisions) ? input.prunedDecisions : [];
    const rawDecisions = Array.isArray(input?.rawDecisions) ? input.rawDecisions : [];
    const timeline = Array.isArray(input?.timeline_macro) ? input.timeline_macro : [];
    const messages = Array.isArray(input?.messages) ? input.messages : [];

    const core = String(digest?.context_state?.core_subject || '').trim();
    const goal = String(digest?.context_state?.current_goal || '').trim();
    const topicLabels = topics.map((t) => t.label).filter(Boolean).slice(0, 6);
    const decisionIntents = decisions.map((d) => d.intent).filter(Boolean).slice(0, 4);

    const summaryParts = [];
    if (core) summaryParts.push(`Subject: ${core}.`);
    if (goal) summaryParts.push(`Goal: ${goal}.`);
    if (topicLabels.length) summaryParts.push(`Topics: ${topicLabels.join(', ')}.`);
    if (decisionIntents.length) summaryParts.push(`Decisions: ${decisionIntents.join(', ')}.`);
    if (timeline.length) summaryParts.push(`Timeline: ${timeline.length} phases.`);
    let context_summary_ultra = summaryParts.join(' ');
    if (context_summary_ultra.length > 280) context_summary_ultra = context_summary_ultra.slice(0, 277) + '...';

    // Extract checklist items from decision "choice" text (often contains explicit "If ..." / "Si ..." clauses).
    const checklist = [];
    const src = decisions.map((d) => String(d.choice || '')).join(' ');
    const candidates = src
      .split(/[\n\r]+|(?<=\.)\s+|(?<=\!)\s+|(?<=\?)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const c of candidates) {
      const isIf = /^if\s+/i.test(c);
      const isSi = /^si\s+/i.test(c);
      if (!isIf && !isSi) continue;
      const item = c.replace(/\s+/g, ' ').trim();
      if (item.length < 8) continue;
      checklist.push(item.length > 160 ? item.slice(0, 157) + '...' : item);
      if (checklist.length >= 6) break;
    }

    // Identify ambiguous tokens (do NOT define them, just flag them).
    const suspicious = new Set();
    const addIfSuspicious = (w) => {
      const t = String(w || '').trim();
      if (!t) return;
      if (/\d/.test(t) || /^vm\d+/i.test(t) || /[_-]/.test(t)) suspicious.add(t);
      if (/^ncontent$/i.test(t)) suspicious.add(t);
    };
    for (const t of topicLabels) addIfSuspicious(t);
    for (const ph of timeline) {
      const s = String(ph?.summary || '');
      const m = s.match(/Keywords:\s*([^•]+)/i);
      if (m && m[1]) {
        for (const raw of m[1].split(',')) addIfSuspicious(raw.trim());
      }
    }

    const unknowns = [...suspicious]
      .slice(0, 6)
      .map((term) => ({ term, reason: 'Observed token; meaning not defined in Ultra payload.' }));

    // "Honesty layer": make it explicit that this package preserves structure, not truth.
    const semantic_validation = {
      status: 'unverified',
      scope: 'structure_only',
      reason: 'Ultra+ does not include the full transcript; semantic correctness is not validated.',
      recommended_checks: [
        'List the hidden assumptions required for the decisions to be correct.',
        'Find at least 3 counterexamples / contradictions to the implied reasoning.',
        'State what evidence would change the conclusion (falsifiability).'
      ]
    };

    // Extract a few assumption-like statements (if explicitly stated) from the live messages.
    // This is still lossy: we only keep short excerpts and we do NOT claim they are true.
    const assumptions_candidates = [];
    const assumptionsSeen = new Set();
    const stripQuotedPrefix = (text) => {
      let t = String(text || '').trim();
      if (!t) return '';
      // ChatGPT UI often includes "You said:" / "Vous avez dit :" echoes inside the conversation.
      t = t.replace(/^\s*(vous\s+avez\s+dit\s*:|you\s+said\s*:)\s*/i, '');
      // Also strip simple "User:" / "Utilisateur:" echoes when present
      t = t.replace(/^\s*(user|utilisateur)\s*:\s*/i, '');
      return t.trim();
    };

    const looksLikeCodeOrLogs = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      // Very long single-line blobs are almost always code/log dumps (CSS, minified, stack traces)
      const lines = t.split(/\r?\n/);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      if (longest > 240) return true;
      // Common signals for shell/code/log noise
      if (/^\s*(\$|#|>|\w+@[\w.-]+).*%?\s/.test(t)) return true; // prompts
      if (/\b(import|export|const|let|var|function|class|def|async|await|return)\b/.test(t)) return true;
      if (/^\s*#!/.test(t)) return true;
      if (/(Traceback|Exception|Error:|stack|at\s+\w+\s+\(|VM\d+:)/i.test(t)) return true;
      if (/[{}[\];]{6,}/.test(t)) return true;
      if (/\/Users\/|\\Users\\|\/home\/|C:\\\\/.test(t)) return true; // paths
      return false;
    };
    const assumptionMarkers = [
      /\b(assume|assumption|hypothesis|suppose|let's\s+assume|we\s+assume)\b/i,
      /\b(hypoth[eè]se|supposons|on\s+suppose|admettons)\b/i
    ];
    for (const m of messages) {
      const text = stripQuotedPrefix(String(m?.content || ''));
      if (!text) continue;
      // Avoid huge dumps (often nested JSON / code); Ultra+ should stay light.
      if (text.length > 1200) continue;
      if (looksLikeCodeOrLogs(text)) continue;
      const cleaned = this._excerpt(text);
      if (!cleaned) continue;
      if (!assumptionMarkers.some((re) => re.test(cleaned))) continue;
      const norm = stripQuotedPrefix(cleaned).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm) continue;
      if (assumptionsSeen.has(norm)) continue;
      assumptionsSeen.add(norm);
      assumptions_candidates.push(cleaned);
      if (assumptions_candidates.length >= 6) break;
    }

    // Semantic spine (Ultra+ hybrid): a tiny, non-inventive “why/how to continue” layer.
    const findMainTension = () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (String(m?.role || '') !== 'user') continue;
        const t = stripQuotedPrefix(String(m?.content || ''));
        if (!t) continue;
        if (looksLikeCodeOrLogs(t)) continue;
        // Prefer explicit questions / blockers (most recent)
        if (/\?/.test(t) || /\b(error|fails?|broken|cannot|can't|doesn't|issue|problem|blocked)\b/i.test(t)) {
          return this._excerpt(t, 160);
        }
      }
      return 'UNKNOWN';
    };

    const open_questions = [];
    const openQuestionsSeen = new Set();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t) continue;
      if (!/\?/.test(t)) continue;
      if (looksLikeCodeOrLogs(t)) continue;
      const ex = this._excerpt(t, 160);
      if (!ex || ex === 'UNKNOWN') continue;
      const norm = stripQuotedPrefix(ex).toLowerCase();
      if (openQuestionsSeen.has(norm)) continue;
      openQuestionsSeen.add(norm);
      open_questions.push(ex);
      if (open_questions.length >= 5) break;
    }

    // Use the first (strongest) decision as the “key decision”.
    const primaryDecision =
      decisions.find((d) => {
        const c = String(d?.choice || '');
        return c && c !== 'UNKNOWN' && c.length >= 24;
      }) || decisions[0] || null;
    const falsifyIf = checklist[0] || 'UNKNOWN';

    // Rejected alternatives (best effort) from the raw decision options.
    const rejected_alternatives = [];
    if (rawDecisions.length) {
      const rd = rawDecisions.find((d) => String(d?.id || '') === String(primaryDecision?.id || '')) || rawDecisions[0];
      const chosen = String(rd?.chosen_option || '').trim();
      const opts = Array.isArray(rd?.options_considered) ? rd.options_considered : [];
      for (const o of opts) {
        const opt = String(o?.option || '').trim();
        if (!opt) continue;
        if (chosen && opt === chosen) continue;
        const ex = this._excerpt(opt, 120);
        if (!ex) continue;
        if (rejected_alternatives.includes(ex)) continue;
        rejected_alternatives.push(ex);
        if (rejected_alternatives.length >= 3) break;
      }
    }

    const semantic_spine = {
      core_context: context_summary_ultra || 'UNKNOWN',
      main_tension: findMainTension(),
      key_decision: {
        statement: primaryDecision ? String(primaryDecision.choice || '') : 'UNKNOWN',
        why: primaryDecision ? String(primaryDecision.rationale || '') : 'No high-confidence decisions extracted.',
        choice_sha256: primaryDecision ? String(primaryDecision.choice_sha256 || '') : '',
        falsify_if: falsifyIf
      },
      assumptions: assumptions_candidates.length ? assumptions_candidates.slice(0, 5) : ['UNKNOWN'],
      rejected_alternatives: rejected_alternatives.length ? rejected_alternatives : [],
      open_questions: open_questions.length ? open_questions : []
    };

    return {
      context_summary_ultra,
      validation_checklist: checklist,
      unknowns,
      semantic_validation,
      assumptions_candidates,
      semantic_spine
    };
  }

  /**
   * Digest cognitive spine: compact, non-inventive “what was kept + why/how to continue”.
   * This lives in RCEP_v1 Digest to make it reusable across LLMs even without transcript.
   * @param {{digestTopics:any[], digestDecisions:any[], digestInsights:any[], timeline_macro:any[], messages:any[]}} input
   * @returns {any}
   */
  _digestCognitiveSpine(input) {
    const topics = Array.isArray(input?.digestTopics) ? input.digestTopics : [];
    const decisions = Array.isArray(input?.digestDecisions) ? input.digestDecisions : [];
    const insights = Array.isArray(input?.digestInsights) ? input.digestInsights : [];
    const timeline = Array.isArray(input?.timeline_macro) ? input.timeline_macro : [];
    const messages = Array.isArray(input?.messages) ? input.messages : [];

    const stripQuotedPrefix = (text) => {
      let t = String(text || '').trim();
      if (!t) return '';
      t = t.replace(/^\s*(vous\s+avez\s+dit\s*:|you\s+said\s*:)\s*/i, '');
      t = t.replace(/^\s*(user|utilisateur)\s*:\s*/i, '');
      return t.trim();
    };

    const looksLikeCodeOrLogs = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      const lines = t.split(/\r?\n/);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      if (longest > 240) return true;
      if (/^\s*(\$|#|>|\w+@[\w.-]+).*%?\s/.test(t)) return true;
      if (/\b(import|export|const|let|var|function|class|def|async|await|return)\b/.test(t)) return true;
      if (/(Traceback|Exception|Error:|stack|VM\d+:)/i.test(t)) return true;
      if (/[{}[\];]{6,}/.test(t)) return true;
      return false;
    };

    const core_context = (() => {
      const labels = topics.map((t) => String(t?.label || '').trim()).filter(Boolean).slice(0, 6);
      const bits = [];
      if (labels.length) bits.push(`Topics: ${labels.join(', ')}.`);
      if (timeline.length) bits.push(`Timeline: ${timeline.length} phases.`);
      if (insights.length) {
        bits.push(
          `Signals: ${insights
            .slice(0, 2)
            .map((x) => this._excerpt(String(x || ''), 120))
            .filter(Boolean)
            .join(' | ')}.`
        );
      }
      const s = bits.join(' ');
      return s ? this._excerpt(s, 260) : 'UNKNOWN';
    })();

    const main_tension = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (String(m?.role || '') !== 'user') continue;
        const t = stripQuotedPrefix(String(m?.content || ''));
        if (!t || looksLikeCodeOrLogs(t)) continue;
        if (
          /\?/.test(t) ||
          /\b(blocked|bloqu[eé]|bug|issue|problem|doesn't work|marche pas|error|fails?)\b/i.test(t)
        ) {
          return this._excerpt(t, 180);
        }
      }
      return 'UNKNOWN';
    })();

    const open_questions = [];
    const oqSeen = new Set();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || !/\?/.test(t) || looksLikeCodeOrLogs(t)) continue;
      const ex = this._excerpt(t, 180);
      const norm = stripQuotedPrefix(ex).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm || oqSeen.has(norm)) continue;
      oqSeen.add(norm);
      open_questions.push(ex);
      if (open_questions.length >= 5) break;
    }

    // IMPROVED: Broader decision criteria patterns (capture more reasoning signals)
    const decision_criteria = [];
    const critSeen = new Set();
    const critRe =
      /\b(because|since|therefore|so that|trade-?off|risk|car|parce que|donc|du coup|risque|pour éviter|pour que|afin de|garantir|assurer|éviter|pour|caractéristique|avantage|inconvénient|bénéfice|coût)\b/i;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'assistant') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!critRe.test(t)) continue;
      const ex = this._excerpt(t, 200);
      const norm = ex.toLowerCase();
      if (critSeen.has(norm)) continue;
      critSeen.add(norm);
      decision_criteria.push(ex);
      if (decision_criteria.length >= 6) break; // Increased from 4 to 6 for XXL chats
    }

    // IMPROVED: Capture implicit assumptions (not just explicit markers)
    const assumptions = [];
    const aSeen = new Set();
    const explicitMarkers = [
      /\b(assume|assumption|hypothesis|suppose|let's\s+assume|we\s+assume)\b/i,
      /\b(hypoth[eè]se|supposons|on\s+suppose|admettons)\b/i
    ];
    // Implicit assumption patterns: "on garde X", "sans Y", "pas de Z", "X est stable", etc.
    const implicitPatterns = [
      /\b(on\s+garde|we\s+keep|keep\s+the|gardons)\b/i,
      /\b(sans|without|pas\s+de|no\s+need\s+for)\b/i,
      /\b(est\s+stable|is\s+stable|sont\s+stables|are\s+stable)\b/i,
      /\b(simple|simples|gratuit|gratuits|free)\b/i,
      /\b(comme\s+avant|as\s+before|same\s+as)\b/i
    ];

    // First pass: explicit assumptions
    for (const m of messages) {
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t) continue;
      if (t.length > 1200) continue;
      if (looksLikeCodeOrLogs(t)) continue;
      if (!explicitMarkers.some((re) => re.test(t))) continue;
      const ex = this._excerpt(t, 180);
      const norm = stripQuotedPrefix(ex).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm || aSeen.has(norm)) continue;
      aSeen.add(norm);
      assumptions.push(ex);
      if (assumptions.length >= 5) break;
    }

    // Second pass: implicit assumptions (prioritize recent messages for XXL chats)
    if (assumptions.length < 5) {
      for (let i = messages.length - 1; i >= 0 && assumptions.length < 5; i--) {
        const m = messages[i];
        const t = stripQuotedPrefix(String(m?.content || ''));
        if (!t || t.length > 1200 || looksLikeCodeOrLogs(t)) continue;
        if (!implicitPatterns.some((re) => re.test(t))) continue;
        const ex = this._excerpt(t, 180);
        const norm = stripQuotedPrefix(ex).toLowerCase().replace(/\s+/g, ' ').trim();
        if (!norm || aSeen.has(norm)) continue;
        aSeen.add(norm);
        assumptions.push(ex);
      }
    }

    const primary =
      decisions.find((d) => String(d?.chosen_option || '').trim() && String(d?.chosen_option || '').trim() !== 'UNKNOWN') ||
      decisions[0] ||
      null;

    // IMPROVED: Search for rejected alternatives in conversation context (not just options_considered)
    const rejected_alternatives = [];
    const altSeen = new Set();

    // First: try explicit options_considered (if available)
    if (primary && Array.isArray(primary.options_considered)) {
      const chosen = String(primary?.chosen_option || '').trim();
      for (const o of primary.options_considered) {
        const opt = String(o?.option || '').trim();
        if (!opt || opt === 'UNKNOWN' || (chosen && opt === chosen)) continue;
        const ex = this._excerpt(opt, 140);
        if (!ex) continue;
        const norm = ex.toLowerCase();
        if (altSeen.has(norm)) continue;
        altSeen.add(norm);
        rejected_alternatives.push(ex);
        if (rejected_alternatives.length >= 3) break;
      }
    }

    // Second: search conversation context for alternative/rejection signals (for XXL chats)
    if (rejected_alternatives.length < 3) {
      const altPatterns = [
        /\b(au lieu de|instead of|plutôt que|rather than|vs|versus|ou bien|or else)\b/i,
        /\b(sans|without|pas de|no\s+need|rejeter|reject|abandon|abandonner)\b/i,
        /\b(ne\s+pas|don't|not\s+using|not\s+using|éviter|avoid)\b/i
      ];
      for (let i = messages.length - 1; i >= 0 && rejected_alternatives.length < 3; i--) {
        const m = messages[i];
        const t = stripQuotedPrefix(String(m?.content || ''));
        if (!t || looksLikeCodeOrLogs(t) || t.length > 600) continue;
        if (!altPatterns.some((re) => re.test(t))) continue;
        const ex = this._excerpt(t, 140);
        const norm = ex.toLowerCase();
        if (!norm || altSeen.has(norm)) continue;
        altSeen.add(norm);
        rejected_alternatives.push(ex);
      }
    }

    // IMPROVED: Better falsify_if heuristic (use decision criteria, open questions, or rejected alternatives)
    const falsifyIf =
      decision_criteria[0] || rejected_alternatives[0] || open_questions[0] || main_tension !== 'UNKNOWN' ? main_tension : 'UNKNOWN';

    return {
      core_context,
      main_tension,
      key_decision: {
        statement: primary ? this._excerpt(String(primary.chosen_option || ''), 260) : 'UNKNOWN',
        why: primary ? this._excerpt(String(primary.intent_text || ''), 180) : 'UNKNOWN',
        falsify_if: falsifyIf
      },
      decision_criteria,
      rejected_alternatives,
      assumptions: assumptions.length ? assumptions : ['UNKNOWN'],
      open_questions
    };
  }

  /**
   * Portable memory: consumer-grade, cross-LLM handoff.
   * Non-inventive: extracts only short excerpts from messages and structured fields.
   *
   * @param {{messages:any[], topics:any[], decisions:any[], timeline_macro:any[], mode:string}} input
   * @returns {{
   *  handoff_title:string,
   *  identity:string[],
   *  current_objective:string,
   *  non_negotiables:string[],
   *  decisions_made:string[],
   *  next_steps:string[],
   *  open_questions:string[]
   * }}
   */
  _portableMemory(input) {
    const messages = Array.isArray(input?.messages) ? input.messages : [];
    const topics = Array.isArray(input?.topics) ? input.topics : [];
    const timeline = Array.isArray(input?.timeline_macro) ? input.timeline_macro : [];

    const stripQuotedPrefix = (text) => {
      let t = String(text || '').trim();
      if (!t) return '';
      t = t.replace(/^\s*(vous\s+avez\s+dit\s*:|you\s+said\s*:)\s*/i, '');
      t = t.replace(/^\s*(user|utilisateur)\s*:\s*/i, '');
      return t.trim();
    };

    const looksLikeCodeOrLogs = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      const lines = t.split(/\r?\n/);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      if (longest > 240) return true;
      if (/^\s*(\$|#|>|\w+@[\w.-]+).*%?\s/.test(t)) return true;
      if (/\b(import|export|const|let|var|function|class|def|async|await|return)\b/i.test(t)) return true;
      if (/(Traceback|Exception|Error:|stack|VM\d+:)/i.test(t)) return true;
      if (/[{}[\];]{6,}/.test(t)) return true;
      if (/\/Users\/|\\Users\\|\/home\/|C:\\\\/.test(t)) return true;
      return false;
    };

    // Filter out micro-instructions about formatting/copy/paste/etc.
    const looksLikeFormattingInstruction = (text) => {
      const t = String(text || '').toLowerCase();
      if (!t) return false;
      return (
        /\b(copy|paste|copier|coller|markdown|mermaid|json|container|fichier|file)\b/i.test(t) ||
        /\b(mets|mets-moi|met|format|retranscri|retranscrire|sorts? moi)\b/i.test(t)
      );
    };

    const looksLikeRawJsonPaste = (text) => {
      const t = String(text || '');
      if (!t) return false;
      // Common when user pastes snapshots or JSON blobs into chat
      if (t.includes('"protocol"') && t.includes('{') && t.includes('}')) return true;
      if (t.includes('"session_id"') && t.includes('"timestamp"')) return true;
      if (t.length > 800 && /[{[][\\s\\S]*[}\\]]/.test(t)) return true;
      return false;
    };

    const pushDedup = (arr, seen, text, maxLen) => {
      const ex = this._excerpt(stripQuotedPrefix(text), maxLen);
      const norm = stripQuotedPrefix(ex).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!ex || !norm) return;
      if (seen.has(norm)) return;
      seen.add(norm);
      arr.push(ex);
    };

    // Identity extraction (project/name/context anchors)
    const identity = [];
    const idSeen = new Set();
    const idPatterns = [
      /\b(le\s+projet\s+s'appelle|project\s+is\s+called|project\s+called)\b/i,
      /\b(je\s+m'appelle|my\s+name\s+is)\b/i,
      /\b(nom\s+du\s+projet|project\s+name)\b/i
    ];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!idPatterns.some((re) => re.test(t))) continue;
      pushDedup(identity, idSeen, t, 220);
      if (identity.length >= 2) break;
    }

    // Current objective: recent user “I want / we need / objectif / goal …” that is NOT formatting-only.
    let current_objective = 'UNKNOWN';
    const goalPatterns = [
      /\b(je\s+veux|i\s+want|we\s+need|objectif|goal|but\s*:|current\s+goal|il\s+faut|on\s+doit)\b/i
    ];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!goalPatterns.some((re) => re.test(t))) continue;
      if (looksLikeFormattingInstruction(t)) continue;
      if (looksLikeRawJsonPaste(t)) continue;
      current_objective = this._excerpt(t, 220) || 'UNKNOWN';
      break;
    }

    // Non-negotiables / preferences: “we keep”, “no X”, “sans”, “must not”, etc.
    const non_negotiables = [];
    const nnSeen = new Set();
    const nnPatterns = [
      /\b(on\s+garde|we\s+keep|keep\s+the|sans|without|pas\s+de|no\s+need|must\s+not|do\s+not|ne\s+pas)\b/i,
      /\b(stable|simples?|gratuit|free|local\s+first)\b/i
    ];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!nnPatterns.some((re) => re.test(t))) continue;
      if (looksLikeFormattingInstruction(t)) continue;
      if (looksLikeRawJsonPaste(t)) continue;
      pushDedup(non_negotiables, nnSeen, t, 200);
      if (non_negotiables.length >= 5) break;
    }

    // Decisions made: prefer assistant “we will / we keep / decision” lines, and user commits that are not formatting-only.
    const decisions_made = [];
    const dmSeen = new Set();
    const dmPatterns = [
      /\b(decision\s*:|décision\s*:|on\s+garde|we\s+keep|we\s+will|on\s+va|we're\s+going\s+to)\b/i
    ];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const role = String(m?.role || '');
      if (role !== 'assistant' && role !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!dmPatterns.some((re) => re.test(t))) continue;
      if (looksLikeFormattingInstruction(t)) continue;
      if (looksLikeRawJsonPaste(t)) continue;
      pushDedup(decisions_made, dmSeen, t, 220);
      if (decisions_made.length >= 5) break;
    }

    // Next steps: assistant “next/then/ensuite/step” lines (most recent)
    const next_steps = [];
    const nsSeen = new Set();
    const nsPatterns = [
      /\b(next|then|step|ensuite|puis|prochaine\s+étape|on\s+va)\b/i
    ];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'assistant') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!nsPatterns.some((re) => re.test(t))) continue;
      if (looksLikeFormattingInstruction(t)) continue;
      if (looksLikeRawJsonPaste(t)) continue;
      pushDedup(next_steps, nsSeen, t, 200);
      if (next_steps.length >= 4) break;
    }

    // Open questions: user questions that aren’t just formatting (keep bounded)
    const open_questions = [];
    const oqSeen = new Set();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = stripQuotedPrefix(String(m?.content || ''));
      if (!t || looksLikeCodeOrLogs(t)) continue;
      if (!/\?/.test(t)) continue;
      if (looksLikeFormattingInstruction(t)) continue;
      if (looksLikeRawJsonPaste(t)) continue;
      pushDedup(open_questions, oqSeen, t, 200);
      if (open_questions.length >= 6) break;
    }

    // A tiny title: derived (non-inventive) from identity/goal/topics.
    const topicHints = topics
      .map((t) => String(t?.label || '').trim())
      .filter(Boolean)
      .filter((w) => !/^\w+@[\w.-]+$/.test(w) && !/\/users\//i.test(w))
      .slice(0, 2);
    const titleParts = [];
    if (identity[0]) titleParts.push(identity[0]);
    else if (current_objective !== 'UNKNOWN') titleParts.push(current_objective);
    if (topicHints.length) titleParts.push(`Themes: ${topicHints.join(', ')}`);
    if (timeline.length) titleParts.push(`${timeline.length} phases`);
    let handoff_title = titleParts.length ? titleParts.join(' — ') : 'Cross‑LLM memory handoff';
    handoff_title = this._excerpt(handoff_title, 140) || 'Cross‑LLM memory handoff';

    return {
      handoff_title,
      identity: identity.length ? identity : ['UNKNOWN'],
      current_objective,
      non_negotiables,
      decisions_made,
      next_steps,
      open_questions
    };
  }

  /**
   * Generate partial snapshot when budget exceeded
   * @param {string} reason
   * @param {Object} partialData
   * @returns {Object}
   */
  generatePartialSnapshot(reason, partialData = {}) {
    const nowIso = new Date().toISOString();
    const sessionId = this._pickSessionId(nowIso);
    const base = {
      version: '0.1.0',
      session_id: sessionId,
      timestamp: nowIso,
      partial: true,
      partial_reason: reason,
      topics: [],
      decisions: [],
      insights: [],
      context_summary: '',
      // Keep raw messages in partial mode (debugging / safety).
      messages: this.messages.map((m) => ({ ...m, session_id: sessionId })), // normalize ids
      metadata: {
        messages: this.messages.length,
        bundle_ratio: 'N/A (partial)',
        compression: 'N/A (partial)',
        generated: nowIso
      },
      checksum: ''
    };
    const snap = { ...base, ...partialData };
    return snap;
  }

  /**
   * Extract 5-10 topics with weights.
   * @returns {Array<{label:string, weight:number, message_refs:string[], summary:string}>}
   */
  extractTopics() {
    try {
      if (typeof extractTopics !== 'function') return [];
      const topics = extractTopics(this.messages);
      return Array.isArray(topics) ? topics : [];
    } catch (e) {
      console.error('[RL4]', 'extractTopics failed', e);
      return [];
    }
  }

  /**
   * Extract decisions with pattern matching.
   * @returns {Array<any>}
   */
  extractDecisions() {
    try {
      if (typeof extractDecisions !== 'function') return [];
      const decisions = extractDecisions(this.messages);
      return Array.isArray(decisions) ? decisions : [];
    } catch (e) {
      console.error('[RL4]', 'extractDecisions failed', e);
      return [];
    }
  }

  /**
   * Extract key insights.
   * @returns {string[]}
   */
  extractInsights() {
    try {
      if (typeof extractInsights !== 'function') return [];
      const insights = extractInsights(this.messages);
      return Array.isArray(insights) ? insights : [];
    } catch (e) {
      console.error('[RL4]', 'extractInsights failed', e);
      return [];
    }
  }

  /**
   * Generate compact summary (max 200 chars).
   * @param {{topics:any[], decisions:any[]}} data
   * @returns {string}
   */
  generateSummary(data) {
    const n = this.messages.length;
    const topTopics = (data.topics || []).slice(0, 3).map((t) => t.label).join(', ');
    const keyDecisions = (data.decisions || []).slice(0, 2).map((d) => d.intent).join(', ');

    let summary = `${n} messages. Topics: ${topTopics || 'none'}. Decisions: ${keyDecisions || 'none'}.`;
    if (summary.length > 200) {
      summary = summary.slice(0, 197) + '...';
    }
    return summary;
  }

  /**
   * Deduplicate messages: remove exact duplicates and filter system messages
   * Keep messages referenced by topics/decisions + unique messages
   * @param {Array} messages
   * @param {Array} topics
   * @param {Array} decisions
   * @returns {Array}
   */
  _deduplicateMessages(messages, topics, decisions) {
    // Collect message IDs referenced by topics/decisions
    const referencedIds = new Set();
    for (const topic of topics || []) {
      for (const ref of topic.message_refs || []) {
        referencedIds.add(ref);
      }
    }
    for (const decision of decisions || []) {
      // Decisions don't have message_refs, but we keep all messages for now
    }

    // Filter system messages (common repetitive patterns)
    const systemPatterns = [
      /Pour exécuter du code, activez l'exécution/i,
      /Pour exécuter du code, activez/i,
      /activez l'exécution de code/i,
      /Paramètres > Capacités/i
    ];

    const seen = new Map(); // content -> first message with this content
    const unique = [];

    for (const msg of messages) {
      const content = (msg.content || '').trim();
      if (!content) continue;

      // Skip system messages
      if (systemPatterns.some((pattern) => pattern.test(content))) {
        continue;
      }

      // Deduplicate: if same content seen before, skip
      const contentKey = content.toLowerCase().slice(0, 200); // First 200 chars for comparison
      if (seen.has(contentKey)) {
        // If this message is referenced, keep it instead of the duplicate
        if (referencedIds.has(msg.id)) {
          const prevIndex = unique.findIndex((m) => seen.get(contentKey) === m.id);
          if (prevIndex >= 0) {
            unique.splice(prevIndex, 1);
            unique.push(msg);
            seen.set(contentKey, msg.id);
          }
        }
        continue;
      }

      seen.set(contentKey, msg.id);
      unique.push(msg);
    }

    return unique;
  }

  /**
   * Encode the full conversation as a single compact string (LLM-readable, no binary).
   * Format:
   *   USER:
   *   ...
   *
   *   <|RL4_MSG|>
   *
   *   ASSISTANT:
   *   ...
   *
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @returns {string}
   */
  _encodeMessagesCompact(messages) {
    const SEP = '\n\n<|RL4_MSG|>\n\n';
    const out = [];
    for (const m of messages || []) {
      const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = String(m.content || '').trim();
      if (!content) continue;
      out.push(`${role}:\n${content}`);
    }
    return out.join(SEP);
  }

  /**
   * SHA-256 hex for a string (used for transcript fingerprint).
   * @param {string} text
   * @returns {Promise<string>}
   */
  async _sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(String(text || ''));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Minimal, non-hallucinated timeline: chunk by message ranges and keep ultra-short excerpts.
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @returns {Array<{range:string, summary:string}>}
   */
  _timelineSummary(messages) {
    const n = Array.isArray(messages) ? messages.length : 0;
    if (!n) return [];
    const chunks = [];
    const size = n <= 12 ? 4 : n <= 30 ? 6 : 8;
    for (let i = 0; i < n; i += size) {
      const start = i + 1;
      const end = Math.min(n, i + size);
      const slice = messages.slice(i, end);
      const first = slice[0];
      const last = slice[slice.length - 1];
      const firstHint = this._excerpt(first?.content || '');
      const lastHint = this._excerpt(last?.content || '');
      chunks.push({
        range: `${start}-${end}`,
        summary: `From: ${first?.role || 'unknown'}(${firstHint}) → To: ${last?.role || 'unknown'}(${lastHint})`
      });
    }
    return chunks;
  }

  /**
   * Macro timeline: group message index ranges into a few phases without inventing meaning.
   * @param {Array<{role:string, content:string}>} messages
   * @param {{maxPhases:number}} opts
   * @returns {Array<{phase:string, range:string, summary:string}>}
   */
  _timelineMacro(messages, opts = {}) {
    const n = Array.isArray(messages) ? messages.length : 0;
    if (!n) return [];
    const maxPhases = Math.max(3, Math.min(7, Number(opts.maxPhases) || 6));

    const size = Math.ceil(n / maxPhases);
    const phases = [];
    for (let i = 0; i < n; i += size) {
      const start = i + 1;
      const end = Math.min(n, i + size);
      const slice = messages.slice(i, end);
      const roles = slice.reduce(
        (acc, m) => {
          const r = m && m.role ? String(m.role) : 'unknown';
          acc[r] = (acc[r] || 0) + 1;
          return acc;
        },
        { user: 0, assistant: 0, unknown: 0 }
      );
      const keywords = this._phaseKeywords(slice, 2);
      const phaseNum = phases.length + 1;
      phases.push({
        phase: `Phase ${phaseNum}`,
        range: `${start}-${end}`,
        summary: keywords.length
          ? `Keywords: ${keywords.join(', ')} • user:${roles.user || 0}, assistant:${roles.assistant || 0}`
          : `Messages ${start}–${end} (user:${roles.user || 0}, assistant:${roles.assistant || 0})`
      });
    }
    return phases.slice(0, 7);
  }

  /**
   * Extract 1–N phase keywords from message slice (non-semantic, frequency-based).
   * This avoids "naming phases" (hallucination) while still giving useful anchors.
   * @param {Array<{content:string}>} slice
   * @param {number} limit
   * @returns {string[]}
   */
  _phaseKeywords(slice, limit = 2) {
    const STOP = new Set([
      // EN
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
      'into',
      'about',
      'then',
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
      'its',
      'our',
      'we',
      'i',
      'me',
      'my',
      // FR
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
      'cela',
      'ceci',
      'etre',
      'être',
      'avoir',
      'faire',
      'fait',
      'faut',
      'vais',
      'va',
      // common chat/meta
      'message',
      'messages',
      'assistant',
      'user',
      'json',
      'rcep',
      'snapshot',
      'checksum',
      'sha256',
      // common dev-noise seen in this project’s chats
      'const',
      'content',
      'object',
      'ncontent',
      'option',
      'phase',
      'summary',
      'range'
    ]);

    const counts = new Map();
    const addTokens = (text) => {
      let t = String(text || '');
      t = t.replace(/```[\s\S]*?```/g, ' ');
      t = t.replace(/`[^`]*`/g, ' ');
      t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
      t = t.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t) return;
      // Keep unicode letters/numbers, split on non-word-ish
      const tokens = t
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean);
      for (const w of tokens) {
        if (w.length < 5) continue;
        if (STOP.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    };

    for (const m of slice || []) addTokens(m && m.content ? m.content : '');

    const scored = [...counts.entries()]
      .map(([w, c]) => ({ w, c }))
      .sort((a, b) => b.c - a.c)
      .slice(0, Math.max(0, Number(limit) || 2))
      .map((x) => x.w);

    return scored;
  }

  _excerpt(text, maxLen = 80) {
    // Keep excerpts clean for any LLM (strip code/markdown noise)
    let t = String(text || '');
    t = t.replace(/```[\s\S]*?```/g, ' ');
    t = t.replace(/`[^`]*`/g, ' ');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');
    // Remove emojis / pictographs (keeps injection text clean)
    try {
      t = t.replace(/\p{Extended_Pictographic}/gu, '');
    } catch (_) {
      // older engines: ignore
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const n = Math.max(24, Number(maxLen) || 80);
    return t.length > n ? t.slice(0, Math.max(0, n - 3)) + '...' : t;
  }

  /**
   * Compress messages JSON with gzip (browser CompressionStream API)
   * @param {string} jsonString
   * @returns {Promise<string>} Base64 encoded compressed data
   */
  async _compressMessages(jsonString) {
    // Use CompressionStream API (available in modern browsers)
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Write data
    const encoder = new TextEncoder();
    writer.write(encoder.encode(jsonString));
    writer.close();

    // Read compressed chunks
    const chunks = [];
    let done = false;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) chunks.push(value);
    }

    // Combine chunks and convert to base64
    const compressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to base64
    const base64 = btoa(String.fromCharCode(...compressed));
    return base64;
  }

  /**
   * originalSize = sum(message.content.length)
   * compressedSize = snapshot JSON size
   * @param {number} originalSize
   * @param {number} compressedSize
   * @returns {string}
   */
  calculateCompressionRatio(originalSize, compressedSize) {
    if (!compressedSize || compressedSize <= 0) return '0x';
    const ratio = originalSize / compressedSize;
    if (!isFinite(ratio) || ratio <= 0) return '0x';
    return `${ratio.toFixed(1)}x`;
  }
}

// Expose globally for popup.html simple script loading (no bundler).
// eslint-disable-next-line no-undef
if (typeof window !== 'undefined') {
  window.RL4SnapshotGenerator = RL4SnapshotGenerator;
}


