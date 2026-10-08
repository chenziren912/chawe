'use strict';
const $ = id => document.getElementById(id);
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const workspace = document.querySelector('.workspace');
const Groups=window.chaweGroups, Pins=window.chawePins;
const inviteToken=(()=>{try{return new URLSearchParams(location.search).get('invite') || sessionStorage.getItem('chawe-group-invite') || '';}catch{return '';}})();
const requestedAccount = new URLSearchParams(location.search).get('account') || '';
const requestedAccountIdentity = new URLSearchParams(location.search).get('accountId') || '';
const drafts = new Map();
const messageNodes = new Map(), dayNodes = new Map(), sendFlights = new Set();
const receiptStates = new Map();
const receiptKey=peer=>Groups.isGroup(peer)?peer+':'+Groups.topicOf(peer)+':'+!!Groups.of(peer)?.topicsEnabled:peer;
let readAckTimer, readAckBusy = false;
const sendMotionWaiters = new Set();
const SEND_MOTION_DURATION = 360, SEND_MOTION_EASING = 'cubic-bezier(.2,.8,.2,1)';
let renderedPeer = null, catchupAfter = null;
let me = '', active = null, chats = [], contacts = [], entries = [], hasOlder = false;
let recommendedGroups = [];
const recommendationJoin = {id:null,busy:false,error:''};
const RECOMMENDATIONS_HIDDEN_PREFIX = 'chawe-group-recommendations-hidden-v1:';
const recommendationVisibility = new Map();
let recommendationSaveFailed = false;
let contactDetails = new Map(), blockedPeople = [], searchPeople = [];
let panel = 'chats', listQuery = '', listError = '', peopleError = '';
let searchActive = false, searchOriginPanel = 'chats';
let searchOriginChats = [], sidePage = 'chats-panel';
const popupStates = new Map(), sideAnimations = new Set();
const UI_MOTION_DURATION = 300, UI_MOTION_EASING = 'cubic-bezier(.2,.8,.2,1)';
let activeProfile = null, profileError = '';
let sending = false, loadingOlder = false, olderError = false, polling = false;
let listRequest = 0, contactRequest = 0, blockRequest = 0, profileRequest = 0, messageRequest = 0;
let contactDialogRequest = 0, confirmDialogRequest = 0, confirmation = null;
let listTimer, searchBusy = false;
const chatSearch = {peer:null,query:'',rows:[],more:false,busy:false,locating:false,controller:null,timer:null,epoch:0};
let savedAccounts = [], switchingAccount = false, loggingOut = false, maxBrowserAccounts = 5;
let activeModal = null, modalReturnFocus = null;
const peerProfiles = new Map();
let ownProfile = null, ownInfoLoaded = false, ownInfoLoading = false, ownInfoSaving = false, ownInfoDirty = false, ownInfoRequest = 0;
let contactExclusions = new Set(), privacySelection = new Set(), privacyPeopleRequest = 0;
let avatarBusy = false, pendingAvatar = null;
let meIdentity = '', directoryVersion = 0, usernameBusy = false, reloadingDirectory = false;
const restorePeerId = new URLSearchParams(location.search).get('peerId') || '';
let openingPeer = null, failedOpenPeer = null, chatOpenRequest = 0, chatOpenController = null;
let messageReady = false, booting = false;
let messagesRevision = 0, changesSync = null, messageMenuTarget = null, editingMessage = null, messageActionBusy = false;
let apiSerial = 0, failedApiSerial = 0, connectionFailed = navigator.onLine === false;
let reconnectTimer, reconnecting = false, reconnectDelay = 2000;
const slowRequests = new Set();

// Appearance is a browser preference shared by its accounts, never chat data.
const UI_SETTINGS_KEY = 'chawe-ui-settings-v1';
const UI_SETTINGS_DEFAULTS = Object.freeze({animations:true,speed:1,transparency:62,blur:true,ripples:true});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
let uiSettings = readUiSettings(), appliedMotionKey = '', settingsSaveFailed = false;
function normalizeUiSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const number = (key,min,max,step) => typeof source[key] === 'number' && Number.isFinite(source[key])
    ? Math.round(Math.max(min,Math.min(max,source[key])) / step) * step : UI_SETTINGS_DEFAULTS[key];
  const flag = key => typeof source[key] === 'boolean' ? source[key] : UI_SETTINGS_DEFAULTS[key];
  return {animations:flag('animations'),speed:Number(number('speed',.5,2,.1).toFixed(1)),
    transparency:number('transparency',0,90,1),blur:flag('blur'),ripples:flag('ripples')};
}
function readUiSettings() {
  try { return normalizeUiSettings(JSON.parse(localStorage.getItem(UI_SETTINGS_KEY))); }
  catch { return {...UI_SETTINGS_DEFAULTS}; }
}
function motionEnabled() { return uiSettings.animations && !reducedMotion.matches; }
function motionDuration(duration) { return motionEnabled() ? duration / uiSettings.speed : 0; }
function finishUiMotion() {
  cancelSendFlights();
  for (const [id,state] of popupStates) {
    state.animation?.cancel(); state.animation = null;
    $(id).hidden = !state.open; $(id).inert = !state.open;
  }
  for (const animation of sideAnimations) animation.cancel(); sideAnimations.clear();
  for (const page of $('sidebar-pages').children) { page.hidden = page.id !== sidePage; page.inert = page.hidden; }
  document.dispatchEvent(new Event('chawe-ui-settings-change'));
}
function renderUiSettings() {
  $('setting-animations').checked = uiSettings.animations;
  $('setting-speed').value = String(Math.round(uiSettings.speed * 100));
  $('setting-speed-value').value = uiSettings.speed + '×';
  $('setting-speed').setAttribute('aria-valuetext',uiSettings.speed + ' 倍速');
  $('setting-speed').disabled = !motionEnabled();
  $('setting-ripples').checked = uiSettings.ripples; $('setting-ripples').disabled = !motionEnabled();
  $('setting-transparency').value = String(uiSettings.transparency);
  $('setting-transparency-value').value = uiSettings.transparency + '%';
  $('setting-transparency').setAttribute('aria-valuetext',uiSettings.transparency + '%');
  $('setting-transparency').disabled = reducedTransparency.matches;
  $('setting-blur').checked = uiSettings.blur; $('setting-blur').disabled = reducedTransparency.matches;
  $('settings-motion-hint').hidden = !reducedMotion.matches;
  $('settings-transparency-hint').hidden = !reducedTransparency.matches;
  for (const id of ['setting-speed','setting-transparency']) {
    const input = $(id), progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
    input.style.setProperty('--range-progress',(progress * 100) + '%');
  }
  $('settings-save-status').textContent = settingsSaveFailed
    ? '设置已生效，但浏览器未允许保存；刷新页面后可能恢复默认。'
    : '动画和外观设置自动保存在当前浏览器，对这里登录的所有账号生效。';
  renderRecommendationSetting();
}
function applyUiSettings() {
  const root = document.documentElement, factor = uiSettings.transparency / UI_SETTINGS_DEFAULTS.transparency;
  // Preserve the existing relative tints, including the denser top-left menu.
  const tint = (name,alpha,rgb = '255,255,255') => root.style.setProperty('--glass-' + name,
    'rgba(' + rgb + ',' + Math.max(.08,Math.min(1,1 - (1 - alpha) * factor)).toFixed(3) + ')');
  for (const [name,alpha] of Object.entries({pane:.30,bar:.32,popup:.38,dialog:.48,control:.26,
    more:.628,composer:.42,search:.36,card:.20,bubble:.52,hoverWhite:.54,input:.28,border:.45})) tint(name,alpha);
  tint('outgoing',.52,'227,241,255'); tint('action',.38,'230,243,255');
  tint('actionHover',.58,'214,236,255'); tint('readonly',.28,'226,237,247');
  root.style.setProperty('--glass-blur',uiSettings.blur ? '14px' : '0px');
  root.style.setProperty('--glass-backdrop-blur',uiSettings.blur ? '4px' : '0px');
  for (const duration of [120,140,150,160,200,220,240,300,1000,2800]) {
    root.style.setProperty('--motion-' + duration,motionDuration(duration) + 'ms');
  }
  root.classList.toggle('motion-disabled',!motionEnabled());
  root.classList.toggle('ripples-disabled',!motionEnabled() || !uiSettings.ripples);
  const motionKey = JSON.stringify([uiSettings.animations,uiSettings.speed,uiSettings.ripples,reducedMotion.matches]);
  if (appliedMotionKey !== motionKey) { finishUiMotion(); appliedMotionKey = motionKey; }
  renderUiSettings();
}
function updateUiSettings(patch) {
  uiSettings = normalizeUiSettings({...uiSettings,...patch});
  try { localStorage.setItem(UI_SETTINGS_KEY,JSON.stringify(uiSettings)); settingsSaveFailed = false; }
  catch { settingsSaveFailed = true; }
  applyUiSettings();
}

function rememberPeople(people) {
  Groups.remember(people);
  for (const person of people) if (typeof person?.username === 'string') {
    const previous = peerProfiles.get(person.username);
    const freshAvatar = typeof person.avatarUrl === 'string' && Number.isSafeInteger(person.avatarVersion)
      && person.avatarVersion >= (previous?.avatarVersion || 0);
    peerProfiles.set(person.username,{username:person.username,id:/^[a-f0-9]{32}$/.test(person.id) ? person.id : previous?.id || '',nickname:person.nickname ?? previous?.nickname ?? '',
      avatarUrl:freshAvatar ? person.avatarUrl : previous?.avatarUrl || '',avatarVersion:freshAvatar ? person.avatarVersion : previous?.avatarVersion || 0});
    if (person.username === me && ownProfile && freshAvatar && person.avatarVersion >= (ownProfile.avatarVersion || 0)) {
      ownProfile = {...ownProfile,avatarUrl:person.avatarUrl,avatarVersion:person.avatarVersion};
    }
  }
  const users = new Set(people.map(person => person?.username));
  for (const node of document.querySelectorAll('[data-avatar-peer]')) if (users.has(node.dataset.avatarPeer)) {
    const peer = node.dataset.avatarPeer;
    paintAvatar(node,peer,node.dataset.avatarPersonal === 'true',node.id === 'my-info-avatar'
      ? (ownInfoLoaded ? $('my-info-nickname').value.trim() : ownProfile?.nickname) || me
      : node.classList.contains('account-avatar') ? node.dataset.avatarName : peer === me ? userName(me) : titleOf(peer));
  }
}
function userName(peer) { return (peer === me ? ownProfile?.nickname : peerProfiles.get(peer)?.nickname || contactDetails.get(peer)?.nickname) || peer; }
function renderMyIdentity() {
  const nickname = ownInfoLoaded ? $('my-info-nickname').value.trim() : ownProfile?.nickname;
  const name = nickname || me;
  $('my-info-name').textContent = name; $('my-info-handle').textContent = '@' + me;
  paintAvatar($('my-info-avatar'),me,true,name);
}
function updateMyAge() {
  const value = $('my-info-birthday').value.trim(), hint = $('my-info-age');
  if (!value) { hint.textContent = '仅自己可见；服务限年满 18 周岁使用。'; return; }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) { hint.textContent = '请按 YYYY-MM-DD 填写有效日期。'; return; }
  const now = new Date(), beforeBirthday = now.getUTCMonth() < date.getUTCMonth()
    || now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate();
  const age = now.getUTCFullYear() - date.getUTCFullYear() - (beforeBirthday ? 1 : 0);
  hint.textContent = age >= 18 ? '年龄：' + age + ' 岁 · 仅自己可见' : '需填写年满 18 周岁的出生日期。';
}
function setMyInfoState(copy = '') {
  const busy = ownInfoLoading || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || usernameBusy;
  $('my-info-fields').disabled = busy || !ownInfoLoaded;
  $('save-my-info').disabled = busy || !ownInfoLoaded || !ownInfoDirty;
  $('reload-my-info').disabled = busy;
  $('save-my-info').querySelector('span').textContent = ownInfoSaving ? '保存中…' : '保存';
  $('change-my-avatar').disabled = busy || !ownInfoLoaded || switchingAccount;
  $('reset-my-avatar').disabled = busy || !ownInfoLoaded || !ownProfile?.avatarUrl || switchingAccount;
  $('change-my-avatar').textContent = ownProfile?.avatarUrl ? '更换头像' : '设置头像';
  $('my-info-username').disabled = busy || !ownInfoLoaded;
  const availableAt = ownProfile?.usernameChangeAllowedAt || 0, allowed = Date.now() >= availableAt;
  const candidate = $('my-info-username').value.trim();
  $('change-my-username').disabled = busy || !ownInfoLoaded || !allowed || !candidate || candidate === me;
  $('username-change-hint').textContent = !ownInfoLoaded ? '正在加载修改限制…' : !allowed
    ? '下次可修改时间：' + new Date(availableAt).toLocaleString('zh-CN')
    : '每 15 天可修改一次。旧用户名立即释放，修改后该账号在所有设备退出登录。';
  $('my-info-status').textContent = usernameBusy ? '正在修改用户名…' : ownInfoLoading ? '正在加载资料…' : avatarBusy ? '正在处理头像…' : ownInfoSaving ? '正在保存…'
    : copy || (ownInfoDirty ? '有未保存的修改' : '资料已与服务器同步');
}
function markMyInfoDirty() {
  if (!ownInfoLoaded || ownInfoLoading || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) return;
  ownInfoDirty = true; $('my-info-error').hidden = true;
  setMyInfoState(); renderMyIdentity(); updateMyAge();
}
function renderContactExclusions() {
  $('contact-exclusions-count').textContent = contactExclusions.size ? contactExclusions.size + ' 人' : '未设置例外';
  const list = $('contact-exclusion-chips'); list.replaceChildren();
  for (const peer of contactExclusions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'privacy-chip';
    button.setAttribute('aria-label','移除 ' + userName(peer) + ' 的例外');
    const name = document.createElement('span'); name.textContent = titleOf(peer); button.append(name);
    const close = document.createElement('span'); close.innerHTML = icon('close'); button.append(close);
    button.addEventListener('click',() => { contactExclusions.delete(peer); renderContactExclusions(); markMyInfoDirty(); }); list.append(button);
  }
}
function refreshKnownNames() {
  renderAccounts(); renderList(); updateComposer(); renderProfile();
  if (panel === 'new' || panel === 'contacts') renderContacts();
  for (const message of entries) {
    const portrait = messageNodes.get(message.seq)?.querySelector('.message-avatar');
    if (portrait) paintAvatar(portrait,message.sender,true,message.sender === me ? userName(me) : titleOf(message.sender));
  }
}
function fillMyInfo(data) {
  const currentAvatar = peerProfiles.get(me);
  ownProfile = {...data,...(currentAvatar && currentAvatar.avatarVersion > (data.avatarVersion || 0)
    ? {avatarUrl:currentAvatar.avatarUrl,avatarVersion:currentAvatar.avatarVersion} : {})};
  ownInfoLoaded = true; ownInfoDirty = false;
  $('my-info-username').value = me;
  rememberPeople([data]);
  for (const field of ['nickname','birthday','phone','email']) $('my-info-' + field).value = data[field] || '';
  $('privacy-everyone').checked = data.visibility === 'everyone'; $('privacy-contacts').checked = data.visibility !== 'everyone';
  contactExclusions = new Set(data.neverShowTo || []);
  $('my-info-error').hidden = true; $('reload-my-info').hidden = true;
  renderMyIdentity(); updateMyAge(); renderContactExclusions(); refreshKnownNames();
}
async function loadMyInfo() {
  if (!me || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) return;
  const request = ++ownInfoRequest;
  ownInfoLoading = true; $('my-info-error').hidden = true; setMyInfoState(); renderMyIdentity();
  try {
    const data = await api('/api/me/profile');
    if (request !== ownInfoRequest) return;
    fillMyInfo(data);
  } catch (error) {
    if (request === ownInfoRequest) { $('my-info-error').textContent = errorText(error); $('my-info-error').hidden = false; $('reload-my-info').hidden = false; }
  } finally {
    if (request === ownInfoRequest) { ownInfoLoading = false; setMyInfoState(ownInfoLoaded ? '' : '资料尚未加载，请重试。'); }
  }
}
function openMyInfo() {
  if (!me || switchingAccount) return;
  setPanel('info'); $('close-my-info').focus({preventScroll:true}); renderMyIdentity();
  if (!ownInfoLoaded || !ownInfoDirty) loadMyInfo();
}
async function saveMyInfo(event) {
  event.preventDefault();
  if (!ownInfoLoaded || ownInfoSaving || ownInfoLoading || avatarBusy || switchingAccount || !ownInfoDirty) return;
  const values = {nickname:$('my-info-nickname').value.trim(),birthday:$('my-info-birthday').value.trim(),
    phone:$('my-info-phone').value.trim(),email:$('my-info-email').value.trim(),
    visibility:$('privacy-everyone').checked ? 'everyone' : 'contacts',excluded:Array.from(contactExclusions).join(','),revision:ownProfile.revision};
  if (Array.from(values.nickname).length > 40) { $('my-info-error').textContent = errorText(Error('invalid_nickname')); $('my-info-error').hidden = false; return; }
  ownInfoSaving = true; $('my-info-error').hidden = true; setMyInfoState(); renderAccounts(); resizeInput();
  try {
    const data = await post('/api/me/profile/save',values); fillMyInfo(data); setMyInfoState('资料已保存');
    await Promise.all([loadAccounts(),loadContacts(),loadChats(),active ? loadActiveProfile() : Promise.resolve()]);
  } catch (error) {
    $('my-info-error').textContent = errorText(error); $('my-info-error').hidden = false;
    if (error.message === 'profile_changed') $('reload-my-info').hidden = false;
  } finally { ownInfoSaving = false; setMyInfoState(ownInfoDirty ? '' : '资料已保存'); renderAccounts(); resizeInput(); }
}
async function loadPrivacyPeople() {
  const request = ++privacyPeopleRequest; $('privacy-list-status').textContent = '正在加载用户…';
  const list = $('privacy-people-list');
  $('retry-privacy-people').hidden = true; $('privacy-done').disabled = true; list.replaceChildren();
  list.scrollTop = 0; list.setAttribute('aria-busy','true'); window.chaweScrollbars?.refresh();
  try {
    const data = await api('/api/people?query=');
    if (request !== privacyPeopleRequest || activeModal !== 'privacy-dialog') return;
    rememberPeople(data.people);
    const people = data.people.filter(person => person.username !== me).sort((a,b) => Number(contacts.includes(b.username)) - Number(contacts.includes(a.username))
      || titleOf(a.username).localeCompare(titleOf(b.username),'zh-CN'));
    const rows = document.createDocumentFragment();
    for (const person of people) {
      const label = document.createElement('label'); label.className = 'privacy-person';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = privacySelection.has(person.username);
      label.classList.toggle('is-selected',input.checked);
      input.setAttribute('aria-label','不向 ' + titleOf(person.username) + ' 显示联系方式');
      input.addEventListener('change',() => {
        if (input.checked) privacySelection.add(person.username); else privacySelection.delete(person.username);
        label.classList.toggle('is-selected',input.checked);
        $('privacy-list-status').textContent = '已选择 ' + privacySelection.size + ' 人';
      });
      const copy = document.createElement('span'); copy.className = 'privacy-person-copy';
      const name = document.createElement('strong'); name.textContent = titleOf(person.username);
      const username = document.createElement('small'); username.textContent = '@' + person.username;
      copy.append(name,username); label.append(avatar(person.username,true),copy,input); rows.append(label);
    }
    list.append(rows);
    $('privacy-list-status').textContent = people.length ? '已选择 ' + privacySelection.size + ' 人' : '还没有其他用户'; $('privacy-done').disabled = false;
  } catch (error) {
    if (request === privacyPeopleRequest && activeModal === 'privacy-dialog') { $('privacy-list-status').textContent = errorText(error); $('retry-privacy-people').hidden = false; }
  } finally {
    if (request === privacyPeopleRequest && activeModal === 'privacy-dialog') {
      list.removeAttribute('aria-busy'); window.chaweScrollbars?.refresh();
    }
  }
}
function openPrivacyPeople() {
  if (!ownInfoLoaded || ownInfoSaving || ownInfoLoading || avatarBusy) return;
  privacySelection = new Set(contactExclusions); openModal('privacy-dialog'); loadPrivacyPeople();
}


