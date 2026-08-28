// ============================================================
// ai-assistant.js - meme studio AI entry and dispatch layer
// ============================================================
(function (global) {
  'use strict';

  if (!global.Capacitor || !global.Capacitor.Plugins || !global.Capacitor.Plugins.AiBridge) {
    console.error('[ai-assistant] AiBridge plugin not found');
    return;
  }

  const aiBridge = global.Capacitor.Plugins.AiBridge;
  const fab = document.getElementById('aiFab');
  const panel = document.getElementById('aiPanel');
  const closeBtn = document.getElementById('aiPanelClose');
  const statusEl = document.getElementById('aiStatus');
  const inputEl = document.getElementById('aiInput');
  const sendBtn = document.getElementById('aiSend');
  const downloadBtn = document.getElementById('aiDownload');

  if (!fab || !panel || !closeBtn || !statusEl || !inputEl || !sendBtn || !downloadBtn) {
    console.error('[ai-assistant] AI UI elements missing');
    return;
  }

  let modelReady = false;
  let busy = false;

  function setStatus(key, type, vars) {
    statusEl.textContent = global.t(key, vars);
    statusEl.className = 'ai-status' + (type ? ' ' + type : '');
  }

  function setBusy(flag) {
    busy = flag;
    inputEl.disabled = flag;
    sendBtn.disabled = flag || !modelReady;
  }

  async function checkModel() {
    setStatus('ai.modelChecking', 'busy');
    try {
      const result = await aiBridge.checkModel();
      modelReady = !!(result && result.ready);
      downloadBtn.classList.toggle('hidden', modelReady);
      sendBtn.disabled = !modelReady || busy;
      if (modelReady) {
        setStatus('ai.modelReady', 'ready');
      } else {
        setStatus('ai.modelMissing', '');
      }
    } catch (e) {
      modelReady = false;
      setStatus('ai.modelMissing', 'error');
    }
  }

  async function downloadModel() {
    setBusy(true);
    setStatus('ai.modelDownloading', 'busy', { percent: 0 });
    try {
      const result = await aiBridge.downloadModel();
      if (result && result.ready) {
        modelReady = true;
        downloadBtn.classList.add('hidden');
        setStatus('ai.modelReady', 'ready');
      } else {
        setStatus('ai.modelMissing', '');
      }
    } catch (e) {
      setStatus('ai.downloadFail', 'error', { error: e.message || e });
    } finally {
      setBusy(false);
    }
  }

  function dispatchCalls(calls) {
    if (!global.MemeApi) return;
    for (const call of calls || []) {
      const fn = global.MemeApi[call.method];
      if (fn) {
        try {
          const ret = fn(call.params || {});
          if (ret && typeof ret.then === 'function') {
            ret.catch(err => console.error('[ai-assistant] dispatch failed', call.method, err));
          }
        } catch (err) {
          console.error('[ai-assistant] dispatch failed', call.method, err);
        }
      }
    }
  }

  async function sendInstruction() {
    if (busy) return;
    const text = inputEl.value.trim();
    if (!text) {
      setStatus('ai.empty', 'error');
      return;
    }
    if (!modelReady) {
      setStatus('ai.modelMissing', 'error');
      return;
    }
    setBusy(true);
    setStatus('ai.generating', 'busy');
    try {
      const result = await aiBridge.generate({ instruction: text });
      if (result && result.ok) {
        dispatchCalls(result.calls);
        setStatus('ai.modelReady', 'ready');
      } else {
        setStatus('ai.rejected', 'error');
      }
    } catch (e) {
      setStatus('ai.genFail', 'error', { error: e.message || e });
    } finally {
      setBusy(false);
    }
  }

  fab.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      inputEl.focus();
      checkModel();
    }
  });
  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
  sendBtn.addEventListener('click', sendInstruction);
  downloadBtn.addEventListener('click', downloadModel);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendInstruction();
    }
  });

  try {
    aiBridge.addListener('ai:downloadProgress', (data) => {
      const percent = data && typeof data.percent === 'number' ? data.percent : 0;
      setStatus('ai.modelDownloading', 'busy', { percent: Math.round(percent) });
    });
  } catch (e) {
    console.warn('[ai-assistant] cannot subscribe download progress', e);
  }

  checkModel();
})(window);
