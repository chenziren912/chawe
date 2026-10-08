'use strict';
// Permission is requested only from an explicit click in the page's own confirmation dialog.
window.chaweNotifications = (() => {
  const $ = id => document.getElementById(id), KEY = 'chawe-notifications-v1';
  let ctx, state = null, busy = false, phase = '', lastError = '', registration, workerPending, pushPending, connecting, promptTimer, retryTimer, promptShown = false;
  let choiceRevision = 0, writes = Promise.resolve();
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
      notification_permission_timeout:'还没收到浏览器的授权结果。请检查地址栏的通知提示，或在网站权限中允许通知后重试。',
      notification_worker_timeout:'浏览器通知组件启动超时，请刷新网页后重新连接。',
      notification_save_timeout:'保存通知设置超时，请检查网络后重试。',
      notification_timeout:'连接通知服务超时，请检查网络后重试。'})[error.message] || (error.name === 'NotAllowedError' ? '浏览器或系统阻止了通知，请检查网站权限和系统通知设置。' : ctx.errorText(error));
  }
  const current = (version,revision) => version === generation && revision === choiceRevision;
  function deadline(task,delay = 10000,reason = 'notification_timeout') {
    let timer;
    return Promise.race([task,new Promise((_,reject) => { timer = setTimeout(() => reject(Error(reason)),delay); })]).finally(() => clearTimeout(timer));
  }
  async function request(context,path,options) {
    const controller = new AbortController();
    try { return await deadline(context.api(path,{...options,signal:controller.signal}),10000,options?.method === 'POST' ? 'notification_save_timeout' : 'notification_timeout'); }
    finally { controller.abort(); }
  }
  function render() {
    $('setting-notifications').checked = !!state?.enabled;
    $('setting-notifications').disabled = busy || !state || !supported();
    $('setting-notification-preview').checked = state?.preview !== false;
    $('setting-notification-preview').disabled = busy || !state;
    $('notification-later').disabled = busy && phase !== 'permission'; $('notification-enable').disabled = busy || !supported();
    $('notification-enable').textContent = busy ? phase === 'permission' ? '等待浏览器授权…' : '正在保存…' : '开启通知';
    let copy = !state ? '正在加载通知设置…' : busy ? phase === 'permission' ? '请在浏览器的通知权限提示中选择允许。' : '正在保存通知设置…' : !supported() ? '这个浏览器暂不支持后台通知。'
      : Notification.permission === 'denied' ? '浏览器已阻止通知；请在地址栏的网站设置中允许通知。'
      : state.enabled && connecting ? '通知已开启，正在连接后台推送；你可以继续聊天。'
      : state.enabled && state.subscribed ? '浏览器通知已启用；网页打开时会自动补发未收到的通知。'
      : state.enabled ? '网页打开时可接收通知，关闭网页后的推送需要重新连接。' : '浏览器通知已关闭。';
    if (state?.enabled && state.pushStatus >= 400) copy = '后台推送服务返回 ' + state.pushStatus + '；网页打开时仍可接收通知，请重新连接后台推送。';
    $('notification-status').textContent = lastError || copy;
    $('retry-notifications').hidden = busy || !!connecting || !supported() || !(lastError || state?.enabled && (!state?.subscribed || state.pushStatus >= 400));
    $('test-notifications').disabled = busy || !state?.enabled || !supported() || Notification.permission !== 'granted';
  }
  async function worker() {
    if (registration?.active) return registration;
    if (!workerPending) {
      const task = deadline((async () => {
        const registered = await navigator.serviceWorker.register('/notification-worker.js',{scope:'/',updateViaCache:'none'});
        const ready = await navigator.serviceWorker.ready;
        if (ready.scope !== registered.scope || !ready.active) throw Error('notification_unsupported');
        return ready;
      })(),10000,'notification_worker_timeout');
      workerPending = task;
      task.then(value => { registration = value; },() => {}).finally(() => { if (workerPending === task) workerPending = null; });
    }
    return workerPending;
  }
  function applicationKey(value) { const source = atob(value.replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(source,char => char.charCodeAt(0)); }
  async function subscription() {
    if (!('PushManager' in window)) throw Error('notification_unsupported');
    const reg = await worker(); let sub = await deadline(reg.pushManager.getSubscription(),5000);
    const key = applicationKey(state.publicKey);
    if (sub && sub.options.applicationServerKey) {
      const existing = new Uint8Array(sub.options.applicationServerKey);
      if (existing.length !== key.length || !existing.every((byte,index) => byte === key[index])) { await deadline(sub.unsubscribe(),5000); sub = null; }
    }
    if (!sub) {
      // A timed-out native subscribe call cannot be cancelled. Reuse it on retry
      // instead of starting overlapping subscriptions in Edge's push service.
      if (!pushPending) {
        const task = reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
        pushPending = task;
        task.then(() => {},() => {}).finally(() => { if (pushPending === task) pushPending = null; });
      }
      sub = await deadline(pushPending,10000);
    }
    const json = sub.toJSON(); return {endpoint:json.endpoint,p256dh:json.keys.p256dh,auth:json.keys.auth};
  }
  async function persist(enabled,preview,subscriptionData) {
    const version = generation, revision = choiceRevision, context = ctx;
    const task = writes.then(async () => {
      if (!current(version,revision)) throw Error('notification_superseded');
      const data = await request(context,'/api/notifications/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({enabled,preview,...subscriptionData})});
      if (!current(version,revision)) throw Error('notification_superseded');
      state = data; remember(state); lastError = ''; render(); return data;
    });
    writes = task.catch(() => {}); return task;
  }
  function connect() {
    if (connecting || !state?.enabled || !supported() || Notification.permission !== 'granted') return;
    const job = {version:generation,revision:choiceRevision}; connecting = job; render();
    (async () => {
      const sub = await subscription();
      if (current(job.version,job.revision) && state?.enabled && Notification.permission === 'granted') await persist(true,state.preview,sub);
    })().catch(error => {
      if (current(job.version,job.revision) && state?.enabled) {
        lastError = (registration?.active ? '网页通知已启用，后台推送暂未连接：' : '通知组件暂未连接：') + errorCopy(error); render();
      }
    }).finally(() => {
      if (connecting === job) {
        connecting = null; render();
        if (!current(job.version,job.revision)) connect();
      }
    });
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
      const data = await request(ctx,'/api/notifications/events?since=' + eventsCursor);
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
    try { await workerRequest('chawe-notification-test'); lastError = ''; render(); $('notification-status').textContent = '测试通知已交给浏览器。如果没有弹出，请检查系统是否允许当前浏览器通知，以及勿扰模式。'; }
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
    const version = generation, revision = ++choiceRevision;
    busy = true; phase = 'permission'; lastError = ''; render(); $('notification-error').hidden = true;
    try {
      // Request permission in this click's task, before any await or network call.
      if (!supported()) throw Error('notification_unsupported');
      const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
      const granted = await deadline(permission,20000,'notification_permission_timeout');
      if (!current(version,revision)) return;
      phase = 'save'; render();
      if (granted !== 'granted') {
        await persist(false,state.preview);
        throw Error(granted === 'denied' ? 'notification_denied' : 'notification_dismissed');
      }
      await persist(true,state.preview);
      if (!current(version,revision)) return;
      // Notification permission and saving the choice complete the dialog.
      // An external push-service connection must not keep it locked open.
      ctx.closeModal('notification-dialog');
      connect();
    } catch (error) {
      if (current(version,revision)) { lastError = errorCopy(error); $('notification-error').textContent = lastError; $('notification-error').hidden = false; }
    } finally {
      if (current(version,revision)) { busy = false; phase = ''; render(); checkEvents(); }
    }
  }
  async function decline() {
    if ((busy && phase !== 'permission') || !ctx || !state) return;
    const version = generation, revision = ++choiceRevision;
    remember({enabled:false,preview:state.preview}); busy = true; phase = 'save'; render();
    try { await persist(false,state.preview); }
    catch (error) { if (current(version,revision)) { state = {...state,confirmed:true,enabled:false}; lastError = errorCopy(error); } }
    finally { if (current(version,revision)) { busy = false; phase = ''; ctx.closeModal('notification-dialog'); render(); } }
  }
  async function saveChoice(enabled,preview) {
    if (busy || !state || ctx.isBusy()) { render(); return; }
    const version = generation, revision = ++choiceRevision;
    busy = true; phase = 'save'; render();
    try { await persist(enabled,preview); }
    catch (error) { if (current(version,revision)) lastError = errorCopy(error); }
    finally { if (current(version,revision)) { busy = false; phase = ''; render(); if (state?.enabled) connect(); } }
  }
  async function load() {
    if (!ctx || busy) return;
    const version = generation, revision = choiceRevision;
    busy = true; phase = 'load'; render();
    try { const data = await request(ctx,'/api/notifications'); if (current(version,revision)) { state = data; lastError = ''; } }
    catch (error) { if (current(version,revision)) lastError = errorCopy(error); }
    finally { if (current(version,revision)) { busy = false; phase = ''; render(); } }
  }
  async function init(context) {
    ctx = context; generation++; choiceRevision++; busy = false; phase = ''; state = null; eventsCursor = 0; clearTimeout(eventsTimer);
    const version = generation, revision = choiceRevision;
    clearTimeout(retryTimer);
    await load(); if (!current(version,revision)) return;
    if (!state) { retryTimer = setTimeout(() => init(ctx),20000); return; }
    const previous = remembered();
    try {
      const choice = state.confirmed ? state : previous;
      if (choice) {
        busy = true; phase = 'save'; render();
        if (choice.enabled && supported() && Notification.permission === 'granted') {
          if (!state.confirmed || !state.enabled) await persist(true,choice.preview);
          connect();
        }
        else if (!state.confirmed || state.enabled) await persist(false,choice.preview);
        else remember(state);
      }
    } catch (error) { if (current(version,revision)) lastError = errorCopy(error); }
    finally { if (current(version,revision)) { busy = false; phase = ''; render(); } }
    if (current(version,revision)) { maybePrompt(); checkEvents(); }
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
  window.addEventListener('storage',event => { if (ctx && event.key === KEY && !busy) { choiceRevision++; load(); } });
  window.addEventListener('online',() => { if (ctx && !busy) { if (!state) init(ctx); else { checkEvents(); connect(); } } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',event => {
    if (ctx && event.data?.type === 'chawe-new-message' && event.data.accountId === ctx.id) ctx.refresh();
  });
  return {init,load,render,isBusy:() => busy};
})();