function setAvatarBusy(busy) { avatarBusy = busy; setMyInfoState(); renderAccounts(); resizeInput(); }
function applyOwnAvatar(data) {
  if (!Number.isSafeInteger(data.avatarVersion) || data.avatarVersion < Math.max(ownProfile?.avatarVersion || 0,peerProfiles.get(me)?.avatarVersion || 0)) return;
  ownProfile = {...ownProfile,avatarUrl:data.avatarUrl,avatarVersion:data.avatarVersion};
  savedAccounts = savedAccounts.map(account => account.username === me ? {...account,...data} : account);
  rememberPeople([data]); renderMyIdentity(); refreshKnownNames(); setMyInfoState();
}
async function refreshOwnAvatar() {
  try { const data = await api('/api/me/profile'); applyOwnAvatar({username:me,avatarUrl:data.avatarUrl,avatarVersion:data.avatarVersion}); } catch {}
}
function clearPendingAvatar() {
  if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
  pendingAvatar = null;
}
async function prepareAvatar(file) {
  if (!file || !ownInfoLoaded || ownInfoLoading || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || switchingAccount) return;
  $('my-info-error').hidden = true;
  if (file.size > 10 * 1024 * 1024) { $('my-info-error').textContent = '请选择不超过 10 MB 的图片。'; $('my-info-error').hidden = false; return; }
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) { $('my-info-error').textContent = '请选择 PNG、JPG 或 WebP 图片。'; $('my-info-error').hidden = false; return; }
  setAvatarBusy(true);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height || bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 40_000_000) throw Error('invalid_avatar');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const side = Math.min(bitmap.width,bitmap.height), context = canvas.getContext('2d');
    if (!context) throw Error('invalid_avatar');
    context.imageSmoothingQuality = 'high'; context.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,512,512);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    if (!blob || blob.size > 2 * 1024 * 1024) throw Error('invalid_avatar');
    clearPendingAvatar(); pendingAvatar = {blob,url:URL.createObjectURL(blob),revision:ownProfile.avatarVersion || 0};
    $('avatar-preview').src = pendingAvatar.url; $('avatar-error').hidden = true;
    $('avatar-submit').disabled = false; $('avatar-submit').textContent = '确认设置'; $('avatar-cancel').disabled = false;
    setAvatarBusy(false); openModal('avatar-dialog'); $('avatar-cancel').focus({preventScroll:true});
  } catch (error) { $('my-info-error').textContent = errorText(Error('invalid_avatar')); $('my-info-error').hidden = false; }
  finally { bitmap?.close(); if (avatarBusy) setAvatarBusy(false); }
}
async function saveAvatar() {
  if (!pendingAvatar || avatarBusy || $('avatar-submit').disabled) return;
  const pending = pendingAvatar;
  let succeeded = false;
  setAvatarBusy(true); $('avatar-error').hidden = true; $('avatar-submit').disabled = true; $('avatar-cancel').disabled = true; $('avatar-submit').textContent = '正在保存…';
  try {
    const data = await api('/api/me/avatar',{method:'POST',headers:{'Content-Type':'image/png','X-Chawe-Avatar-Version':String(pending.revision)},body:pending.blob});
    applyOwnAvatar(data); setAvatarBusy(false); closeModal('avatar-dialog'); succeeded = true;
  } catch (error) {
    $('avatar-error').textContent = errorText(error); $('avatar-error').hidden = false;
    if (error.message === 'avatar_changed') await refreshOwnAvatar();
  } finally {
    setAvatarBusy(false); $('avatar-submit').disabled = false; $('avatar-cancel').disabled = false; $('avatar-submit').textContent = '确认设置';
    if (succeeded) setMyInfoState(ownInfoDirty ? '头像已保存；其他修改请点击保存' : '头像已保存');
  }
}

// Cache only confirmed messages, partitioned by the signed-in account and peer.
const messageCache = (() => {
  const memory = new Map(), MAX_MESSAGES = 1000, MAX_RECORDS = 64, MAX_BYTES = 20 * 1024 * 1024;
  let database, writeQueue = Promise.resolve();
  const keyOf = (account,peer) => !Groups.isGroup(peer)?JSON.stringify(['identity-v1',meIdentity,directoryVersion,account,peer]):JSON.stringify(['identity-v2',meIdentity,directoryVersion,account,peer,Groups.topicOf(peer),Groups.of(peer)?.historyFloor || 0,Groups.of(peer)?.topicsEnabled || false]);
  function recordOf(account,peer,messages,revision = 0) {
    const unique = new Map();
    for (const message of messages) {
      if (!Number.isSafeInteger(message?.seq) || message.seq <= 0 || !Number.isFinite(message.time)
          || !(Groups.isGroup(peer)?/^[A-Za-z0-9_]{3,20}$/.test(message.sender):[account,peer].includes(message.sender)) || typeof message.text !== 'string' || message.text.length > (message.attachment?.kind === 'article' ? 200000 : 8000)) continue;
      const version = Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : 0;
      if (unique.has(message.seq) && unique.get(message.seq).revision > version) continue;
      unique.set(message.seq,{seq:message.seq,time:message.time,sender:message.sender,
        text:message.deleted ? '' : message.text,revision:version,
        editedAt:Number.isFinite(message.editedAt) ? message.editedAt : 0,deleted:message.deleted === true,
        read:message.read===true,topic:message.topic || Groups.topicOf(peer),reactions:message.reactions || [],attachment:message.deleted ? null : window.chaweAttachments.normalize(message.attachment)});
    }
    const ordered = Array.from(unique.values()).sort((a,b) => a.seq-b.seq), kept = [];
    let size = 0, next = ordered.at(-1)?.seq;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const message = ordered[i], bytes = message.text.length * 2 + (message.attachment?.name.length || 0)*2 + 300;
      // A gap must stay on the server side of lazy loading, never masquerade as cached history.
      if ((!Groups.isGroup(peer) && message.seq !== next) || kept.length >= MAX_MESSAGES || (kept.length && size + bytes > 1024 * 1024)) break;
      kept.push(message); size += bytes; next--;
    }
    kept.reverse();
    return {key:keyOf(account,peer),account,peer,messages:kept,more:(kept[0]?.seq || 1) > 1,bytes:size,
      revision:Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      readThrough:receiptStates.get(receiptKey(peer))?.readThrough || 0,peerReadThrough:receiptStates.get(receiptKey(peer))?.peerReadThrough || 0,updatedAt:Date.now()};
  }
  function remember(record) {
    memory.set(record.key,record);
    let bytes = 0, count = 0;
    for (const item of Array.from(memory.values()).sort((a,b) => b.updatedAt-a.updatedAt)) {
      bytes += item.bytes; count++;
      if (count > MAX_RECORDS || bytes > MAX_BYTES) memory.delete(item.key);
    }
    return record;
  }
  function open() {
    if (database) return database;
    database = new Promise(resolve => {
      let request, settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(null),800);
      try { request = indexedDB.open('chawe-message-cache-v1',1); } catch { finish(null); return; }
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('conversations',{keyPath:'key'});
        store.createIndex('updatedAt','updatedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => { db.close(); database = null; };
        finish(db);
      };
      request.onerror = request.onblocked = () => finish(null);
    });
    return database;
  }
  async function read(account,peer) {
    const key = keyOf(account,peer);
    if (memory.has(key)) return memory.get(key);
    const db = await open(); if (!db) return null;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(null),250);
      try {
        const request = db.transaction('conversations').objectStore('conversations').get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.account !== account || record.peer !== peer || !Array.isArray(record.messages)) { finish(null); return; }
          applyReadState(record,peer,false);
          const existing = memory.get(key);
          finish(remember(recordOf(account,peer,[...record.messages,...(existing?.messages || [])],
            Math.max(record.revision || 0,existing?.revision || 0))));
        };
        request.onerror = () => finish(null);
      } catch { finish(null); }
    });
  }
  function save(account,peer,messages,revision = 0) {
    if (!account || !peer) return;
    const old = memory.get(keyOf(account,peer));
    const record = recordOf(account,peer,[...(old?.messages || []),...messages],Math.max(old?.revision || 0,revision));
    if (old && old.revision === record.revision && old.readThrough === record.readThrough && old.peerReadThrough === record.peerReadThrough && old.messages.length === record.messages.length
        && old.messages.every((message,index) => message.seq === record.messages[index].seq
          && message.revision === record.messages[index].revision && message.text === record.messages[index].text
          && message.deleted === record.messages[index].deleted && message.attachment?.id === record.messages[index].attachment?.id)) return;
    remember(record);
    writeQueue = writeQueue.then(async () => {
      const db = await open(); if (!db) return;
      await new Promise(resolve => {
        let transaction;
        try {
          transaction = db.transaction('conversations','readwrite');
          const store = transaction.objectStore('conversations'), request = store.get(record.key);
          request.onsuccess = () => {
            const stored = request.result;
            const valid = stored?.account === account && stored.peer === peer && Array.isArray(stored.messages);
            if (valid) applyReadState(stored,peer,false);
            applyReadState(record,peer,false);
            const merged = recordOf(account,peer,[...(valid ? stored.messages : []),...record.messages],
              Math.max(valid ? stored.revision || 0 : 0,record.revision));
            store.put(merged);
            let count = 0, bytes = 0;
            const cursor = store.index('updatedAt').openCursor(null,'prev');
            cursor.onsuccess = () => {
              const item = cursor.result; if (!item) return;
              count++; bytes += item.value.bytes || 0;
              if (count > MAX_RECORDS || bytes > MAX_BYTES) item.delete();
              item.continue();
            };
          };
          transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
        } catch { resolve(); }
      });
    }).catch(() => {});
  }
  return {read,save};
})();

function updateConnectionHint() {
  const connecting = !!openingPeer || !!chatOpenController || connectionFailed || navigator.onLine === false || slowRequests.size > 0;
  $('search').placeholder = connecting ? '连接中...' : '搜索';
  const box = $('search').closest('.search-box');
  box.classList.toggle('is-connecting',connecting);
  box.classList.toggle('is-searching',connecting || searchBusy);
  $('chat-search-box').classList.toggle('is-searching',!!chatSearch.peer && (connecting || chatSearch.busy));
  $('chat-search-input').placeholder = connecting ? '连接中...' : '搜索此聊天';
  const searchStatus = searchBusy ? '正在搜索…' : '';
  if ($('search-loading-status').textContent !== searchStatus) $('search-loading-status').textContent = searchStatus;
  const text = connecting ? '连接中，仍可点击搜索' : '';
  if ($('connection-status').textContent !== text) $('connection-status').textContent = text;
}
function connectionLost(serial) {
  connectionFailed = true; failedApiSerial = Math.max(failedApiSerial,serial);
  updateConnectionHint(); scheduleReconnect();
}
function connectionRestored(serial) {
  if (serial <= failedApiSerial || navigator.onLine === false) return;
  const recovered = connectionFailed;
  connectionFailed = false; reconnectDelay = 2000; clearTimeout(reconnectTimer);
  updateConnectionHint();
  if (recovered) setTimeout(() => {
    if (!me) boot();
    else {
      loadContacts(); loadChats(); loadActiveProfile(); pollNew();
      if (failedOpenPeer) openChat(failedOpenPeer);
    }
  },0);
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!connectionFailed || reconnecting || document.hidden || navigator.onLine === false) return;
  reconnectTimer = setTimeout(async () => {
    reconnecting = true;
    try { await api('/api/me'); } catch { reconnectDelay = Math.min(reconnectDelay * 2,20000); }
    finally { reconnecting = false; if (connectionFailed) scheduleReconnect(); }
  },reconnectDelay);
}

