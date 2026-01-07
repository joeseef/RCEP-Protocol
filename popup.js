/**
 * RL4 Snapshot Extension - Popup Logic
 * Orchestrates snapshot generation, clipboard copy, and UI updates
 */

let currentSnapshot = null;
let hasSnapshotInThisUiSession = false;
let cachedLastPrompt = '';
let optionsExpanded = false;

const STORAGE_KEYS = {
  LAST_PROMPT: 'rl4_last_prompt_v1',
  CAPTURE_PROGRESS: 'rl4_capture_progress_v1',
  LAST_SNAPSHOT: 'rl4_last_snapshot_v1',
  RL4_BLOCKS: 'rl4_blocks_v1',
  RL4_BLOCKS_STATUS: 'rl4_blocks_status_v1',
  LAST_SUPPORTED_TAB: 'rl4_last_supported_tab_v1'
};

async function getRememberedSupportedTab() {
  try {
    const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SUPPORTED_TAB]);
    const v = res && res[STORAGE_KEYS.LAST_SUPPORTED_TAB] && typeof res[STORAGE_KEYS.LAST_SUPPORTED_TAB] === 'object'
      ? res[STORAGE_KEYS.LAST_SUPPORTED_TAB]
      : null;
    if (!v || typeof v.tabId !== 'number') return null;
    const now = Date.now();
    const fresh = typeof v.updatedAt === 'number' ? now - v.updatedAt < 30 * 60_000 : true;
    if (!fresh) return null;
    try {
      const tab = await chrome.tabs.get(v.tabId);
      return tab && typeof tab.id === 'number' ? tab : null;
    } catch (_) {
      return null;
    }
  } catch (_) {
    return null;
  }
}

async function getTargetActiveTab() {
  // 1) Prefer the last provider tab remembered by background/content scripts.
  const remembered = await getRememberedSupportedTab();
  if (remembered) return remembered;

  // 2) Fallback: active tab in the last focused window (works better than currentWindow when RL4 UI is detached).
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && typeof tab.id === 'number') return tab;
  } catch (_) {}

  // 3) Final fallback.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function saveLastPrompt(prompt) {
  const p = String(prompt || '');
  if (!p) return;
  // Avoid quota issues if someone enables full transcript and it becomes enormous.
  if (p.length > 1_500_000) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_PROMPT]: p });
}

async function loadLastPrompt() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_PROMPT]);
  return res && typeof res[STORAGE_KEYS.LAST_PROMPT] === 'string' ? res[STORAGE_KEYS.LAST_PROMPT] : '';
}

async function loadLastSnapshot() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT]);
  const s = res && res[STORAGE_KEYS.LAST_SNAPSHOT] && typeof res[STORAGE_KEYS.LAST_SNAPSHOT] === 'object'
    ? res[STORAGE_KEYS.LAST_SNAPSHOT]
    : null;
  return s;
}

async function loadRl4BlocksStatus() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.RL4_BLOCKS_STATUS]);
  const s = res && res[STORAGE_KEYS.RL4_BLOCKS_STATUS] && typeof res[STORAGE_KEYS.RL4_BLOCKS_STATUS] === 'object'
    ? res[STORAGE_KEYS.RL4_BLOCKS_STATUS]
    : null;
  return s;
}

