'use strict';
window.chaweTyping = (() => {
  const client = crypto.randomUUID().replaceAll('-','');
  let ctx, current, base = '', actors = [], sendTimer, expireTimer, pollTimer, controller;
  let lastAction = 0, lastSent = 0, writes = Promise.resolve();
  const keyOf = state => state && state.accountId + ':' + state.peer + ':' + state.topic;
  async function request(state,values,write,signal) {
    const aborter = new AbortController(), abort = () => aborter.abort();
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort,1500);
    try {
      const query = new URLSearchParams({peer:state.peer,topic:state.topic,...values});
      const response = await fetch('/api/typing' + (write ? '' : '?' + query),{
        method:write ? 'POST' : 'GET',credentials:'same-origin',cache:'no-store',signal:aborter.signal,
        headers:{'X-Chawe-Account':state.account,'X-Chawe-Identity':state.accountId,
          'X-Chawe-Directory-Version':String(state.directoryVersion),...(write ? {'Content-Type':'application/x-www-form-urlencoded'} : {})},
        ...(write ? {body:query} : {})});
      if (!response.ok) throw Error('typing_unavailable');
      return await response.json();
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
  }
  function paint() {
    clearTimeout(expireTimer); const now = performance.now(); actors = actors.filter(actor => actor.expires > now);
    const label = document.getElementById('chat-subtitle');
    if (!ctx || !label) return;
    if (!current) {label.classList.remove('is-typing'); label.textContent = base; return;}
    if (keyOf(ctx.getState()) !== keyOf(current)) return;
    const names = actors.slice(0,3).map(actor => actor.name);
    label.classList.toggle('is-typing',!!names.length);
    label.textContent = names.length ? current.group ? names.join('、') + (actors.length > 3 ? '等' : '') + ' 正在输入…' : '对方正在输入…' : base;
    if (actors.length) expireTimer = setTimeout(paint,Math.max(1,Math.min(...actors.map(actor => actor.expires))-now));
  }
  function queueWrite(state,at) {
    const version = state.writeVersion = (state.writeVersion || 0) + 1;
    writes = writes.catch(() => {}).then(async () => {
      if (state.writeVersion !== version) return;
      const remaining = at ? Math.max(0,Math.ceil(3000-(performance.now()-at))) : 0;
      await request(state,{client,remaining:String(remaining)},true);
    }).catch(() => {});
  }
  function stop() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (current && lastAction) queueWrite(current,0);
    lastAction = 0; lastSent = 0;
  }
  function sync(fallback) {
    const state = ctx?.getState(); if (fallback !== undefined) base = fallback;
    const next = state?.ready && state.peer && state.peer !== state.account ? state : null;
    if (keyOf(next) !== keyOf(current)) {
      stop(); controller?.abort(); current = next; actors = []; paint();
      clearTimeout(pollTimer); pollTimer = setTimeout(poll,0);
    }
    paint();
  }
  function flush() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!current || document.hidden || !ctx.getState().canType) return;
    lastSent = performance.now(); queueWrite(current,lastAction);
  }
  function activity() {
    sync(); if (!current || document.hidden || !ctx.getState().canType) return;
    lastAction = performance.now();
    if (!lastSent || lastAction-lastSent >= 400) flush();
    else if (!sendTimer) sendTimer = setTimeout(() => {sendTimer = null; flush();},400-(lastAction-lastSent));
  }
  async function poll() {
    clearTimeout(pollTimer);
    if (!current || document.hidden || controller) return;
    const state = current, aborter = new AbortController(); controller = aborter;
    const began = performance.now();
    try {
      const data = await request(state,{},false,aborter.signal);
      if (current !== state || document.hidden) return;
      const now = performance.now(), elapsed = now-began;
      actors = (Array.isArray(data.actors) ? data.actors : []).filter(actor => /^[a-f0-9]{32}$/.test(actor.id) && typeof actor.name === 'string' && Number.isFinite(actor.remaining) && actor.remaining > elapsed && actor.remaining <= 3000)
        .map(actor => ({name:actor.name,expires:now+actor.remaining-elapsed}));
      paint();
    } catch { if (current === state) {actors = []; paint();} }
    finally {
      if (controller === aborter) controller = null;
      if (current && !document.hidden) pollTimer = setTimeout(poll,500);
    }
  }
  function init(context) { ctx = context; sync(); }
  document.getElementById('message-input').addEventListener('click',activity);
  document.getElementById('message-input').addEventListener('input',activity);
  document.getElementById('composer').addEventListener('submit',stop);
  document.addEventListener('visibilitychange',() => {
    if (document.hidden) {stop(); controller?.abort(); clearTimeout(pollTimer); actors = []; paint();}
    else {sync(); clearTimeout(pollTimer); pollTimer = setTimeout(poll,0);}
  });
  window.addEventListener('pagehide',stop);
  return {init,sync,stop,activity};
})();