async function api(path, options) {
  const logicalPath=path;
  if(path.startsWith('/api/messages?') || path.startsWith('/api/messages/changes?')){const u=new URL(path,location.href),peer=u.searchParams.get('with');if(Groups.isGroup(peer)){u.searchParams.delete('with');u.searchParams.set('id',peer.slice(6));u.searchParams.set('topic',Groups.topicOf(peer));path=u.pathname.replace('/api/messages','/api/groups/messages')+'?'+u.searchParams;}}
  const account = me || requestedAccount;
  const headers = new Headers(options?.headers);
  if (account) headers.set('X-Chawe-Account',account);
  if (meIdentity || requestedAccountIdentity) headers.set('X-Chawe-Identity',meIdentity || requestedAccountIdentity);
  if (directoryVersion) headers.set('X-Chawe-Directory-Version',String(directoryVersion));
  const serial = ++apiSerial, controller = new AbortController(), external = options?.signal;
  const abort = () => controller.abort();
  if (external?.aborted) abort(); else external?.addEventListener('abort',abort,{once:true});
  const slowTimer = setTimeout(() => { slowRequests.add(serial); updateConnectionHint(); },1500);
  // Read requests can time out and retry; writes are never retried automatically.
  let timedOut = false;
  const timeout = (options?.method || 'GET') === 'GET' ? setTimeout(() => { timedOut = true; controller.abort(); },12000) : null;
  try {
    const response = await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers,signal:controller.signal});
    if (response.status === 401) {
      if (!loggingOut || path === '/api/logout') location.replace(account ? '/?add-account=1&return-account=' + encodeURIComponent(account) : '/');
      throw Error('unauthorized');
    }
    const data = await response.json();
    if (!response.ok && data.error === 'directory_changed' && me) {
      if (!reloadingDirectory) {
        reloadingDirectory = true;
        const peer = activeProfile?.id || '';
        location.replace('/app?account=' + encodeURIComponent(me) + (peer ? '&peerId=' + encodeURIComponent(peer) : ''));
      }
      throw Error('directory_changed');
    }
    if (response.status >= 500) connectionLost(serial); else connectionRestored(serial);
    if (!response.ok) throw Error(data.error || 'request_failed');
    if (data.profile?.kind==='group')rememberPeople([data.profile]);
    if (logicalPath.startsWith('/api/messages?') || logicalPath.startsWith('/api/messages/changes?')) {
      applyReadState(data,new URL(logicalPath,location.href).searchParams.get('with')); scheduleReadAck();
    }
    return data;
  } catch (error) {
    if (timedOut) { connectionLost(serial); throw Error('connection_timeout'); }
    if (error.name !== 'AbortError' && (error instanceof TypeError || error instanceof SyntaxError || error.name === 'NetworkError')) connectionLost(serial);
    throw error;
  } finally {
    clearTimeout(slowTimer); clearTimeout(timeout); external?.removeEventListener('abort',abort);
    slowRequests.delete(serial); updateConnectionHint();
  }
}
function post(path, values) {
  const peer=values.to || values.with || values.peer;
  if(Groups.isGroup(peer) && (path.startsWith('/api/messages/') || path==='/api/articles/send')){values={...values,id:peer.slice(6),topic:Groups.topicOf(peer)};if(path==='/api/articles/send')values.requestId=arguments[1].id;delete values.to;delete values.with;delete values.peer;path=path==='/api/messages/read'?'/api/groups/read':path.replace('/api/','/api/groups/');}
  if((path==='/api/attachments/create' || path==='/api/voice/create')&&Groups.of(values.peerId))values={...values,topic:Groups.topicOf('group:'+values.peerId)};
  return api(path, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(values)});
}
function errorText(error) {
  return ({
    group_not_member:'你已不在此群聊中。',group_not_found:'群聊已不存在。',group_changed:'群设置已更新，请重新载入后保存。',group_permission_denied:'你没有执行此操作的权限。',group_owner_required:'此操作仅限群主。',group_handle_taken:'此群用户名已被使用。',group_members_required:'请至少选择一位联系人。',group_contacts_only:'只能选择你的联系人。',group_contact_required:'请选择你的联系人，并确认未被拉黑。',group_invite_invalid:'邀请链接已失效。',group_invite_limit:'邀请链接数量或设置超出限制。',group_topic_not_found:'该话题不存在。',group_topic_closed:'该话题已关闭。',group_voice_no_recipients:'群内没有其他可接收一次性语音的成员。',invalid_group:'请检查群名称、简介及用户名格式。',invalid_group_topic:'话题名称不能为空，最多 80 字。',group_reaction_disabled:'群聊未开放此表情回应。',pins_limit:'每个聊天最多置顶 100 条消息。',
    rate_limited:'操作太频繁，请稍后再试。',
    user_not_found:'没有找到此用户，请检查用户名。',
    super_admin_required:'此操作需要超级管理员权限。',super_admin_protected:'群内角色操作不能移除超级管理员权限。',account_changed:'该账号已发生变化，请重新打开资料后确认。',
    invalid_user:'不能将自己添加为联系人或拉黑自己。',
    invalid_alias:'联系人备注最多 40 个字符，不能包含换行或控制字符。',
    invalid_message:'消息不能为空，最多 4000 字。',
    invalid_article:'文章不能为空，最多 100000 字、256 KB。',
    contact_not_found:'此用户已不在你的联系人中。',
    blocked_by_you:'你已拉黑此用户，请先解除拉黑。',
    message_unavailable:'暂时无法向此用户发送消息。',
    account_not_saved:'这个账号的登录已失效，请通过添加账号重新登录。',
    browser_account_limit:'同一浏览器最多同时登录 5 个账号，请先退出一个账号。',
    device_registration_limit:'此设备指纹已注册 5 个账号，无法继续注册。',
    invalid_nickname:'昵称最多 40 个字符，不能包含换行或控制字符。',
    invalid_birthday:'请填写有效的 YYYY-MM-DD 日期，出生年份不早于 1900，且需年满 18 周岁。',
    invalid_phone:'请输入有效电话：6–20 位数字，可使用开头的 +、空格、括号和横线。',
    invalid_email:'请输入有效邮箱地址，或留空。',
    invalid_privacy:'请选择联系方式的显示范围。',
    invalid_profile_exclusions:'例外名单中有无效用户，请重新选择。',
    profile_changed:'资料已在其他页面修改。请重新载入最新资料后再编辑。',
    invalid_avatar:'无法处理这张图片，请选择有效的 PNG、JPG 或 WebP 图片。',
    avatar_too_large:'头像图片过大，请选择较小的图片。',
    avatar_changed:'头像已在其他页面更新，请取消并重新打开操作。',
    invalid_username:'用户名须由 3–20 位字母、数字或下划线组成。',
    username_unchanged:'请输入与当前不同的用户名。',
    username_taken:'用户名已被使用，请换一个。',
    username_cooldown:'距离上次修改还不足 15 天，请稍后再试。',
    directory_changed:'账号信息已更新，正在重新加载…',
    account_update_pending:'账号更新尚未完成，请稍后重试。',
    client_update_required:'界面已更新，请刷新页面后重试。',
    connection_timeout:'连接超时，请稍后重试。',
    message_not_found:'这条消息已经不存在。',message_not_yours:'只能编辑或撤回自己的消息。',
    message_retracted:'这条消息已被撤回。',message_changed:'消息已在其他页面修改，请重新选择编辑。'
  })[error.message] || '连接暂时中断，请重试。';
}
function timeOf(ms) { return ms ? new Date(ms).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : ''; }
function dayOf(ms) { return new Date(ms).toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'}); }
function saved(peer) { return peer === me; }
function titleOf(peer) { if(peer?.startsWith('__deleted_'))return '已删除账户'; if(Groups.isGroup(peer))return Groups.of(peer)?.name || '群聊'; return saved(peer) ? '收藏夹' : contactDetails.get(peer)?.alias || userName(peer); }
function previewOf(chat) { return chat.lastText || (saved(chat.peer) ? '保存给自己的消息' : '@' + chat.peer); }
function paintAvatar(node,peer,personal = false,name = peer === me ? userName(me) : titleOf(peer)) {
  if(Groups.isGroup(peer)){node.dataset.avatarPeer=peer;Groups.paintAvatar(node,Groups.of(peer));return;}
  node.dataset.avatarPeer = peer; node.dataset.avatarPersonal = String(personal); node.dataset.avatarName = name;
  if (saved(peer) && !personal) {
    if (node.dataset.avatarImage !== 'bookmark') { node.innerHTML = icon('bookmark'); node.dataset.avatarImage = 'bookmark'; }
    return;
  }
  const meta = peerProfiles.get(peer), url = (peer === me ? ownProfile?.avatarUrl : meta?.avatarUrl) || '';
  const initial = (Array.from(name)[0] || '').toUpperCase();
  let fallback = node.querySelector('.avatar-initial');
  if (!fallback) { fallback = document.createElement('span'); fallback.className = 'avatar-initial'; }
  fallback.textContent = initial; node.title = name;
  const imageUrl = url.startsWith('/api/avatar?peer=') ? url + '&account=' + encodeURIComponent(me) : '';
  if (node.dataset.avatarImage === imageUrl && (imageUrl ? node.querySelector('img') : node.contains(fallback))) return;
  node.replaceChildren(fallback); node.dataset.avatarImage = imageUrl;
  if (imageUrl) {
    const image = document.createElement('img'); image.alt = ''; image.decoding = 'async'; image.loading = 'lazy';
    image.addEventListener('error',() => image.remove(),{once:true}); image.src = imageUrl; node.append(image);
  }
}
function avatar(peer, small = false, personal = false) {
  const node = document.createElement('span');
  node.className = 'avatar' + (small ? ' small' : '') + (saved(peer) && !personal ? ' saved' : ' user-avatar');
  paintAvatar(node,peer,personal);
  return node;
}
function showStatus(text) { $('draft-notice').textContent = text; }
function resetStatus() { showStatus('消息会保存在服务器。请勿发送密码或其他敏感信息。'); }
function accountError(text = '') {
  $('account-menu-error').textContent = text; $('account-menu-error').hidden = !text;
}
function renderAccounts() {
  const list = $('account-menu'), focused = document.activeElement?.dataset.account;
  list.replaceChildren();
  for (const account of savedAccounts.length ? savedAccounts : [{username:me}]) {
    if (!account.username) continue;
    const row = document.createElement('button'); row.type = 'button'; row.className = 'account-row';
    row.dataset.account = account.username; row.setAttribute('aria-current',String(account.username === me));
    const displayName = account.username === me ? ownProfile?.nickname || account.nickname || me : account.nickname || account.username;
    row.setAttribute('aria-label',(account.username === me ? '当前账号 ' : '切换到 ') + displayName + '，@' + account.username);
    const picture = document.createElement('span'); picture.className = 'avatar account-avatar'; picture.setAttribute('aria-hidden','true');
    paintAvatar(picture,account.username,true,displayName);
    picture.dataset.tone = String(Array.from(account.username).reduce((sum,char) => sum + char.codePointAt(0),0) % 4);
    const copy = document.createElement('span'); copy.className = 'account-copy';
    const name = document.createElement('span'); name.className = 'account-name'; name.textContent = displayName; copy.append(name);
    if (displayName !== account.username) { const username = document.createElement('small'); username.textContent = '@' + account.username; copy.append(username); }
    row.append(picture,copy);
    if (account.username === me) {
      const check = document.createElement('span'); check.className = 'account-check'; check.innerHTML = icon('check'); row.append(check);
    }
    row.disabled = switchingAccount || sending || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy());
    row.addEventListener('click',() => changeAccount(account.username)); list.append(row);
  }
  $('add-account').disabled = switchingAccount || sending || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || savedAccounts.length >= maxBrowserAccounts || Groups.isBusy();
  $('add-account-label').textContent = savedAccounts.length >= maxBrowserAccounts ? '已登录 5 个账号' : '添加账号';
  $('add-account').title = savedAccounts.length >= maxBrowserAccounts ? '请先退出一个账号，再添加账号' : '';
  $('logout-account').disabled = !me || switchingAccount || sending || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || Groups.isBusy();
  if (focused && isPopupOpen('more-menu')) Array.from(list.children).find(row => row.dataset.account === focused)?.focus();
}
async function loadAccounts() {
  if (!me || switchingAccount) return;
  try {
    const data = await api('/api/accounts'); savedAccounts = data.accounts;
    rememberPeople(data.accounts);
    maxBrowserAccounts = Number.isInteger(data.maxAccounts) && data.maxAccounts > 0 ? data.maxAccounts : 5;
    renderAccounts(); accountError();
  } catch (error) { accountError(errorText(error)); }
}
async function changeAccount(username) {
  if (Groups.isBusy() || sending || switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) return;
  cancelChatOpening();
  if (username === me) { setMoreMenu(false,true); return; }
  switchingAccount = true; accountError('正在切换账号…'); renderAccounts(); resizeInput();
  try {
    const data = await post('/api/accounts/switch',{username});
    location.assign('/app?account=' + encodeURIComponent(data.username));
  } catch (error) {
    switchingAccount = false; accountError(errorText(error)); renderAccounts(); resizeInput();
  }
}
function isPopupOpen(id) { return popupStates.get(id)?.open ?? !$(id).hidden; }
function modalButtons() {
  if (!activeModal) return [];
  return Array.from($(activeModal).querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]'))
    .filter(element => element.getClientRects().length && !element.closest('[hidden],[inert]'));
}
function modalBusy(id) { if(id==='group-confirm-dialog')return Groups.modalBusy();if(id==='pins-dialog')return false; if(id==='voice-once-dialog')return window.chaweVoice.modalBusy(); if (id === 'article-dialog' || id === 'attachment-dialog' || id === 'media-dialog') return false; return id === 'notification-dialog' ? window.chaweNotifications.isBusy() : id === 'avatar-dialog' ? avatarBusy : id === 'privacy-dialog' ? false : $(id === 'contact-dialog' ? 'contact-submit' : 'confirm-submit').disabled; }
function openModal(id) {
  window.chaweReactions.close();
  if (activeModal && activeModal !== id) closeModal(activeModal,false);
  modalReturnFocus = document.activeElement;
  cancelSendFlights(); closeMessageMenu(true); setEmojiMenu(false); setComposeMenu(false); setChatMoreMenu(false); setMoreMenu(false); setAttachmentMenu(false);
  activeModal = id; workspace.inert = true;
  setPopup(id,true,'none',220);
  (modalButtons()[0] || $(id).querySelector('[role="dialog"]')).focus({preventScroll:true});
}
function closeModal(id, returnFocus = true) {
  if (activeModal !== id) return;
  activeModal = null; workspace.inert = false; syncProfileAccess();
  if (id === 'privacy-dialog') { ++privacyPeopleRequest; window.chaweScrollbars?.refresh(); }
  if (id === 'avatar-dialog') clearPendingAvatar();
  if (id === 'attachment-dialog' || id === 'media-dialog') window.chaweAttachments.onClose(id);
  if(id==='voice-once-dialog')window.chaweVoice.onClose();
  if(id==='article-dialog')window.chaweArticles.onClose();
  if(id==='group-confirm-dialog')Groups.onClose();
  setPopup(id,false,'none',180);
  if (returnFocus) {
    const target = modalReturnFocus?.isConnected && !modalReturnFocus.disabled && modalReturnFocus.getClientRects().length && !modalReturnFocus.closest('[hidden],[inert]')
      ? modalReturnFocus : isPopupOpen('user-profile') ? $('close-profile') : panel === 'info' && !searchActive ? $('close-my-info') : $('more-button');
    target.focus({preventScroll:true});
  }
  modalReturnFocus = null;
}
function setPopup(id, open, collapsed, duration = UI_MOTION_DURATION, immediate = false) {
  const element = $(id), previous = popupStates.get(id);
  // Reused popup elements must not carry a previous interaction into a new opening.
  if (!open || previous?.open !== true || immediate) rippleEffects.clearWithin(element);
  if (previous?.open === open && !immediate) return;
  const current = element.hidden ? null : getComputedStyle(element);
  const start = current ? {opacity:current.opacity,transform:current.transform} : {opacity:0,transform:collapsed};
  previous?.animation?.cancel();
  const state = {open,animation:null}; popupStates.set(id,state);
  element.inert = !open;
  if (immediate || !motionEnabled() || (!open && element.hidden)) {
    element.hidden = !open; return;
  }
  element.hidden = false;
  const end = open ? {opacity:1,transform:'none'} : {opacity:0,transform:collapsed};
  state.animation = element.animate([start,end],{duration:motionDuration(duration),easing:UI_MOTION_EASING,fill:'both'});
  state.animation.onfinish = () => {
    if (popupStates.get(id) !== state) return;
    element.hidden = !open; state.animation.cancel(); state.animation = null;
  };
}
function setEmojiMenu(open, returnFocus = false) {
  if (open) { closeMessageMenu(); setMoreMenu(false); setComposeMenu(false); setChatMoreMenu(false); setAttachmentMenu(false); }
  setPopup('emoji-picker',open,'translateY(16px) scale(.88)');
  $('emoji-button').setAttribute('aria-expanded',String(open));
  if (returnFocus) $('emoji-button').focus();
}
function setComposeMenu(open, returnFocus = false) {
  if (panel !== 'chats' || searchActive) open = false;
  if (open) { closeMessageMenu(); setEmojiMenu(false); setMoreMenu(false); setChatMoreMenu(false); setAttachmentMenu(false); }
  setPopup('compose-menu',open,'translateY(12px) scale(.55)');
  $('new-message').classList.toggle('is-compose-open',open);
  $('new-message').setAttribute('aria-expanded',String(open));
  $('new-message').setAttribute('aria-label',open ? '关闭新建对话菜单' : '新建对话');
  if (open) $('new-private-chat').focus();
  else if (returnFocus) $('new-message').focus();
}
function setChatMoreMenu(open, returnFocus = false) {
  if (!active || isPopupOpen('user-profile')) open = false;
  if (open) { closeMessageMenu(); setEmojiMenu(false); setMoreMenu(false); setComposeMenu(false); setAttachmentMenu(false); }
  setPopup('chat-more-menu',open,'translateY(-8px) scale(.8)');
  $('chat-more-button').setAttribute('aria-expanded',String(open));
  if (open) $('open-profile').focus();
  else if (returnFocus) $('chat-more-button').focus();
}
function setAttachmentMenu(open, returnFocus = false) {
  if ($('attachment-button').disabled || !active || !messageReady) open = false;
  if (open) { closeMessageMenu(); setEmojiMenu(false); setMoreMenu(false); setComposeMenu(false); setChatMoreMenu(false); }
  setPopup('attachment-menu',open,'translateY(14px) scale(.9)',240);
  $('attachment-button').setAttribute('aria-expanded',String(open));
  if (open) $('attach-media').focus({preventScroll:true});
  else if (returnFocus && !$('attachment-button').disabled) $('attachment-button').focus({preventScroll:true});
}
function closeChatSearch(returnFocus = false, immediate = false) {
  ++chatSearch.epoch; clearTimeout(chatSearch.timer); chatSearch.controller?.abort();
  Object.assign(chatSearch,{peer:null,query:'',rows:[],more:false,busy:false,locating:false,controller:null});
  $('chat-search-input').value = '';
  $('chat-search-input').setAttribute('aria-expanded','false');
  $('conversation-header').classList.remove('is-chat-searching');
  setPopup('chat-search-header',false,'translateX(28px)',220,immediate);
  setPopup('chat-search-results',false,'translateY(-12px)',220,immediate);
  updateConnectionHint();
  $('group-header-search').hidden=!Groups.isGroup(active);
  if (returnFocus) $('chat-more-button').focus({preventScroll:true});
}
function openChatSearch() {
  if (!active || !messageReady) return;
  closeChatSearch(false,true);
  setChatMoreMenu(false); setEmojiMenu(false); setAttachmentMenu(false); closeMessageMenu(); closeProfile(true,false);
  chatSearch.peer = active;
  $('group-header-search').hidden=true;
  $('chat-search-input').setAttribute('aria-expanded','true');
  $('conversation-header').classList.add('is-chat-searching');
  setPopup('chat-search-header',true,'translateX(28px)',220);
  setPopup('chat-search-results',true,'translateY(-12px)',220);
  renderChatSearch(); updateConnectionHint();
  $('chat-search-input').focus({preventScroll:true});
}
function chatSearchPreview(message) {
  return [message.attachment ? (message.attachment.kind === 'image' ? '图片' : message.attachment.kind === 'video' ? '视频' : message.attachment.kind.startsWith('voice') ? '语音' : message.attachment.kind === 'article' ? '文章' : '文件') + ' · ' + message.attachment.name : '',message.text].filter(Boolean).join(' · ');
}
function renderChatSearch() {
  const list = $('chat-search-list'), status = $('chat-search-status'); list.replaceChildren();
  $('chat-search-clear').hidden = !$('chat-search-input').value;
  list.setAttribute('aria-busy',String(chatSearch.busy));
  status.textContent = chatSearch.query ? (chatSearch.rows.length ? '找到 ' + chatSearch.rows.length + (chatSearch.more ? '+' : '') + ' 条消息' : chatSearch.busy ? '' : '没有找到相关消息') : '搜索此聊天的消息或附件文件名';
  for (const message of chatSearch.rows) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'chat-search-result';
    row.disabled = chatSearch.locating;
    const copy = document.createElement('span'); copy.className = 'row-copy';
    const top = document.createElement('span'); top.className = 'row-top';
    const title = document.createElement('span'); title.className = 'row-title'; title.textContent = message.sender === me ? userName(me) : titleOf(message.sender);
    const date = document.createElement('time'); date.className = 'row-time'; date.dateTime = new Date(message.time).toISOString(); date.textContent = dayOf(message.time) + ' ' + timeOf(message.time);
    const preview = document.createElement('span'); preview.className = 'row-preview'; preview.textContent = chatSearchPreview(message);
    top.append(title,date); copy.append(top,preview); row.append(avatar(message.sender,true,true),copy);
    row.addEventListener('click',() => locateChatSearchMessage(message)); list.append(row);
  }
  $('chat-search-more').hidden = !chatSearch.more;
  $('chat-search-more').disabled = chatSearch.busy || chatSearch.locating;
  $('chat-search-retry').hidden = true;
}
function changeChatSearch() {
  ++chatSearch.epoch; clearTimeout(chatSearch.timer); chatSearch.controller?.abort();
  chatSearch.controller = null; chatSearch.query = $('chat-search-input').value.trim();
  chatSearch.rows = []; chatSearch.more = false; chatSearch.locating = false;
  chatSearch.busy = !!chatSearch.query;
  renderChatSearch(); updateConnectionHint();
  if (chatSearch.query) chatSearch.timer = setTimeout(() => loadChatSearch(false),250);
}
async function loadChatSearch(older = false) {
  if (!chatSearch.peer || chatSearch.peer !== active || !chatSearch.query || chatSearch.locating) return;
  const peer = chatSearch.peer, query = chatSearch.query, epoch = ++chatSearch.epoch;
  chatSearch.controller?.abort(); const controller = new AbortController(); chatSearch.controller = controller;
  chatSearch.busy = true; updateConnectionHint(); renderChatSearch();
  try {
    const params = new URLSearchParams({with:peer,q:query,limit:'50'});
    if (older && chatSearch.rows.length) params.set('before',String(Math.min(...chatSearch.rows.map(row => row.seq))));
    const data = await api('/api/messages?' + params,{signal:controller.signal});
    if (epoch !== chatSearch.epoch || peer !== active) return;
    const rows = new Map((older ? chatSearch.rows : []).map(row => [row.seq,row]));
    for (const message of data.messages) if (!message.deleted) rows.set(message.seq,message);
    chatSearch.rows = [...rows.values()].sort((a,b) => b.seq - a.seq); chatSearch.more = data.more;
    chatSearch.busy = false; renderChatSearch();
  } catch (error) {
    if (epoch !== chatSearch.epoch || error.name === 'AbortError') return;
    chatSearch.busy = false; renderChatSearch(); $('chat-search-status').textContent = errorText(error);
    $('chat-search-retry').hidden = false;
  } finally {
    if (epoch === chatSearch.epoch) { chatSearch.busy = false; chatSearch.controller = null; updateConnectionHint(); }
  }
}
async function locateChatSearchMessage(message) {
  if (!chatSearch.peer || chatSearch.locating || sending || sendFlights.size) return;
  const peer = chatSearch.peer, request = messageRequest, epoch = ++chatSearch.epoch;
  clearTimeout(chatSearch.timer); chatSearch.controller?.abort();
  const controller = new AbortController(); chatSearch.controller = controller;
  chatSearch.locating = true; chatSearch.busy = true; updateConnectionHint(); renderChatSearch();
  try {
    if (!messageNodes.has(message.seq)) {
      const [before,after] = await Promise.all([
        api('/api/messages?' + new URLSearchParams({with:peer,before:String(message.seq + 1),limit:'50'}),{signal:controller.signal}),
        api('/api/messages?' + new URLSearchParams({with:peer,after:String(message.seq),limit:'50'}),{signal:controller.signal})
      ]);
      await waitForSendMotion();
      if (epoch !== chatSearch.epoch || active !== peer || request !== messageRequest || sending) return;
      cancelSendFlights(); ++messageRequest;
      entries = []; mergeMessages([...before.messages,...after.messages]); hasOlder = before.more;
      loadingOlder = false; olderError = false; catchupAfter = after.more ? after.messages.at(-1)?.seq ?? message.seq : null;
      renderMessages(); cacheCurrentMessages();
    }
    if (epoch !== chatSearch.epoch || active !== peer) return;
    const node = messageNodes.get(message.seq);
    if (!node || !node.isConnected) throw Error('message_retracted');
    closeChatSearch();
    const log = $('messages');
    const top = log.scrollTop + node.getBoundingClientRect().top - log.getBoundingClientRect().top - (log.clientHeight - node.offsetHeight) / 2;
    log.scrollTo({top:Math.max(0,top),behavior:motionEnabled() ? 'smooth' : 'instant'});
    if (motionEnabled()) node.animate([{boxShadow:'0 0 0 4px #3390ec66'},{boxShadow:'0 0 0 4px #3390ec66',offset:.65},{boxShadow:'0 0 0 0 #3390ec00'}],{duration:motionDuration(1400)});
  } catch (error) {
    if (epoch !== chatSearch.epoch || error.name === 'AbortError') return;
    chatSearch.busy = false; chatSearch.locating = false; renderChatSearch(); $('chat-search-status').textContent = errorText(error);
  } finally {
    if (epoch === chatSearch.epoch) {
      chatSearch.busy = false; chatSearch.locating = false; chatSearch.controller = null;
      $('chat-search-list').querySelectorAll('button').forEach(button => { button.disabled = false; });
      $('chat-search-more').disabled = false; updateConnectionHint();
    }
  }
}
function setMoreMenu(open, returnFocus = false) {
  if (searchActive) open = false;
  if (open) { closeMessageMenu(); setEmojiMenu(false); setComposeMenu(false); setChatMoreMenu(false); setAttachmentMenu(false); }
  setPopup('more-menu',open,'translateY(-10px) scale(.85)');
  if (searchActive) $('more-button').removeAttribute('aria-expanded');
  else $('more-button').setAttribute('aria-expanded',String(open));
  if (open) { $('more-menu').querySelector('button:not(:disabled)')?.focus(); loadAccounts(); }
  else if (returnFocus) $('more-button').focus();
}
function setSearchMode(enabled) {
  searchActive = enabled;
  document.querySelector('.sidebar').classList.toggle('search-active',enabled);
  $('more-button').classList.toggle('is-back',enabled);
  $('more-button').setAttribute('aria-label',enabled ? '退出搜索' : '更多');
  $('more-button').setAttribute('aria-controls',enabled ? 'search-panel' : 'more-menu');
  if (enabled) $('more-button').removeAttribute('aria-expanded');
  else $('more-button').setAttribute('aria-expanded','false');
}
function enterSearch() {
  if(Groups.searchFocus())return;
  if (openingPeer || failedOpenPeer) cancelChatOpening();
  if (searchActive) return;
  setEmojiMenu(false); setComposeMenu(false); setChatMoreMenu(false);
  searchOriginPanel = panel; searchOriginChats = chats.slice();
  setMoreMenu(false); setSearchMode(true); setPanel('chats');
}
function resetSearch() {
  clearTimeout(listTimer); ++listRequest;
  listQuery = ''; $('search').value = ''; $('search').blur();
  setSearchBusy(false);
  chats = searchOriginChats.slice(); searchPeople = []; listError = ''; peopleError = '';
  setSearchMode(false);
}
function leaveSearch() {
  if (!searchActive) return;
  const destination = searchOriginPanel;
  resetSearch(); setPanel(destination); $('more-button').focus();
  if (destination === 'chats') loadChats();
  else if (destination === 'blocks') loadBlocks();
  else if (destination === 'settings') renderUiSettings();
  else if (destination === 'notifications') window.chaweNotifications.render();
  else if (destination === 'info') renderMyIdentity();
  else loadContacts();
}
function showSidePage(id) {
  if (id === sidePage) return;
  const outgoing = $(sidePage), incoming = $(id);
  const returning = id === 'chats-panel' || sidePage === 'search-panel';
  const outgoingStyle = getComputedStyle(outgoing);
  const start = {opacity:outgoingStyle.opacity,transform:outgoingStyle.transform};
  const incomingStyle = incoming.hidden ? null : getComputedStyle(incoming);
  const arriving = incomingStyle ? {opacity:incomingStyle.opacity,transform:incomingStyle.transform}
    : {opacity:0,transform:returning ? 'translateX(-24px)' : 'translateX(32px)'};
  for (const animation of sideAnimations) animation.cancel(); sideAnimations.clear();
  sidePage = id;
  for (const page of $('sidebar-pages').children) {
    page.inert = page !== incoming;
    page.hidden = page !== incoming && page !== outgoing;
    page.style.zIndex = page === incoming ? '2' : '1';
  }
  incoming.hidden = false;
  if (!motionEnabled()) { outgoing.hidden = true; return; }
  const animate = (page,frames,departing) => {
    const animation = page.animate(frames,{duration:motionDuration(UI_MOTION_DURATION),easing:UI_MOTION_EASING,fill:'both'});
    sideAnimations.add(animation);
    animation.onfinish = () => {
      if (departing && sidePage !== page.id) page.hidden = true;
      animation.cancel(); sideAnimations.delete(animation);
    };
  };
  animate(outgoing,[start,{opacity:0,transform:returning ? 'translateX(32px)' : 'translateX(-24px)'}],true);
  animate(incoming,[arriving,{opacity:1,transform:'none'}],false);
}
function setPanel(name) {
  if (name !== 'chats' && (openingPeer || failedOpenPeer)) cancelChatOpening();
  setMoreMenu(false); setComposeMenu(false);
  if (name !== 'chats' && searchActive) resetSearch();
  panel = name;Groups.panelChanged(name);
  $('new-message').hidden = name !== 'chats' || searchActive;
  if (name !== 'chats') {
    clearTimeout(listTimer); listQuery = ''; $('search').value = ''; loadChats();
  }
  $('no-results').hidden = true;
  if (name === 'new' || name === 'contacts') {
    $('contacts-heading').textContent = name === 'new' ? '新建私聊' : '联系人';
    renderContacts();
  }
  if (name === 'chats') renderList();
  if (name === 'settings') renderUiSettings();
  if (name === 'notifications') window.chaweNotifications.render();
  if (name === 'info') renderMyIdentity();
  showSidePage(Groups.panelId(name) || (searchActive ? 'search-panel' : name === 'chats' ? 'chats-panel' : name === 'blocks' ? 'blocks-panel' : name === 'settings' ? 'settings-panel' : name === 'notifications' ? 'notifications-panel' : name === 'info' ? 'my-info-panel' : 'contacts-panel'));
}
function searchHeading(parent, text) {
  const label = document.createElement('h3'); label.className = 'search-heading'; label.textContent = text; parent.append(label);
}
function searchProblem(parent, text) {
  const copy = document.createElement('p'); copy.className = 'search-error'; copy.textContent = text; parent.append(copy);
}
function renderSearchHome() {
  const home = $('search-home'); home.replaceChildren();
  const peers = [...new Set([...searchOriginChats.map(chat => chat.peer),...contacts])].filter(peer => peer !== me).slice(0,8);
  if (!peers.length) {
    const hint = document.createElement('p'); hint.className = 'search-hint';
    hint.textContent = '搜索聊天、联系人、消息或 @用户名'; home.append(hint); return;
  }
  const strip = document.createElement('div'); strip.className = 'search-people'; strip.setAttribute('aria-label','最近聊天与联系人');
  for (const peer of peers) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'search-person';
    button.dataset.peer = peer; button.append(avatar(peer));
    const name = document.createElement('span'); name.textContent = titleOf(peer); button.append(name);
    button.addEventListener('click',() => openChat(peer)); strip.append(button);
  }
  home.append(strip);
  updateOpeningRows();
}
function renderList() {
  renderRecommendationSetting();
  const list = $(searchActive ? 'search-results' : 'chat-list'), empty = $(searchActive ? 'search-no-results' : 'no-results');
  list.replaceChildren();
  $('search-home').hidden = !!listQuery;
  $('search-results').hidden = !listQuery;
  if (searchActive && !listQuery) { empty.hidden = true; renderSearchHome(); return; }
  const rows = chats.slice();
  if (active && !rows.some(chat => chat.peer === active) && !listQuery)
    rows.unshift({peer:active,lastText:'',lastAt:0});
  const people = listQuery ? searchPeople.filter(person => !rows.some(chat => chat.peer === person.username)) : [];
  const recommendations = !searchActive && !listQuery ? visibleGroupRecommendations() : [];
  empty.hidden = panel !== 'chats' || rows.length !== 0 || people.length !== 0 || !!listError || !!peopleError || recommendations.length > 0;
  empty.textContent = !searchActive && !listQuery ? '还没有会话，可通过新建开始聊天' : '没有找到相关聊天、联系人或用户';
  if (listQuery && (rows.length || listError)) searchHeading(list,'聊天与联系人');
  if (listError) searchProblem(list,listError);
  for (const chat of rows) {
    const row = document.createElement('button'); row.type = 'button';
    row.className = 'chat-row' + (active === chat.peer ? ' selected' : '');
    row.dataset.peer = chat.peer;
    row.setAttribute('aria-pressed',String(active === chat.peer)); row.append(avatar(chat.peer));
    const copy = document.createElement('span'); copy.className = 'row-copy';
    const top = document.createElement('span'); top.className = 'row-top';
    const title = document.createElement('span'); title.className = 'row-title'; title.textContent = titleOf(chat.peer);
    const time = document.createElement('span'); time.className = 'row-time'; time.textContent = timeOf(chat.lastAt);
    const preview = document.createElement('span'); preview.className = 'row-preview'; preview.textContent = previewOf(chat);
    top.append(title,time); copy.append(top,preview); row.append(copy);
    row.addEventListener('click',() => openChat(chat.peer)); list.append(row);
  }
  if (people.length || peopleError) searchHeading(list,'全局搜索');
  if (peopleError) searchProblem(list,peopleError);
  for (const person of people) list.append(personNode(person));
  if (!searchActive && !listQuery) renderGroupRecommendations(list,rows.length === 0 && !listError,recommendations);
  updateOpeningRows();
}
function recommendationsHidden() {
  if (!meIdentity) return false;
  if (!recommendationVisibility.has(meIdentity)) {
    let hidden = false;
    try { hidden = localStorage.getItem(RECOMMENDATIONS_HIDDEN_PREFIX + meIdentity) === '1'; } catch {}
    recommendationVisibility.set(meIdentity,hidden);
  }
  return recommendationVisibility.get(meIdentity);
}
function visibleGroupRecommendations() {
  return recommendationsHidden() ? [] : recommendedGroups.filter(group => !group.joined);
}
function renderRecommendationSetting() {
  const toggle = $('setting-group-recommendations'), status = $('group-recommendations-save-status');
  if (toggle) { toggle.checked = !recommendationsHidden(); toggle.disabled = !meIdentity; }
  if (status) status.hidden = !recommendationSaveFailed;
}
function setRecommendationsHidden(hidden) {
  if (!meIdentity) return;
  recommendationVisibility.set(meIdentity,hidden); recommendationSaveFailed = false;
  try { localStorage.setItem(RECOMMENDATIONS_HIDDEN_PREFIX + meIdentity,hidden ? '1' : '0'); }
  catch { recommendationSaveFailed = true; }
  renderList();
}
function renderGroupRecommendations(list,emptyChats,recommendations) {
  if (!recommendations.length) return;
  if (emptyChats) {
    const hint = document.createElement('p'); hint.className = 'group-recommendation-empty';
    hint.textContent = '还没有会话，加入群聊开始聊天吧'; list.append(hint);
  }
  const section = document.createElement('section'); section.className = 'group-recommendations'; section.setAttribute('aria-label','群聊推荐');
  const header = document.createElement('div'); header.className = 'group-recommendations-heading';
  const heading = document.createElement('h3'); heading.textContent = '群聊推荐';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'group-recommendations-close'; close.setAttribute('aria-label','关闭群聊推荐'); close.title = '关闭群聊推荐'; close.innerHTML = icon('close'); close.disabled = recommendationJoin.busy;
  close.addEventListener('click',() => setRecommendationsHidden(true)); header.append(heading,close); section.append(header);
  for (const group of recommendations) {
    const row = document.createElement('div'); row.className = 'group-recommendation-row';
    const picture = document.createElement('span'); picture.className = 'avatar'; picture.setAttribute('aria-hidden','true'); Groups.paintAvatar(picture,group);
    const copy = document.createElement('span'); copy.className = 'group-recommendation-copy';
    const title = document.createElement('strong'); title.textContent = group.name;
    const detail = document.createElement('small'); detail.textContent = '公开群 · ' + group.memberCount + ' 位成员'; copy.append(title,detail);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'group-recommendation-join';
    const pending = recommendationJoin.busy && recommendationJoin.id === group.id;
    button.disabled = recommendationJoin.busy || switchingAccount; button.setAttribute('aria-busy',String(pending));
    button.setAttribute('aria-label','加入' + group.name);
    if (pending) { const spinner = document.createElement('span'); spinner.className = 'group-recommendation-spinner'; spinner.setAttribute('aria-hidden','true'); button.append(spinner); }
    button.append(document.createTextNode(pending ? '加入中…' : '加入'));
    button.addEventListener('click',() => joinRecommendedGroup(group)); row.append(picture,copy,button); section.append(row);
  }
  if (recommendationJoin.error) { const error = document.createElement('p'); error.className = 'group-recommendation-error'; error.setAttribute('role','alert'); error.textContent = recommendationJoin.error; section.append(error); }
  list.append(section);
}
async function joinRecommendedGroup(group) {
  if (!me || switchingAccount || recommendationJoin.busy) return;
  if (group.joined) { await openChat('group:'+group.id); return; }
  if (Groups.isBusy() || window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) { showStatus('请先完成当前操作，再加入群聊。'); return; }
  const accountId = meIdentity, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),12000);
  recommendationJoin.id = group.id; recommendationJoin.busy = true; recommendationJoin.error = ''; renderList();
  try {
    const joined = await api('/api/groups/join',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:group.id}),signal:controller.signal});
    clearTimeout(timer);
    if (accountId !== meIdentity || switchingAccount) return;
    // A list fetched before this join must not bring the recommendation back.
    ++listRequest;
    rememberPeople([joined]);
    recommendedGroups = recommendedGroups.map(item => item.id === group.id ? {...item,joined:true,memberCount:joined.memberCount} : item);
    recommendationJoin.busy = false; renderList();
    loadChats(); await openChat('group:'+joined.id);
  } catch (error) {
    if (accountId === meIdentity && !switchingAccount) {
      recommendationJoin.error = error.name === 'AbortError' ? '加入请求超时。可以重试，已加入时不会重复添加。' : errorText(error);
    }
  } finally {
    clearTimeout(timer); recommendationJoin.busy = false;
    if (accountId === meIdentity && !switchingAccount) renderList();
  }
}
function setSearchBusy(enabled) {
  enabled = !!enabled && searchActive && !!listQuery;
  if (enabled === searchBusy) return;
  searchBusy = enabled;
  $('search-results').setAttribute('aria-busy',String(enabled));
  updateConnectionHint();
}
async function loadChats() {
  const request = ++listRequest, query = listQuery, usernameQuery = query.replace(/^@/,'');
  setSearchBusy(!!query);
  try {
    const [chatResult, peopleResult, groupResult] = await Promise.allSettled([
      api('/api/chats?query=' + encodeURIComponent(query)),
      usernameQuery && Array.from(usernameQuery).length <= 40 ? api('/api/people?query=' + encodeURIComponent(usernameQuery)) : Promise.resolve({people:[]}),
      usernameQuery ? api('/api/groups/list?global=true&query='+encodeURIComponent(usernameQuery)) : Promise.resolve({groups:[]})
    ]);
    if (request !== listRequest || query !== listQuery) return;
    if (!query && chatResult.status === 'fulfilled') {
      const recommendations = chatResult.value.recommendedGroups;
      recommendedGroups = Array.isArray(recommendations) ? recommendations.filter(group => /^[a-f0-9]{32}$/.test(group?.id) && typeof group.name === 'string' && Number.isSafeInteger(group.memberCount)) : [];
    }
    chats = chatResult.status === 'fulfilled' ? chatResult.value.chats : query
      ? searchOriginChats.filter(chat => titleOf(chat.peer).toLowerCase().includes(query.toLowerCase())
        || chat.peer.toLowerCase().includes(usernameQuery.toLowerCase()) || (chat.lastText || '').toLowerCase().includes(query.toLowerCase()))
      : chats;
    searchPeople = peopleResult.status === 'fulfilled' ? peopleResult.value.people : [];
    if(groupResult.status==='fulfilled')searchPeople.push(...groupResult.value.groups.filter(g=>!chats.some(c=>c.peer===g.username)));
    rememberPeople([...chats.map(chat => chat.profile).filter(Boolean),...searchPeople]);
    listError = chatResult.status === 'rejected' ? errorText(chatResult.reason) : '';
    peopleError = peopleResult.status === 'rejected' ? errorText(peopleResult.reason) : '';
    if (query) {
      const needle = query.toLowerCase(), usernameNeedle = usernameQuery.toLowerCase();
      for (const peer of contacts) {
        if ((titleOf(peer).toLowerCase().includes(needle) || peer.toLowerCase().includes(usernameNeedle))
            && !chats.some(chat => chat.peer === peer)) chats.push({peer,lastText:'',lastAt:0});
      }
    }
    renderList();
  } finally {
    // A stale response must not stop the spinner for a newer search.
    if (request === listRequest && query === listQuery) setSearchBusy(false);
  }
}
async function loadContacts(throwOnError = false) {
  const request = ++contactRequest;
  try {
    const data = await api('/api/contacts');
    if (!Array.isArray(data.details)) throw Error('client_update_required');
    if (request !== contactRequest) return data.details;
    contacts = data.contacts.filter(peer => peer !== me);
    contactDetails = new Map(data.details.map(person => [person.username,person]));
    rememberPeople(data.details);
    if (panel === 'new' || panel === 'contacts') renderContacts();
    if (activeProfile && !Groups.isGroup(active)) {
      const detail = contactDetails.get(active);
      activeProfile = {...activeProfile,contact:!!detail,alias:detail?.alias || '',displayName:titleOf(active)};
      updateComposer(); renderProfile();
    }
    if (panel === 'chats') renderList();
    return data.details;
  } catch (error) {
    if (request === contactRequest && (panel === 'new' || panel === 'contacts')) $('user-results').textContent = errorText(error);
    if (throwOnError) throw error;
  }
}
function personNode(person) {
  const row = document.createElement('button'); row.type = 'button'; row.className = 'person-row';
  row.dataset.peer = person.username;
  row.append(avatar(person.username));
  const copy = document.createElement('span'); copy.className = 'person-copy';
  const name = document.createElement('strong'); name.textContent = titleOf(person.username);
  const status = document.createElement('small'); status.textContent = person.kind==='group' ? person.memberCount+' 位成员'+(person.handle?' · @'+person.handle:'') : '@' + person.username + (person.blockedByMe ? ' · 已拉黑' : '');
  copy.append(name,status); row.append(copy); row.addEventListener('click',() => openChat(person.username)); return row;
}
function renderContacts() {
  const target = $('user-results'); target.replaceChildren();
  if (!contacts.length) {
    const empty = document.createElement('div'); empty.className = 'contacts-empty'; empty.innerHTML = icon('users');
    const title = document.createElement('strong'); title.textContent = '还没有联系人';
    const text = document.createElement('p'); text.textContent = '点击右上角的 + 添加联系人，或使用顶部搜索框查找用户并开始聊天。';
    empty.append(title,text); target.append(empty); return;
  }
  for (const peer of contacts) target.append(personNode(contactDetails.get(peer)));
  updateOpeningRows();
}
async function openContacts(name = 'contacts') {
  setPanel(name); $('close-contacts').focus(); await loadContacts();
}
async function loadBlocks() {
  const request = ++blockRequest;
  try {
    const data = await api('/api/blocks');
    if (request !== blockRequest) return;
    blockedPeople = data.people; rememberPeople(data.people); renderBlocks();
  } catch (error) { if (request === blockRequest && panel === 'blocks') $('block-results').textContent = errorText(error); }
}
function renderBlocks() {
  const target = $('block-results'); target.replaceChildren();
  if (!blockedPeople.length) {
    const empty = document.createElement('p'); empty.className = 'panel-empty'; empty.textContent = '没有已拉黑的用户'; target.append(empty); return;
  }
  for (const person of blockedPeople) {
    const row = document.createElement('div'); row.className = 'blocked-row'; row.append(personNode(person));
    const unblock = document.createElement('button'); unblock.type = 'button'; unblock.className = 'small-action'; unblock.textContent = '解除拉黑';
    unblock.addEventListener('click',() => openConfirm('unblock',person.username)); row.append(unblock); target.append(row);
  }
  updateOpeningRows();
}
async function refreshSocial() {
  await Promise.all([loadContacts(),loadBlocks()]);
  await Promise.all([loadChats(),active ? loadActiveProfile() : Promise.resolve()]);
}
function openContactDialog(peer = null) {
  ++contactDialogRequest;
  $('contact-dialog-title').textContent = peer && contactDetails.has(peer) ? '编辑联系人' : '添加联系人';
  $('contact-username').value = peer || ''; $('contact-username').readOnly = !!peer;
  $('contact-alias').value = peer ? contactDetails.get(peer)?.alias || '' : '';
  $('contact-error').hidden = true; $('contact-submit').disabled = false;
  $('contact-cancel').disabled = false;
  openModal('contact-dialog'); (peer ? $('contact-alias') : $('contact-username')).focus({preventScroll:true});
}
function openConfirm(action, peer) {
  ++confirmDialogRequest;
  const name = titleOf(peer);
  const actions = {
    deleteAccount:{title:'永久删除账号 @'+peer+'？',copy:'将删除该账号、私聊和收藏夹、登录状态及上传的文件，用户名立即释放。群内文字消息保留并标记为已删除账户；该账号拥有的群聊会交给剩余成员，无成员时解散。此操作无法撤销。',label:'永久删除账号',path:'/api/admin/accounts/delete'},
    remove:{title:'删除联系人',copy:'将 ' + name + ' 从你的联系人中删除？仅影响你的列表，已有消息会保留，仍可继续聊天。',label:'删除',path:'/api/contacts/remove'},
    block:{title:'拉黑用户',copy:'拉黑 ' + name + ' 后，双方将无法发送新消息。已有聊天记录和联系人设置会保留。',label:'拉黑',path:'/api/blocks/add'},
    unblock:{title:'解除拉黑',copy:'解除对 ' + name + ' 的拉黑？解除后可重新发送消息，被拒绝的消息不会补发。',label:'解除拉黑',path:'/api/blocks/remove'},
    logout:{title:'确认退出账号？',copy:'退出当前账号 ' + me + ' 的登录。账号和服务器中的聊天记录会保留，其他已登录账号仍可使用。',label:'退出账号',path:'/api/logout'},
    reloadInfo:{title:'重新载入资料？',copy:'将丢弃此页面中尚未保存的资料修改，并重新载入服务器上的最新资料。',label:'重新载入',path:'reload-my-info'},
    avatarReset:{title:'恢复默认头像？',copy:'将移除当前上传的头像，恢复为昵称或用户名首字的默认头像。',label:'确认恢复',path:'/api/me/avatar/reset'},
    rename:{title:'确认修改用户名？',copy:'将 @' + me + ' 修改为 @' + $('my-info-username').value.trim()
      + '。旧用户名立即释放，每 15 天只能修改一次。确认后该账号在所有设备和浏览器退出登录。聊天、联系人和资料会保留。'
      + (ownInfoDirty ? ' 此页尚未保存的其他资料修改会丢弃。' : ''),label:'确认修改并退出',path:'/api/me/username'}
  };
  confirmation = {...actions[action],peer,accountId:activeProfile?.username===peer?activeProfile.id:null,avatarVersion:ownProfile?.avatarVersion || 0,newUsername:$('my-info-username').value.trim()};
  $('confirm-title').textContent = confirmation.title; $('confirm-copy').textContent = confirmation.copy;
  $('confirm-submit').textContent = confirmation.label; $('confirm-submit').disabled = false; $('confirm-cancel').disabled = false; $('confirm-error').hidden = true;
  openModal('confirm-dialog'); $('confirm-cancel').focus({preventScroll:true});
}
function syncProfileAccess() {
  const modal = (isPopupOpen('user-profile') || isPopupOpen('group-settings')) && matchMedia('(max-width:640px)').matches;
  $('conversation').inert = modal; document.querySelector('.sidebar').inert = modal;
  if (modal && !isPopupOpen('group-settings') && !$('user-profile').contains(document.activeElement)) $('close-profile').focus({preventScroll:true});
}
function closeProfile(immediate = false, returnFocus = true) {
  const wasOpen = isPopupOpen('user-profile');
  if (wasOpen) cancelSendFlights();
  setPopup('user-profile',false,'translateX(calc(100% + 16px))',360,immediate);
  syncProfileAccess();
  if (wasOpen && returnFocus) $('chat-more-button').focus({preventScroll:true});
}
async function openProfile() {
  if(Groups.isGroup(active)){Groups.openSettings(active);return;}
  if (!active) return;
  if (chatSearch.peer) closeChatSearch(false,true);
  setEmojiMenu(false); setMoreMenu(false); setComposeMenu(false); setChatMoreMenu(false); setAttachmentMenu(false);
  cancelSendFlights();
  // Slide a separate layer over the chat: resizing its viewport rewraps long
  // messages on every frame and changes the reader's scroll position.
  renderProfile();
  setPopup('user-profile',true,'translateX(calc(100% + 16px))',360);
  syncProfileAccess(); $('close-profile').focus({preventScroll:true}); await loadActiveProfile();
}
function renderProfile() {
  if(Groups.isGroup(active))return;
  if (!active) return;
  const info = activeProfile, self = saved(active);
  $('profile-avatar').className = 'avatar profile-avatar' + (self ? ' saved' : '');
  paintAvatar($('profile-avatar'),active);
  $('profile-name').textContent = titleOf(active);
  $('profile-username').textContent = '@' + active;
  $('profile-status').textContent = info ? self ? '只有你能看到' : info.blockedByMe ? '已拉黑' : info.contact ? '联系人' : '用户' : profileError || '正在加载…';
  $('profile-alias-wrap').hidden = !info?.alias; $('profile-alias').textContent = info?.alias || '';
  $('profile-nickname-wrap').hidden = !info?.nickname; $('profile-nickname').textContent = info?.nickname || '';
  for (const field of ['phone','email']) {
    const value = info?.contactsVisible === true ? info[field] || '' : '';
    $('profile-' + field + '-wrap').hidden = !value; $('profile-' + field).textContent = value;
  }
  $('profile-contact').hidden = self; $('profile-contact').disabled = !info;
  $('profile-contact-label').textContent = info?.contact ? '编辑联系人' : '添加到联系人';
  $('profile-contact').querySelector('use').setAttribute('href',info?.contact ? '#i-settings' : '#i-plus');
  $('profile-remove').hidden = self || !info?.contact;
  $('profile-block').hidden = self; $('profile-block').disabled = !info;
  $('profile-block-label').textContent = info?.blockedByMe ? '解除拉黑' : '拉黑用户';
  $('profile-delete-account').hidden = !info?.canDeleteAccount;
  $('profile-delete-account').disabled = !info?.id;
}
async function loadActiveProfile() {
  if (!active) return;
  const peer = active, request = ++profileRequest;
  try {
    const data = await api('/api/profile?peer=' + encodeURIComponent(peer));
    if (peer !== active || request !== profileRequest) return;
    applyActiveProfile(data);
  } catch (error) {
    if (peer === active && request === profileRequest) { if(Groups.isGroup(peer)&&['group_not_member','group_not_found'].includes(error.message)){activeProfile={...activeProfile,joined:false,canMessage:false};Groups.remember([activeProfile]);updateComposer();}
      profileError = errorText(error); showStatus(profileError); renderProfile(); }
  }
}
function applyActiveProfile(data) {
  const oldGroup=activeProfile?.kind==='group'?activeProfile:null,changedTopics=oldGroup && data.kind==='group' && oldGroup.topicsEnabled!==data.topicsEnabled;
  activeProfile = data; profileError = '';
  rememberPeople([data]);
  if (data.contact) contactDetails.set(active,{username:data.username,nickname:data.nickname,alias:data.alias,contact:data.contact,blockedByMe:data.blockedByMe,canMessage:data.canMessage});
  else contactDetails.delete(active);
  updateComposer(); renderProfile();if(changedTopics&&!sending&&!window.chaweVoice.isBusy()&&!window.chaweArticles.isBusy()&&!window.chaweAttachments.isBusy()){messageReady=false;renderedPeer=null;queueMicrotask(()=>openChat(data.username));}
}
function updateComposer() {
  if (!active) return;
  const group=Groups.isGroup(active),g=Groups.of(active);
  $('open-profile').hidden=group;$('open-chat-search').hidden=group;$('edit-group').hidden=!group;$('leave-group').hidden=!group;$('group-header-search').hidden=!group || !!chatSearch.peer;
  if(group && g)activeProfile=g;Groups.header(active);
  const info = activeProfile, self = saved(active), allowed = info?.canMessage === true;
  if(Groups.isGroup(active) && info && !allowed && entries.length){entries=[];messageNodes.clear();renderedPeer=null;messageReady=false;$('messages').replaceChildren();Pins.activate(null);}
  if (info && !allowed && editingMessage) cancelMessageEdit(true);
  if (info && !allowed && !window.chaweArticles.isBusy()) window.chaweArticles.close(true);
  $('chat-title').textContent = titleOf(active);
  $('chat-subtitle').textContent = !info ? '正在加载…' : group ? (info.memberCount+' 位成员') : self ? '只有你能看到' : info.blockedByMe ? '已拉黑' : info.contact ? '联系人' : '@' + active;
  window.chaweTyping.sync($('chat-subtitle').textContent);
  $('header-avatar').className = 'avatar small' + (self ? ' saved' : '');
  paintAvatar($('header-avatar'),active);
  $('contact-banner').hidden = group || !info || self || (info.contact && !info.blockedByMe);
  $('contact-banner-text').textContent = info?.blockedByMe ? '你已拉黑此用户' : '此用户不在你的联系人中';
  $('banner-add').hidden = !!info?.contact || !!info?.blockedByMe;
  $('banner-block').textContent = info?.blockedByMe ? '解除拉黑' : '拉黑用户';
  if (!info) { if (profileError) showStatus(profileError); else resetStatus(); }
  else if (!allowed) showStatus(info.blockedByMe ? '你已拉黑此用户，解除拉黑后可发送消息。' : '暂时无法向此用户发送消息。');
  else resetStatus();
  resizeInput();
}
function updateOpeningRows() {
  for (const row of document.querySelectorAll('[data-peer]')) {
    const busy = row.dataset.peer === openingPeer;
    row.classList.toggle('is-opening',busy);
    if (busy) row.setAttribute('aria-busy','true'); else row.removeAttribute('aria-busy');
  }
}
function finishChatOpening() {
  openingPeer = null; failedOpenPeer = null;
  $('chat-open-status').hidden = true; updateOpeningRows();
  updateConnectionHint();
}
function cancelChatOpening() {
  ++chatOpenRequest; chatOpenController?.abort(); chatOpenController = null;
  finishChatOpening();
}
function showChatOpening(peer, error = '') {
  openingPeer = error ? null : peer; failedOpenPeer = error ? peer : null;
  const status = $('chat-open-status');
  status.classList.toggle('load-failed',!!error);
  $('chat-open-copy').textContent = error;
  $('retry-open-chat').hidden = !error;
  status.hidden = !error;
  updateOpeningRows();
  updateConnectionHint();
}
function cacheCurrentMessages() { if (messageReady && active) messageCache.save(me,active,entries,messagesRevision); }
function commitChat(peer, messages, more, profile, error = '', revision = 0) {
  closeMessageMenu(true); cancelMessageEdit(true);
  window.chaweArticles.close(true);
  if (active) drafts.set(active,$('message-input').value);
  cancelSendFlights(); catchupAfter = null;
  ++messageRequest; ++profileRequest;
  Groups.closeSettings(true);
  active = peer; activeProfile = profile || Groups.of(peer); profileError = error;
  entries = messages.slice(); hasOlder = more; messageReady = true; messagesRevision = revision;
  loadingOlder = false; olderError = false;
  finishChatOpening();
  setChatMoreMenu(false); closeProfile(true,false);
  if (searchActive) resetSearch();
  setPanel('chats'); workspace.classList.add('chat-open');
  $('empty-selection').hidden = true; $('chat-view').hidden = false;
  setEmojiMenu(false);
  $('message-input').value = drafts.get(peer) || '';
  if (profile) applyActiveProfile(profile); else updateComposer();
  renderList();
  renderMessages(true); cacheCurrentMessages(); Pins.activate(peer);
  requestAnimationFrame(maybeLoadOlder);
  return {messages:messageRequest,profile:profileRequest};
}
async function openChat(peer,allowBusy=false) {
  if(Groups.isBusy()&&!allowBusy){showStatus('请等待群设置操作完成。');return;}
  if((window.chaweVoice.isBusy() || window.chaweArticles.isBusy())){showStatus('请先发送或取消当前录音，或等待一次性语音播放结束。');return;}
  if (!me || openingPeer === peer) return;
  setAttachmentMenu(false);
  if (chatSearch.peer && chatSearch.peer !== peer) closeChatSearch(false,true);
  if (active === peer && messageReady) {
    cancelChatOpening();
    if (searchActive) resetSearch();
    setPanel('chats'); workspace.classList.add('chat-open');
    loadActiveProfile(); pollNew(); return;
  }
  chatOpenController?.abort();
  const controller = new AbortController(), request = ++chatOpenRequest;
  chatOpenController = controller; showChatOpening(peer);
  setEmojiMenu(false); setMoreMenu(false); setComposeMenu(false); setChatMoreMenu(false);
  let committed = false, epoch, preparedProfile = null, preparedError = '';
  const profileReady=api('/api/profile?peer=' + encodeURIComponent(peer),{signal:controller.signal}).then(data => {
    if (request !== chatOpenRequest) return;
    preparedProfile = data;
    if (committed && active === peer && epoch.profile === profileRequest) applyActiveProfile(data);
  },error => {
    if (request !== chatOpenRequest || error.name === 'AbortError') return;
    preparedError = errorText(error);
    if (committed && active === peer && epoch.profile === profileRequest) {
      profileError = preparedError; updateComposer(); renderProfile();
    }
  });
  try {
    if(Groups.isGroup(peer)){
      await profileReady;if(request!==chatOpenRequest)return;
      if(!preparedProfile){showChatOpening(peer,preparedError || '群资料加载失败，请重试。');return;}
      rememberPeople([preparedProfile]);
      if(!preparedProfile.joined){finishChatOpening();Groups.joinDialog(preparedProfile);return;}
    }
    const cached = await messageCache.read(me,peer);
    if (request !== chatOpenRequest) return;
    const base = cached?.messages.at(-1)?.seq || 0;
    if (base) {
      const recent = cached.messages.slice(-50);
      epoch = commitChat(peer,recent,recent[0].seq > 1,preparedProfile,preparedError,cached.revision || 0); committed = true;
    }
    const params = new URLSearchParams({with:peer,limit:base ? '100' : '50'});
    if (base) params.set('after',String(base));
    const data = await api('/api/messages?' + params,{signal:controller.signal});
    if (request !== chatOpenRequest) return;
    if (!committed) {
      epoch = commitChat(peer,data.messages,data.more,preparedProfile,preparedError); committed = true;
    } else {
      await waitForSendMotion();
      if (request !== chatOpenRequest || active !== peer || epoch.messages !== messageRequest) return;
      if (sending) { catchupAfter = Math.min(catchupAfter ?? base,base); return; }
      const log = $('messages'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
      mergeMessages(data.messages);
      hasOlder = (entries[0]?.seq || 1) > 1;
      if (data.messages.length) renderMessages(atBottom);
      if (data.more) catchupAfter = data.messages.at(-1)?.seq || base;
      cacheCurrentMessages();
      if (catchupAfter !== null) queueMicrotask(pollNew);
    }
    if ((data.revision || 0) > messagesRevision) await syncMessageChanges();
    loadChats();
  } catch (error) {
    if (request !== chatOpenRequest || error.name === 'AbortError') return;
    if (committed && active === peer) showStatus(errorText(error));
    else showChatOpening(peer,errorText(error));
  } finally {
    if (request === chatOpenRequest) { chatOpenController = null; updateConnectionHint(); }
  }
}

function applyReadState(data,peer,paint = true) {
  if (!peer || !Number.isSafeInteger(data?.readThrough) || data.readThrough < 0
      || !Number.isSafeInteger(data.peerReadThrough) || data.peerReadThrough < 0) return;
  const old = receiptStates.get(receiptKey(peer)) || {readThrough:0,peerReadThrough:0};
  const next = {readThrough:Math.max(old.readThrough,data.readThrough),peerReadThrough:Math.max(old.peerReadThrough,data.peerReadThrough)};
  receiptStates.set(receiptKey(peer),next);
  if (paint && peer === active) {
    for (const message of entries) {
      const node = messageNodes.get(message.seq); if (node) paintMessageTicks(node,message,peer);
    }
    if (messageReady && (old.peerReadThrough !== next.peerReadThrough || old.readThrough !== next.readThrough)) cacheCurrentMessages();
  }
}
async function locatePinnedMessage(peer,message) {
  if(active!==peer||!messageReady)return;
  const epoch=messageRequest,topic=Groups.topicOf(peer),seq=message.seq;
  closeChatSearch(false,true);closeMessageMenu(true);cancelSendFlights();
  if(!messageNodes.has(seq)){
    const [before,after]=await Promise.all([
      api('/api/messages?'+new URLSearchParams({with:peer,before:String(seq+1),limit:'50'})),
      api('/api/messages?'+new URLSearchParams({with:peer,after:String(seq),limit:'50'}))]);
    await waitForSendMotion();if(active!==peer||messageRequest!==epoch||Groups.topicOf(peer)!==topic)return;
    entries=[];mergeMessages([...before.messages,...after.messages]);hasOlder=before.more;catchupAfter=null;
    renderedPeer=null;renderMessages(false);cacheCurrentMessages();
  }
  if(active!==peer||messageRequest!==epoch)return;
  const target=messageNodes.get(seq);if(!target)throw Error('message_not_found');
  const log=$('messages'),r=target.getBoundingClientRect(),box=log.getBoundingClientRect();
  log.scrollTo({top:log.scrollTop+r.top-box.top-(log.clientHeight-r.height)/2,behavior:motionEnabled()?'smooth':'instant'});
  target.classList.add('is-pin-jump');setTimeout(()=>target.classList.remove('is-pin-jump'),1600);Pins.schedule();
}
function paintMessageTicks(bubble,message,peer) {
  const meta = bubble.querySelector('.bubble-meta'); if (!meta) return;
  let ticks = meta.querySelector('.message-ticks');
  if (message.sender !== me || message.seq <= 0 || message.deleted) { ticks?.remove(); return; }
  const read = Groups.isGroup(peer)?message.read===true:message.seq <= (receiptStates.get(receiptKey(peer))?.peerReadThrough || 0);
  if (!ticks) { ticks = document.createElement('span'); ticks.className = 'message-ticks'; meta.append(ticks); }
  if (ticks.dataset.state !== String(read)) {
    ticks.dataset.state = String(read); ticks.innerHTML = icon(read ? 'read' : 'sent');
    ticks.setAttribute('role','img'); ticks.setAttribute('aria-label',read ? '已读' : '发送成功');
    meta.title = new Date(message.time).toLocaleString('zh-CN',{hour12:false}) + (read ? ' · 已读' : ' · 发送成功');
  }
}
function scheduleReadAck() {
  if (readAckTimer) return;
  readAckTimer = setTimeout(() => { readAckTimer = null; acknowledgeVisibleMessages(); },250);
}
async function acknowledgeVisibleMessages() {
  if (readAckBusy || !active || !messageReady || document.hidden || !document.hasFocus() || activeModal || chatSearch.peer
      || openingPeer || isPopupOpen('user-profile') || !$('conversation').getClientRects().length) return;
  const peer = active, bounds = $('messages').getBoundingClientRect();
  let seq = receiptStates.get(receiptKey(peer))?.readThrough || 0;
  for (const message of entries) {
    if ((Groups.isGroup(peer)?message.sender===me:message.sender!==peer) || message.deleted || message.seq <= seq) continue;
    const node = messageNodes.get(message.seq); if (!node?.isConnected) continue;
    const box = node.getBoundingClientRect();
    if (Math.min(box.bottom,bounds.bottom,innerHeight) - Math.max(box.top,bounds.top,0) >= Math.min(28,box.height / 3)) seq = message.seq;
  }
  if (!seq || seq <= (receiptStates.get(receiptKey(peer))?.readThrough || 0)) return;
  readAckBusy = true;
  try { applyReadState(await post('/api/messages/read',{peer,seq:String(seq)}),peer); }
  catch { /* Keep the unacknowledged position; the next poll or scroll retries. */ }
  finally { readAckBusy = false; if (active !== peer) scheduleReadAck(); }
}
function messageNode(message) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (message.sender === me ? ' outgoing' : '');
  bubble.dataset.seq = String(message.seq);
  bubble.dataset.day = dayOf(message.time);
  const portrait = avatar(message.sender,true,true);
  // Saved Messages keeps its bookmark; senders use their personal portrait.
  const senderName = message.sender === me ? userName(me) : titleOf(message.sender);
  portrait.className = 'avatar user-avatar message-avatar';
  paintAvatar(portrait,message.sender,true,senderName);
  portrait.title = senderName; portrait.setAttribute('aria-hidden','true');
  bubble.append(portrait);
  const content = document.createElement('span'); content.className = 'message-text'; content.textContent = message.text; bubble.append(content);
  const meta = document.createElement('time'); meta.className = 'bubble-meta'; meta.textContent = timeOf(message.time);
  meta.dateTime = new Date(message.time).toISOString(); meta.title = new Date(message.time).toLocaleString('zh-CN',{hour12:false});
  bubble.append(meta); window.chaweAttachments.renderMessage(bubble,message,active); Groups.decorate(bubble,message,active); window.chaweReactions.render(bubble,message,active); paintMessageTicks(bubble,message,active); return bubble;
}
function updateMessageNode(bubble,message) {
  bubble.classList.toggle('is-editing-message',editingMessage?.peer === active && editingMessage.seq === message.seq);
  const content = bubble.querySelector('.message-text'), meta = bubble.querySelector('.bubble-meta');
  const stamp = timeOf(message.time) + (message.editedAt ? ' · 已编辑' : '');
  if (content.textContent !== message.text) content.textContent = message.text;
  if (meta.textContent !== stamp) {
    meta.textContent = stamp; bubble.style.setProperty('--message-meta-space',message.editedAt ? '94px' : '48px');
  }
  bubble.dataset.day = dayOf(message.time);
  window.chaweAttachments.renderMessage(bubble,message,active);
  Groups.decorate(bubble,message,active);window.chaweReactions.render(bubble,message,active);paintMessageTicks(bubble,message,active);
}
function mergeMessages(messages) {
  const merged = new Map(entries.map(message => [message.seq,message]));
  for (const message of messages) {
    const old = merged.get(message.seq);
    if (!old || (message.revision || 0) >= (old.revision || 0)) merged.set(message.seq,message);
  }
  entries = Array.from(merged.values()).sort((a,b) => a.seq-b.seq);
}