function renderRl4BlocksStatus(statusObj) {
  const manualWrap = document.getElementById('rl4BlocksManual');
  const copyFinalBtn = document.getElementById('copyPromptBtn');
  const s = statusObj && typeof statusObj === 'object' ? statusObj : null;
  if (!s || !s.status) {
    manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }

  const status = String(s.status || '');
  if (status === 'awaiting') {
    manualWrap?.classList.remove('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  if (status === 'captured') {
    manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  if (status === 'sealed') {
    manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = false;
    return;
  }
  if (status === 'error') {
    manualWrap?.classList.remove('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  manualWrap?.classList.remove('hidden');
  if (copyFinalBtn) copyFinalBtn.disabled = true;
}

let rl4BlocksPollTimer = null;
function stopRl4BlocksPoll() {
  if (rl4BlocksPollTimer) clearInterval(rl4BlocksPollTimer);
  rl4BlocksPollTimer = null;
}

function startRl4BlocksPoll({ onSealed } = {}) {
  stopRl4BlocksPoll();
  rl4BlocksPollTimer = setInterval(async () => {
    try {
      const s = await loadRl4BlocksStatus();
      renderRl4BlocksStatus(s);
      refreshGuidance().catch(() => {});
      if (s && s.status === 'sealed') {
        stopRl4BlocksPoll();
        onSealed?.(s);
      }
    } catch (_) {
      // ignore
    }
  }, 500);
}

function renderLastPrompt(prompt) {
  const wrap = document.getElementById('lastPrompt');
  const textEl = document.getElementById('lastPromptText');
  if (!wrap || !textEl) return;
  const p = String(prompt || '').trim();
  if (!p) {
    wrap.classList.add('hidden');
    textEl.textContent = '';
    return;
  }
  textEl.textContent = p;
  // Only show last prompt once the user has generated (or restored) a snapshot in this UI session.
  if (hasSnapshotInThisUiSession) wrap.classList.remove('hidden');
}

function setLastPromptExpanded(isExpanded) {
  const wrap = document.getElementById('lastPrompt');
  const textEl = document.getElementById('lastPromptText');
  const btn = document.getElementById('toggleLastPromptBtn');
  if (!wrap || !textEl) return;
  const expanded = !!isExpanded;
  wrap.dataset.expanded = expanded ? 'true' : 'false';
  textEl.style.display = expanded ? 'block' : 'none';
  wrap.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function setOptionsExpanded(isExpanded) {
  const body = document.getElementById('optionsBody');
  const btn = document.getElementById('optionsToggleBtn');
  const expanded = !!isExpanded;
  optionsExpanded = expanded;
  if (body) {
    if (expanded) body.classList.remove('hidden');
    else body.classList.add('hidden');
  }
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function setPostActionsEnabled(enabled) {
  const postActions = document.getElementById('postActions');
  const viewRawBtn = document.getElementById('viewRawBtn');
  const copyEncoderPromptBtn = document.getElementById('copyEncoderPromptBtn');
  const copyLastPromptBtn = document.getElementById('copyLastPromptBtn');
  const rl4BlocksInput = document.getElementById('rl4BlocksInput');
  const finalizeBlocksBtn = document.getElementById('finalizeBlocksBtn');
  const on = !!enabled;

  if (postActions) {
    if (on) postActions.classList.remove('hidden');
    else postActions.classList.add('hidden');
  }

  if (copyEncoderPromptBtn) copyEncoderPromptBtn.disabled = !on;
  if (copyLastPromptBtn) copyLastPromptBtn.disabled = !on;

  // View raw JSON is a link; disable it via aria + pointer events.
  if (viewRawBtn) {
    if (on) {
      viewRawBtn.removeAttribute('aria-disabled');
      viewRawBtn.style.pointerEvents = '';
      viewRawBtn.style.opacity = '';
    } else {
      viewRawBtn.setAttribute('aria-disabled', 'true');
      viewRawBtn.style.pointerEvents = 'none';
      viewRawBtn.style.opacity = '0.55';
    }
  }

  // Keep finalization gated by actual RL4 blocks state, but prevent interaction before snapshot exists.
  if (!on) {
    if (rl4BlocksInput) rl4BlocksInput.disabled = true;
    if (finalizeBlocksBtn) finalizeBlocksBtn.disabled = true;
  } else {
    if (rl4BlocksInput) rl4BlocksInput.disabled = false;
    // finalizeBlocksBtn is enabled only when text is present (handled in click path) — keep it enabled.
    if (finalizeBlocksBtn) finalizeBlocksBtn.disabled = false;
  }
}

function clearGuidanceGlow() {
  const ids = [
    'generateBtn',
    'copyEncoderPromptBtn',
    'rl4BlocksManual',
    'rl4BlocksInput',
    'finalizeBlocksBtn',
    'copyPromptBtn',
    'metadata',
    'postActions'
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.remove('rl4-guide-cta');
    el.classList.remove('rl4-guide-container');
    el.classList.remove('rl4-guide-input');
  }
}

function setGuidanceStep(step) {
  clearGuidanceGlow();
  const s = String(step || '');
  const glowCta = (id) => document.getElementById(id)?.classList.add('rl4-guide-cta');
  const glowBox = (id) => document.getElementById(id)?.classList.add('rl4-guide-container');
  const glowInput = (id) => document.getElementById(id)?.classList.add('rl4-guide-input');

  if (s === 'generate') {
    glowCta('generateBtn');
    return;
  }
  if (s === 'encode') {
    glowBox('postActions');
    glowCta('copyEncoderPromptBtn');
    return;
  }
  if (s === 'paste_response') {
    glowBox('rl4BlocksManual');
    glowInput('rl4BlocksInput');
    return;
  }
  if (s === 'finalize') {
    glowBox('rl4BlocksManual');
    glowCta('finalizeBlocksBtn');
    return;
  }
  if (s === 'copy_final') {
    glowBox('postActions');
    glowCta('copyPromptBtn');
    return;
  }
}

async function computeGuidanceStep() {
  // Default: push user to Generate Context.
  if (!hasSnapshotInThisUiSession || !currentSnapshot) return 'generate';

  // If blocks are already sealed -> copy final snapshot.
  try {
    const s = await loadRl4BlocksStatus();
    const st = s && s.status ? String(s.status) : '';
    if (st === 'sealed') return 'copy_final';
    if (st === 'awaiting' || st === 'error') {
      const ta = document.getElementById('rl4BlocksInput');
      const hasText = ta ? String(ta.value || '').trim().length > 0 : false;
      return hasText ? 'finalize' : 'paste_response';
    }
    if (st === 'captured') return 'finalize';
  } catch (_) {}

  // Snapshot exists but not finalized -> encode next.
  return 'encode';
}

async function refreshGuidance() {
  try {
    const step = await computeGuidanceStep();
    setGuidanceStep(step);
  } catch (_) {
    // ignore
  }
}

function resetUiForNewRun() {
  try {
    stopProgressPoll();
    stopRl4BlocksPoll();
  } catch (_) {}

  hasSnapshotInThisUiSession = false;
  currentSnapshot = null;

  // UI reset
  try {
    const meta = document.getElementById('metadata');
    meta?.classList.add('hidden');
    if (meta) meta.style.display = 'none';
    const mc = document.getElementById('messageCount');
    const cr = document.getElementById('compressionRatio');
    const cs = document.getElementById('checksum');
    if (mc) mc.textContent = '-';
    if (cr) cr.textContent = '-';
    if (cs) cs.textContent = '-';

    document.getElementById('postActions')?.classList.add('hidden');
    document.getElementById('rl4BlocksManual')?.classList.add('hidden');
    const ta = document.getElementById('rl4BlocksInput');
    if (ta) ta.value = '';
  } catch (_) {}

  setPostActionsEnabled(false);
  setLastPromptExpanded(false);
  renderLastPrompt(cachedLastPrompt); // will hide because hasSnapshotInThisUiSession=false
  setBusy(false);
  showStatus('success', 'Step 1/ Generate Context');
  refreshGuidance().catch(() => {});
}

function setBusy(isBusy) {
  const el = document.getElementById('busySpinner');
  if (!el) return;
  if (isBusy) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

let pollTimer = null;
function stopProgressPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startProgressPoll(captureId, { onDone, onError } = {}) {
  stopProgressPoll();
  pollTimer = setInterval(async () => {
    try {
      const res = await chrome.storage.local.get([STORAGE_KEYS.CAPTURE_PROGRESS]);
      const p = res && res[STORAGE_KEYS.CAPTURE_PROGRESS] && typeof res[STORAGE_KEYS.CAPTURE_PROGRESS] === 'object'
        ? res[STORAGE_KEYS.CAPTURE_PROGRESS]
        : null;

      if (!p) return;
      if (captureId && p.captureId && p.captureId !== captureId) return;

      const status = String(p.status || '');
      const phase = String(p.phase || '');
      const phaseIndex = typeof p.phaseIndex === 'number' ? p.phaseIndex : null;
      const phaseTotal = typeof p.phaseTotal === 'number' ? p.phaseTotal : null;
      const strategy = typeof p.strategy === 'string' ? p.strategy : '';
      const received = typeof p.receivedMessages === 'number' ? p.receivedMessages : (typeof p.messages === 'number' ? p.messages : 0);
      const total = typeof p.totalMessages === 'number' ? p.totalMessages : null;
      const chunks = typeof p.receivedChunks === 'number' ? p.receivedChunks : null;
      const totalChunks = typeof p.totalChunks === 'number' ? p.totalChunks : null;

      let line = '';
      // Only show % when total is reliable and coherent (avoid 100% (827/425) nonsense).
      if (total && total > 0 && received >= 0 && received <= total) {
        const pct = Math.min(100, Math.max(0, Math.floor((received / total) * 100)));
        line = `Progress: ${pct}% (${received}/${total} msgs)`;
      } else if (totalChunks && chunks !== null) {
        const pct = Math.min(100, Math.max(0, Math.floor((chunks / totalChunks) * 100)));
        line = `Progress: ${pct}% (chunks ${chunks}/${totalChunks})`;
      } else if (received > 0) {
        line = `Progress: ${received} msgs captured…`;
      }

      const phaseLabel = phase
        ? (phaseIndex && phaseTotal ? `Phase ${phaseIndex}/${phaseTotal}: ${phase}` : `Phase: ${phase}`)
        : '';
      const strategyLabel = strategy ? `Mode: ${strategy}` : '';
      const lines = [strategyLabel, phaseLabel, line].filter(Boolean).join('\n');
      if (status && status !== 'done' && status !== 'error') {
        setBusy(true);
        showStatus('loading', `Extracting conversation...\n\n${lines || 'Working…'}`);
      }

      if (status === 'done') {
        stopProgressPoll();
        setBusy(false);
        if (typeof onDone === 'function') onDone(p);
      }
      if (status === 'error') {
        stopProgressPoll();
        setBusy(false);
        if (typeof onError === 'function') onError(p);
      }
    } catch (_) {
      // ignore
    }
  }, 250);
}

/**
 * Initialize popup UI and event listeners
 */
document.addEventListener('DOMContentLoaded', async () => {
  const generateBtn = document.getElementById('generateBtn');
  const viewRawBtn = document.getElementById('viewRawBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  const copyEncoderPromptBtn = document.getElementById('copyEncoderPromptBtn');
  const finalizeBlocksBtn = document.getElementById('finalizeBlocksBtn');
  const rl4BlocksInput = document.getElementById('rl4BlocksInput');
  const copyLastPromptBtn = document.getElementById('copyLastPromptBtn');
  const toggleLastPromptBtn = document.getElementById('toggleLastPromptBtn');
  const optionsToggleBtn = document.getElementById('optionsToggleBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const ultraEl = document.getElementById('ultraCompress');
  const semanticEl = document.getElementById('semanticHints');
  const includeTranscriptEl = document.getElementById('includeTranscript');
  const integrityEl = document.getElementById('integritySeal');
  setBusy(false);

  // UX: At rest, only "Generate Context" should be actionable.
  setPostActionsEnabled(false);
  setLastPromptExpanded(false);
  setOptionsExpanded(false);
  refreshGuidance().catch(() => {});

  reloadBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    resetUiForNewRun();
  });

  optionsToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setOptionsExpanded(!optionsExpanded);
  });

  // Restore and display last prompt (persisted) so closing the popup doesn't lose it.
  try {
    const last = await loadLastPrompt();
    cachedLastPrompt = last;
    renderLastPrompt(last);
  } catch (_) {
    // ignore
  }

  // Restore last snapshot (if any) to re-enable "View raw JSON" and "Copy prompt"
  try {
    const lastSnap = await loadLastSnapshot();
    if (lastSnap) {
      currentSnapshot = lastSnap;
      hasSnapshotInThisUiSession = true;
      setPostActionsEnabled(true);
      renderLastPrompt(cachedLastPrompt);
      setLastPromptExpanded(false);
      refreshGuidance().catch(() => {});
    }
    const lastPrompt = await loadLastPrompt();
    if (!lastPrompt && lastSnap) {
      const prompt = buildInjectionPrompt(lastSnap);
      await saveLastPrompt(prompt);
      cachedLastPrompt = prompt;
      renderLastPrompt(prompt);
    }
  } catch (_) {
    // ignore
  }

  // If a job is currently running, show spinner + progress even after reopening popup.
  try {
    const activeTab = await getTargetActiveTab();
    const activeTabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : null;
    const res = await chrome.storage.local.get([STORAGE_KEYS.CAPTURE_PROGRESS]);
    const p = res && res[STORAGE_KEYS.CAPTURE_PROGRESS] && typeof res[STORAGE_KEYS.CAPTURE_PROGRESS] === 'object'
      ? res[STORAGE_KEYS.CAPTURE_PROGRESS]
      : null;
    const now = Date.now();
    // Captures can run for minutes (virtualized hydration on huge chats).
    // Keep the UI attached even if the last progress tick is older than 30s.
    const isFresh = p && typeof p.updatedAt === 'number' ? now - p.updatedAt < 10 * 60_000 : false;
    const matchesTab = activeTabId !== null && p && typeof p.tabId === 'number' ? p.tabId === activeTabId : false;
    if (p && p.status && p.status !== 'done' && p.status !== 'error' && matchesTab && isFresh) {
      startProgressPoll(p.captureId || null, {
        onDone: async () => {
          const snap = await loadLastSnapshot();
          if (snap) {
            currentSnapshot = snap;
            updateMetadata(snap);
            document.getElementById('postActions')?.classList.remove('hidden');
            showStatus('success', 'Ready. Snapshot finished in background.');
            hasSnapshotInThisUiSession = true;
            setPostActionsEnabled(true);
            refreshGuidance().catch(() => {});
          }
        },
        onError: (pp) => {
          showStatus('error', `Capture error: ${pp && pp.error ? pp.error : 'Unknown error'}`);
        }
      });
    } else {
      // No running job for this tab → spinner off.
      setBusy(false);
    }
  } catch (_) {
    // ignore
  }

  copyLastPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!hasSnapshotInThisUiSession) return;
    const last = await loadLastPrompt();
    if (!last) return;
    await copyToClipboard(last);
    showStatus('success', '✓ Copied to clipboard.');
  });

  // Last prompt toggle button (explicit, easier to understand than click-anywhere).
  toggleLastPromptBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    const wrap = document.getElementById('lastPrompt');
    const expanded = wrap && wrap.dataset && wrap.dataset.expanded === 'true';
    setLastPromptExpanded(!expanded);
  });

  generateBtn.addEventListener('click', generateSnapshot);
  viewRawBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentSnapshot) {
      showRawJSON(currentSnapshot);
    }
  });
  copyPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    const prompt = buildInjectionPrompt(currentSnapshot);
    await copyToClipboard(prompt);
    showStatus('success', 'Step 4/ Copied.\n\nPaste the snapshot into another LLM to resume with memory.');
    refreshGuidance().catch(() => {});
  });

  copyEncoderPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    try {
      const prompt = buildRl4BlocksEncoderPrompt(currentSnapshot);
      await copyToClipboard(prompt);

      // Arm content script: capture <RL4-...> blocks from the next assistant reply.
      const tab = await getTargetActiveTab();
      if (tab && typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, { action: 'armRl4BlocksCapture', tabId: tab.id }, () => {});
      }

      renderRl4BlocksStatus({ status: 'awaiting' });
      startRl4BlocksPoll({
        onSealed: async () => {
          try {
            const snap = await loadLastSnapshot();
            if (snap) {
              currentSnapshot = snap;
              updateMetadata(snap);
            }
          } catch (_) {}
        }
      });

      showStatus(
        'success',
        'Step 2/ Finalization prompt copied.\n\nPaste it into your current conversation and send it.\n\nStep 3/ Then paste the LLM response below.'
      );

      // Guide the user to the next action if they use manual finalization.
      try {
        document.getElementById('rl4BlocksManual')?.classList.remove('hidden');
        const ta = document.getElementById('rl4BlocksInput');
        if (ta && typeof ta.focus === 'function') ta.focus();
      } catch (_) {}

      refreshGuidance().catch(() => {});
    } catch (err) {
      showStatus('error', `Encoder copy failed: ${err && err.message ? err.message : String(err)}`);
    }
  });

  finalizeBlocksBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    const raw = rl4BlocksInput ? String(rl4BlocksInput.value || '').trim() : '';
    if (!raw) {
      showStatus('warning', 'Step 3/ Paste the LLM response first.');
      return;
    }
    try {
      const tab = await getTargetActiveTab();
      if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found.');

      showStatus('loading', 'Finalizing snapshot…');
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'finalizeRl4BlocksManual', text: raw },
        async (resp) => {
          if (chrome.runtime.lastError) {
            showStatus('error', `Finalize error: ${chrome.runtime.lastError.message || 'Unknown error'}`);
            return;
          }
          if (!resp || resp.ok !== true) {
            showStatus('error', `Finalize error: ${resp && resp.error ? resp.error : 'Unknown error'}`);
            return;
          }
          startRl4BlocksPoll({
            onSealed: async () => {
              const snap = await loadLastSnapshot();
              if (snap) currentSnapshot = snap;
              showStatus('success', 'Step 3/ Finalized.\n\nStep 4/ Copy the final snapshot into another LLM.');
              updateMetadata(currentSnapshot);
              refreshGuidance().catch(() => {});
            }
          });
        }
      );
    } catch (err) {
      showStatus('error', `Finalize failed: ${err && err.message ? err.message : String(err)}`);
    }
  });

  rl4BlocksInput?.addEventListener('input', () => {
    refreshGuidance().catch(() => {});
  });

  // UX: Ultra mode should never include transcript_compact (too big for most LLMs)
  const syncControls = () => {
    const ultraOn = ultraEl ? !!ultraEl.checked : false;
    if (!includeTranscriptEl) return;
    if (ultraOn) {
      includeTranscriptEl.checked = false;
      includeTranscriptEl.disabled = true;
      includeTranscriptEl.parentElement?.classList.add('is-disabled');
    } else {
      includeTranscriptEl.disabled = false;
      includeTranscriptEl.parentElement?.classList.remove('is-disabled');
    }

    // Semantic hints are relevant only in Ultra mode.
    if (semanticEl) {
      if (ultraOn) {
        semanticEl.disabled = false;
        semanticEl.parentElement?.classList.remove('is-disabled');
      } else {
        semanticEl.checked = false;
        semanticEl.disabled = true;
        semanticEl.parentElement?.classList.add('is-disabled');
      }
    }

    // Integrity seal is always available, but visually soften it if transcript is enabled
    // (some users may prefer "raw fidelity" and accept no seal; we keep it opt-in).
    if (integrityEl && includeTranscriptEl) {
      const transcriptOn = !ultraOn && !!includeTranscriptEl.checked;
      if (transcriptOn) {
        integrityEl.parentElement?.classList.add('is-disabled');
      } else {
        integrityEl.parentElement?.classList.remove('is-disabled');
      }
    }
  };

  if (ultraEl) ultraEl.addEventListener('change', syncControls);
  syncControls();

  // On open, show RL4 blocks status if an encode is in progress / completed.
  try {
    const s = await loadRl4BlocksStatus();
    renderRl4BlocksStatus(s);
    refreshGuidance().catch(() => {});
    if (s && (s.status === 'awaiting' || s.status === 'captured')) {
      startRl4BlocksPoll();
    }
  } catch (_) {
    // ignore
  }
});

