'use strict';
// Permission is requested only from an explicit click in the page's own confirmation dialog.
window.chaweNotifications = (() => {
  const $ = id => document.getElementById(id), KEY = 'chawe-notifications-v1';
  let ctx, state = null, busy = false, lastError = '', registration, promptTimer, retryTimer, promptShown = false;
  let eventsTimer, eventsBusy = false, eventsCursor = 0, generation = 0;
  const supported = () => 'Notification' in window && 'serviceWorker' in navigator && isSecureContext;
  const remembered = () => { try { const value = JSON.parse(localStorage.getItem(KEY) || '{}')[ctx.id]; return value?.confirmed === true ? value : null; } catch { return null; } };
  function remember(value) {
    try { const values = JSON.parse(localStorage.getItem(KEY) || '{}'); values[ctx.id] = {confirmed:true,enabled:value.enabled,preview:value.preview}; localStorage.setItem(KEY,JSON.stringify(values)); } catch {}
  }
  function errorCopy(error) {
    return ({unsupported_push_service:'服务器尚未兼容这个通知推送地址，请联系运营者。',invalid_push_subscription:'浏览器通知订阅无效，请重新连接。',
      push_subscription_required:'需要先连接浏览器通知。',push_capacity_reached:'通知订阅已达上限，请稍后再试。',
      notification_denied:'浏览器已阻止通知。请在地址栏的网站设置中允许通知，再重新连接。',
      notification_dismissed:'尚未获得通知权限，你可以稍后再次开启。',notification_unsupported:'这个浏览器暂不支持后台消息通知。',
      notification_connection_failed:'无法显示通知，请检查网络、浏览器通知权限与系统通知设置。',
      notification_timeout:'连接通知服务超时，请检查网络后重试。'})[error.message] || (error.name === 'NotAllowedError' ? '浏览器或系统阻止了通知，请检查网站权限和系统通知设置。' : ctx.errorText(error));
  }
  function render() {
    $('setting-notifications').checked = !!state?.enabled;
    $('setting-notifications').disabled = busy || !state || !supported();
    $('setting-notification-preview').checked = state?.preview !== false;
    $('setting-notification-preview').disabled = busy || !state;
    $('notification-later').disabled = busy; $('notification-enable').disabled = busy || !supported();
    $('notification-enable').textContent = busy ? '正在连接…' : '开启通知';
    let copy = !state ? '正在加载通知设置…' : busy ? '正在保存通知设置…' : !supported() ? '这个浏览器暂不支持后台通知。'
      : Notification.permission === 'denied' ? '浏览器已阻止通知；请在地址栏的网站设置中允许通知。'
      : state.enabled && state.subscribed ? '浏览器通知已启用；网页打开时会自动补发未收到的通知。'
      : state.enabled ? '网页打开时可接收通知，关闭网页后的推送需要重新连接。' : '浏览器通知已关闭。';
    if (state?.enabled && state.pushStatus >= 400) copy = '后台推送服务返回 ' + state.pushStatus + '；网页打开时仍可接收通知，请重新连接后台推送。';
    $('notification-status').textContent = lastError || copy;
    $('retry-notifications').hidden = busy || !supported() || !(lastError || state?.enabled && (!state?.subscribed || state.pushStatus >= 400));
    $('test-notifications').disabled = busy || !state?.enabled || !supported() || Notification.permission !== 'granted';
  }
  async function worker() {
    if (!registration) {
      const registered = await navigator.serviceWorker.register('/notification-worker.js',{scope:'/',updateViaCache:'none'});
      let timeout;
      try { registration = await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject) => { timeout = setTimeout(() => reject(Error('notification_timeout')),15000); })]); }
      finally { clearTimeout(timeout); }
      if (registration.scope !== registered.scope) throw Error('notification_unsupported');
    }
    return registration;
  }
  function applicationKey(value) { const source = atob(value.replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(source,char => char.charCodeAt(0)); }
  async function subscription() {
    if (!('PushManager' in window)) throw Error('notification_unsupported');
    const reg = await worker(); let sub = await reg.pushManager.getSubscription();
    const key = applicationKey(state.publicKey);
    if (sub && sub.options.applicationServerKey && !Array.from(new Uint8Array(sub.options.applicationServerKey)).every((byte,index) => byte === key[index])) { await sub.unsubscribe(); sub = null; }
    if (!sub) {
      let timeout;
      try { sub = await Promise.race([reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key}),new Promise((_,reject) => { timeout = setTimeout(() => reject(Error('notification_timeout')),15000); })]); }
      finally { clearTimeout(timeout); }
    }
    const json = sub.toJSON(); return {endpoint:json.endpoint,p256dh:json.keys.p256dh,auth:json.keys.auth};
  }
  async function persist(enabled,preview,request) {
    const data = await ctx.post('/api/notifications/save',{enabled,preview,...request}); state = data; remember(state); lastError = ''; render();
    return data;
  }
  async function connect(preview) {
    // A failing external push service must not disable notifications in an open page.
    await worker();
    await persist(true,preview);
    try { await persist(true,preview,await subscription()); }
    catch (error) { lastError = '网页通知已启用。后台推送连接失败：' + errorCopy(error); render(); }
  }
  async function workerRequest(type,value = {}) {
    const reg = await worker(), target = reg.active;
    if (!target) throw Error('notification_timeout');
    return new Promise((resolve,reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(Error('notification_timeout')); },15000);
      channel.port1.onmessage = event => {
        clearTimeout(timer); channel.port1.close();
        if (event.data?.ok) resolve(); else reject(Error(event.data?.error || 'notification_timeout'));
      };
      target.postMessage({type,...value},[channel.port2]);
    });
  }
  async function checkEvents() {
    if (!ctx || !supported() || Notification.permission !== 'granted') return;
    if (eventsBusy) { clearTimeout(eventsTimer); eventsTimer = setTimeout(checkEvents,2500); return; }
    const version = generation; eventsBusy = true;
    try {
      const data = await ctx.api('/api/notifications/events?since=' + eventsCursor);
      if (version !== generation) return;
      for (const event of data.events) {
        if (version !== generation) return;
        await workerRequest('chawe-notification-check',event);
      }
      if (version === generation) eventsCursor = data.cursor;
    } catch (error) {
      if (version === generation && error.message !== 'unauthorized' && error.message !== 'directory_changed') {
        lastError = '通知连接暂时中断，正在重试。' + errorCopy(error); render();
      }
    } finally {
      eventsBusy = false;
      if (version === generation) { clearTimeout(eventsTimer); eventsTimer = setTimeout(checkEvents,2500); }
    }
  }
  async function testNotification() {
    if (busy || !state?.enabled || Notification.permission !== 'granted') return;
    try { await workerRequest('chawe-notification-test'); lastError = ''; render(); $('notification-status').textContent = '测试通知已交给浏览器。如果没有弹出，请检查系统是否允许 Chrome Canary 通知，以及勿扰模式。'; }
    catch (error) { lastError = errorCopy(error); render(); }
  }
  function prompt() {
    if (!ctx || busy || ctx.isBusy()) return;
    $('notification-error').hidden = true;
    if (!supported()) { $('notification-error').textContent = '这个浏览器暂不支持后台通知，可以先选择“暂不开启”。'; $('notification-error').hidden = false; }
    render(); ctx.openModal('notification-dialog');
  }
  function maybePrompt() {
    clearTimeout(promptTimer);
    if (!state || state.confirmed || remembered() || promptShown || document.hidden) return;
    if (ctx.hasModal() || ctx.isBusy()) { promptTimer = setTimeout(maybePrompt,1500); return; }
    promptShown = true; prompt();
  }
  async function enable() {
    if (busy || !ctx || !state) return;
    // Keep the permission call in the click handler's task, before any await.
    const permission = supported() ? Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission() : Promise.reject(Error('notification_unsupported'));
    busy = true; lastError = ''; render(); $('notification-error').hidden = true;
    try {
      const granted = await permission;
      if (granted !== 'granted') {
        remember({enabled:false,preview:state.preview});
        await persist(false,state.preview);
        throw Error(granted === 'denied' ? 'notification_denied' : 'notification_dismissed');
      }
      remember({enabled:true,preview:state.preview});
      await connect(state.preview);
      ctx.closeModal('notification-dialog');
    } catch (error) { lastError = errorCopy(error); $('notification-error').textContent = lastError; $('notification-error').hidden = false; }
    finally { busy = false; render(); checkEvents(); }
  }
  async function decline() {
    if (busy || !ctx || !state) return;
    remember({enabled:false,preview:state.preview}); busy = true; render();
    try { await persist(false,state.preview); }
    catch (error) { state = {...state,confirmed:true,enabled:false}; lastError = errorCopy(error); }
    finally { busy = false; ctx.closeModal('notification-dialog'); render(); }
  }
  async function saveChoice(enabled,preview) {
    if (busy || !state || ctx.isBusy()) { render(); return; }
    busy = true; render();
    try { await persist(enabled,preview); } catch (error) { lastError = errorCopy(error); }
    finally { busy = false; render(); }
  }
  async function load() {
    if (!ctx || busy) return; busy = true; render();
    try { state = await ctx.api('/api/notifications'); lastError = ''; }
    catch (error) { lastError = errorCopy(error); }
    finally { busy = false; render(); }
  }
  async function init(context) {
    ctx = context; generation++; eventsCursor = 0; clearTimeout(eventsTimer);
    clearTimeout(retryTimer);
    await load(); if (!state) { retryTimer = setTimeout(() => init(ctx),20000); return; }
    await checkEvents();
    const previous = remembered();
    try {
      const choice = state.confirmed ? state : previous;
      if (choice) {
        busy = true; render();
        if (choice.enabled && supported() && Notification.permission === 'granted') await connect(choice.preview);
        else if (!state.confirmed || state.enabled) await persist(false,choice.preview);
        else remember(state);
      }
    } catch (error) { lastError = errorCopy(error); }
    finally { busy = false; render(); }
    maybePrompt(); checkEvents();
  }
  $('notification-enable').addEventListener('click',enable);
  $('notification-later').addEventListener('click',decline);
  $('setting-notifications').addEventListener('change',event => { if (event.target.checked) { render(); prompt(); } else saveChoice(false,state.preview); });
  $('setting-notification-preview').addEventListener('change',event => saveChoice(state.enabled,event.target.checked));
  $('retry-notifications').addEventListener('click',() => { if (!state) load().then(maybePrompt); else prompt(); });
  $('test-notifications').addEventListener('click',testNotification);
  document.addEventListener('visibilitychange',() => {
    if (!document.hidden && ctx) {
      if (state?.enabled && supported() && Notification.permission !== 'granted') saveChoice(false,state.preview);
      render(); maybePrompt(); checkEvents();
    }
  });
  window.addEventListener('storage',event => { if (ctx && event.key === KEY && !busy) load(); });
  window.addEventListener('online',() => { if (ctx && !busy) { if (!state) init(ctx); else { checkEvents(); if (state.enabled && Notification.permission === 'granted') connect(state.preview).catch(error => { lastError = errorCopy(error); render(); }); } } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',event => {
    if (ctx && event.data?.type === 'chawe-new-message' && event.data.accountId === ctx.id) ctx.refresh();
  });
  return {init,load,render,isBusy:() => busy};
})();
