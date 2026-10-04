'use strict';
window.chawePins=(()=>{
  const $=id=>document.getElementById(id),hiddenVersions=new Map();let ctx,peer=null,rows=[],version=0,canPin=false,request=0,fetching=false,frame=0,current=null,animation=null,busy=false,jumpCenter=0,jumpTimer;
  const key=()=>['chawe-hidden-pins-v1',ctx.accountId(),peer,ctx.groups.topicOf(peer)].join(':');
  const summary=m=>m.attachment?(m.attachment.kind==='image'?'图片':m.attachment.kind==='video'?'视频':m.attachment.kind.startsWith('voice')?'语音':m.attachment.kind==='article'?'文章':'文件')+(m.attachment.name?' · '+m.attachment.name:''):m.text;
  function hidden(){if(hiddenVersions.get(key())===version)return true;try{return localStorage.getItem(key())===String(version);}catch{return false;}}
  function center(){if(jumpCenter)return jumpCenter;const box=$('messages').getBoundingClientRect(),middle=box.top+box.height/2;let nearest=null,distance=Infinity;
    for(const [seq,node]of ctx.nodes()){if(!node.isConnected)continue;const r=node.getBoundingClientRect(),d=middle<r.top?r.top-middle:middle>r.bottom?middle-r.bottom:0;if(d<distance){distance=d;nearest=seq;}}
    return nearest || ctx.entries().at(-1)?.seq || Infinity;
  }
  function paintIndicator(index,total,appearing){
    const indicator=$('pinned-indicator'),track=$('pinned-indicator-track');if(!indicator||!track)return;
    const visible=Math.min(total,4),height=(38-(visible-1)*3)/visible;
    const first=Math.max(0,Math.min(total-visible,index-1-Math.floor((visible-1)/2)));
    if(indicator.dataset.count!==String(total)){
      const segments=document.createDocumentFragment();for(let i=0;i<total;i++){const segment=document.createElement('span');segment.className='pinned-indicator-segment';segments.append(segment);}
      track.replaceChildren(segments);indicator.dataset.count=String(total);indicator.style.setProperty('--pin-segment-height',height+'px');
    }
    indicator.style.setProperty('--pin-indicator-duration',ctx.motionDuration(280)+'ms');track.style.transitionDuration=(appearing?0:ctx.motionDuration(280))+'ms';
    for(let i=0;i<track.children.length;i++)track.children[i].classList.toggle('is-active',i===index-1);
    track.style.transform='translateY(-'+first*(height+3)+'px)';
    $('pinned-jump').setAttribute('aria-label','置顶消息 '+index+'，共 '+total+' 条；点击跳转');
  }
  function paint(){frame=0;if(!ctx)return;const host=$('pinned-banner');if(!peer||!rows.length||hidden()||!ctx.ready()){host.hidden=true;current=null;return;}
    const midpoint=center(),message=rows.filter(m=>m.seq<midpoint).at(-1) || rows[0],index=rows.findIndex(m=>m.seq===message.seq)+1;
    const signature=[peer,message.seq,message.revision || 0,summary(message),index,rows.length].join('|'),appearing=host.hidden,log=$('messages'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<80;
    host.hidden=false;current=message;if(appearing){if(atBottom)log.scrollTop=log.scrollHeight;schedule();}
    paintIndicator(index,rows.length,appearing);
    if($('pinned-content').dataset.signature===signature)return;
    const content=$('pinned-content');animation?.cancel();content.dataset.signature=signature;
    const title=document.createElement('strong'),text=document.createElement('span');title.textContent='置顶消息 #'+index;text.textContent=summary(message);content.replaceChildren(title,text);
    if(ctx.motionDuration(280))animation=content.animate([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:ctx.motionDuration(280),easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  function schedule(){if(ctx&&!frame)frame=requestAnimationFrame(paint);}
  function apply(data){version=data.version;canPin=data.canPin;rows=(data.messages || []).sort((a,b)=>a.seq-b.seq);schedule();}
  function changed(updates){const known=new Map(updates.map(m=>[m.seq,m]));rows=rows.map(m=>known.get(m.seq)||m).filter(m=>!m.deleted);schedule();}
  function activate(next){peer=next;rows=[];current=null;version=0;canPin=!ctx?.groups.isGroup(next);fetching=false;++request;clearTimeout(jumpTimer);jumpCenter=0;$('pinned-banner').hidden=true;if(next&&ctx)refresh();}
  async function refresh(){if(!ctx||!peer||fetching)return;const selected=peer,epoch=++request,topic=ctx.groups.topicOf(peer);fetching=true;
    try{const data=await ctx.api('/api/pins?'+new URLSearchParams({peer:selected,topic}));if(epoch===request&&peer===selected&&ctx.groups.topicOf(peer)===topic)apply(data);}
    catch{}finally{if(epoch===request){fetching=false;$('pin-selected-message').disabled=busy;}}
  }
  function menu(message){const group=ctx.groups.of(peer),allowed=group?ctx.groups.canManage(group,'pinMessages')||ctx.groups.can(group,'pinMessages'):canPin;
    $('pin-selected-message').hidden=!allowed||message.attachment?.kind==='voice-once';$('pin-selected-message').disabled=busy||fetching;$('pin-selected-label').textContent=rows.some(m=>m.seq===message.seq)?'取消置顶':'置顶消息';
  }
  async function toggle(target){if(busy||target.peer!==peer)return;busy=true;const selected=peer,pinned=!rows.some(m=>m.seq===target.seq),topic=ctx.groups.topicOf(peer);
    try{const data=await ctx.post('/api/pins',{peer:selected,seq:target.seq,pinned:String(pinned),topic});if(selected===peer&&ctx.groups.topicOf(peer)===topic){hiddenVersions.delete(key());try{localStorage.removeItem(key());}catch{}apply(data);}ctx.showStatus(pinned?'消息已置顶。':'已取消置顶。');}
    catch(error){ctx.showStatus(ctx.errorText(error));}finally{busy=false;}
  }
  async function jump(message=current){if(!message||busy||!peer)return;busy=true;const selected=peer;
    try{await ctx.jump(selected,message);if(peer===selected){jumpCenter=message.seq;paint();clearTimeout(jumpTimer);jumpTimer=setTimeout(()=>{jumpCenter=0;schedule();},ctx.motionDuration(550)+100);}}
    catch(error){ctx.showStatus(ctx.errorText(error));}finally{busy=false;}
  }
  function list(){if(!peer)return;const host=$('pins-list-content');host.replaceChildren();for(const message of rows.slice().reverse()){
      const b=document.createElement('button');b.className='pins-list-row';b.type='button';const title=document.createElement('strong'),copy=document.createElement('span');title.textContent=new Date(message.time).toLocaleString('zh-CN',{hour12:false});copy.textContent=summary(message);b.append(title,copy);b.addEventListener('click',()=>{ctx.closeModal('pins-dialog');jump(message);});host.append(b);
    }ctx.openModal('pins-dialog');}
  function init(context){ctx=context;$('pinned-jump').addEventListener('click',()=>jump());$('pinned-list').addEventListener('click',list);$('pins-list-close').addEventListener('click',()=>ctx.closeModal('pins-dialog'));
    $('pinned-close').addEventListener('click',()=>{hiddenVersions.set(key(),version);try{localStorage.setItem(key(),String(version));}catch{}$('pinned-banner').hidden=true;current=null;});$('messages').addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule,{passive:true});}
  return {init,activate,refresh,schedule,menu,toggle,changed};
})();