function applyMessageChanges(updates) {
  Pins.changed(updates);
  window.chaweArticles.updateViewer(updates,active);
  const known = new Map(entries.map(message => [message.seq,message]));
  const changed = updates.filter(message => known.has(message.seq)
    && ((message.revision || 0) > (known.get(message.seq).revision || 0) || Groups.isGroup(active)&&message.read!==known.get(message.seq).read || JSON.stringify(message.reactions || [])!==JSON.stringify(known.get(message.seq).reactions || [])));
  if (!changed.length) return;
  const log = $('messages'), bounds = log.getBoundingClientRect();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const removed = new Set(changed.filter(message => message.deleted).map(message => message.seq));
  const anchor = Array.from(log.children).find(node => node.dataset.seq && !removed.has(Number(node.dataset.seq))
    && node.getBoundingClientRect().bottom > bounds.top);
  const previousTop = anchor?.getBoundingClientRect().top;
  mergeMessages(changed); renderMessages(atBottom);
  if (!atBottom && anchor?.isConnected) log.scrollTop += anchor.getBoundingClientRect().top - previousTop;
  requestAnimationFrame(maybeLoadOlder);
}
async function fetchMessageChanges(sync) {
  let more;
  do {
    const data = await api('/api/messages/changes?' + new URLSearchParams({with:sync.peer,after:String(messagesRevision),limit:'100'}));
    await waitForSendMotion();
    if (active !== sync.peer || messageRequest !== sync.epoch) return;
    if (!Number.isSafeInteger(data.revision) || data.revision < messagesRevision || !Array.isArray(data.updates))
      throw Error('client_update_required');
    const previous = messagesRevision;
    applyMessageChanges(data.updates);
    messagesRevision = data.revision;
    messageCache.save(me,sync.peer,data.updates,messagesRevision); cacheCurrentMessages();
    more = data.more && messagesRevision > previous;
  } while (more);
}
async function syncMessageChanges() {
  if (!active || !messageReady) return;
  if (changesSync?.peer === active && changesSync.epoch === messageRequest) return changesSync.promise;
  const sync = {peer:active,epoch:messageRequest};
  changesSync = sync; sync.promise = fetchMessageChanges(sync);
  try { await sync.promise; } finally { if (changesSync === sync) changesSync = null; }
}
function closeMessageMenu(immediate = false) {
  if (messageMenuTarget) messageNodes.get(messageMenuTarget.seq)?.classList.remove('context-target');
  messageMenuTarget = null;
  setPopup('message-context-menu',false,'scale(.9)',180,immediate);
}
function refreshMessageMenuActions() {
  $('edit-selected-message').disabled = sending || messageActionBusy || activeProfile?.canMessage !== true;
  $('retract-selected-message').disabled = messageActionBusy;
  $('favorite-selected-message').disabled = messageActionBusy;
}
function openMessageMenu(event) {
  window.chaweReactions.close();
  if (!(event.target instanceof Element)) return;
  const bubble = event.target.closest('.bubble[data-seq]');
  if (!bubble || !messageReady || $('conversation').inert) return;
  const message = entries.find(entry => entry.seq === Number(bubble.dataset.seq));
  if (!message || message.deleted) return;
  if(message.attachment?.kind==='voice-once'&&message.sender!==me){event.preventDefault();closeMessageMenu(true);return;}
  event.preventDefault();
  cancelSendFlights();
  closeMessageMenu(true); setEmojiMenu(false); setMoreMenu(false); setComposeMenu(false); setChatMoreMenu(false); setAttachmentMenu(false);
  messageMenuTarget = {peer:active,seq:message.seq};
  bubble.classList.add('context-target');
  const own = message.sender === me, menu = $('message-context-menu');
  $('edit-selected-message').hidden = !own || !!message.attachment?.kind.startsWith('voice'); $('retract-selected-message').hidden = !own && !Groups.canManage(Groups.of(active),'deleteMessages');
  $('react-selected-message').hidden=!window.chaweReactions.choices(active).length;
  Pins.menu(message);
  $('favorite-selected-message').hidden = message.attachment?.kind === 'voice-once';
  refreshMessageMenuActions();
  menu.hidden = false;
  const size = menu.getBoundingClientRect(), origin = bubble.getBoundingClientRect();
  const x = event.clientX || origin.left + origin.width / 2, y = event.clientY || origin.bottom;
  menu.style.left = Math.max(8,Math.min(x,innerWidth-size.width-8)) + 'px';
  menu.style.top = Math.max(8,Math.min(y,innerHeight-size.height-8)) + 'px';
  menu.hidden = true;
  setPopup('message-context-menu',true,'scale(.9)',220);
  menu.querySelector('button:not([hidden]):not(:disabled)')?.focus({preventScroll:true});
}
function cancelMessageEdit(force = false) {
  if (!editingMessage || (sending && !force)) return;
  const edit = editingMessage; editingMessage = null;
  if (edit.article) window.chaweArticles.close(true);
  if (renderedPeer === edit.peer) messageNodes.get(edit.seq)?.classList.remove('is-editing-message');
  drafts.set(edit.peer,edit.draft);
  if (active === edit.peer) $('message-input').value = edit.draft;
  $('edit-message-bar').hidden = true; resizeInput();
}
function startMessageEdit(target) {
  if (!target || target.peer !== active || sending || switchingAccount || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || window.chaweArticles.isBusy()) return;
  const message = entries.find(entry => entry.seq === target.seq && !entry.deleted && entry.sender === me);
  if (!message || activeProfile?.canMessage !== true) return;
  cancelMessageEdit();
  window.chaweArticles.close(true);
  editingMessage = {peer:active,seq:message.seq,version:message.revision || 0,text:message.text,draft:$('message-input').value,attachment:!!message.attachment,article:message.attachment?.kind === 'article'};
  messageNodes.get(message.seq)?.classList.add('is-editing-message');
  if (editingMessage.article) { window.chaweArticles.open(editingMessage); resizeInput(); return; }
  $('edit-message-preview').textContent = message.text;
  $('edit-message-bar').hidden = false;
  $('message-input').value = message.text; resizeInput();
  $('message-input').focus({preventScroll:true});
}
async function submitMessageEdit() {
  const edit = editingMessage;
  if (!edit || active !== edit.peer || sending || switchingAccount || activeProfile?.canMessage !== true) return;
  const text = $('message-input').value.trim();
  if (!text && !edit.attachment) return;
  if (text === edit.text) { cancelMessageEdit(); return; }
  sending = true; $('message-input').readOnly = true; resizeInput();
  try {
    const data = await post('/api/messages/edit',{with:edit.peer,seq:edit.seq,version:edit.version,text});
    messageCache.save(me,edit.peer,[data.message]);
    if (active === edit.peer) {
      if (editingMessage === edit) cancelMessageEdit(true);
      applyMessageChanges([data.message]); cacheCurrentMessages(); showStatus('消息已编辑。');
    }
    loadChats();
  } catch (error) {
    if (active === edit.peer) {
      showStatus(errorText(error));
      if (error.message === 'message_changed' || error.message === 'message_retracted') syncMessageChanges().catch(() => {});
    }
  } finally {
    sending = false; $('message-input').readOnly = false; resizeInput();
    if (active === edit.peer) $('message-input').focus({preventScroll:true});
  }
}
async function performMessageAction(action,target) {
  if (!target || messageActionBusy) return;
  const peer = target.peer, epoch = messageRequest;
  messageActionBusy = true;
  try {
    const data = await post('/api/messages/' + action,{with:peer,seq:target.seq});
    messageCache.save(me,action === 'favorite' ? me : peer,[data.message]);
    await waitForSendMotion();
    if (active === peer && epoch === messageRequest) {
      if (action === 'retract') { applyMessageChanges([data.message]); cacheCurrentMessages(); showStatus('消息已撤回。'); }
      else showStatus(saved(peer) ? '这条消息已在收藏夹中。' : '消息已保存到收藏夹。');
    }
    loadChats();
  } catch (error) { if (active === peer) showStatus(errorText(error)); }
  finally { messageActionBusy = false; refreshMessageMenuActions(); }
}
function cancelSendFlights() {
  for (const cancel of Array.from(sendFlights)) cancel();
}
function resumeAfterSendMotion() {
  if (sendFlights.size) return;
  for (const resolve of sendMotionWaiters) resolve();
  sendMotionWaiters.clear();
  if (catchupAfter !== null) queueMicrotask(pollNew);
  requestAnimationFrame(maybeLoadOlder);
}
async function waitForSendMotion() {
  while (sendFlights.size) await new Promise(resolve => sendMotionWaiters.add(resolve));
}
function captureMessageLayout() {
  return {peer:active,rows:Array.from($('messages').children)
    .filter(node => node.classList.contains('bubble') || node.classList.contains('day'))
    .map(node => ({node,rect:node.getBoundingClientRect()}))};
}
function animateMessageLayout(previous) {
  const log = $('messages');
  if (previous.peer !== active || document.hidden || $('conversation').inert
      || !motionEnabled()) return;
  const viewport = log.getBoundingClientRect();
  // Read every destination before starting animations, so all rows move together.
  const shifts = previous.rows.filter(row => row.node.parentElement === log).map(row => {
    const rect = row.node.getBoundingClientRect();
    return {node:row.node,dy:row.rect.top - rect.top,
      visible:Math.max(row.rect.bottom,rect.bottom) > viewport.top && Math.min(row.rect.top,rect.top) < viewport.bottom};
  }).filter(row => row.visible && Math.abs(row.dy) > .5);
  if (!shifts.length) return;
  const animations = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const animation of animations) animation.cancel();
    sendFlights.delete(finish); resumeAfterSendMotion();
  };
  try {
    sendFlights.add(finish);
    for (const row of shifts) animations.push(row.node.animate([
      {transform:'translateY(' + row.dy + 'px)'}, {transform:'translateY(0)'}
    ],{duration:motionDuration(SEND_MOTION_DURATION),easing:SEND_MOTION_EASING,fill:'both'}));
    Promise.all(animations.map(animation => animation.finished)).then(finish,finish);
  } catch { finish(); }
}
function animateSentMessage(seq, source) {
  const bubble = messageNodes.get(seq), log = $('messages');
  if (!bubble || !source.width || !source.height || !bubble.getClientRects().length
      || document.hidden || $('conversation').inert || !motionEnabled()) return;
  const destination = bubble.getBoundingClientRect(), bounds = log.getBoundingClientRect();
  const bottom = Math.min(innerHeight,$('conversation').getBoundingClientRect().bottom);
  if (!destination.width || bottom <= bounds.top) return;
  const layer = document.createElement('div'), flight = bubble.cloneNode(true);
  // Keep the sender at the edge of the message row; only the text bubble
  // travels from the composer to its destination.
  flight.querySelector('.message-avatar')?.remove();
  layer.className = 'message-flight-layer'; layer.setAttribute('aria-hidden','true');
  Object.assign(layer.style,{left:bounds.left+'px',top:bounds.top+'px',width:bounds.width+'px',height:(bottom-bounds.top)+'px'});
  flight.classList.remove('send-arriving'); flight.classList.add('message-flight');
  Object.assign(flight.style,{left:(destination.left-bounds.left)+'px',top:(destination.top-bounds.top)+'px',width:destination.width+'px'});
  layer.append(flight); document.body.append(layer);
  const sourceStyle = getComputedStyle($('message-input')), targetStyle = getComputedStyle(bubble);
  const dx = source.left + parseFloat(sourceStyle.paddingLeft) - destination.left - parseFloat(targetStyle.paddingLeft);
  const dy = source.top + parseFloat(sourceStyle.paddingTop) - destination.top - parseFloat(targetStyle.paddingTop);
  let animation, portraitAnimation, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true; portraitAnimation?.cancel();
    layer.remove(); bubble.classList.remove('send-arriving'); sendFlights.delete(cancel);
    resumeAfterSendMotion();
  };
  const cancel = () => { if (animation) animation.cancel(); finish(); };
  try {
    bubble.classList.add('send-arriving'); sendFlights.add(cancel);
    animation = flight.animate([
      {transform:'translate('+dx+'px,'+dy+'px)',opacity:.9,backgroundColor:'rgba(227,241,255,0)',boxShadow:'none',borderRadius:'8px'},
      {transform:'translate(0,0)',opacity:1,backgroundColor:getComputedStyle(bubble).backgroundColor,boxShadow:getComputedStyle(bubble).boxShadow,borderRadius:getComputedStyle(bubble).borderRadius}
    ],{duration:motionDuration(SEND_MOTION_DURATION),easing:SEND_MOTION_EASING,fill:'both'});
    portraitAnimation = bubble.querySelector('.message-avatar')?.animate([
      {opacity:0,transform:'scale(.7)'},{opacity:1,transform:'scale(1)'}
    ],{duration:motionDuration(240),delay:motionDuration(120),easing:SEND_MOTION_EASING,fill:'both'});
    flight.querySelector('.bubble-meta').animate([{opacity:0},{opacity:1}],{duration:motionDuration(240),delay:motionDuration(120),fill:'both'});
    animation.finished.then(finish,finish);
  } catch { cancel(); }
}
function olderLoader() {
  const loader = document.createElement('div'); loader.className = 'older-loader';
  loader.setAttribute('role','status'); loader.setAttribute('aria-label','正在加载更早的消息');
  const circle = document.createElement('span'); circle.className = 'older-loader-circle';
  circle.setAttribute('aria-hidden','true');
  for (let i = 0; i < 3; i++) circle.append(document.createElement('i'));
  loader.append(circle); return loader;
}
// Reserve only the space after the final text line, using the actual stamp width.
function sizeMessageTimestamps() {
  const measurements = [];
  for (const bubble of $('messages').children) {
    if (!bubble.classList.contains('bubble') || bubble.classList.contains('has-attachment')) continue;
    const width = bubble.querySelector('.bubble-meta')?.offsetWidth;
    if (width) measurements.push([bubble,Math.ceil(width)+9+'px']);
  }
  for (const [bubble,width] of measurements) {
    if (bubble.style.getPropertyValue('--message-meta-space') !== width) bubble.style.setProperty('--message-meta-space',width);
  }
}
const floatingMessageDate = (() => {
  const log = $('messages'), badge = $('scroll-date');
  if (!log || !badge) return {setRows() {}};
  let rows = [], peer = null, frame = 0, timer = 0, visible = false;
  function paint() {
    frame = 0;
    if (!visible || !log.getClientRects().length || !rows.length) { badge.classList.remove('is-visible'); return; }
    const viewport = log.getBoundingClientRect();
    let left = 0, right = rows.length;
    // Rows remain ordered; find the first message whose bottom is in the viewport.
    while (left < right) {
      const middle = (left+right) >>> 1;
      if (rows[middle].getBoundingClientRect().bottom <= viewport.top+1) left = middle+1;
      else right = middle;
    }
    const row = rows[left];
    if (!row || row.getBoundingClientRect().top >= viewport.bottom) { badge.classList.remove('is-visible'); return; }
    const day = row.dataset.day;
    if (badge.textContent !== day) badge.textContent = day;
    badge.classList.add('is-visible');
  }
  function refresh() { if (!frame) frame = requestAnimationFrame(paint); }
  function hide() { clearTimeout(timer); visible = false; badge.classList.remove('is-visible'); }
  log.addEventListener('scroll',() => {
    visible = true; clearTimeout(timer); refresh(); timer = setTimeout(hide,1100);
  },{passive:true});
  window.addEventListener('resize',refresh,{passive:true});
  document.addEventListener('visibilitychange',() => { if (document.hidden) hide(); });
  return {setRows(next) {
    if (peer !== active) { peer = active; hide(); }
    rows = next.filter(node => node.classList.contains('bubble') && node.dataset.day);
    refresh();
  }};
})();
function renderMessages(scrollBottom = false, preserveFromTop = false) {
  const log = $('messages'), oldHeight = log.scrollHeight, oldTop = log.scrollTop;
  if (renderedPeer !== active) {
    cancelSendFlights(); messageNodes.clear(); dayNodes.clear(); log.replaceChildren(); renderedPeer = active;
  }
  const desired = [], sequences = new Set(), days = new Set();
  const pendingAttachments = window.chaweAttachments.pendingNodes(active,entries);
  if (hasOlder && loadingOlder) desired.push(olderLoader());
  else if (hasOlder && olderError) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'older-retry';
    retry.textContent = '加载失败，点击重试'; retry.addEventListener('click',loadOlder); desired.push(retry);
  }
  if (messageMenuTarget?.peer === active && !entries.some(message => message.seq === messageMenuTarget.seq && !message.deleted)) closeMessageMenu(true);
  if (editingMessage?.peer === active && entries.some(message => message.seq === editingMessage.seq && message.deleted)) {
    cancelMessageEdit(true); showStatus('正在编辑的消息已被撤回。');
  }
  if (messageReady && !hasOlder && !entries.some(message => !message.deleted) && !pendingAttachments.length) {
    const empty = document.createElement('div'); empty.className = 'conversation-notice';
    empty.innerHTML = icon(saved(active) ? 'bookmark' : 'plane');
    const title = document.createElement('strong'); title.textContent = '还没有消息';
    const copy = document.createElement('span');
    copy.textContent = saved(active) ?
      '发给自己的消息会保存在服务器。' : '发送第一条消息，开始聊天。';
    empty.append(title,copy); desired.push(empty);
  }
  let lastDay = '';
  for (const message of entries) {
    if (message.deleted) continue;
    const day = dayOf(message.time);
    if (day !== lastDay) {
      if (!dayNodes.has(day)) {
        const label = document.createElement('span'); label.className = 'day'; label.textContent = day; dayNodes.set(day,label);
      }
      desired.push(dayNodes.get(day)); days.add(day); lastDay = day;
    }
    if (!messageNodes.has(message.seq)) messageNodes.set(message.seq,messageNode(message));
    updateMessageNode(messageNodes.get(message.seq),message);
    desired.push(messageNodes.get(message.seq)); sequences.add(message.seq);
  }
  if (pendingAttachments.length && dayOf(Date.now()) !== lastDay) {
    const day = dayOf(Date.now());
    if (!dayNodes.has(day)) { const label = document.createElement('span'); label.className='day'; label.textContent=day; dayNodes.set(day,label); }
    desired.push(dayNodes.get(day)); days.add(day);
  }
  desired.push(...pendingAttachments);
  const keep = new Set(desired);
  if (sendFlights.size && (log.children.length !== desired.length
      || desired.some((node,index) => log.children[index] !== node))) cancelSendFlights();
  for (const child of Array.from(log.children)) if (!keep.has(child)) child.remove();
  let cursor = log.firstChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling;
    else log.insertBefore(node,cursor);
  }
  for (const seq of messageNodes.keys()) if (!sequences.has(seq)) messageNodes.delete(seq);
  for (const day of dayNodes.keys()) if (!days.has(day)) dayNodes.delete(day);
  sizeMessageTimestamps();
  floatingMessageDate.setRows(desired);
  if (scrollBottom) log.scrollTop = log.scrollHeight;
  else log.scrollTop = oldTop + (preserveFromTop ? log.scrollHeight - oldHeight : 0);
  scheduleReadAck(); Pins.schedule(); window.chaweReactions.refresh();
}
window.addEventListener('focus',scheduleReadAck);
window.addEventListener('resize',scheduleReadAck,{passive:true});
document.addEventListener('visibilitychange',() => { if (!document.hidden) scheduleReadAck(); });
$('messages').addEventListener('scroll',scheduleReadAck,{passive:true});
window.addEventListener('resize',sizeMessageTimestamps,{passive:true});
document.fonts?.ready.then(sizeMessageTimestamps);
function maybeLoadOlder() {
  const log = $('messages');
  if (hasOlder && !olderError && messageReady && !loadingOlder && !sending && !sendFlights.size && entries.length
      && log.scrollTop <= Math.max(180, log.clientHeight / 4)) loadOlder();
}
async function loadOlder() {
  if (!active || !messageReady || !hasOlder || !entries.length || loadingOlder || sending || sendFlights.size) return;
  const peer = active, request = messageRequest, before = entries[0].seq;
  const log = $('messages'), atTop = log.scrollTop < 8;
  loadingOlder = true; olderError = false; renderMessages(false,!atTop);
  try {
    const cached = await messageCache.read(me,peer);
    if (active !== peer || request !== messageRequest) return;
    const local = cached?.messages.filter(message => message.seq < before).slice(-50) || [];
    const data = cached?.revision === messagesRevision && local.at(-1)?.seq === before - 1 ? {messages:local,more:local[0].seq > 1}
      : await api('/api/messages?' + new URLSearchParams({with:peer,before:String(before),limit:'50'}));
    await waitForSendMotion();
    if (active !== peer || request !== messageRequest) return;
    mergeMessages(data.messages); hasOlder = data.more;
    loadingOlder = false; renderMessages(false,true);
    cacheCurrentMessages();
    if ((data.revision || 0) > messagesRevision) await syncMessageChanges();
    requestAnimationFrame(maybeLoadOlder);
  } catch (error) {
    await waitForSendMotion();
    if (active === peer && request === messageRequest) {
      loadingOlder = false; olderError = true; renderMessages(false,true);
      showStatus(errorText(error));
    }
  } finally {
    if (active === peer && request === messageRequest && loadingOlder) {
      loadingOlder = false;
      renderMessages(false,true);
    }
  }
}
async function pollNew() {
  if (!active || !messageReady || sending || sendFlights.size || loadingOlder || polling || document.hidden) return;
  polling = true;
  const peer = active, request = messageRequest, last = catchupAfter ?? entries.at(-1)?.seq ?? 0;
  let more = false;
  try {
    const data = await api('/api/messages?' + new URLSearchParams({with:peer,after:String(last),limit:'100'}));
    await waitForSendMotion();
    if (active !== peer || request !== messageRequest || sending) return;
    const seen = new Set(entries.map(message => message.seq));
    const fresh = data.messages.filter(message => message.seq > last && !seen.has(message.seq));
    if (fresh.length) {
      const log = $('messages'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
      const previousLayout = captureMessageLayout();
      mergeMessages(fresh); if (!last && data.more) hasOlder = true;
      renderMessages(atBottom);
      if (atBottom) animateMessageLayout(previousLayout);
      cacheCurrentMessages();
    }
    if (active !== peer || request !== messageRequest || sending) return;
    const end = data.messages.at(-1)?.seq || last;
    more = last > 0 && data.more && end > last;
    catchupAfter = more ? end : null;
    if ((data.revision || 0) > messagesRevision) await syncMessageChanges();
    if (fresh.length) await loadChats();
  } catch { /* A later poll retries transient network failures. */ }
  finally {
    polling = false;
    if (more && active === peer && request === messageRequest) queueMicrotask(pollNew);
  }
}
$('messages').addEventListener('scroll',maybeLoadOlder,{passive:true});
function resizeInput() {
  window.chaweReactions.refresh();
  const input = $('message-input'), recording = window.chaweVoice.isRecording?.() ?? !$('voice-recorder').hidden;
  $('composer').hidden = recording || !!activeProfile && activeProfile.canMessage !== true;
  if (!$('composer').hidden) {
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight,140) + 'px';
  }
  const article = window.chaweArticles.isOpen(), articleBusy = window.chaweArticles.isBusy();
  const hasText = article ? !window.chaweArticles.isEmpty() : !!input.value.trim() || !!editingMessage?.attachment, button = $('send-button');
  const group=Groups.of(active),permit=kind=>!Groups.isGroup(active)||Groups.can(group,kind),closed=group?.topicsEnabled&&group.topics.find(t=>t.id===Groups.topicOf(active))?.closed&&!Groups.canManage(group,'manageTopics');
  input.readOnly=sending || !permit('text');input.placeholder=permit('text')?'消息':'你没有发送文字消息的权限';
  const mode = sending || articleBusy ? 'sending' : editingMessage ? 'edit' : article || hasText ? 'send' : 'voice';
  const label = mode === 'sending' ? editingMessage ? '正在保存编辑' : '正在发送消息' : mode === 'edit' ? '保存消息编辑' : mode === 'send' ? '发送消息' : '录制语音消息';
  button.dataset.mode = mode; button.setAttribute('aria-label',label); button.title = label;
  button.setAttribute('aria-busy',String(sending || articleBusy)); $('composer').setAttribute('aria-busy',String(sending || articleBusy));
  button.disabled = !!closed || !permit(article?'articles':mode==='voice'?'voice':'text') || sending || articleBusy || switchingAccount || !messageReady || !active || activeProfile?.canMessage !== true || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || article && (!window.chaweArticles.isReady() || !hasText);
  $('emoji-button').disabled = sending || articleBusy || switchingAccount || article && !window.chaweArticles.isReady();
  $('attachment-button').disabled = article || sending || switchingAccount || !!editingMessage || !messageReady || !active || activeProfile?.canMessage !== true || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy());
  $('attach-media').disabled=!permit('photos')&&!permit('videos');$('attach-file').disabled=!permit('files');$('attach-article').disabled=!permit('articles');
  if ($('attachment-button').disabled) setAttachmentMenu(false);
  $('cancel-message-edit').disabled = sending;
  $('account-menu').querySelectorAll('button').forEach(row => { row.disabled = sending || switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()); });
  $('add-account').disabled = sending || switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || savedAccounts.length >= maxBrowserAccounts || Groups.isBusy();
  $('logout-account').disabled = !me || sending || switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || Groups.isBusy();
}
$('more-button').addEventListener('click',() => {
  if(Groups.clearFilter())return;
  if (searchActive) leaveSearch();
  else setMoreMenu(!isPopupOpen('more-menu'));
});
document.addEventListener('pointerdown',event => {
  if (event.target.closest('.chawe-scrollbar')) return;
  if (!$('message-context-menu').contains(event.target)) closeMessageMenu();
  if (!$('more-menu').contains(event.target) && !$('more-button').contains(event.target)) setMoreMenu(false);
  if (!$('emoji-picker').contains(event.target) && !$('emoji-button').contains(event.target)) setEmojiMenu(false);
  if (!$('attachment-menu').contains(event.target) && !$('attachment-button').contains(event.target)) setAttachmentMenu(false);
  if (!$('compose-menu').contains(event.target) && !$('new-message').contains(event.target)) setComposeMenu(false);
  if (!$('chat-more-menu').contains(event.target) && !$('chat-more-button').contains(event.target)) setChatMoreMenu(false);
});
document.addEventListener('focusin',event => {
  if (!$('attachment-menu').contains(event.target) && !$('attachment-button').contains(event.target)) setAttachmentMenu(false);
  if (isPopupOpen('message-context-menu') && !$('message-context-menu').contains(event.target)) closeMessageMenu();
  if (!$('more-menu').contains(event.target) && !$('more-button').contains(event.target)) setMoreMenu(false);
  if (!$('compose-menu').contains(event.target) && !$('new-message').contains(event.target)) setComposeMenu(false);
  if (!$('chat-more-menu').contains(event.target) && !$('chat-more-button').contains(event.target)) setChatMoreMenu(false);
});
$('search').addEventListener('focus',enterSearch);
$('search').addEventListener('input',event => {
  if(Groups.filter(event.target.value))return;
  enterSearch();
  listQuery = event.target.value.trim().slice(0,100);
  ++listRequest;
  setSearchBusy(!!listQuery);
  if (panel !== 'chats') setPanel('chats');
  clearTimeout(listTimer); listTimer = setTimeout(loadChats,220);
});
$('new-message').addEventListener('click',() => setComposeMenu(!isPopupOpen('compose-menu')));
$('retry-open-chat').addEventListener('click',() => { if (failedOpenPeer) openChat(failedOpenPeer); });
$('cancel-open-chat').addEventListener('click',cancelChatOpening);
$('new-private-chat').addEventListener('click',() => openContacts('new'));
$('open-contacts').addEventListener('click',() => openContacts());
$('open-blocks').addEventListener('click',() => { setPanel('blocks'); $('close-blocks').focus(); loadBlocks(); });
$('open-settings').addEventListener('click',() => { setPanel('settings'); $('close-settings').focus({preventScroll:true}); });
$('open-notifications').addEventListener('click',() => { setPanel('notifications'); window.chaweNotifications.load(); $('close-notifications').focus({preventScroll:true}); });
$('close-notifications').addEventListener('click',() => { setPanel('chats'); $('more-button').focus({preventScroll:true}); });
$('open-my-info').addEventListener('click',openMyInfo);
$('close-my-info').addEventListener('click',() => { setPanel('chats'); $('more-button').focus({preventScroll:true}); });
$('my-info-form').addEventListener('submit',saveMyInfo);
$('my-info-username').addEventListener('input',() => { $('my-info-error').hidden = true; setMyInfoState(); });
$('my-info-username').addEventListener('keydown',event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('change-my-username').click(); } });
$('change-my-username').addEventListener('click',() => {
  if ($('change-my-username').disabled) return;
  if (!/^[A-Za-z0-9_]{3,20}$/.test($('my-info-username').value.trim())) {
    $('my-info-error').textContent = errorText(Error('invalid_username')); $('my-info-error').hidden = false; return;
  }
  openConfirm('rename',me);
});
$('change-my-avatar').addEventListener('click',() => {
  if ($('change-my-avatar').disabled) return;
  $('my-avatar-file').value = ''; $('my-avatar-file').click();
});
$('my-avatar-file').addEventListener('change',event => prepareAvatar(event.target.files[0]));
$('reset-my-avatar').addEventListener('click',() => { if (!$('reset-my-avatar').disabled) openConfirm('avatarReset',me); });
$('avatar-cancel').addEventListener('click',() => { if (!avatarBusy) closeModal('avatar-dialog'); });
$('avatar-submit').addEventListener('click',saveAvatar);
for (const field of ['nickname','birthday','phone','email']) $('my-info-' + field).addEventListener('input',event => {
  if (field === 'birthday' && /^\d{8}$/.test(event.target.value)) event.target.value = event.target.value.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  markMyInfoDirty();
});
for (const id of ['privacy-everyone','privacy-contacts']) $(id).addEventListener('change',markMyInfoDirty);
$('reload-my-info').addEventListener('click',() => { if (ownInfoDirty) openConfirm('reloadInfo',me); else loadMyInfo(); });
$('edit-contact-exclusions').addEventListener('click',openPrivacyPeople);
$('retry-privacy-people').addEventListener('click',loadPrivacyPeople);
$('privacy-cancel').addEventListener('click',() => closeModal('privacy-dialog'));
$('privacy-done').addEventListener('click',() => {
  if ($('privacy-done').disabled) return;
  contactExclusions = new Set(privacySelection); renderContactExclusions(); markMyInfoDirty(); closeModal('privacy-dialog');
});
$('close-settings').addEventListener('click',() => { setPanel('chats'); $('more-button').focus({preventScroll:true}); });
$('setting-animations').addEventListener('change',event => updateUiSettings({animations:event.target.checked}));
$('setting-speed').addEventListener('input',event => updateUiSettings({speed:Number(event.target.value) / 100}));
$('setting-transparency').addEventListener('input',event => updateUiSettings({transparency:Number(event.target.value)}));
$('setting-blur').addEventListener('change',event => updateUiSettings({blur:event.target.checked}));
$('setting-ripples').addEventListener('change',event => updateUiSettings({ripples:event.target.checked}));
$('reset-ui-settings').addEventListener('click',() => updateUiSettings(UI_SETTINGS_DEFAULTS));
$('setting-group-recommendations')?.addEventListener('change',event => setRecommendationsHidden(!event.target.checked));
reducedMotion.addEventListener('change',applyUiSettings);
reducedTransparency.addEventListener('change',applyUiSettings);
window.addEventListener('storage',event => {
  if (event.key === RECOMMENDATIONS_HIDDEN_PREFIX + meIdentity || event.key === null) {
    recommendationVisibility.delete(meIdentity); recommendationSaveFailed = false; renderList();
  }
  if (event.key === 'chawe-auth-change-v1') {
    try {
      if (JSON.parse(event.newValue)?.id === meIdentity) location.replace('/?add-account=1');
    } catch {}
    return;
  }
  if (event.key !== UI_SETTINGS_KEY && event.key !== null) return;
  uiSettings = readUiSettings(); settingsSaveFailed = false; applyUiSettings();
});
$('add-account').addEventListener('click',() => {
  if (!me || sending || switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) return;
  if (savedAccounts.length >= maxBrowserAccounts) { accountError(errorText(Error('browser_account_limit'))); return; }
  try { sessionStorage.setItem('chawe_add_account_return',JSON.stringify({account:me,time:Date.now()})); } catch {}
  location.assign('/?add-account=1&return-account=' + encodeURIComponent(me));
});
$('logout-account').addEventListener('click',() => { if (!Groups.isBusy() && me && !sending && !switchingAccount && !ownInfoSaving && !avatarBusy && !window.chaweAttachments.isBusy() && !(window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) openConfirm('logout',me); });
$('close-contacts').addEventListener('click',() => setPanel('chats'));
$('close-blocks').addEventListener('click',() => setPanel('chats'));
$('add-contact').addEventListener('click',() => openContactDialog());
$('contact-cancel').addEventListener('click',() => closeModal('contact-dialog'));
$('contact-form').addEventListener('submit',async event => {
  event.preventDefault();
  if ($('contact-submit').disabled) return;
  const peer = $('contact-username').value.trim().replace(/^@/,''), alias = $('contact-alias').value.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(peer)) { $('contact-error').textContent = '请输入 3–20 位字母、数字或下划线组成的用户名。'; $('contact-error').hidden = false; return; }
  if (Array.from(alias).length > 40) { $('contact-error').textContent = errorText(Error('invalid_alias')); $('contact-error').hidden = false; return; }
  const request = contactDialogRequest; $('contact-submit').disabled = true; $('contact-cancel').disabled = true;
  try {
    await post('/api/contacts/save',{peer,alias});
    if (request === contactDialogRequest) closeModal('contact-dialog');
    await refreshSocial();
  } catch (error) {
    if (request === contactDialogRequest) { $('contact-error').textContent = errorText(error); $('contact-error').hidden = false; }
  } finally { if (request === contactDialogRequest) { $('contact-submit').disabled = false; $('contact-cancel').disabled = false; } }
});
$('confirm-cancel').addEventListener('click',() => closeModal('confirm-dialog'));
$('confirm-form').addEventListener('submit',async event => {
  event.preventDefault(); const action = confirmation; if (!action || $('confirm-submit').disabled) return;
  if (action.path === 'reload-my-info') { closeModal('confirm-dialog'); loadMyInfo(); return; }
  const request = confirmDialogRequest;
  $('confirm-submit').disabled = true; $('confirm-cancel').disabled = true;
  if (action.path === '/api/logout') {
    loggingOut = true; switchingAccount = true; cancelChatOpening(); cancelSendFlights(); renderAccounts(); resizeInput();
  }
  if (action.path === '/api/me/avatar/reset') setAvatarBusy(true);
  if (action.path === '/api/me/username') {
    usernameBusy = true; switchingAccount = true; cancelChatOpening(); cancelSendFlights(); setMyInfoState(); renderAccounts(); resizeInput();
  }
  try {
    const data = await post(action.path,action.path === '/api/me/avatar/reset' ? {revision:action.avatarVersion}
      : action.path === '/api/me/username' ? {username:action.newUsername}
      : action.path === '/api/admin/accounts/delete' ? {id:action.accountId,username:action.peer} : {peer:action.peer});
    if(action.path === '/api/admin/accounts/delete') {
      try { localStorage.setItem('chawe-auth-change-v1',JSON.stringify({id:data.deletedId,time:Date.now()})); } catch {}
      location.replace(action.peer===me?'/':'/app?account='+encodeURIComponent(me)); return;
    }
    if (action.path === '/api/me/username') {
      try { sessionStorage.removeItem('chawe_add_account_return'); localStorage.setItem('chawe-auth-change-v1',JSON.stringify({id:meIdentity,time:Date.now()})); } catch {}
      location.replace('/?add-account=1'); return;
    }
    if (action.path === '/api/logout') {
      try { sessionStorage.removeItem('chawe_add_account_return'); } catch {}
      location.replace(data.username ? '/app?account=' + encodeURIComponent(data.username) : '/'); return;
    }
    if (action.path === '/api/me/avatar/reset') { applyOwnAvatar(data); setAvatarBusy(false); }
    if (request === confirmDialogRequest) closeModal('confirm-dialog');
    await refreshSocial();
  } catch (error) {
    if (request === confirmDialogRequest) { $('confirm-error').textContent = errorText(error); $('confirm-error').hidden = false; }
    if (action.path === '/api/me/avatar/reset' && error.message === 'avatar_changed') await refreshOwnAvatar();
    if (action.path === '/api/me/username' && error.message === 'username_cooldown') {
      try { const data = await api('/api/me/profile'); ownProfile.usernameChangeAllowedAt = data.usernameChangeAllowedAt; } catch {}
    }
  } finally {
    if (action.path === '/api/me/username') { usernameBusy = false; switchingAccount = false; setMyInfoState(); renderAccounts(); resizeInput(); }
    if (action.path === '/api/me/avatar/reset') {
      setAvatarBusy(false);
      if (activeModal !== 'confirm-dialog') setMyInfoState(ownInfoDirty ? '头像已恢复默认；其他修改请点击保存' : '头像已恢复默认');
    }
    if (action.path === '/api/logout') { loggingOut = false; switchingAccount = false; renderAccounts(); resizeInput(); }
    if (request === confirmDialogRequest) { $('confirm-submit').disabled = false; $('confirm-cancel').disabled = false; }
  }
});
for (const id of ['contact-dialog','confirm-dialog','privacy-dialog','avatar-dialog','notification-dialog','attachment-dialog','media-dialog','voice-once-dialog','article-dialog','group-confirm-dialog','pins-dialog']) $(id).addEventListener('click',event => {
  if (event.target === $(id) && !modalBusy(id)) closeModal(id);
});
document.addEventListener('keydown',event => {
  if (!activeModal) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!modalBusy(activeModal)) closeModal(activeModal);
  } else if (event.key === 'Tab') {
    const buttons = modalButtons(), first = buttons[0], last = buttons.at(-1);
    if (!first) { event.preventDefault(); $(activeModal).querySelector('[role="dialog"]').focus(); }
    else if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
},{capture:true});
document.addEventListener('focusin',event => {
  if (activeModal && !$(activeModal).contains(event.target)) (modalButtons()[0] || $(activeModal).querySelector('[role="dialog"]')).focus({preventScroll:true});
});
$('open-profile').addEventListener('click',openProfile);
$('open-chat-search').addEventListener('click',openChatSearch);
$('group-header-search').addEventListener('click',openChatSearch);
$('react-selected-message').addEventListener('click',()=>{const target=messageMenuTarget;closeMessageMenu();window.chaweReactions.open(target);});
$('pin-selected-message').addEventListener('click',()=>{const target=messageMenuTarget;closeMessageMenu();if(target)Pins.toggle(target);});
$('close-chat-search').addEventListener('click',() => closeChatSearch(true));
$('chat-search-input').addEventListener('input',changeChatSearch);
$('chat-search-input').addEventListener('keydown',event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(chatSearch.timer); loadChatSearch(); }
});
$('chat-search-clear').addEventListener('click',() => { $('chat-search-input').value = ''; changeChatSearch(); $('chat-search-input').focus(); });
$('chat-search-more').addEventListener('click',() => loadChatSearch(true));
$('chat-search-retry').addEventListener('click',() => loadChatSearch());
$('chat-more-button').addEventListener('click',() => setChatMoreMenu(!isPopupOpen('chat-more-menu')));
$('close-profile').addEventListener('click',() => closeProfile());
matchMedia('(max-width:640px)').addEventListener('change',syncProfileAccess);
$('profile-contact').addEventListener('click',() => { if (active) openContactDialog(active); });
$('profile-remove').addEventListener('click',() => { if (active) openConfirm('remove',active); });
$('profile-delete-account').addEventListener('click',() => { if(activeProfile?.canDeleteAccount&&activeProfile.id&&!Groups.isGroup(active))openConfirm('deleteAccount',active); });
function confirmActiveBlock() { if (activeProfile) openConfirm(activeProfile.blockedByMe ? 'unblock' : 'block',active); }
$('profile-block').addEventListener('click',confirmActiveBlock);
$('banner-add').addEventListener('click',() => { if (active) openContactDialog(active); });
$('banner-block').addEventListener('click',confirmActiveBlock);
$('back').addEventListener('click',() => {
  if((window.chaweVoice.isBusy() || window.chaweArticles.isBusy())){showStatus('请先发送或取消当前录音。');return;}
  setAttachmentMenu(false);
  closeChatSearch(false,true);
  closeMessageMenu(true); cancelMessageEdit(true);
  window.chaweArticles.close(true);
  cancelChatOpening(); cancelSendFlights(); setChatMoreMenu(false); setEmojiMenu(false); closeProfile(true,false);
  workspace.classList.remove('chat-open');
});
window.addEventListener('resize',() => { cancelSendFlights(); closeMessageMenu(true); });
$('messages').addEventListener('wheel',cancelSendFlights,{passive:true});
$('messages').addEventListener('touchstart',cancelSendFlights,{passive:true});
$('message-input').addEventListener('input',() => { if (active && !editingMessage) drafts.set(active,$('message-input').value); resizeInput(); });
$('message-input').addEventListener('keydown',event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('composer').addEventListener('submit',async event => {
  event.preventDefault();
  if (window.chaweArticles.isOpen()) { await window.chaweArticles.send(); return; }
  if (editingMessage) { await submitMessageEdit(); return; }
  if (!active || !messageReady || activeProfile?.canMessage !== true || sending || switchingAccount || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy())) return;
  const text = $('message-input').value.trim(), peer = active;
  if (!text) { if(event.submitter===$('send-button'))await window.chaweVoice.start(); return; }
  sending = true; $('message-input').readOnly = true; resizeInput();
  try {
    const [data] = await Promise.all([
      post('/api/messages/send',{to:peer,text}),
      new Promise(resolve => setTimeout(resolve,motionDuration(240)))
    ]);
    messageCache.save(me,peer,[data.message]);
    drafts.set(peer,'');
    if (active === peer) {
      const source = $('message-input').getBoundingClientRect(), last = entries.at(-1)?.seq || 0;
      const isNew = !messageNodes.has(data.message.seq);
      const previous = isNew ? captureMessageLayout() : null;
      cancelSendFlights();
      $('message-input').value = ''; resizeInput(); resetStatus();
      $('message-input').readOnly = false;
      if (data.message.seq > last + 1) catchupAfter = Math.min(catchupAfter ?? last,last);
      mergeMessages([data.message]); renderMessages(true);
      cacheCurrentMessages();
      if (isNew) { animateMessageLayout(previous); animateSentMessage(data.message.seq,source); }
      $('message-input').focus();
    }
    loadChats();
  } catch (error) {
    if (active === peer) {
      if (error.message === 'blocked_by_you' || error.message === 'message_unavailable') loadActiveProfile();
      showStatus(errorText(error));
    }
  } finally {
    sending = false; $('message-input').readOnly = false; resizeInput();
    if (active === peer) $('message-input').focus();
    if (active === peer && catchupAfter !== null) pollNew();
  }
});
for (const emoji of ['😀','😊','🥰','😎','🤔','🥳','👍','❤️','🎉','✨','☕','👋']) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji; button.setAttribute('aria-label',emoji);
  button.addEventListener('click',() => {
    if (sending || switchingAccount) return;
    if (window.chaweArticles.isOpen()) { if (!window.chaweArticles.isBusy()) window.chaweArticles.insert(emoji); return; }
    const input = $('message-input'); input.setRangeText(emoji,input.selectionStart,input.selectionEnd,'end');
    if (!editingMessage) drafts.set(active,input.value); resizeInput(); input.focus();
  });
  $('emoji-picker').append(button);
}
$('emoji-button').addEventListener('click',() => {
  setEmojiMenu(!isPopupOpen('emoji-picker'));
});
$('attachment-button').addEventListener('click',() => setAttachmentMenu(!isPopupOpen('attachment-menu')));
for (const [id,mode] of [['attach-media','media'],['attach-file','file']]) {
  $(id).addEventListener('click',() => { setAttachmentMenu(false); window.chaweAttachments.openPicker(mode); });
}
$('attach-article').addEventListener('click',() => { setAttachmentMenu(false); window.chaweArticles.open(); });
$('attachment-menu').addEventListener('keydown',event => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault(); const buttons = [...$('attachment-menu').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
});
document.addEventListener('keydown',event => {
  if (event.key !== 'Escape' || activeModal) return;
  if (isPopupOpen('message-context-menu')) { event.preventDefault(); closeMessageMenu(); $('message-input').focus({preventScroll:true}); }
  else if (isPopupOpen('attachment-menu')) { event.preventDefault(); setAttachmentMenu(false,true); }
  else if (isPopupOpen('chat-more-menu')) { event.preventDefault(); setChatMoreMenu(false,true); }
  else if (isPopupOpen('compose-menu')) { event.preventDefault(); setComposeMenu(false,true); }
  else if (isPopupOpen('more-menu')) { event.preventDefault(); setMoreMenu(false,true); }
  else if (isPopupOpen('emoji-picker')) { event.preventDefault(); setEmojiMenu(false,true); }
  else if (openingPeer || failedOpenPeer) { event.preventDefault(); cancelChatOpening(); }
  else if (isPopupOpen('group-settings')) { event.preventDefault(); Groups.closeSettings(); }
  else if (isPopupOpen('user-profile')) { event.preventDefault(); closeProfile(); }
  else if (chatSearch.peer) { event.preventDefault(); closeChatSearch(true); }
  else if (editingMessage) { event.preventDefault(); cancelMessageEdit(); }
  else if (window.chaweArticles.isOpen()) { event.preventDefault(); window.chaweArticles.close(); }
  else if (searchActive) { event.preventDefault(); leaveSearch(); }
  else if (panel === 'settings' || panel === 'notifications' || panel === 'info') { event.preventDefault(); setPanel('chats'); $('more-button').focus({preventScroll:true}); }
});
$('messages').addEventListener('contextmenu',openMessageMenu);
$('messages').addEventListener('scroll',() => { if (isPopupOpen('message-context-menu')) closeMessageMenu(true); },{passive:true});
$('cancel-message-edit').addEventListener('click',() => { cancelMessageEdit(); $('message-input').focus({preventScroll:true}); });
$('edit-selected-message').addEventListener('click',() => { const target = messageMenuTarget; closeMessageMenu(); startMessageEdit(target); });
$('retract-selected-message').addEventListener('click',() => { const target = messageMenuTarget; closeMessageMenu(); performMessageAction('retract',target); });
$('favorite-selected-message').addEventListener('click',() => { const target = messageMenuTarget; closeMessageMenu(); performMessageAction('favorite',target); });
$('message-context-menu').addEventListener('keydown',event => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from($('message-context-menu').querySelectorAll('button:not([hidden]):not(:disabled)'));
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus({preventScroll:true});
});
document.addEventListener('visibilitychange',() => {
  if (document.hidden) { cancelSendFlights(); clearTimeout(reconnectTimer); }
  else if (connectionFailed) scheduleReconnect();
  else if (me) { loadContacts(); loadChats(); loadActiveProfile(); pollNew(); if (panel === 'blocks') loadBlocks(); }
  else boot();
});
window.addEventListener('offline',() => connectionLost(++apiSerial));
window.addEventListener('online',() => {
  connectionFailed = true; reconnectDelay = 250; updateConnectionHint(); scheduleReconnect();
});

