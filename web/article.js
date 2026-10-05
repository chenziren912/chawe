'use strict';
window.chaweArticles = (() => {
  const $ = id => document.getElementById(id), encoder = new TextEncoder(), drafts = new Map();
  const MAX_BYTES = 262144, MAX_CHARACTERS = 100000;
  let ctx, state = null, editor = null, libraryPromise, saveTimer, preview = null, view = null, viewEpoch = 0, scrollFrame = 0;
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),n => n.toString(16).padStart(2,'0')).join('');
  const load = () => libraryPromise ||= import('/article-editor.js?v=4cb2735a73721cb581f135362729f71340bd4f58e595470200fc7560be02b179').catch(error => { libraryPromise = null; throw error; });
  const keyOf = s => 'chawe.article-draft.v1.' + s.accountId + '.' + s.peerId + (/^group:/.test(s.peer)?'.'+(s.topic || 'general'):'');
  const limitError = value => encoder.encode(value).length > MAX_BYTES || Array.from(value).length > MAX_CHARACTERS;
  function normalize(a) {
    return a && a.kind === 'article' && /^[a-f0-9]{32}$/.test(a.id) && typeof a.name === 'string' && a.name.length <= 512
      && a.type === 'text/markdown' && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_BYTES ? {...a} : null;
  }
  function readDraft(s) {
    try {
      const draft = drafts.get(keyOf(s)) || JSON.parse(localStorage.getItem(keyOf(s)) || 'null');
      return typeof draft?.text === 'string' && !limitError(draft.text) ? draft : null;
    } catch { return drafts.get(keyOf(s)) || null; }
  }
  function saveDraft() {
    clearTimeout(saveTimer);
    if (!state || state.edit) return;
    const draft = {text:state.text,id:state.id}; drafts.set(keyOf(state),draft);
    try {
      if (draft.text) localStorage.setItem(keyOf(state),JSON.stringify(draft)); else localStorage.removeItem(keyOf(state));
      $('article-draft-status').textContent = '草稿已保存在此浏览器';
    } catch { $('article-draft-status').textContent = '草稿暂存在当前页面'; }
  }
  function updateValue(text) {
    if (!state || state.busy) return;
    if (state.text !== text) state.id = randomId();
    state.text = text;
    $('article-error').hidden = !limitError(text);
    $('article-error').textContent = '文章最多 100000 字，Markdown 文件大小不超过 256 KB。';
    $('article-count').textContent = Array.from(text).length.toLocaleString('zh-CN') + ' 字';
    if (!state.edit) { $('article-draft-status').textContent = '正在保存草稿…'; clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft,350); }
    ctx.changed();
  }
  function expand(open,immediate = false) {
    cancelAnimationFrame(scrollFrame);
    const composer = $('article-composer'), log = $('messages'), bottom = log.scrollHeight-log.scrollTop-log.clientHeight < 80;
    composer.style.setProperty('--article-expand-duration',ctx.motionDuration(320) + 'ms');
    if (immediate) composer.style.transitionDuration = '0s';
    composer.classList.toggle('is-open',open); composer.inert = !open;
    $('composer').classList.toggle('is-article-mode',open); $('article-bottom-label').hidden = !open;
    $('message-input').hidden = open; $('draft-notice').hidden = open;
    const end = performance.now() + (immediate ? 0 : ctx.motionDuration(320));
    const step = () => { if (bottom) log.scrollTop = log.scrollHeight; window.chaweScrollbars?.refresh();
      if (performance.now() < end) scrollFrame = requestAnimationFrame(step); else composer.style.transitionDuration = ''; };
    scrollFrame = requestAnimationFrame(step);
  }
  async function open(edit = null) {
    const info = ctx.getState();
    if (!info.canSend || state?.busy) return;
    if (state) close(true);
    const draft = edit ? null : readDraft(info);
    const current = state = {...info,edit,text:edit?.text ?? draft?.text ?? '',id:/^[a-f0-9]{32}$/.test(draft?.id) ? draft.id : randomId(),busy:false};
    $('article-heading').textContent = edit ? '编辑文章' : '编写文章';
    $('article-bottom-label').textContent = edit ? '文章 · 点击右侧按钮保存' : '文章 · 点击右侧按钮发送';
    $('article-draft-status').textContent = edit ? '修改后点击下方按钮保存' : '草稿保存在此浏览器';
    $('article-error').hidden = true; $('article-editor-loading').hidden = false;
    $('article-retry').hidden = true; $('article-editor-loading-copy').textContent = '正在打开编辑器…';
    expand(true); ctx.changed();
    try {
      const library = await load(); if (state !== current) return;
      editor = library.mountEditor($('article-editor-host'),{value:current.text,onChange:updateValue,onSave:saveDraft,onSend:send,
        onError:() => { ctx.showStatus('编辑器操作未完成，请重试。'); }});
      $('article-editor-loading').hidden = true; updateValue(current.text); editor.focus();
    } catch {
      if (state !== current) return;
      $('article-editor-loading-copy').textContent = '编辑器未能加载'; $('article-retry').hidden = false; ctx.changed();
    }
  }
  function close(immediate = false,sent = false) {
    if (!state || state.busy) return false;
    const previous = state;
    if (sent && !state.edit) {
      clearTimeout(saveTimer); drafts.delete(keyOf(state));
      try { localStorage.removeItem(keyOf(state)); } catch {}
    } else saveDraft();
    editor?.dispose(); editor = null; state = null;
    $('article-editor-host').replaceChildren(); expand(false,immediate); ctx.changed();
    if (previous.edit) ctx.editEnded(previous.edit);
    return true;
  }
  async function send() {
    const current = state, info = ctx.getState();
    if (!current || !editor || current.busy || !info.canSend || current.peer !== info.peer || !current.text.trim()) return;
    if (limitError(current.text)) { updateValue(current.text); return; }
    const source = $('article-editor-host').getBoundingClientRect();
    current.busy = true; editor.setReadOnly(true); $('article-close').disabled = true; ctx.changed();
    try {
      const data = await ctx.post(current.edit ? '/api/messages/edit' : '/api/articles/send',current.edit
        ? {with:current.peer,seq:current.edit.seq,version:current.edit.version,text:current.text}
        : {to:current.peer,text:current.text,id:current.id});
      current.busy = false;
      // Capture message positions before closing the expanded composer; the chat owns the FLIP animation.
      ctx.complete(current.peer,data.message,source,!!current.edit,() => close(true,true));
      $('message-input').focus({preventScroll:true});
    } catch (error) {
      current.busy = false; editor?.setReadOnly(false);
      if (state === current) { $('article-error').hidden = false; $('article-error').textContent = ctx.errorText(error); }
      if (['message_changed','message_retracted'].includes(error.message)) ctx.sync();
    } finally { $('article-close').disabled = false; ctx.changed(); }
  }
  function renderMessage(bubble,message,peer) {
    const old = bubble.querySelector(':scope > .message-attachment'), meta = bubble.querySelector('.bubble-meta');
    bubble.classList.add('has-attachment','has-article'); bubble.classList.remove('has-media','media-only','has-voice');
    bubble.querySelector('.message-text').hidden = true;
    if (old?.dataset.articleRevision === String(message.revision || 0) && old.dataset.attachment === message.attachment.id) return;
    if (old) { if (meta && old.contains(meta)) bubble.append(meta); window.chaweAttachments.dispose(old); old.remove(); }
    const frame = document.createElement('div'); frame.className = 'message-attachment attachment-article';
    frame.dataset.attachment = message.attachment.id; frame.dataset.articleRevision = String(message.revision || 0);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'article-message-open';
    button.setAttribute('aria-label','阅读文章：' + message.attachment.name);
    const label = document.createElement('span'); label.className = 'article-message-label'; label.innerHTML = '<svg aria-hidden="true"><use href="#i-article"/></svg><span>文章</span>';
    const title = document.createElement('strong'); title.textContent = message.attachment.name;
    const summary = document.createElement('span'); summary.className = 'article-message-summary';
    summary.textContent = message.text.replace(/^\s*#{1,6}\s+[^\n]+\n?/,'').replace(/[`*_>#\[\]]/g,'').replace(/\s+/g,' ').trim().slice(0,160) || '点击阅读文章';
    const more = document.createElement('span'); more.className = 'article-message-read'; more.textContent = '阅读全文';
    button.append(label,title,summary,more); button.addEventListener('click',() => openViewer(message,peer)); frame.append(button);
    bubble.insertBefore(frame,bubble.querySelector('.message-text')); if (meta) frame.append(meta);
  }
  async function openViewer(message,peer) {
    const epoch = ++viewEpoch; preview?.dispose(); preview = null;
    view = {peer,seq:message.seq,message}; $('article-view-host').replaceChildren(); $('article-view-title').textContent = message.attachment.name;
    $('article-view-status').hidden = false; $('article-view-status').textContent = '正在打开文章…'; $('article-view-retry').hidden = true;
    ctx.openModal('article-dialog');
    try {
      const library = await load(); if (epoch !== viewEpoch || !view) return;
      preview = library.mountPreview($('article-view-host'),view.message.text); $('article-view-status').hidden = true;
    } catch { if(epoch === viewEpoch) { $('article-view-status').textContent = '文章未能打开'; $('article-view-retry').hidden = false; } }
    $('article-view-retry').onclick = () => openViewer(message,peer);
  }
  function updateViewer(updates,peer) {
    if (!view || view.peer !== peer) return;
    const updated = updates.find(item => item.seq === view.seq); if (!updated) return;
    if (updated.deleted) { ctx.closeModal('article-dialog'); ctx.showStatus('这篇文章已被撤回。'); }
    else { view.message = updated; $('article-view-title').textContent = updated.attachment.name; preview?.update(updated.text); }
  }
  function onClose() { ++viewEpoch; view = null; preview?.dispose(); preview = null; $('article-view-host').replaceChildren(); }
  function init(context) {
    ctx = context;
    $('article-close').onclick = () => { if (state?.edit) ctx.cancelEdit(); else close(); $('message-input').focus({preventScroll:true}); };
    $('article-retry').onclick = () => open(state?.edit || null);
    $('article-view-close').onclick = () => ctx.closeModal('article-dialog');
    window.addEventListener('pagehide',saveDraft);
  }
  return {init,open,close,send,normalize,renderMessage,onClose,updateViewer,
    isOpen:() => !!state, isBusy:() => !!state?.busy, isReady:() => !!editor,
    isEmpty:() => !state?.text.trim(), insert:text => editor?.insert(text), focus:() => editor?.focus()};
})();
