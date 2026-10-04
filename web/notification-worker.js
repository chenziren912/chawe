'use strict';
// Notification previews always use current cookies. Media caching has its own authorization check.
importScripts('/media-cache-worker.js?v=native-download-20261003');
self.addEventListener('install',event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event => event.waitUntil(self.clients.claim()));
const validEvent = value => /^[a-f0-9]{32}$/.test(value?.event) && /^[a-f0-9]{32}$/.test(value?.accountId) && /^[a-f0-9]{32}$/.test(value?.peerId);
let database, delivery = Promise.resolve();
const notificationInterval = 15000;
let lastShownAt = 0, pendingDelivery, pendingTimer;
const memorySeen = new Map();
const databaseReady = () => database ||= new Promise((resolve,reject) => {
  const request = indexedDB.open('chawe-notification-delivery-v1',1);
  request.onupgradeneeded = () => request.result.createObjectStore('events',{keyPath:'id'}).createIndex('expires','expires');
  request.onsuccess = () => resolve(request.result); request.onerror = () => { database = null; reject(request.error); };
});
async function seen(id) {
  if ((memorySeen.get(id) || 0) > Date.now()) return true;
  try {
    const db = await databaseReady();
    return await new Promise((resolve,reject) => {
      const tx = db.transaction('events','readonly'), request = tx.objectStore('events').get(id);
      request.onsuccess = () => resolve(request.result?.expires > Date.now()); request.onerror = () => reject(request.error);
    });
  } catch { return false; }
}
async function remember(id) {
  memorySeen.set(id,Date.now()+86400000);
  for (const [key,expires] of memorySeen) if (expires <= Date.now()) memorySeen.delete(key);
  while (memorySeen.size > 5000) memorySeen.delete(memorySeen.keys().next().value);
  try {
    const db = await databaseReady();
    await new Promise((resolve,reject) => {
      const tx = db.transaction('events','readwrite'), store = tx.objectStore('events');
      store.put({id,expires:Date.now()+86400000});
      store.index('expires').openCursor(IDBKeyRange.upperBound(Date.now())).onsuccess = event => {
        const cursor = event.target.result; if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch { /* Storage restrictions must not suppress the browser notification itself. */ }
}
function queueDelivery(payload,background = false) {
  const task = delivery.then(() => deliver(payload,background)); delivery = task.catch(() => {}); return task;
}
async function deviceLastShown(visible) {
  for (const notification of visible) if (validEvent(notification.data)) lastShownAt = Math.max(lastShownAt,notification.timestamp || 0);
  try {
    const db = await databaseReady();
    const saved = await new Promise((resolve,reject) => {
      const request = db.transaction('events','readonly').objectStore('events').get('device-state-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (Number.isFinite(saved?.shown)) lastShownAt = Math.max(lastShownAt,saved.shown);
  } catch { /* The server also persists the device reservation. */ }
  return lastShownAt;
}
async function rememberDevice(shown) {
  lastShownAt = shown;
  try {
    const db = await databaseReady();
    await new Promise((resolve,reject) => {
      const tx = db.transaction('events','readwrite');
      tx.objectStore('events').put({id:'device-state-v1',shown,expires:shown+86400000});
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch { /* Restricted storage still uses the worker and server reservations. */ }
}
function deferDelivery(payload,background,delay) {
  pendingDelivery = {payload,background}; clearTimeout(pendingTimer);
  // This timer is a convenience; the durable server outbox retries if the worker is suspended.
  pendingTimer = setTimeout(() => {
    const pending = pendingDelivery; pendingDelivery = null;
    if (pending) queueDelivery(pending.payload,pending.background).catch(() => {});
  },Math.max(50,delay+50));
}
async function deliver(payload,background) {
  if (!validEvent(payload)) throw Error('invalid_notification');
  if (await seen(payload.event)) return;
  // Also deduplicate after a worker restart between showing and saving the event ID.
  const visible = await self.registration.getNotifications();
  const wait = Math.min(notificationInterval,Math.max(0,await deviceLastShown(visible)+notificationInterval-Date.now()));
  if (visible.some(notification => notification.data?.event === payload.event)) { await remember(payload.event); return; }
  let data;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),10000);
  try {
    const response = await fetch('/api/notifications/message?event=' + payload.event + '&wait=' + Math.ceil(wait),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if ([401,403,404].includes(response.status)) { await remember(payload.event); return; }
    if (!response.ok) throw Error('notification_connection_failed');
    data = await response.json();
    if (!validEvent(data) || data.event !== payload.event || data.accountId !== payload.accountId || data.peerId !== payload.peerId) throw Error('invalid_notification');
    if (data.suppressed) {
      if (Number.isFinite(data.retryAfter) && data.retryAfter > 0) deferDelivery(payload,background,Math.min(notificationInterval,data.retryAfter));
      else await remember(payload.event);
      return;
    }
  } catch (error) {
    if (!background) throw error;
    if (wait > 0) { deferDelivery(payload,background,wait); return; }
    data = {...payload,title:'chawe',body:'你收到了一条新消息，连接恢复后可查看。'};
  } finally { clearTimeout(timeout); }
  const shown = Date.now();
  await self.registration.showNotification(data.title,{body:data.body,icon:'/wechat-upside-down.svg',tag:'chawe-messages',
    renotify:true,silent:false,data:{event:data.event,accountId:data.accountId,peerId:data.peerId},timestamp:shown});
  await rememberDevice(shown);
  for (const notification of visible) if (validEvent(notification.data) && notification.tag !== 'chawe-messages') notification.close();
  await remember(payload.event);
  const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for (const window of windows) window.postMessage({type:'chawe-new-message',accountId:data.accountId,peerId:data.peerId});
}
self.addEventListener('message',event => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  if (!['chawe-notification-check','chawe-notification-test'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    try {
      if (event.data.type === 'chawe-notification-test') await self.registration.showNotification('chawe · 测试通知',{
        body:'浏览器通知通道已开启。收到新消息时会在这里提醒。',icon:'/wechat-upside-down.svg',tag:'chawe-notification-test',renotify:true,silent:false});
      else await queueDelivery(event.data);
      event.ports[0]?.postMessage({ok:true});
    } catch (error) { event.ports[0]?.postMessage({ok:false,error:error.name === 'NotAllowedError' ? 'notification_denied' : 'notification_connection_failed'}); }
  })());
});
self.addEventListener('pushsubscriptionchange',event => {
  event.waitUntil((async () => {
    let sub = event.newSubscription || await self.registration.pushManager.getSubscription();
    if (!sub && event.oldSubscription?.options) sub = await self.registration.pushManager.subscribe(event.oldSubscription.options);
    if (!sub) return;
    const value = sub.toJSON();
    const response = await fetch('/api/notifications/refresh',{method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({endpoint:value.endpoint,p256dh:value.keys.p256dh,auth:value.keys.auth})});
    if (!response.ok) throw Error('notification_subscription_refresh_failed');
  })());
});
self.addEventListener('push',event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    if (validEvent(payload)) await queueDelivery(payload,true);
  })());
});
self.addEventListener('notificationclick',event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (!/^[a-f0-9]{32}$/.test(data?.accountId) || !/^[a-f0-9]{32}$/.test(data?.peerId)) return;
    const url = self.location.origin + '/app?accountId=' + data.accountId + '&peerId=' + data.peerId;
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    // Reuse a tab for this account only. Do not replace another account or its draft.
    for (const window of windows) {
      const current = new URL(window.url);
      if (current.origin === self.location.origin && current.searchParams.get('accountId') === data.accountId) {
        await window.navigate(url); await window.focus(); return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