// Decorative layers live outside refreshed lists and never intercept input.
const rippleEffects = (() => {
  const waves = new Set(), presses = new Map();
  const selectors = 'button,a[href],summary,input:not([type="hidden"]),textarea,[role="button"],.search-box,.composer';
  function surfaceOf(target) {
    if (!(target instanceof Element)) return null;
    let surface = target.closest(selectors);
    if (!surface || surface.matches(':disabled') || surface.closest('[inert],[hidden],[aria-disabled="true"]')) return null;
    if (surface.matches('input[type="checkbox"],input[type="radio"],input[type="range"]')) return null;
    if (surface.id === 'search' || surface.id === 'chat-search-input') surface = surface.closest('.search-box');
    else if (surface.id === 'message-input') surface = surface.closest('.composer');
    return surface;
  }
  function removeWave(record) {
    clearTimeout(record.timer); record.layer.remove(); waves.delete(record);
  }
  function cancelPress(id) {
    const press = presses.get(id); if (!press) return;
    clearTimeout(press.timer); if (press.wave) removeWave(press.wave); presses.delete(id);
  }
  function clearWaves() {
    for (const id of presses.keys()) cancelPress(id);
    for (const record of waves) removeWave(record);
  }
  function clearWithin(root) {
    for (const [id,press] of presses) if (root.contains(press.surface)) cancelPress(id);
    for (const record of waves) if (root.contains(record.surface) || root.contains(record.layer)) removeWave(record);
  }
  function showWave(surface, clientX, clientY) {
    if (!motionEnabled() || !uiSettings.ripples || document.hidden || !surface.isConnected || !surface.getClientRects().length) return null;
    const host = surface.closest('.action-dialog,.popup-menu,.more-menu,.emoji-picker,.composer,.sidebar,.user-profile,.conversation') || surface.parentElement;
    if (getComputedStyle(host).position === 'static') host.classList.add('ripple-anchor');
    const bounds = surface.getBoundingClientRect(), base = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !base.width || !base.height) return null;
    const scaleX = base.width / host.offsetWidth, scaleY = base.height / host.offsetHeight;
    const ancestors = [], clip = {left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom};
    for (let node = surface.parentElement; node; node = node.parentElement) {
      ancestors.push(node);
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left,box.left); clip.right = Math.min(clip.right,box.right); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top,box.top); clip.bottom = Math.min(clip.bottom,box.bottom); }
    }
    const width = (clip.right - clip.left) / scaleX, height = (clip.bottom - clip.top) / scaleY;
    if (width <= 0 || height <= 0) return null;
    const circular = surface.id === 'attachment-button' || surface.id === 'emoji-button' || surface.classList.contains('video-center-play') || surface.classList.contains('voice-circle');
    const x = circular ? width / 2 : Math.max(0,Math.min(width,(clientX - clip.left) / scaleX));
    const y = circular ? height / 2 : Math.max(0,Math.min(height,(clientY - clip.top) / scaleY));
    const size = circular ? Math.max(width,height) : 2 * Math.hypot(Math.max(x,width - x),Math.max(y,height - y));
    const style = getComputedStyle(surface), rgb = style.color.match(/[\d.]+/g) || [];
    const lightText = rgb.length >= 3 && .2126 * Number(rgb[0]) + .7152 * Number(rgb[1]) + .0722 * Number(rgb[2]) > 200;
    const layer = document.createElement('span'), wave = document.createElement('span');
    layer.className = 'click-ripple-layer'; layer.setAttribute('aria-hidden','true'); wave.className = 'click-ripple-wave';
    Object.assign(layer.style,{
      left:((clip.left - base.left) / scaleX - host.clientLeft + host.scrollLeft) + 'px',
      top:((clip.top - base.top) / scaleY - host.clientTop + host.scrollTop) + 'px',
      width:width + 'px',height:height + 'px',borderRadius:style.borderRadius
    });
    layer.style.setProperty('--ripple-color',lightText ? '#fff' : '#3390ec');
    Object.assign(wave.style,{width:size + 'px',height:size + 'px',left:(x - size / 2) + 'px',top:(y - size / 2) + 'px'});
    layer.append(wave); host.append(layer);
    if (waves.size >= 6) removeWave(waves.values().next().value);
    const record = {surface,layer,ancestors,timer:null}; waves.add(record);
    record.timer = setTimeout(() => removeWave(record),motionDuration(1000) + 50);
    return record;
  }
  document.addEventListener('pointerdown',event => {
    if (event.button !== 0 || !event.isPrimary || !motionEnabled() || !uiSettings.ripples) return;
    const surface = surfaceOf(event.target); if (!surface) return;
    cancelPress(event.pointerId);
    const press = {surface,x:event.clientX,y:event.clientY,wave:null,timer:null};
    presses.set(event.pointerId,press);
    const start = () => { press.timer = null; press.wave = showWave(surface,press.x,press.y); };
    if (event.pointerType === 'touch') press.timer = setTimeout(start,80);
    else start();
  },{capture:true,passive:true});
  document.addEventListener('pointermove',event => {
    const press = presses.get(event.pointerId);
    if (press && Math.hypot(event.clientX - press.x,event.clientY - press.y) > 10) cancelPress(event.pointerId);
  },{capture:true,passive:true});
  document.addEventListener('pointerup',event => {
    const press = presses.get(event.pointerId); if (!press) return;
    if (press.timer !== null) { clearTimeout(press.timer); showWave(press.surface,press.x,press.y); }
    presses.delete(event.pointerId);
  },{capture:true,passive:true});
  document.addEventListener('pointercancel',event => cancelPress(event.pointerId),{capture:true,passive:true});
  document.addEventListener('click',event => {
    if (event.detail !== 0 || event.pointerType) return;
    const surface = surfaceOf(event.target); if (!surface || !surface.matches('button,a[href],summary,[role="button"]')) return;
    const box = surface.getBoundingClientRect(); showWave(surface,box.left + box.width / 2,box.top + box.height / 2);
  },{capture:true,passive:true});
  document.addEventListener('scroll',event => {
    for (const record of waves) if (record.ancestors.includes(event.target)) removeWave(record);
    for (const [id,press] of presses) if (event.target instanceof Element && event.target.contains(press.surface)) cancelPress(id);
  },{capture:true,passive:true});
  window.addEventListener('resize',clearWaves,{passive:true});
  document.addEventListener('visibilitychange',() => { if (document.hidden) clearWaves(); });
  document.addEventListener('chawe-ui-settings-change',clearWaves);
  return {clearWithin};
})();

