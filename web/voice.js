'use strict';
window.chaweVoice = (() => {
  const $=id=>document.getElementById(id), players=new Set(), consumed=new Set();
  let ctx, recording=null, epoch=0, oncePlayback=null, stateTimer, stateBusy=false;
  const resizer=window.ResizeObserver?new ResizeObserver(items=>{for(const item of items){const p=[...players].find(p=>p.frame===item.target);p?.sync();}}):{observe(){},unobserve(){}};
  const icon=name=>'<svg aria-hidden="true"><use href="#i-'+name+'"/></svg>';
  const clock=n=>{n=Math.max(0,Math.floor(n||0));return (n>=3600?Math.floor(n/3600)+':':'')+String(Math.floor(n/60)%60).padStart(n>=3600?2:1,'0')+':'+String(n%60).padStart(2,'0');};
  const uid=()=>crypto.randomUUID().replace(/-/g,'');
  const elapsed=r=>r.elapsed+(r.phase==='recording'?performance.now()-r.started:0);
  const copyError=e=>({NotAllowedError:'麦克风或音频播放权限被拒绝，请检查网站设置。',NotFoundError:'没有找到可用的麦克风。',NotReadableError:'麦克风被其他程序占用，或无法读取。',AbortError:'连接已中断，请检查网络。'})[e.name]||({voice_consumed:'这条一次性语音已经播放过了。',voice_once_only:'一次性语音只能由接收方播放一次。',invalid_voice_format:'录音格式无法识别，请重新录制。',voice_not_found:'语音不存在或已经删除。',voice_processing_failed:'语音索引处理暂未完成，请重试发送。',unsupported_voice:'这个浏览器没有支持的录音格式。',recording_failed:'浏览器录音中断，请重试或发送已录制的部分。'})[e.message]||ctx.errorText(e);
  function normalize(a) {
    if(!a || !['voice','voice-once'].includes(a.kind) || !/^[a-f0-9]{32}$/.test(a.id) || !['audio/webm','audio/ogg','audio/mp4'].includes(a.type)
        || !Number.isSafeInteger(a.size)||a.size<1||!Number.isFinite(a.duration)||a.duration<=0 || !Array.isArray(a.waveform)||a.waveform.length<8||a.waveform.length>128
        || !a.waveform.every(n=>Number.isInteger(n)&&n>=0&&n<=100))return null;
    return {id:a.id,name:'语音消息',type:a.type,size:a.size,kind:a.kind,duration:a.duration,waveform:a.waveform,once:a.kind==='voice-once',consumed:!!a.consumed||consumed.has(a.id)};
  }
  function bars(canvas,values,progress=0,burning=false,particles=[]) {
    const dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);
    const n=Math.max(8,Math.min(values.length,Math.floor(w/5))),gap=w/n,style=getComputedStyle(canvas);
    const base=style.getPropertyValue('--voice-wave').trim()||'#7293ad',played=style.getPropertyValue('--voice-played').trim()||'#0067d8';
    for(let i=0;i<n;i++){
      if(burning && i/n<progress)continue;
      const start=Math.floor(i*values.length/n),end=Math.max(start+1,Math.floor((i+1)*values.length/n));
      let value=0;for(let j=start;j<end;j++)value=Math.max(value,values[j]||0);
      const height=Math.max(4,(h-8)*value/100);c.fillStyle=i/n<progress?played:base;
      c.beginPath();c.roundRect(i*gap+gap*.22,(h-height)/2,Math.max(2,gap*.48),height,2);c.fill();
    }
    for(const p of particles){c.globalAlpha=Math.max(0,p.life);c.fillStyle=p.color;c.beginPath();c.arc(p.x*w,p.y*h,p.size,0,Math.PI*2);c.fill();}c.globalAlpha=1;
  }
  function pulse(node) {
    if(!ctx.motionDuration(180))return;
    node.animate([{transform:'scale(.85)'},{transform:'scale(1.07)'},{transform:'scale(1)'}],{duration:ctx.motionDuration(220),easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  function setRecordUI() {
    const r=recording;if(!r)return;
    const live=r.phase==='recording',sending=r.phase==='sending'||r.phase==='cancelling'||r.preparing||r.cancelIntent,waiting=r.phase==='requesting';
    $('voice-recorder').classList.toggle('is-recording',live);$('voice-recorder').classList.toggle('is-uploading',sending);
    $('voice-pause').innerHTML=icon(live?'pause':'mic');$('voice-pause').setAttribute('aria-label',live?'暂停录音':'继续录音');$('voice-pause').disabled=sending||waiting||r.transitioning||r.recorder?.state==='inactive'||!!r.id;
    $('voice-once').hidden=false;$('voice-once').classList.toggle('is-selected',r.once);$('voice-once').setAttribute('aria-pressed',String(r.once));$('voice-once').disabled=sending||!!r.id;
    $('voice-once').title=/^group:/.test(r.peer)?'一次性语音 · 每位接收成员各听一次':'一次性语音 · 接收方只能听一次';
    $('voice-preview').hidden=live||waiting; $('voice-preview').disabled=sending||!r.blob;
    $('voice-preview').innerHTML=icon(r.preview&&!r.preview.paused?'pause':'play');
    $('voice-send').disabled=sending||waiting||r.transitioning||elapsed(r)<150;
    $('voice-send').innerHTML=sending?'<span class="composer-spinner"></span>':icon('send');
    $('voice-record-hint').textContent=waiting?'正在申请麦克风权限…':r.cancelIntent?r.error||'正在取消发送…':r.preparing?'正在准备录音…':sending?'正在发送 '+Math.round(r.progress||0)+'%':live?r.once?'录音中 · 一次性语音':'录音中':r.once?/^group:/.test(r.peer)?'一次性语音 · 每位接收成员各听一次':'一次性语音 · 仅接收方可播放一次':'已暂停 · 可试听或继续录音';
    if(r.error && !sending && !waiting)$('voice-record-hint').textContent=r.error;
    ctx.changed();
  }
  function waveOf(r) {
    const source=r.peaks.length?r.peaks:[3];const result=[];
    for(let i=0;i<80;i++){const from=Math.floor(i*source.length/80),to=Math.max(from+1,Math.floor((i+1)*source.length/80));let max=0;for(let j=from;j<to;j++)max=Math.max(max,source[j]||0);result.push(Math.max(2,Math.min(100,Math.round(max))));}return result;
  }
  function recordFrame(r) {
    if(recording!==r)return;
    if(r.phase==='recording'){
      const bytes=new Uint8Array(r.analyser.fftSize);r.analyser.getByteTimeDomainData(bytes);let power=0;for(const b of bytes)power+=((b-128)/128)**2;
      r.peak=Math.max(r.peak,Math.min(100,Math.sqrt(power/bytes.length)*240));
      if(elapsed(r)>=r.nextPeak){r.peaks.push(Math.max(2,r.peak));r.peak=0;r.nextPeak=elapsed(r)+r.interval;
        if(r.peaks.length>=4096){const next=[];for(let i=0;i<r.peaks.length;i+=2)next.push(Math.max(r.peaks[i],r.peaks[i+1]||0));r.peaks=next;r.interval*=2;}}
    }
    const seconds=elapsed(r)/1000,preview=r.phase==='paused'&&r.preview?r.preview.currentTime:0;
    $('voice-clock').textContent=r.preview&&!r.preview.paused?clock(preview)+' / '+clock(seconds):clock(seconds)+','+String(Math.floor(elapsed(r)%1000/10)).padStart(2,'0');
    bars($('voice-record-wave'),waveOf(r),seconds?preview/seconds:0);
    r.raf=requestAnimationFrame(()=>recordFrame(r));
  }
  async function start() {
    if(!ctx||recording||oncePlayback||!ctx.getState().canSend)return;
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){ctx.showStatus('这个浏览器暂不支持麦克风录音，请使用支持录音的浏览器。');return;}
    const state=ctx.getState(),r={epoch:++epoch,peer:state.peer,peerId:state.peerId,accountId:state.accountId,phase:'requesting',elapsed:0,started:0,peaks:[],peak:0,nextPeak:0,interval:80,chunks:[],once:false,progress:0};
    recording=r;ctx.closeMenus();$('voice-recorder').closest('.composer-area').classList.add('is-voice-recording');$('voice-recorder').hidden=false;setRecordUI();
    if(ctx.motionDuration(200))$('voice-recorder').animate([{opacity:0,transform:'translateY(12px) scale(.97)'},{opacity:1,transform:'none'}],{duration:ctx.motionDuration(250),easing:'cubic-bezier(.2,.8,.2,1)'});
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(recording!==r||r.cancelIntent){stream.getTracks().forEach(t=>t.stop());return;}r.stream=stream;
      const type=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
      if(!type)throw Error('unsupported_voice');
      r.recorder=new MediaRecorder(stream,{mimeType:type,audioBitsPerSecond:32000});r.type=r.recorder.mimeType.split(';')[0];
      const Audio=window.AudioContext||window.webkitAudioContext;r.context=new Audio();await r.context.resume();
      if(recording!==r||r.cancelIntent){r.context.close();stream.getTracks().forEach(t=>t.stop());return;}
      r.source=r.context.createMediaStreamSource(stream);r.analyser=r.context.createAnalyser();r.analyser.fftSize=512;r.source.connect(r.analyser);
      r.recorder.addEventListener('dataavailable',event=>{if(event.data.size)r.chunks.push(event.data);});
      r.recorder.addEventListener('error',event=>{r.elapsed=elapsed(r);r.error=copyError(event.error||Error('recording_failed'));r.phase='paused';r.stream.getTracks().forEach(t=>t.stop());setRecordUI();});
      for(const track of stream.getAudioTracks())track.addEventListener('ended',()=>{if(recording===r&&r.phase==='recording'){pause().catch(()=>{});r.error='麦克风连接已中断，现有录音仍可发送。';setRecordUI();}});
      r.phase='recording';r.started=performance.now();r.recorder.start(500);recordFrame(r);setRecordUI();
    }catch(error){if(recording===r){ctx.showStatus(copyError(error));cleanup(r);}}
  }
  function eventOnce(target,name,action) {
    return new Promise((resolve,reject)=>{let timer;const done=()=>{clearTimeout(timer);resolve();};target.addEventListener(name,done,{once:true});
      try{action();timer=setTimeout(()=>{target.removeEventListener(name,done);reject(Error('recording_failed'));},5000);}catch(error){target.removeEventListener(name,done);reject(error);}});
  }
  async function pause() {
    const r=recording;if(!r||r.phase!=='recording')return;
    r.elapsed=elapsed(r);r.phase='paused';r.transitioning=true;setRecordUI();
    try{
      await eventOnce(r.recorder,'pause',()=>r.recorder.pause());if(recording!==r||r.cancelIntent)return;
      r.stream.getAudioTracks().forEach(t=>t.enabled=false);
      await eventOnce(r.recorder,'dataavailable',()=>r.recorder.requestData());
      if(recording!==r||r.cancelIntent)return;makePreview(r);
    }finally{r.transitioning=false;if(recording===r)setRecordUI();}
  }
  function makePreview(r) {
    if(r.preview){r.preview.pause();r.preview.removeAttribute('src');}if(r.url)URL.revokeObjectURL(r.url);
    r.blob=new Blob(r.chunks,{type:r.type});r.url=URL.createObjectURL(r.blob);r.preview=new Audio(r.url);r.preview.preload='auto';
    r.preview.addEventListener('ended',setRecordUI);r.preview.addEventListener('pause',setRecordUI);r.preview.addEventListener('play',setRecordUI);
  }
  async function togglePause() {
    const r=recording;if(!r||r.transitioning||r.preparing||r.cancelIntent||['sending','requesting','cancelling'].includes(r.phase))return;pulse($('voice-pause'));
    try{if(r.phase==='recording')await pause();else{if(r.id){ctx.showStatus('这条语音已经开始上传，请发送或取消后重新录音。');return;}r.preview?.pause();r.error='';r.stream.getAudioTracks().forEach(t=>t.enabled=true);
      r.transitioning=true;setRecordUI();await r.context.resume();if(recording!==r||r.cancelIntent)return;r.recorder.resume();r.phase='recording';r.started=performance.now();}}
    catch(error){r.error=copyError(error);r.phase='paused';}
    finally{r.transitioning=false;if(recording===r)setRecordUI();}
  }
  async function preview() {
    const r=recording;if(!r?.preview||r.phase!=='paused')return;pulse($('voice-preview'));
    try{if(r.preview.paused){pauseAll();ctx.pauseMedia();await r.preview.play();}else r.preview.pause();setRecordUI();}catch(error){r.error='暂时无法试听这条录音。';setRecordUI();}
  }
  function cleanup(r) {
    if(recording!==r)return;recording=null;++epoch;cancelAnimationFrame(r.raf);r.preview?.pause();if(r.url)URL.revokeObjectURL(r.url);
    r.stream?.getTracks().forEach(t=>t.stop());if(r.recorder?.state!=='inactive')try{r.recorder?.stop();}catch{}r.source?.disconnect();r.context?.close().catch(()=>{});
    $('voice-recorder').hidden=true;$('voice-recorder').closest('.composer-area').classList.remove('is-voice-recording');ctx.changed();
  }
  async function cancel() {
    const r=recording;if(!r)return;pulse($('voice-cancel'));r.elapsed=elapsed(r);r.cancelIntent=true;r.phase='cancelling';setRecordUI();r.controller?.abort();r.stream?.getTracks().forEach(t=>t.stop());
    if(r.id){r.phase='cancelling';setRecordUI();try{const data=await ctx.post('/api/voice/cancel',{id:r.id});if(data.message){ctx.complete(r.peer,data.message,$('voice-recorder').getBoundingClientRect());ctx.showStatus('语音已经发送，未能取消。');}}
      catch(error){r.phase='paused';r.error='取消结果尚未确认，请再次点击取消。';setRecordUI();return;}}
    if(ctx.motionDuration(180))await $('voice-recorder').animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(12px) scale(.94)'}],{duration:ctx.motionDuration(200),easing:'ease-out'}).finished.catch(()=>{});
    cleanup(r);
  }
  async function send() {
    const r=recording;if(!r||r.transitioning||r.preparing||r.cancelIntent||['sending','requesting','cancelling'].includes(r.phase))return;pulse($('voice-send'));r.preparing=true;setRecordUI();
    try{
      if(r.phase==='recording')await pause();if(recording!==r||r.cancelIntent)return;
      if(r.recorder.state!=='inactive')await eventOnce(r.recorder,'stop',()=>r.recorder.stop());
      if(recording!==r||r.cancelIntent)return;
      r.stream.getTracks().forEach(t=>t.stop());makePreview(r);r.preview.pause();
      if(!r.blob.size||r.elapsed<150)throw Error('invalid_voice');
      r.phase='sending';r.preparing=false;r.error='';r.id ||= uid();r.controller=new AbortController();setRecordUI();
      const data=await ctx.post('/api/voice/create',{id:r.id,peerId:r.peerId,type:r.type,size:r.blob.size,duration:Math.round(r.elapsed),waveform:waveOf(r).join(','),once:r.once});
      if(recording!==r||r.phase!=='sending')return;
      let current=await ctx.api('/api/voice/status?id='+r.id,{signal:r.controller.signal});
      if(current.state==='cancelled'){r.id=null;r.phase='paused';throw Error('upload_closed');}
      while(!current.message&&current.offset<r.blob.size){const end=Math.min(current.offset+(data.chunkSize||524288),r.blob.size),body=await r.blob.slice(current.offset,end).arrayBuffer();
        current=await ctx.api('/api/voice/chunk?'+new URLSearchParams({id:r.id,offset:String(current.offset)}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body,signal:r.controller.signal});
        if(recording!==r||r.phase!=='sending')return;r.progress=current.offset/r.blob.size*100;setRecordUI();}
      if(!current.message)current=await ctx.post('/api/voice/send',{id:r.id});
      if(recording!==r||r.phase==='cancelling')return;
      if(!current.message)throw Error('request_failed');
      const source=$('voice-recorder').getBoundingClientRect();ctx.complete(r.peer,current.message,source);cleanup(r);
    }catch(error){if(recording!==r||r.cancelIntent)return;r.preparing=false;r.phase='paused';r.error=copyError(error);setRecordUI();}
  }
  function pauseAll(except=null){for(const p of players)if(p!==except)p.audio.pause();}
  function dispose(root){for(const p of Array.from(players))if(root.contains(p.frame)){resizer.unobserve(p.frame);players.delete(p);p.audio.pause();cancelAnimationFrame(p.raf);p.audio.removeAttribute('src');p.audio.load();}}
  function markConsumed(id){consumed.add(id);for(const p of players)if(p.a.id===id){p.a.consumed=true;p.audio.pause();p.sync();}}
  function renderMessage(bubble,message,peer) {
    const a=normalize(message.attachment),old=bubble.querySelector(':scope > .message-attachment'),stamp=bubble.querySelector('.bubble-meta');
    if(!a)return;
    if(old?.dataset.attachment===a.id){const p=[...players].find(p=>p.frame===old);if(p){p.a.consumed ||= a.consumed;p.sync();}return;}
    if(old){if(stamp&&old.contains(stamp))bubble.append(stamp);dispose(old);old.remove();}
    const frame=document.createElement('div');frame.className='message-attachment voice-message';frame.dataset.attachment=a.id;frame.dataset.voiceId=a.id;
    const play=document.createElement('button');play.type='button';play.className='voice-play voice-circle';
    play.innerHTML='<span class="voice-control-icon voice-control-play">'+icon('play')+'</span><span class="voice-control-icon voice-control-pause" hidden>'+icon('pause')+'</span><span class="voice-loading-spinner" aria-hidden="true" hidden></span>';
    const playIcon=play.querySelector('.voice-control-play'),pauseIcon=play.querySelector('.voice-control-pause'),spinner=play.querySelector('.voice-loading-spinner');
    const copy=document.createElement('div');copy.className='voice-message-copy';
    const wave=document.createElement('canvas');wave.className='voice-wave';wave.setAttribute('role','slider');wave.tabIndex=a.once?-1:0;wave.setAttribute('aria-label','语音播放进度');wave.setAttribute('aria-valuemin','0');wave.setAttribute('aria-valuemax',String(a.duration));
    const label=document.createElement('span');label.className='voice-message-duration';label.textContent=clock(a.duration);copy.append(wave,label);
    const expiredLabel=document.createElement('span');expiredLabel.className='voice-expired-label';expiredLabel.textContent='Expired voice message';expiredLabel.hidden=true;frame.append(play,copy,expiredLabel);if(stamp)frame.append(stamp);
    const audio=new Audio();audio.preload='none';audio.controls=false;audio.disableRemotePlayback=true;
    if(!a.once)audio.src=ctx.urlOf(a,message,peer);
    const p={a,frame,audio,raf:0,loading:false,requested:false,pending:false,playAttempt:0};players.add(p);
    const duration=()=>Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:a.duration;
    p.sync=()=>{
      if(!players.has(p))return;
      const used=p.a.consumed||consumed.has(a.id),mine=message.sender===ctx.getState().account;
      // The server consumes the voice before transfer; keep the active listener's card until playback finishes.
      const listening=oncePlayback?.a.id===a.id&&!oncePlayback.finished&&!oncePlayback.failed,expired=a.once&&used&&!listening;
      bubble.classList.toggle('is-voice-expired',expired);frame.classList.toggle('is-expired',expired);
      play.hidden=copy.hidden=expired;expiredLabel.hidden=!expired;
      if(expired){play.disabled=true;play.setAttribute('aria-busy','false');cancelAnimationFrame(p.raf);p.raf=0;return;}
      play.disabled=a.once&&(used||mine&&peer!==ctx.getState().account);play.setAttribute('aria-label',p.loading?'正在加载语音':used?'语音已播放':a.once&&mine?'一次性语音仅接收方可播放':audio.paused?'播放语音':'暂停语音');
      play.setAttribute('aria-busy',String(p.loading));playIcon.hidden=p.loading||!audio.paused;pauseIcon.hidden=p.loading||audio.paused;spinner.hidden=!p.loading;
      const total=duration();frame.classList.toggle('is-consumed',used);frame.classList.toggle('is-playing',!audio.paused);label.textContent=used?'语音已播放':audio.paused?clock(total):clock(audio.currentTime)+' / '+clock(total);
      wave.setAttribute('aria-valuemax',String(total));wave.setAttribute('aria-valuenow',String(Math.min(total,audio.currentTime)));wave.setAttribute('aria-valuetext',clock(audio.currentTime)+'，总时长 '+clock(total));
      bars(wave,a.waveform,audio.currentTime/total);cancelAnimationFrame(p.raf);if(!audio.paused)p.raf=requestAnimationFrame(p.sync);
    };
    play.addEventListener('click',async()=>{
      pulse(play);if(a.once){if(p.loading||oncePlayback)return;p.loading=true;p.sync();try{await playOnce(a,message,peer,frame);}finally{p.loading=false;p.sync();}return;}
      if(p.requested||!audio.paused){++p.playAttempt;p.requested=p.pending=p.loading=false;audio.pause();p.sync();return;}
      const attempt=++p.playAttempt;p.requested=p.pending=p.loading=true;
      try{pauseAll(p);recording?.preview?.pause();ctx.pauseMedia();p.sync();await audio.play();}
      catch(error){if(players.has(p)&&attempt===p.playAttempt&&error.name!=='AbortError')ctx.showStatus('语音暂时无法播放，请检查网络后重试。');}
      finally{if(attempt===p.playAttempt){p.pending=p.loading=false;p.requested=!audio.paused;p.sync();}}
    });
    const seek=event=>{if(a.once)return;const r=wave.getBoundingClientRect(),total=duration();try{audio.currentTime=Math.max(0,Math.min(total,(event.clientX-r.left)/r.width*total));p.sync();}catch{}};
    wave.addEventListener('pointerdown',event=>{if(a.once)return;event.preventDefault();wave.setPointerCapture(event.pointerId);seek(event);});
    wave.addEventListener('pointermove',event=>{if(wave.hasPointerCapture(event.pointerId))seek(event);});
    wave.addEventListener('keydown',event=>{if(a.once||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const total=duration();try{audio.currentTime=event.key==='Home'?0:event.key==='End'?total:Math.max(0,Math.min(total,audio.currentTime+(event.key==='ArrowRight'?5:-5)));p.sync();}catch{}});
    for(const e of ['loadedmetadata','timeupdate','play','durationchange'])audio.addEventListener(e,p.sync);
    const settled=()=>{++p.playAttempt;p.requested=p.pending=p.loading=false;p.sync();};
    audio.addEventListener('pause',()=>{if(audio.paused)settled();});
    audio.addEventListener('ended',()=>{if(audio.ended)settled();});
    audio.addEventListener('emptied',()=>{if(audio.networkState===0)settled();});
    audio.addEventListener('waiting',()=>{if(p.requested&&!audio.paused){p.loading=true;p.sync();}});
    audio.addEventListener('stalled',()=>{if(p.requested&&!audio.paused&&audio.readyState<3){p.loading=true;p.sync();}});
    audio.addEventListener('playing',()=>{if(!audio.paused){p.loading=false;p.requested=true;p.sync();}});
    audio.addEventListener('canplay',()=>{if(!p.pending&&!audio.paused){p.loading=false;p.sync();}});
    audio.addEventListener('error',()=>{settled();if(players.has(p))ctx.showStatus('无法读取这条语音，请检查网络后重试。');});
    bubble.insertBefore(frame,bubble.querySelector('.message-text'));resizer.observe(frame);requestAnimationFrame(p.sync);
  }
  async function playOnce(a,message,peer,frame) {
    if(oncePlayback||consumed.has(a.id)||a.consumed)return;
    const state=ctx.getState(),source=frame.getBoundingClientRect(),playback={a,particles:[],last:0,raf:0,started:false};oncePlayback=playback;
    pauseAll();recording?.preview?.pause();ctx.pauseMedia();
    $('voice-once-status').textContent='正在加载一次性语音…';$('voice-once-close').hidden=true;ctx.openModal('voice-once-dialog');
    const card=$('voice-once-card'),target=card.getBoundingClientRect();
    if(ctx.motionDuration(350))card.animate([{transform:'translate('+(source.left+source.width/2-target.left-target.width/2)+'px,'+(source.top+source.height/2-target.top-target.height/2)+'px) scale('+source.width/target.width+','+source.height/target.height+')',opacity:.5},{transform:'none',opacity:1}],{duration:ctx.motionDuration(350),easing:'cubic-bezier(.2,.8,.2,1)'});
    bars($('voice-once-wave'),a.waveform);
    try{
      const controller=new AbortController();let idle=setTimeout(()=>controller.abort(),30000);
      let response;try{response=await fetch('/api/voice/play?'+new URLSearchParams({id:a.id,peerId:ctx.peerId(peer),seq:String(message.seq)}),{method:'POST',headers:ctx.headers(),credentials:'same-origin',cache:'no-store',signal:controller.signal});}
      finally{clearTimeout(idle);}
      if(!response.ok){const error=await response.json();throw Error(error.error||'request_failed');}
      markConsumed(a.id);const parts=[],reader=response.body.getReader();
      try{while(true){idle=setTimeout(()=>controller.abort(),30000);const part=await reader.read();clearTimeout(idle);if(part.done)break;parts.push(part.value);}}
      finally{clearTimeout(idle);reader.releaseLock();}
      const blob=new Blob(parts,{type:a.type});if(oncePlayback!==playback)return;
      playback.url=URL.createObjectURL(blob);playback.audio=new Audio(playback.url);playback.audio.controls=false;
      playback.audio.addEventListener('ended',()=>finishOnce(playback));
      playback.audio.addEventListener('error',()=>{if(oncePlayback===playback){$('voice-once-status').textContent='音频无法播放。一次性语音已经失效。';$('voice-once-close').hidden=false;playback.failed=true;markConsumed(a.id);}});
      await playback.audio.play();playback.started=true;$('voice-once-dialog').classList.add('is-burning');animateOnce(playback);
    }catch(error){if(oncePlayback===playback){playback.failed=true;$('voice-once-status').textContent=copyError(error);$('voice-once-close').hidden=false;}if(error.message==='voice_consumed'||consumed.has(a.id))markConsumed(a.id);}
  }
  function animateOnce(p) {
    if(oncePlayback!==p)return;
    const duration=Number.isFinite(p.audio.duration)&&p.audio.duration>0?p.audio.duration:p.a.duration,progress=Math.min(1,p.audio.currentTime/duration),now=performance.now();
    const delta=p.time?Math.min(.1,(now-p.time)/1000):.016;p.time=now;
    if(ctx.motionDuration(100)>0&&Math.floor(progress*80)>Math.floor(p.last*80))for(let i=0;i<8;i++)p.particles.push({x:progress,y:.5,vx:(Math.random()-.4)*.2,vy:(Math.random()-.5)*2,life:1,size:Math.random()*2+1,color:i%3?'#61b7ff':'#ffd077'});
    p.last=progress;p.particles=p.particles.filter(q=>q.life>0);for(const q of p.particles){q.x+=q.vx*delta;q.y+=q.vy*delta;q.life-=delta*1.4;}
    bars($('voice-once-wave'),p.a.waveform,progress,true,p.particles);$('voice-once-status').textContent=clock(p.audio.currentTime)+' / '+clock(duration);
    p.raf=requestAnimationFrame(()=>animateOnce(p));
  }
  function finishOnce(p) {
    if(oncePlayback!==p)return;cancelAnimationFrame(p.raf);bars($('voice-once-wave'),p.a.waveform,1,true);$('voice-once-status').textContent='Expired voice message';p.finished=true;markConsumed(p.a.id);
    setTimeout(()=>{if(oncePlayback===p)ctx.closeModal('voice-once-dialog');},ctx.motionDuration(500)||0);
  }
  function onClose() {const p=oncePlayback;if(!p)return;oncePlayback=null;cancelAnimationFrame(p.raf);p.audio?.pause();if(p.url)URL.revokeObjectURL(p.url);$('voice-once-dialog').classList.remove('is-burning');if(consumed.has(p.a.id))markConsumed(p.a.id);}
  async function checkState() {
    if(!ctx||stateBusy||document.hidden)return;const s=ctx.getState();if(!s.peerId||!document.querySelector('.voice-message'))return;
    stateBusy=true;try{const data=await ctx.api('/api/voice/state?peerId='+s.peerId);if(ctx.getState().peerId===s.peerId)for(const v of data.voices)if(v.consumed)markConsumed(v.id);}catch{}finally{stateBusy=false;}
  }
  function init(context){ctx=context;clearInterval(stateTimer);stateTimer=setInterval(checkState,4000);}
  $('voice-pause').addEventListener('click',togglePause);$('voice-preview').addEventListener('click',preview);$('voice-send').addEventListener('click',send);$('voice-cancel').addEventListener('click',cancel);
  $('voice-once').addEventListener('click',()=>{const r=recording;if(!r||r.id)return;r.once=!r.once;pulse($('voice-once'));setRecordUI();});
  $('voice-record-wave').addEventListener('pointerdown',event=>{const r=recording;if(!r?.preview||r.phase!=='paused')return;const b=event.currentTarget.getBoundingClientRect();try{r.preview.currentTime=Math.max(0,Math.min(r.elapsed/1000,(event.clientX-b.left)/b.width*r.elapsed/1000));}catch{}});
  $('voice-once-close').addEventListener('click',()=>ctx.closeModal('voice-once-dialog'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkState();});
  new MutationObserver(()=>{for(const p of Array.from(players))if(!p.frame.isConnected)dispose(p.frame);}).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('pagehide',()=>{if(recording)cleanup(recording);pauseAll();onClose();});
  return {init,start,normalize,renderMessage,dispose,pauseAll,onClose,isRecording:()=>!!recording,isBusy:()=>!!recording||!!oncePlayback,modalBusy:()=>!!oncePlayback&&!oncePlayback.finished&&!oncePlayback.failed};
})();