/**
 * Main snapshot generation flow
 */
async function generateSnapshot() {
  const generateBtn = document.getElementById('generateBtn');
  const statusDiv = document.getElementById('status');
  const metadataDiv = document.getElementById('metadata');
  const postActions = document.getElementById('postActions');
  const urlInput = document.getElementById('urlInput');
  const includeTranscriptEl = document.getElementById('includeTranscript');
  const ultraEl = document.getElementById('ultraCompress');
  const semanticEl = document.getElementById('semanticHints');
  const integrityEl = document.getElementById('integritySeal');

  try {
    // Reset UI
    generateBtn.disabled = true;
    metadataDiv.classList.add('hidden');
    postActions?.classList.add('hidden');
    setPostActionsEnabled(false);
    setBusy(true);
    showStatus('loading', 'Starting capture… (runs in background)');

    // Get target tab (provider tab even if RL4 UI is detached)
    const activeTab = await getTargetActiveTab();
    const targetUrl = (urlInput && urlInput.value ? urlInput.value.trim() : '') || '';
    const ultraCompress = ultraEl ? !!ultraEl.checked : false;
    const semanticHints = ultraCompress && semanticEl ? !!semanticEl.checked : false;
    let includeTranscript = ultraCompress ? false : includeTranscriptEl ? !!includeTranscriptEl.checked : false;
    const tab = await resolveTargetTab(activeTab, targetUrl);
    
    await waitForContentScript(tab.id);
    const captureId = `cap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outputMode = ultraCompress ? (semanticHints ? 'ultra_plus' : 'ultra') : 'digest';
    const wantsIntegritySeal = integrityEl ? !!integrityEl.checked : false;

    // Poll progress and auto-load snapshot when job finishes (if popup stays open).
    startProgressPoll(captureId, {
      onDone: async () => {
        const snap = await loadLastSnapshot();
        if (!snap) {
          showStatus('warning', 'Capture finished, but no snapshot found. Reopen the popup and try again.');
          setBusy(false);
          return;
        }
        currentSnapshot = snap;
        updateMetadata(snap);
        hasSnapshotInThisUiSession = true;
        setPostActionsEnabled(true);

        const prompt = buildInjectionPrompt(snap);
        try {
          await saveLastPrompt(prompt);
        } catch (_) {}
        cachedLastPrompt = prompt;
        renderLastPrompt(prompt);
        setLastPromptExpanded(false);

        const msgCount = snap.metadata?.messages || snap.metadata?.total_messages || 0;
    showStatus(
      'success',
          `Step 1/ Done.\n\nMessages: ${msgCount}\nChecksum: ${String(snap.checksum || '').substring(0, 16)}...\n\nStep 2/ Create the finalization prompt.`
        );
        setBusy(false);
        refreshGuidance().catch(() => {});
      },
      onError: (p) => {
        showStatus('error', `Capture error: ${p && p.error ? p.error : 'Unknown error'}`);
        setBusy(false);
        refreshGuidance().catch(() => {});
      }
    });

    showStatus('loading', 'Capture running in background.\n\nYou can close this popup and come back later.');
    setGuidanceStep('generate');
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: 'startSnapshotJob',
        captureId,
        options: { outputMode, includeTranscript, wantsIntegritySeal }
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          showStatus('error', `Error: ${chrome.runtime.lastError.message || 'Failed to start capture job'}`);
          stopProgressPoll();
          setBusy(false);
          return;
        }
        if (!resp || resp.ok !== true) {
          const msg = resp && resp.error && resp.error.message ? resp.error.message : 'Failed to start snapshot job.';
          showStatus('error', `Error: ${msg}`);
          stopProgressPoll();
          setBusy(false);
        }
      }
    );

    // If we opened a temporary tab, close it.
    if (tab && tab.__rl4_temp === true) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        // ignore
      }
    }

  } catch (error) {
    console.error('[RL4] Error generating snapshot:', error);
    showStatus('error', `Error: ${error.message || 'Failed to generate context'}`);
    setBusy(false);
  } finally {
    generateBtn.disabled = false;
  }
}

function buildInjectionPrompt(snapshot) {
  const hasTranscript = typeof snapshot.transcript_compact === 'string' && snapshot.transcript_compact.length > 0;
  const protocol = snapshot && snapshot.protocol ? snapshot.protocol : 'RCEP_v1';
  const hasSig = snapshot && snapshot.signature && typeof snapshot.signature === 'object';
  return (
    `*** RL4 MEMORY HANDOFF (Cross‑LLM) ***\n` +
    `Protocol family: RCEP™\n` +
    `Protocol version: ${protocol}\n` +
    (hasSig ? `Integrity: Tamper-sealed (device-only)\n` : `Integrity: Unsealed\n`) +
    `\n` +
    `[INSTRUCTIONS FOR THE AI]\n` +
    `- This is a cross‑LLM memory handoff. Continue from it.\n` +
    `- Use "portable_memory" first (human handoff). Use "semantic_spine"/"cognitive_spine" for details.\n` +
    `- Treat the JSON below as ground truth (structure).\n` +
    `- Do not assume missing facts; ask targeted questions if needed.\n` +
    `- IMPORTANT: Integrity can be verified, but semantic correctness may be unverified.\n` +
    (hasSig
      ? `- If "signature" is present, do not edit this JSON. If verification fails, treat it as tampered.\n` +
        `- NOTE: "Tamper-sealed" means mutation detection, NOT semantic validation.\n`
      : '') +
    `\n` +
    (hasTranscript
      ? `Transcript: Included (full fidelity).\n`
      : `Transcript: Not included (token-saver). Fingerprint available under "conversation_fingerprint".\n`) +
    `\n` +
    `CONTEXT_JSON:\n` +
    `${JSON.stringify(snapshot, null, 2)}\n` +
    `\n` +
    `*** Generated by RL4 Snapshot (RCEP™) ***\n`
  );
}

function buildRl4BlocksEncoderPrompt(snapshot) {
  const protocol = snapshot && snapshot.protocol ? snapshot.protocol : 'RCEP_v1';
  const hasSig = snapshot && snapshot.signature && typeof snapshot.signature === 'object';
  return (
    `RL4 Conversation Encoder — Cross‑LLM Memory (Ping‑Pong Aware)\n\n` +
    `You are given an RL4 Snapshot JSON (RCEP™). Your job is to produce a compact, human-usable RL4 BLOCKS output that preserves:\n` +
    `- validated direction (what the user kept)\n` +
    `- drift guards (what was rejected / non-negotiables)\n` +
    `- how the user pilots the model (control style)\n` +
    `- where to resume (next steps + open questions)\n\n` +
    `CRITICAL RULES\n` +
    `- ENCODE CONTENT, NOT METADATA.\n` +
    `- Do NOT narrate “user said / assistant replied”.\n` +
    `- Use "portable_memory" FIRST. Then use "semantic_spine"/"cognitive_spine"/"decisions"/"timeline_macro" to refine.\n` +
    `- Do not invent missing facts. If unknown, output UNKNOWN.\n` +
    `- OUTPUT ONLY the 7 blocks + the human summary. NO extra recommendations, NO ads, NO extra sections.\n` +
    `- After the human summary, print exactly: <RL4-END/>\n` +
    (hasSig ? `- The JSON includes a device-only tamper seal. Do NOT edit it.\n` : '') +
    `\nOUTPUT FORMAT (MUST follow)\n` +
    `1) <RL4-ARCH>phase|key:value|...|compress:XX%</RL4-ARCH>\n` +
    `2) <RL4-LAYERS> ... </RL4-LAYERS>\n` +
    `3) <RL4-TOPICS> ... </RL4-TOPICS>\n` +
    `4) <RL4-TIMELINE> ... VELOCITY:..|CLARITY:..|DECISIONS:.. </RL4-TIMELINE>\n` +
    `5) <RL4-DECISIONS> ... include rejected:... </RL4-DECISIONS>\n` +
    `6) <RL4-INSIGHTS>patterns=... correlations=... risks=... recommendations=... </RL4-INSIGHTS>\n` +
    `7) HUMAN SUMMARY (plain text, 8–12 lines max)\n` +
    `   Then: <RL4-END/>\n\n` +
    `SPECIAL REQUIREMENTS (Ping‑Pong)\n` +
    `- In DECISIONS, separate: validated_intents, rejected, constraints/control_style.\n` +
    `- Include drift guards: “Do NOT re-propose rejected directions”.\n\n` +
    `CONTEXT_JSON (protocol: ${protocol}):\n` +
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
}

/**
 * Device-only (offline) integrity signature for tamper-evidence.
 * - Generates a P-256 key pair on first use and stores it in IndexedDB (private key non-exportable).
 * - Signs the string "checksum:<hex>".
 * @param {string} checksumHex
 * @returns {Promise<{type:string, algo:string, key_id:string, public_key_spki:string, signed_payload:string, value:string}>}
 */
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

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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

  // Generate non-exportable key pair (private key stays inside WebCrypto)
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  // Public key should be exportable as SPKI; if it fails, we still sign but cannot provide a stable key_id.
  let publicKeySpkiB64 = '';
  let keyId = 'unknown';
  try {
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    publicKeySpkiB64 = arrayBufferToBase64(spki);
    keyId = await sha256HexBytes(spki);
  } catch (e) {
    // Fallback: try JWK (public only)
    try {
      const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      const jwkBytes = new TextEncoder().encode(JSON.stringify(jwk));
      publicKeySpkiB64 = arrayBufferToBase64(jwkBytes.buffer);
      keyId = await sha256HexBytes(jwkBytes.buffer);
    } catch (_) {
      // keep unknown
    }
  }

  await idbPut(db, 'keys', {
    id: 'device_signing_v1',
    createdAt: Date.now(),
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    keyId,
    publicKeySpkiB64
  });

  return { privateKey: kp.privateKey, keyId, publicKeySpkiB64 };
}

async function resolveTargetTab(activeTab, targetUrl) {
  if (!targetUrl) {
    if (!activeTab || !activeTab.id) throw new Error('No active tab found.');
    return activeTab;
  }

  let u;
  try {
    u = new URL(targetUrl);
  } catch (_) {
    throw new Error('Invalid URL. Paste a full https:// link.');
  }

  const host = (u.hostname || '').toLowerCase();
  const allowed =
    host.includes('claude.ai') ||
    host.includes('chatgpt.com') ||
    host.includes('chat.openai.com') ||
    host.includes('gemini.google.com') ||
    host.includes('bard.google.com') ||
    host === 'g.co';
  if (!allowed) {
    throw new Error('Unsupported site. Use Claude.ai, ChatGPT, or Gemini.');
  }

  // Reuse active tab if it already matches exactly.
  if (activeTab && activeTab.url === targetUrl) {
    return activeTab;
  }

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  await waitForTabComplete(tab.id);
  return { ...tab, __rl4_temp: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 900);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForContentScript(tabId) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timeoutMs = 9000;

    const tick = () => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError) {
          if (Date.now() - start > timeoutMs) {
            reject(new Error('Content script not ready. Please refresh the page and try again.'));
            return;
          }
          setTimeout(tick, 250);
          return;
        }
        if (response && response.ok) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Content script not ready. Please refresh the page and try again.'));
          return;
        }
        setTimeout(tick, 250);
      });
    };

    tick();
  });
}

/**
 * Get messages from content script via message passing
 */
async function getMessagesFromContentScript(tabId, captureId) {
  const attemptSend = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'getMessages', deep: true, captureId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(response);
      });
    });

  const startedAt = Date.now();
  const timeoutMs = 9000;
  // Retry because newly opened tabs sometimes haven't registered the content script yet.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await attemptSend();

      // content.js returns: { ok: true, messages: [...] } (and may include session_id)
      if (response && response.ok) {
        return Array.isArray(response.messages) ? response.messages : [];
      }

      // Backward/alternative formats support
      if (response && response.success) {
        return Array.isArray(response.messages) ? response.messages : [];
      }

      const errObj = response && response.error ? response.error : null;
      const msg =
        (errObj && errObj.message) ||
        (typeof response?.error === 'string' ? response.error : null) ||
        'Failed to get messages';
      throw new Error(msg);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const isNotReady =
        /receiving end does not exist/i.test(msg) ||
        /could not establish connection/i.test(msg) ||
        /message port closed/i.test(msg);
      if (!isNotReady) {
        throw new Error('Could not communicate with content script. Please refresh the page.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  throw new Error('Could not communicate with content script. Please refresh the page.');
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    
    try {
      document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (fallbackError) {
      document.body.removeChild(textarea);
      throw new Error('Please allow clipboard access or copy manually');
    }
  }
}

/**
 * Update metadata display
 */
function updateMetadata(snapshot) {
  const metadataDiv = document.getElementById('metadata');
  const messageCountEl = document.getElementById('messageCount');
  const compressionRatioEl = document.getElementById('compressionRatio');
  const checksumEl = document.getElementById('checksum');

  messageCountEl.textContent = snapshot.metadata.messages || snapshot.metadata.total_messages || 0;
  compressionRatioEl.textContent =
    snapshot.metadata.compression_digest || snapshot.metadata.compression || snapshot.metadata.compression_ratio || 'N/A';
  checksumEl.textContent = snapshot.checksum ? snapshot.checksum.substring(0, 16) + '...' : '-';

  metadataDiv.classList.remove('hidden');
  // If a previous "Reload" forced display:none, undo it.
  metadataDiv.style.display = '';
}

/**
 * Show status message
 */
function showStatus(type, message) {
  const statusDiv = document.getElementById('status');
  statusDiv.className = `status ${type}`;
  statusDiv.textContent = message;
  statusDiv.classList.remove('hidden');
}

/**
 * Show raw JSON in new window (for debugging)
 */
function showRawJSON(snapshot) {
  const jsonStr = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  // Open in new tab
  chrome.tabs.create({ url });
  
  // Cleanup after a delay
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

