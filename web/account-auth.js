'use strict';
const incomingInvite=new URLSearchParams(location.search).get('invite');if(/^[a-f0-9]{32}$/.test(incomingInvite || '')){try{sessionStorage.setItem('chawe-group-invite',incomingInvite);}catch{}}
// Hash browser/device signals locally; send neither raw attributes nor rendered images.
let chaweFingerprintPromise;
window.chaweDeviceFingerprint = () => chaweFingerprintPromise ||= (async () => {
  const agent = navigator.userAgent;
  const family = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox'
    : /OPR\//.test(agent) ? 'Opera' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Other';
  let rendering = '', renderer = '';
  try {
    const canvas = document.createElement('canvas'); canvas.width = 260; canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#3390ec'; context.fillRect(4,4,240,52);
      context.font = '17px Arial'; context.fillStyle = '#fff';
      context.fillText('Chawe · Aa09 聊天 ☀',12,34); rendering = canvas.toDataURL();
    }
  } catch {}
  try {
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl');
    if (gl) {
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {}
  let timezone = ''; try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const signals = JSON.stringify(['chawe-device-v1',family,navigator.userAgentData?.platform || navigator.platform,
    navigator.hardwareConcurrency || 0,navigator.deviceMemory || 0,navigator.maxTouchPoints || 0,
    Math.min(screen.width,screen.height),Math.max(screen.width,screen.height),screen.colorDepth,
    devicePixelRatio,navigator.language,timezone,renderer,rendering]);
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signals));
  return Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,'0')).join('');
})();
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('add-account') !== '1') return;
  const user = params.get('return-account');
  const destination = /^[A-Za-z0-9_]{3,20}$/.test(user || '') ? '/app?account=' + encodeURIComponent(user) : '/app';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'account-auth-back';
  button.setAttribute('aria-label','返回聊天'); button.title = '返回聊天';
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 4-8 8 8 8M4 12h16"/></svg>';
  let fromChat = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem('chawe_add_account_return') || 'null');
    fromChat = saved?.account === user && Date.now() - saved.time < 30 * 60 * 1000 && history.length > 1;
  } catch {}
  const clearReturn = () => { try { sessionStorage.removeItem('chawe_add_account_return'); } catch {} };
  button.addEventListener('click',() => { clearReturn(); if (fromChat) history.back(); else location.assign(destination); });
  window.addEventListener('pagehide',clearReturn,{once:true});
  document.body.append(button);
})();