async function boot() {
  if (booting || me) return;
  booting = true;
  try {
    const data = await api('/api/me'); me = data.username; meIdentity = data.id; directoryVersion = data.directoryVersion;
    ownProfile = {...data,nickname:data.nickname || ''}; rememberPeople([data]); document.title = me + ' · chawe';
    Groups.init({api,post,errorText,openModal,closeModal,motionDuration,setPopup,showStatus,avatar,title:titleOf,rememberPeople,loadContacts:()=>loadContacts(true),changed:resizeInput,closeProfile:()=>closeProfile(true,false),profileAccess:syncProfileAccess,
      me:()=>({...ownProfile,username:me,id:meIdentity}),myName:()=>userName(me),contacts:()=>Array.from(contactDetails.values()),account:()=>me,active:()=>active,panel:()=>panel,setPanel,header:()=>Groups.header(active),openChat:peer=>openChat(peer,true),
      filterAppearance:on=>{document.querySelector('.sidebar').classList.toggle('search-active',on);$('more-button').classList.toggle('is-back',on);$('more-button').setAttribute('aria-label',on?'退出筛选':'更多');},
      isBusy:()=>sending || switchingAccount || Groups.isBusy() || window.chaweVoice.isBusy() || window.chaweArticles.isBusy() || window.chaweAttachments.isBusy(),
      refresh:async()=>{await Promise.all([loadChats(),loadActiveProfile()]);},closeMenus:()=>{setChatMoreMenu(false);setComposeMenu(false);setMoreMenu(false);setAttachmentMenu(false);setEmojiMenu(false);closeMessageMenu();},
      applyMessages:messages=>{applyMessageChanges(messages);cacheCurrentMessages();},
      applyStates:states=>{const known=new Map(entries.map(m=>[m.seq,m]));applyMessageChanges(states.filter(s=>known.has(s.seq)).map(s=>({...known.get(s.seq),...s})));cacheCurrentMessages();},
      changeTopic:async peer=>{messageReady=false;renderedPeer=null;cancelMessageEdit(true);await openChat(peer);},
      leave:peer=>{if(active===peer){cancelChatOpening();++messageRequest;active=null;activeProfile=null;entries=[];messageReady=false;messageNodes.clear();renderedPeer=null;$('messages').replaceChildren();$('chat-view').hidden=true;$('empty-selection').hidden=false;workspace.classList.remove('chat-open');Pins.activate(null);}}
    });
    Pins.init({api,post,errorText,showStatus,openModal,closeModal,motionDuration,groups:Groups,accountId:()=>meIdentity,peer:()=>active,entries:()=>entries,nodes:()=>messageNodes,epoch:()=>messageRequest,ready:()=>messageReady,jump:locatePinnedMessage});
    window.chaweReactions.init({api,post,errorText,showStatus,motionDuration,groups:Groups,nodes:()=>messageNodes,message:seq=>entries.find(message=>message.seq===seq),
      getState:()=>({peer:active,accountId:meIdentity,epoch:messageRequest,topic:Groups.topicOf(active),ready:messageReady && !switchingAccount && !activeModal && !openingPeer && !editingMessage && (Groups.isGroup(active)?!!Groups.of(active)?.joined:activeProfile?.canMessage===true)}),
      applyMessages:messages=>{applyMessageChanges(messages);cacheCurrentMessages();},
      applyStates:states=>{const known=new Map(entries.map(message=>[message.seq,message]));applyMessageChanges(states.filter(state=>known.has(state.seq)).map(state=>({...known.get(state.seq),...state})));cacheCurrentMessages();}});
    history.replaceState(null,'','/app?account=' + encodeURIComponent(me) + '&accountId=' + meIdentity); renderAccounts();
    window.chaweArticles.init({post,errorText,openModal,closeModal,showStatus,motionDuration,changed:resizeInput,
      getState:() => ({peer:active,peerId:saved(active)?meIdentity:activeProfile?.id,accountId:meIdentity,topic:Groups.topicOf(active),
        canSend:messageReady && activeProfile?.canMessage === true && (!Groups.isGroup(active)||Groups.can(Groups.of(active),'articles')) && !sending && !switchingAccount
          && (!editingMessage || editingMessage.article) && !window.chaweVoice.isBusy() && !window.chaweAttachments.isBusy()}),
      cancelEdit:() => cancelMessageEdit(),editEnded:edit => { if (editingMessage === edit) cancelMessageEdit(true); },
      sync:() => syncMessageChanges().catch(() => {}),
      complete:(peer,message,source,edited,close) => {
        const previous=captureMessageLayout(),isNew=!messageNodes.has(message.seq),last=entries.at(-1)?.seq || 0;
        close(); messageCache.save(me,peer,[message]);
        if (peer === active) {
          if (edited) applyMessageChanges([message]);
          else { if (message.seq > last+1) catchupAfter=Math.min(catchupAfter ?? last,last); mergeMessages([message]); }
          renderMessages(!edited); cacheCurrentMessages(); animateMessageLayout(previous);
          if (!edited && isNew) animateSentMessage(message.seq,source);
        }
        loadChats();
      }});
    window.chaweAttachments.init({api,post,icon,errorText,openModal,closeModal,showStatus,motionDuration,
      closeMenus:()=>{setAttachmentMenu(false);setEmojiMenu(false);closeMessageMenu();},
      canAttach:kind=>!Groups.isGroup(active)||Groups.can(Groups.of(active),({image:'photos',video:'videos',file:'files'})[kind]),
      getState:() => ({peer:active,peerId:saved(active)?meIdentity:activeProfile?.id,account:me,accountId:meIdentity,
        canSend:messageReady && activeProfile?.canMessage === true && !sending && !switchingAccount && !editingMessage && !window.chaweArticles.isOpen() && !(window.chaweVoice.isBusy() || window.chaweArticles.isBusy())}),
      headers:() => ({'X-Chawe-Account':me,'X-Chawe-Identity':meIdentity,'X-Chawe-Directory-Version':String(directoryVersion)}),
      peerId:peer => peer === me ? meIdentity : peerProfiles.get(peer)?.id || (peer === active ? activeProfile?.id : ''),
      stateChanged:resizeInput,
      createBubble:text => messageNode({seq:0,time:Date.now(),sender:me,text}),
      rerender:(peer,forceBottom=false) => { if (peer !== active) return; const before=captureMessageLayout(),log=$('messages');
        const bottom=forceBottom || log.scrollHeight-log.scrollTop-log.clientHeight<100; renderMessages(bottom); animateMessageLayout(before); },
      registerFlight:cancel => { sendFlights.add(cancel); return () => { sendFlights.delete(cancel); resumeAfterSendMotion(); }; },
      complete:(peer,messages,remarkSeq) => { messageCache.save(me,peer,messages); if (peer === active) {
        const isNewRemark=remarkSeq && !messageNodes.has(remarkSeq),source=$('message-input').getBoundingClientRect();
        const before=captureMessageLayout(),log=$('messages'),bottom=log.scrollHeight-log.scrollTop-log.clientHeight<100;
        mergeMessages(messages); renderMessages(bottom); animateMessageLayout(before); cacheCurrentMessages();
        if(isNewRemark && bottom)animateSentMessage(remarkSeq,source); }
        loadChats(); },connectionLost:() => connectionLost(++apiSerial),connectionRestored:() => connectionRestored(++apiSerial)});
    window.chaweVoice.init({api,post,errorText,openModal,closeModal,showStatus,motionDuration,changed:resizeInput,
      getState:()=>({peer:active,peerId:saved(active)?meIdentity:activeProfile?.id,account:me,accountId:meIdentity,
        canSend:messageReady && activeProfile?.canMessage===true && (!Groups.isGroup(active)||Groups.can(Groups.of(active),'voice')) && !sending && !switchingAccount && !editingMessage && !window.chaweArticles.isOpen() && !window.chaweAttachments.isBusy()}),
      headers:()=>({'X-Chawe-Account':me,'X-Chawe-Identity':meIdentity,'X-Chawe-Directory-Version':String(directoryVersion)}),
      peerId:peer=>peer===me?meIdentity:peerProfiles.get(peer)?.id||(peer===active?activeProfile?.id:''),
      urlOf:(a,message,peer)=>window.chaweAttachments.urlOf(a,message,peer),pauseMedia:()=>window.chaweAttachments.pausePlayers(),
      closeMenus:()=>{setAttachmentMenu(false);setEmojiMenu(false);setMoreMenu(false);setComposeMenu(false);setChatMoreMenu(false);closeMessageMenu();},
      complete:(peer,message,source)=>{messageCache.save(me,peer,[message]);if(peer===active){const isNew=!messageNodes.has(message.seq),previous=captureMessageLayout(),last=entries.at(-1)?.seq||0;
        if(message.seq>last+1)catchupAfter=Math.min(catchupAfter??last,last);mergeMessages([message]);renderMessages(true);cacheCurrentMessages();
        if(isNew){animateMessageLayout(previous);animateSentMessage(message.seq,source);}}loadChats();}});
    await loadAccounts(); await Promise.all([loadContacts(),loadChats()]);
    if(inviteToken){try{sessionStorage.removeItem('chawe-group-invite');}catch{}await Groups.handleInvite(inviteToken);}
    window.chaweNotifications.init({id:meIdentity,api,post,errorText,openModal,closeModal,
      hasModal:() => !!activeModal,isBusy:() => switchingAccount || ownInfoSaving || avatarBusy || window.chaweAttachments.isBusy() || (window.chaweVoice.isBusy() || window.chaweArticles.isBusy()) || sending,
      refresh:() => { loadChats(); pollNew(); }});
    if (/^[a-f0-9]{32}$/.test(restorePeerId)) { try { const peer = await api('/api/profile?peerId=' + restorePeerId); await openChat(peer.username); } catch {} }
    $('empty-selection').firstElementChild.textContent = '选择一个聊天，开始交流';
  } catch {
    $('empty-selection').firstElementChild.textContent = '连接中，网络恢复后会自动重试';
    scheduleReconnect();
  } finally { booting = false; }
}
applyUiSettings(); updateConnectionHint(); boot();
window.chaweTyping.init({getState:()=>({peer:active,account:me,accountId:meIdentity,directoryVersion,group:Groups.isGroup(active),topic:Groups.topicOf(active),
  ready:!!active && !!me && messageReady && activeProfile?.canMessage===true && !switchingAccount && !reloadingDirectory,
  canType:messageReady && activeProfile?.canMessage===true && !switchingAccount && !sending && !document.getElementById('message-input').disabled && !document.getElementById('message-input').readOnly
    && !window.chaweArticles.isOpen() && !window.chaweVoice.isBusy() && (!Groups.isGroup(active)||Groups.can(Groups.of(active),'text'))})});
setInterval(() => {
  if (!document.hidden && me && !connectionFailed && !switchingAccount && !reloadingDirectory) { if (!listQuery) loadChats(); loadActiveProfile(); pollNew(); Pins.refresh(); window.chaweReactions.poll(); }
},4000);
setInterval(() => {
  if (!document.hidden && me && !connectionFailed && !switchingAccount && !reloadingDirectory) { loadContacts(); if (listQuery) loadChats(); if (panel === 'blocks') loadBlocks(); }
},8000);
