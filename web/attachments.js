'use strict';
window.chaweAttachments = (() => {
  const $ = id => document.getElementById(id), MAX_IMAGE = 20*1024*1024, MAX_VIDEO = 100*1024*1024, MAX_FILE = 200*1024*1024, MAX_VIDEO_SECONDS = 600;
  const tasks = new Map(), players = new Set(), recentDownloads = new Map();
  let downloadListenerInstalled = false;
  let ctx = null, selection = null, previewEpoch = 0, pickerMode = 'media';
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const button = (label,name,action,cls = 'icon-button') => {
    const node=document.createElement('button'); node.type='button'; node.className=cls; node.setAttribute('aria-label',label);
    node.innerHTML=icon(name); node.addEventListener('click',action); return node;
  };
  const sizeOf = size => size >= 1024*1024 ? (size/(1024*1024)).toFixed(1)+' MB' : size >= 1024 ? (size/1024).toFixed(1)+' KB' : size+' B';
  const clock = seconds => { const n=Math.floor(Number.isFinite(seconds)?seconds:0); return (n>=3600?Math.floor(n/3600)+':':'')+String(Math.floor(n/60)%60).padStart(n>=3600?2:1,'0')+':'+String(n%60).padStart(2,'0'); };
  function normalize(a) {
    if(a?.kind==='article')return window.chaweArticles.normalize(a);
    if(a?.kind?.startsWith('voice'))return window.chaweVoice.normalize(a);
    if (!a || !/^[a-f0-9]{32}$/.test(a.id) || typeof a.name!=='string' || !a.name || a.name.length>512
        || !['image','video','file'].includes(a.kind) || typeof a.type!=='string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(a.type)
        || !Number.isSafeInteger(a.size) || a.size<1 || a.size>MAX_FILE) return null;
    return {id:a.id,name:a.name,type:a.type,size:a.size,kind:a.kind};
  }
  function fileCard(a) {
    const card=document.createElement('div'); card.className='attachment-file-card';
    const mark=document.createElement('span'); mark.className='attachment-file-icon'; mark.innerHTML=icon('file');
    const copy=document.createElement('span'), name=document.createElement('strong'), size=document.createElement('small');
    name.textContent=a.name; size.textContent=sizeOf(a.size); copy.append(name,size); card.append(mark,copy); return card;
  }
  function mediaSource(node,url) {
    if(!url.startsWith('/api/attachments/file?') || !window.chaweMediaCacheReady){node.src=url;return Promise.resolve();}
    return window.chaweMediaCacheReady.then(() => {if(node.isConnected)node.src=url;});
  }
  function player(url,preview = false) {
    const wrap=document.createElement('div'); wrap.className='custom-video'+(preview?' video-preview':'');
    const video=document.createElement('video'); video.playsInline=true; video.preload=preview?'auto':'metadata'; video.controls=false;
    video.disablePictureInPicture=true; video.disableRemotePlayback=true; video.setAttribute('controlslist','nodownload noremoteplayback');
    const sourceReady=mediaSource(video,url);
    const center=button('播放视频','play',toggle,'video-center-play');
    const toolbar=document.createElement('div'); toolbar.className='video-toolbar';
    const play=button('播放','play',toggle,'video-control');
    const time=document.createElement('span'); time.className='video-time'; time.textContent='0:00 / 0:00';
    const seek=document.createElement('input'); seek.type='range'; seek.min='0'; seek.max='1000'; seek.value='0'; seek.step='1'; seek.className='video-seek'; seek.setAttribute('aria-label','视频播放进度'); seek.disabled=true;
    const mute=button('静音','volume',() => { video.muted=!video.muted; sync(); },'video-control');
    const volume=document.createElement('input'); volume.type='range'; volume.min='0'; volume.max='1'; volume.step='.05'; volume.value='1'; volume.className='video-volume'; volume.setAttribute('aria-label','音量');
    const expand=button('全屏播放','expand',async () => {
      try { if (document.fullscreenElement === wrap) await document.exitFullscreen(); else if (wrap.requestFullscreen) await wrap.requestFullscreen(); else wrap.classList.toggle('video-expanded'); }
      catch { wrap.classList.toggle('video-expanded'); }
    },'video-control');
    const error=document.createElement('span'); error.className='video-error'; error.hidden=true;
    const buffering=document.createElement('span'); buffering.className='video-buffering'; buffering.hidden=true; buffering.setAttribute('aria-label','视频缓冲中');
    const duration=document.createElement('span'); duration.className='video-duration'; duration.textContent='视频';
    toolbar.append(play,time,seek,mute,volume,expand); wrap.append(video,center,buffering,error,duration,toolbar);
    let scrubbing=false, controlsTimer=null;
    function showControls() {
      clearTimeout(controlsTimer); wrap.classList.add('is-controls-visible');
      controlsTimer=setTimeout(() => {
        if (!scrubbing && !wrap.contains(document.activeElement)) wrap.classList.remove('is-controls-visible');
      },2200);
    }
    async function toggle() {
      if (!video.paused) { video.pause(); return; }
      for (const item of players) if (item.video!==video) item.video.pause();
      window.chaweVoice?.pauseAll();
      try { await sourceReady;if(!video.isConnected)return;await video.play(); } catch { error.textContent='暂时无法播放，请重试或下载原文件。'; error.hidden=false; }
    }
    function sync() {
      const ready=Number.isFinite(video.duration) && video.duration>0;
      seek.disabled=!ready; time.textContent=clock(video.currentTime)+' / '+clock(Math.ceil(video.duration));
      duration.textContent=ready?clock(Math.ceil(video.duration)):'视频';
      if (!scrubbing) seek.value=String(ready?Math.round(video.currentTime/video.duration*1000):0);
      seek.style.setProperty('--range-fill',seek.value/10+'%');
      seek.setAttribute('aria-valuetext',clock(video.currentTime)+'，总时长 '+clock(Math.ceil(video.duration)));
      play.innerHTML=icon(video.paused?'play':'pause'); play.setAttribute('aria-label',video.paused?'播放':'暂停');
      center.hidden=!video.paused || !error.hidden; wrap.classList.toggle('is-playing',!video.paused);
      mute.innerHTML=icon(video.muted || video.volume===0?'muted':'volume'); mute.setAttribute('aria-label',video.muted?'取消静音':'静音');
      mute.setAttribute('aria-pressed',String(video.muted)); volume.value=String(video.muted?0:video.volume);
      volume.style.setProperty('--range-fill',Number(volume.value)*100+'%');
    }
    wrap.addEventListener('pointermove',showControls);
    wrap.addEventListener('pointerdown',showControls);
    wrap.addEventListener('focusin',showControls);
    wrap.addEventListener('pointerleave',() => { if (!scrubbing && !wrap.contains(document.activeElement)) wrap.classList.remove('is-controls-visible'); });
    seek.addEventListener('pointerdown',() => { scrubbing=true; });
    for (const name of ['pointerup','pointercancel','change','blur']) seek.addEventListener(name,() => { scrubbing=false; sync(); });
    seek.addEventListener('input',() => { if (Number.isFinite(video.duration)) video.currentTime=Number(seek.value)*video.duration/1000; });
    volume.addEventListener('input',() => { video.volume=Number(volume.value); video.muted=video.volume===0; sync(); });
    video.addEventListener('click',toggle);
    video.addEventListener('play',showControls);
    video.addEventListener('pause',() => { clearTimeout(controlsTimer); if (!wrap.contains(document.activeElement)) wrap.classList.remove('is-controls-visible'); });
    for (const event of ['timeupdate','durationchange','loadedmetadata','play','pause','ended','volumechange']) video.addEventListener(event,sync);
    video.addEventListener('waiting',() => { buffering.hidden=false; });
    for (const event of ['playing','canplay','pause','ended']) video.addEventListener(event,() => { buffering.hidden=true; });
    video.addEventListener('error',() => { error.textContent='此视频格式无法在当前浏览器播放，可下载原文件。'; error.hidden=false; center.hidden=true; buffering.hidden=true; });
    const record={wrap,video,cleanup:() => clearTimeout(controlsTimer)}; players.add(record);
    return wrap;
  }
  function dispose(root) {
    window.chaweVoice?.dispose(root);
    for (const item of Array.from(players)) if (root.contains(item.wrap)) {
      item.video.pause(); item.cleanup(); item.video.removeAttribute('src'); item.video.load(); players.delete(item);
    }
  }
  function urlOf(a,message,peer,download = false) {
    const state=ctx?.getState(), peerId=ctx?.peerId(peer);
    if (!state?.accountId || !peerId) return '';
    // Keep browser downloads outside the media cache worker, including older active workers.
    return (download?'/api/attachments/download?':'/api/attachments/file?')+new URLSearchParams({id:a.id,accountId:state.accountId,peerId,seq:String(message.seq)});
  }
  function downloadClick(event) {
    if(!ctx || event.defaultPrevented || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
    const link=event.target instanceof Element?event.target.closest('a.attachment-file-link,a.attachment-download,a#media-download'):null;if(!link)return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin || url.pathname!=='/api/attachments/download')return;
    const now=performance.now();for(const [key,time]of recentDownloads)if(now-time>=3000)recentDownloads.delete(key);
    if(recentDownloads.has(url.href)){event.preventDefault();ctx.showStatus('已请求下载，请先查看浏览器下载列表。');return;}
    recentDownloads.set(url.href,now);ctx.showStatus('已请求浏览器下载，请在下载列表中查看进度。');
    // Leave the anchor's default action intact: no fetch, Blob, or page-owned transfer.
  }
  function openViewer(a,message,peer) {
    const url=urlOf(a,message,peer); if (!url) return;
    dispose($('media-content')); $('media-content').replaceChildren(); $('media-title').textContent=a.name;
    $('media-download').href=urlOf(a,message,peer,true); $('media-download').download=a.name;
    $('media-caption').textContent=message.text; $('media-caption').hidden=!message.text;
    if (a.kind==='video') $('media-content').append(player(url));
    else {
      const image=document.createElement('img'); mediaSource(image,url); image.alt=a.name; image.className='media-full-image';
      image.addEventListener('error',() => { const copy=document.createElement('p'); copy.textContent='图片未能加载，请稍后重试或下载原文件。'; image.replaceWith(copy); },{once:true});
      $('media-content').append(image);
    }
    ctx.openModal('media-dialog');
  }
  function renderMessage(bubble,message,peer) {
    const a=normalize(message.attachment), old=bubble.querySelector(':scope > .message-attachment'), stamp=bubble.querySelector('.bubble-meta');
    bubble.classList.toggle('has-article',a?.kind==='article');
    if(a?.kind==='article'){window.chaweArticles.renderMessage(bubble,message,peer);return;}
    bubble.classList.toggle('has-voice',!!a?.kind.startsWith('voice'));
    if(a?.kind.startsWith('voice')){
      bubble.classList.add('has-attachment');bubble.classList.remove('has-media','media-only');
      const text=bubble.querySelector('.message-text');if(text)text.hidden=!message.text;
      window.chaweVoice.renderMessage(bubble,message,peer);return;
    }
    bubble.classList.toggle('has-attachment',!!a);
    bubble.classList.toggle('has-media',!!a && a.kind!=='file');
    bubble.classList.toggle('media-only',!!a && a.kind!=='file' && !message.text);
    const text=bubble.querySelector('.message-text'); if (text) text.hidden=!!a && !message.text;
    if (!a) { if (old) { if(stamp && old.contains(stamp)) bubble.append(stamp); dispose(old); old.remove(); } return; }
    const url=urlOf(a,message,peer);
    if (old?.dataset.attachment===a.id && old.dataset.mediaUrl===url) return;
    if (old) { dispose(old); old.remove(); }
    const frame=document.createElement('div'); frame.className='message-attachment attachment-'+a.kind; frame.dataset.attachment=a.id; frame.dataset.mediaUrl=url;
    if (a.kind==='image') {
      const open=document.createElement('button'); open.type='button'; open.className='attachment-image-open'; open.setAttribute('aria-label','查看图片：'+a.name);
      const image=document.createElement('img'); image.alt=a.name; image.loading='lazy'; image.decoding='async'; mediaSource(image,url);
      const failed=document.createElement('span'); failed.className='attachment-image-error'; failed.textContent='图片加载失败，点击重试'; failed.hidden=true;
      image.addEventListener('error',() => { failed.hidden=false; image.hidden=true; });
      open.addEventListener('click',() => { if (!failed.hidden) { image.hidden=false; failed.hidden=true; image.src=url; } else openViewer(a,message,peer); });
      open.append(image,failed); frame.append(open);
    } else if (a.kind==='video') frame.append(player(url));
    else {
      const link=document.createElement('a'); link.href=urlOf(a,message,peer,true); link.download=a.name; link.className='attachment-file-link';
      link.append(fileCard(a)); const mark=document.createElement('span'); mark.innerHTML=icon('download'); link.append(mark); frame.append(link);
    }
    if (a.kind!=='file') {
      const download=document.createElement('a'); download.className='attachment-download'; download.href=urlOf(a,message,peer,true); download.download=a.name;
      download.setAttribute('aria-label','下载原文件：'+a.name); download.title='下载原文件'; download.innerHTML=icon('download'); frame.append(download);
    }
    bubble.insertBefore(frame,text); bubble.dataset.attachmentId=a.id;
    if (stamp) frame.append(stamp);
  }
  function onClose(id) {
    if (id==='media-dialog') {
      const root=$('media-content'); for(const p of players)if(root.contains(p.wrap))p.video.pause();
      if(document.fullscreenElement && root.contains(document.fullscreenElement))document.exitFullscreen().catch(() => {});
      root.querySelectorAll('.video-expanded').forEach(node => node.classList.remove('video-expanded'));
      setTimeout(() => { if($('media-dialog').hidden){dispose(root);root.replaceChildren();} },ctx.motionDuration(180)+30); return;
    }
    if (id!=='attachment-dialog') return;
    const epoch=++previewEpoch,oldUrl=selection?.url,root=$('attachment-preview'); selection=null;
    for(const p of players)if(root.contains(p.wrap))p.video.pause();
    if(document.fullscreenElement && root.contains(document.fullscreenElement))document.exitFullscreen().catch(() => {});
    root.querySelectorAll('.video-expanded').forEach(node => node.classList.remove('video-expanded'));
    setTimeout(() => { if(epoch===previewEpoch){dispose(root);root.replaceChildren();} if(oldUrl)URL.revokeObjectURL(oldUrl); },ctx.motionDuration(180)+30);
    $('attachment-input').value=''; $('attachment-emojis').hidden=true; $('attachment-emoji').setAttribute('aria-expanded','false');
  }
  function kindOf(file) {
    if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|ico|svg)$/i.test(file.name)) return 'image';
    if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv|wmv|flv|mpeg|mpg|m2ts|ts|ogv|3gp|3g2)$/i.test(file.name)) return 'video';
    return 'file';
  }
  function supportedMedia(file) {
    return /\.(png|jpe?g|gif|webp|mp4|webm|mov|m4v)$/i.test(file.name)
      || /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime|x-m4v))$/i.test(file.type);
  }
  function readVideoDuration(url){
    return new Promise(resolve=>{
      const video=document.createElement('video');video.preload='metadata';video.muted=true;let finished=false;
      const done=()=>{if(finished)return;finished=true;clearTimeout(timer);const duration=video.duration;
        video.removeAttribute('src');video.load();resolve(Number.isFinite(duration)&&duration>0?duration:null);};
      const timer=setTimeout(done,5000);video.addEventListener('loadedmetadata',done,{once:true});video.addEventListener('error',done,{once:true});video.src=url;
    });
  }
  function selectionTitle() {
    if (!selection) return;
    const kind=$('attachment-as-file').checked?'file':selection.kind;
    $('attachment-title').textContent=kind==='image'?'发送图片':kind==='video'?'发送视频':'发送文件';
  }
  function openPicker(mode) {
    if (!ctx || !ctx.getState().canSend || isBusy()) return;
    pickerMode = mode === 'file' ? 'file' : 'media';
    const input = $('attachment-input'); input.value = '';
    input.accept = pickerMode === 'media' ? '.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov,.m4v,image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v' : '';
    input.click();
  }
  function paste(event) {
    if(!ctx || event.defaultPrevented || !ctx.getState().canSend || isBusy())return;
    const clipboard=event.clipboardData;if(!clipboard)return;
    let files=Array.from(clipboard.files || []);
    if(!files.length)files=Array.from(clipboard.items || []).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);
    if(!files.length)return;
    event.preventDefault();ctx.closeMenus?.();
    if(files.length>1){ctx.showStatus('一次只能发送一个附件，请分别粘贴。');return;}
    let file=files[0];
    if(!file.name){const extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','video/mp4':'mp4','video/webm':'webm'})[file.type] || 'bin';file=new File([file],'剪贴板-'+Date.now()+'.'+extension,{type:file.type});}
    choose(file,supportedMedia(file)?'media':'file');
  }
  async function choose(file,mode=pickerMode) {
    if (!ctx || !file || !ctx.getState().canSend || isBusy()) return;
    if (mode === 'media' && !supportedMedia(file)) {
      ctx.showStatus('图片或视频支持 PNG、JPG、GIF、WebP、MP4、WebM、MOV 和 M4V。其他格式请使用“文件”。'); return;
    }
    const mediaKind=kindOf(file),limit=mediaKind==='image'?MAX_IMAGE:mediaKind==='video'?MAX_VIDEO:MAX_FILE;
    if(ctx.canAttach && !ctx.canAttach(mode==='file'?'file':mediaKind)){ctx.showStatus('你没有发送此类附件的权限。');return;}
    if(file.size<1){ctx.showStatus('请选择非空文件。');return;}
    if(file.size>limit){ctx.showStatus(mediaKind==='image'?'图片最大 20 MB。':mediaKind==='video'?'视频最大 100 MB，时长最多 10 分钟。':'文件最大 200 MB。');return;}
    if (Array.from(file.name).length>200) { ctx.showStatus('文件名过长，请将文件名缩短至 200 个字符以内。'); return; }
    const epoch=++previewEpoch, state=ctx.getState();
    selection={file,url:URL.createObjectURL(file),kind:mode === 'file' ? 'file' : mediaKind,mediaKind,valid:mediaKind!=='video',peer:state.peer,peerId:state.peerId};
    if (!selection.peerId) { URL.revokeObjectURL(selection.url); selection=null; ctx.showStatus('用户资料正在更新，请稍后重试。'); return; }
    $('attachment-caption').value=''; $('attachment-caption').style.height=''; $('attachment-error').hidden=true;
    $('attachment-as-file').checked=selection.kind==='file'; $('attachment-as-file-label').hidden=selection.kind==='file';
    const info=file.name+' · '+sizeOf(file.size)+' · '+(mediaKind==='image'?'图片上限 20 MB':mediaKind==='video'?'视频上限 100 MB / 10 分钟':'文件上限 200 MB');
    $('attachment-file-info').textContent=info; $('attachment-send').disabled=!selection.valid;
    dispose($('attachment-preview')); $('attachment-preview').replaceChildren(); selectionTitle();
    if (selection.kind==='image') {
      const image=document.createElement('img'); image.src=selection.url; image.alt=file.name; $('attachment-preview').append(image);
      image.addEventListener('error',() => { if (epoch!==previewEpoch) return; $('attachment-as-file').checked=true; selection.kind='file';
        $('attachment-preview').replaceChildren(fileCard({name:file.name,size:file.size})); selectionTitle();
        $('attachment-error').textContent='无法预览此图片，将作为文件发送。'; $('attachment-error').hidden=false; });
    } else if (selection.kind==='video') $('attachment-preview').append(player(selection.url,true));
    else $('attachment-preview').append(fileCard({name:file.name,size:file.size}));
    ctx.openModal('attachment-dialog'); $('attachment-caption').focus({preventScroll:true});
    if(mediaKind==='video'){
      const current=selection;$('attachment-file-info').textContent=info+' · 正在读取时长…';
      const duration=await readVideoDuration(current.url);if(epoch!==previewEpoch||selection!==current)return;
      current.valid=duration===null||duration<=MAX_VIDEO_SECONDS;$('attachment-send').disabled=!current.valid;
      $('attachment-file-info').textContent=info+(duration===null?'':' · '+clock(Math.ceil(duration)));
      if(!current.valid){$('attachment-error').textContent='视频时长不能超过 10 分钟，请裁剪后重新选择。';$('attachment-error').hidden=false;}
    }
  }
  function pendingFrame(t) {
    const frame=document.createElement('div'); frame.className='message-attachment pending-attachment attachment-'+t.kind;
    if (t.kind==='file') frame.append(fileCard({name:t.file.name,size:t.file.size}));
    else if (t.kind==='image') { const img=document.createElement('img'); img.src=t.url; img.alt=t.file.name; frame.append(img); }
    else if (t.poster) { const img=document.createElement('img'); img.src=t.poster; img.alt=t.file.name; frame.append(img); }
    else { const video=document.createElement('video'); video.src=t.url; video.muted=true; video.playsInline=true; video.preload='metadata'; frame.append(video); }
    const progress=document.createElement('span'); progress.className='upload-percent'; progress.textContent='0%'; progress.setAttribute('role','status');
    const overlay=document.createElement('div'); overlay.className='upload-overlay';
    const cancel=button('取消发送附件','close',() => cancelTask(t),'upload-cancel');
    const ring=document.createElementNS('http://www.w3.org/2000/svg','svg'); ring.classList.add('upload-ring'); ring.setAttribute('viewBox','0 0 48 48');
    ring.innerHTML='<circle class="upload-ring-track" cx="24" cy="24" r="21"/><circle class="upload-ring-progress" cx="24" cy="24" r="21"/>';
    cancel.prepend(ring); overlay.append(cancel); frame.append(progress,overlay);
    t.percentNode=progress; t.cancelButton=cancel; t.progressRing=ring.querySelector('.upload-ring-progress'); t.frame=frame;
    return frame;
  }
  function updateTask(t) {
    if (!t.node) return;
    const waiting=t.state==='finalizing', cancelling=t.cancelIntent, failed=t.state==='failed' || t.state==='cancel-failed';
    if (t.mediaMessage) {
      const content=t.node.querySelector('.message-text'); content.textContent=t.caption; content.hidden=!failed || !t.caption || cancelling;
      t.note.textContent=cancelling?'附件已送达，正在核对取消结果…':failed?(t.caption?'附件已发送；备注尚未确认。':'附件已发送，结果尚未确认。')+(t.error || '')
        :t.caption?'附件已发送，正在确认备注…':'附件已发送，正在确认结果…';
      t.retry.hidden=!failed; t.retry.textContent=cancelling?'重试确认':t.caption?'重试发送备注':'重试确认'; t.discard.hidden=!failed || cancelling;
      t.node.setAttribute('aria-busy',String(!failed)); return;
    }
    t.percentNode.textContent=(t.percent||0)+'%'; t.progressRing.style.strokeDasharray=Math.max(8,132*(t.percent||0)/100)+' 132';
    t.frame.classList.toggle('upload-failed',failed); t.cancelButton.disabled=t.state==='cancelling';
    t.node.classList.toggle('upload-error',failed);
    t.note.textContent=failed?(t.error || '上传失败，请重试。'):cancelling?'正在取消发送…':waiting?'正在发送…':'正在上传…';
    t.retry.hidden=!failed; t.retry.textContent=cancelling?'重试取消':'重试发送';
    t.node.setAttribute('aria-busy',String(!failed));
  }
  function pendingNodes(peer,messages) {
    return Array.from(tasks.values()).filter(t => t.peer===peer && t.state!=='completed' && t.state!=='cancelled'
      ).map(t => {
        const committed=messages.find(m => m.attachment?.id===t.id);
        if(committed && !t.mediaMessage){committedTask(t,committed);updateTask(t);}
        return t.node;
      });
  }
  async function fly(t,source,clone) {
    if (!t.node.isConnected || !source.width || !source.height || !ctx.motionDuration(420) || document.hidden) return;
    const target=t.frame.getBoundingClientRect();
    if (!target.width) return;
    const flight=document.createElement('div'); flight.className='attachment-flight'; flight.setAttribute('aria-hidden','true');
    Object.assign(flight.style,{left:target.left+'px',top:target.top+'px',width:target.width+'px',height:target.height+'px'});
    clone.className='attachment-flight-content'; flight.append(clone); document.body.append(flight); t.node.classList.add('send-arriving');
    let animation, done=false, finishMotion;
    await new Promise(resolve => {
      const finish=() => { if(done)return;done=true;animation?.cancel();flight.remove();t.node.classList.remove('send-arriving');finishMotion?.();resolve(); };
      finishMotion=ctx.registerFlight(finish);
      try {
        animation=flight.animate([
          {transform:'translate('+(source.left-target.left)+'px,'+(source.top-target.top)+'px) scale('+(source.width/target.width)+','+(source.height/target.height)+')',borderRadius:'16px',opacity:1},
          {transform:'translate(0,0) scale(1)',borderRadius:'10px',opacity:1}
        ],{duration:ctx.motionDuration(420),easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});
        animation.finished.then(finish,finish);
      } catch { finish(); }
    });
  }
  function posterOf(video) {
    if (!video?.videoWidth || video.readyState<2) return '';
    try { const canvas=document.createElement('canvas'),scale=Math.min(1,640/video.videoWidth,640/video.videoHeight); canvas.width=Math.max(1,Math.round(video.videoWidth*scale)); canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height); return canvas.toDataURL('image/jpeg',.8); } catch { return ''; }
  }
  async function sendSelected(event) {
    event.preventDefault(); if (!selection || !selection.valid || !ctx.getState().canSend || isBusy()) return;
    const item=selection, caption=$('attachment-caption').value.trim();
    if (Array.from(caption).length>4000) { $('attachment-error').textContent='说明最多 4000 字。'; $('attachment-error').hidden=false; return; }
    const asFile=$('attachment-as-file').checked, preview=$('attachment-preview'), source=preview.getBoundingClientRect();
    const poster=posterOf(preview.querySelector('video'));
    const t={...item,caption,kind:asFile?'file':item.kind,asFile,poster,key:crypto.randomUUID().replaceAll('-',''),id:'',state:'starting',offset:0,percent:0,cancelIntent:false,xhr:null};
    const clone=asFile?fileCard({name:item.file.name,size:item.file.size}):poster?Object.assign(document.createElement('img'),{src:poster,alt:''}):preview.cloneNode(true);
    selection=null; ctx.closeModal('attachment-dialog',false);
    t.node=ctx.createBubble(''); t.node.removeAttribute('data-seq'); t.node.dataset.pending=t.key; t.node.classList.add('has-attachment','upload-bubble');
    if(t.kind!=='file')t.node.classList.add('has-media','media-only');
    const text=t.node.querySelector('.message-text'); text.hidden=true;
    t.node.insertBefore(pendingFrame(t),text);
    t.note=document.createElement('span'); t.note.className='upload-note';
    t.retry=document.createElement('button'); t.retry.type='button'; t.retry.className='upload-retry'; t.retry.hidden=true;
    t.retry.addEventListener('click',() => { if (t.cancelIntent) cancelTask(t); else run(t); });
    t.node.insertBefore(t.note,t.node.querySelector('.bubble-meta')); t.node.insertBefore(t.retry,t.node.querySelector('.bubble-meta'));
    tasks.set(t.key,t); updateTask(t); ctx.stateChanged(); ctx.rerender(t.peer,true);
    await fly(t,source,clone); run(t);
  }
  function chunk(t,offset,blob) {
    return new Promise((resolve,reject) => {
      const xhr=new XMLHttpRequest(); t.xhr=xhr;
      xhr.open('POST','/api/attachments/chunk?'+new URLSearchParams({id:t.id,offset:String(offset)})); xhr.withCredentials=true;
      xhr.setRequestHeader('Content-Type','application/octet-stream'); for(const [name,value] of Object.entries(ctx.headers())) xhr.setRequestHeader(name,value);
      xhr.timeout=90000;
      xhr.upload.addEventListener('progress',event => { if (event.lengthComputable) { t.percent=Math.min(99,Math.floor((offset+event.loaded)/t.file.size*100)); updateTask(t); } });
      xhr.onload=() => {
        t.xhr=null;
        try { const data=JSON.parse(xhr.responseText); if(xhr.status>=200 && xhr.status<300) { ctx.connectionRestored(); resolve(data); }
          else { if(xhr.status>=500)ctx.connectionLost(); if(xhr.status===401)location.replace('/?add-account=1&return-account='+encodeURIComponent(ctx.getState().account));
            if(data.error==='directory_changed')location.reload(); reject(Error(data.error || 'request_failed')); }
        } catch { ctx.connectionLost(); reject(Error('request_failed')); }
      };
      xhr.onerror=xhr.ontimeout=() => { t.xhr=null;ctx.connectionLost();reject(Error('connection_timeout')); };
      xhr.onabort=() => { t.xhr=null;reject(new DOMException('Aborted','AbortError')); };
      xhr.send(blob);
    });
  }
  function committedTask(t,message) {
      if (!t.mediaMessage) {
        const old=t.node; t.node=ctx.createBubble(t.caption); t.node.removeAttribute('data-seq'); t.node.dataset.pending=t.key;
        t.node.classList.add('remark-pending'); t.mediaMessage=message;
        t.note=document.createElement('span'); t.note.className='upload-note';
        t.retry=document.createElement('button'); t.retry.type='button'; t.retry.className='upload-retry';
        t.retry.addEventListener('click',() => { if(t.cancelIntent)cancelTask(t);else run(t); });
        t.discard=document.createElement('button'); t.discard.type='button'; t.discard.className='upload-retry discard-remark';
        t.discard.textContent=t.caption?'取消备注':'关闭提示'; t.discard.addEventListener('click',() => { if(!t.running && !t.cancelling)removed(t,false); });
        t.node.insertBefore(t.note,t.node.querySelector('.bubble-meta')); t.node.insertBefore(t.retry,t.node.querySelector('.bubble-meta')); t.node.insertBefore(t.discard,t.node.querySelector('.bubble-meta'));
        dispose(old);
      }
  }
  async function complete(t,data) {
    if (t.finished) return;
    const message=data.message,remark=data.remark;
    if (t.caption && !message.text && !remark && !t.cancelIntent) {
      committedTask(t,message);
      t.state='failed'; t.error=data.remarkError==='message_unavailable'?'当前无法向对方发送消息。':'请联网后重试。';
      updateTask(t); ctx.complete(t.peer,[message]); ctx.stateChanged(); return;
    }
    t.finished=true; t.state='completed'; t.percent=100; updateTask(t); tasks.delete(t.key);
    ctx.complete(t.peer,remark?[message,remark]:[message],remark?.seq); ctx.stateChanged();
    dispose(t.node); URL.revokeObjectURL(t.url);
    if (t.cancelIntent) ctx.showStatus('附件已发送成功，取消时发送已完成。可在消息菜单中撤回。');
  }
  async function run(t) {
    if (t.running || t.finished || t.cancelIntent) return;
    t.running=true; t.state=t.id?'uploading':'starting'; t.error=''; updateTask(t);
    try {
      if (t.mediaMessage) {
        t.state='finalizing'; updateTask(t);
        const data=await ctx.post('/api/attachments/send',{id:t.id,caption:t.caption});
        if(data.message)await complete(t,data);else throw Error('upload_incomplete'); return;
      }
      if (!t.id) {
        const data=await ctx.post('/api/attachments/create',{id:t.key,peerId:t.peerId,name:t.file.name,size:String(t.file.size),asFile:String(t.asFile)});
        t.id=data.id; t.offset=data.offset;
      } else {
        const data=await ctx.api('/api/attachments?id='+encodeURIComponent(t.id));
        if (data.message) {
          const result=t.caption && !data.remark && !data.message.text && !t.cancelIntent
            ? await ctx.post('/api/attachments/send',{id:t.id,caption:t.caption}) : data;
          await complete(t,result); return;
        }
        if (data.state==='cancelled') { await removed(t,false); return; }
        t.offset=data.offset;
      }
      if (t.cancelIntent || t.finished) { await ctx.post('/api/attachments/cancel',{id:t.id}); return; }
      t.state='uploading'; updateTask(t);
      while(t.offset<t.file.size) {
        const data=await chunk(t,t.offset,t.file.slice(t.offset,Math.min(t.offset+512*1024,t.file.size)));
        t.offset=data.offset; t.percent=Math.min(99,Math.floor(t.offset/t.file.size*100)); updateTask(t);
        if (t.cancelIntent || t.finished) return;
      }
      if (t.cancelIntent || t.finished) return;
      t.state='finalizing'; updateTask(t);
      const data=await ctx.post('/api/attachments/send',{id:t.id,caption:t.caption});
      if (data.message) await complete(t,data); else throw Error('upload_incomplete');
    } catch(error) {
      if (t.cancelIntent || t.finished) return;
      // A lost completion response is ambiguous. Read its commit record before offering a retry.
      if (t.id && t.state==='finalizing') {
        try { const data=await ctx.api('/api/attachments?id='+encodeURIComponent(t.id)); if(data.message){await complete(t,data);return;} } catch {}
      }
      t.state='failed'; t.error=errorText(error); updateTask(t);
    } finally { t.running=false; ctx.stateChanged(); }
  }
  function errorText(error) {
    return ({attachment_too_large:'图片最大 20 MB，视频最大 100 MB，文件最大 200 MB。',
      attachment_image_too_large:'图片最大 20 MB。',attachment_video_too_large:'视频最大 100 MB。',attachment_file_too_large:'文件最大 200 MB。',
      attachment_video_too_long:'视频时长不能超过 10 分钟，请裁剪后重新选择。',attachment_video_invalid:'无法确认视频时长或视频格式无效，请转换为标准视频后重新选择。',
      attachment_video_probe_failed:'视频检查未完成，请稍后重试。',attachment_processing_busy:'正在处理其他视频，请稍后重试。',attachment_validation_required:'附件需要重新检查，请重试发送。',
      attachment_storage_full:'服务器附件存储空间不足，请联系运营者。',
      invalid_filename:'文件名无效，请修改后重试。',upload_limit:'仍有未完成的上传，请先完成或取消。',upload_not_found:'这次上传已失效，请取消并重新选择文件。',
      upload_offset:'上传进度需要同步，请点击重试。',upload_closed:'上传已关闭，请取消后重新选择。',upload_incomplete:'文件尚未上传完成，请重试。',
      invalid_upload_chunk:'上传数据无效，请重新选择文件。'})[error.message] || ctx.errorText(error);
  }
  async function cancelTask(t) {
    if (t.finished || t.cancelling) return;
    t.cancelIntent=true; t.cancelling=true; t.state='cancelling'; t.xhr?.abort(); updateTask(t);
    try {
      if (!t.id) { await removed(t,true); return; }
      const data=await ctx.post('/api/attachments/cancel',{id:t.id});
      if (data.message) { await complete(t,data); return; }
      await removed(t,true);
    } catch(error) {
      if (t.finished) return;
      if (error.message==='upload_not_found') { await removed(t,true); return; }
      t.state='cancel-failed'; t.error='取消尚未确认，请联网后重试取消。'; updateTask(t);
    } finally { t.cancelling=false; ctx.stateChanged(); }
  }
  async function dust(t) {
    if (!ctx.motionDuration(800) || !t.node.isConnected || document.hidden) return;
    const rect=t.frame.getBoundingClientRect(), image=t.frame.querySelector('img,video');
    const canvas=document.createElement('canvas'); canvas.className='attachment-dust'; canvas.setAttribute('aria-hidden','true');
    const pad=90, dpr=Math.min(devicePixelRatio||1,2), width=rect.width+pad*2,height=rect.height+pad*2;
    canvas.width=Math.ceil(width*dpr); canvas.height=Math.ceil(height*dpr);
    Object.assign(canvas.style,{left:(rect.left-pad)+'px',top:(rect.top-pad)+'px',width:width+'px',height:height+'px'});
    const paint=canvas.getContext('2d'), bitmap=document.createElement('canvas'); bitmap.width=Math.max(1,Math.ceil(rect.width)); bitmap.height=Math.max(1,Math.ceil(rect.height));
    const brush=bitmap.getContext('2d'); brush.fillStyle='#d7edfc'; brush.fillRect(0,0,bitmap.width,bitmap.height);
    try {
      if (image && (image.naturalWidth || image.videoWidth)) {
        const iw=image.naturalWidth||image.videoWidth,ih=image.naturalHeight||image.videoHeight,scale=Math.max(bitmap.width/iw,bitmap.height/ih);
        brush.drawImage(image,(bitmap.width-iw*scale)/2,(bitmap.height-ih*scale)/2,iw*scale,ih*scale);
      } else { brush.fillStyle='#3390ec';brush.font='bold 18px sans-serif';brush.fillText(t.file.name.slice(0,22),14,Math.min(50,bitmap.height/2)); }
    } catch {}
    const pieces=[]; const step=Math.max(7,Math.ceil(rect.width/28));
    for(let y=0;y<bitmap.height;y+=step)for(let x=0;x<bitmap.width;x+=step)pieces.push({x,y,w:Math.min(step,bitmap.width-x),h:Math.min(step,bitmap.height-y),dx:(Math.random()-.25)*110,dy:20+Math.random()*70,angle:(Math.random()-.5)*1.6,delay:Math.random()*.18});
    document.body.append(canvas); t.node.style.visibility='hidden'; const duration=ctx.motionDuration(850);
    await new Promise(resolve => {
      let start=null, frameId=null, finished=false, release;
      const finish=() => { if(finished)return;finished=true;cancelAnimationFrame(frameId);canvas.remove();t.node.style.visibility='';release?.();resolve(); };
      release=ctx.registerFlight(finish);
      function draw(now) {
        start??=now; const fraction=(now-start)/duration; paint.setTransform(dpr,0,0,dpr,0,0);paint.clearRect(0,0,width,height);
        for(const p of pieces){const f=Math.max(0,Math.min(1,(fraction-p.delay)/(1-p.delay))),ease=f*f;
          paint.save();paint.globalAlpha=Math.pow(1-f,1.5);paint.translate(pad+p.x+p.w/2+p.dx*ease,pad+p.y+p.h/2+p.dy*ease);paint.rotate(p.angle*ease);
          paint.drawImage(bitmap,p.x,p.y,p.w,p.h,-p.w/2,-p.h/2,p.w*(1-f*.3),p.h*(1-f*.3));paint.restore();}
        if(fraction>=1)finish();else frameId=requestAnimationFrame(draw);
      }
      frameId=requestAnimationFrame(draw);
    });
  }
  async function removed(t,animate) {
    if(t.finished)return;t.finished=true;t.state='cancelled';
    if(animate)await dust(t);
    tasks.delete(t.key);ctx.rerender(t.peer);ctx.stateChanged();dispose(t.node);URL.revokeObjectURL(t.url);
  }
  function isBusy() { return tasks.size>0; }
  function init(context) {
    ctx=context;
    if(!downloadListenerInstalled){document.addEventListener('click',downloadClick);downloadListenerInstalled=true;}
    $('attachment-input').addEventListener('change',() => choose($('attachment-input').files[0]));
    $('message-input').addEventListener('paste',paste);
    $('attachment-form').addEventListener('submit',sendSelected);
    $('attachment-close').addEventListener('click',() => ctx.closeModal('attachment-dialog'));
    $('media-close').addEventListener('click',() => ctx.closeModal('media-dialog'));
    $('attachment-as-file').addEventListener('change',selectionTitle);
    $('attachment-caption').addEventListener('keydown',event => { if(event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();$('attachment-form').requestSubmit();} });
    $('attachment-caption').addEventListener('input',() => { const input=$('attachment-caption');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,100)+'px'; });
    for(const emoji of ['😀','😊','😂','🥰','😎','🤔','👍','👎','👏','🙏','❤️','💙','🔥','🎉','✨','👌','👀','🚀']){
      const b=document.createElement('button');b.type='button';b.textContent=emoji;b.setAttribute('aria-label','插入 '+emoji);
      b.addEventListener('click',() => { const input=$('attachment-caption');if(input.value.length+emoji.length<=4000)input.setRangeText(emoji,input.selectionStart,input.selectionEnd,'end');input.focus();input.dispatchEvent(new Event('input')); });$('attachment-emojis').append(b);
    }
    $('attachment-emoji').addEventListener('click',() => { const menu=$('attachment-emojis'),open=menu.hidden;menu.hidden=!open;$('attachment-emoji').setAttribute('aria-expanded',String(open));
      if(open && ctx.motionDuration(200))menu.animate([{opacity:0,transform:'translateY(12px) scale(.9)'},{opacity:1,transform:'none'}],{duration:ctx.motionDuration(200),easing:'cubic-bezier(.2,.8,.2,1)'}); });
    window.addEventListener('online',() => { for(const t of tasks.values())if(t.cancelIntent && !t.finished)cancelTask(t); });
    window.addEventListener('pagehide',() => {
      for(const t of tasks.values()){t.xhr?.abort();if(t.id && !t.finished)fetch('/api/attachments/cancel',{method:'POST',credentials:'same-origin',keepalive:true,
        headers:{...ctx.headers(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:t.id})}).catch(() => {});}
      for(const item of players)item.video.pause();
    });
    const observer=new MutationObserver(() => { for(const item of Array.from(players))if(!item.wrap.isConnected){dispose(item.wrap);} });
    observer.observe(document.body,{childList:true,subtree:true});
    ctx.stateChanged();
  }
  return {init,normalize,renderMessage,pendingNodes,isBusy,onClose,openPicker,urlOf,pausePlayers:()=>{for(const item of players)item.video.pause();}};
})();
