'use strict';
window.chaweReactions = (() => {
  const emojis=['👍','❤️','😂','🔥','🎉','👏','😍','🤔','👎','😢','😮','💯'];
  const $=id=>document.getElementById(id),busy=new Set();
  let ctx,host,trigger,picker,candidate=null,target=null,hoverTimer,hideTimer,pollBusy=false,expanded=false,mutation=0;
  const node=(tag,style)=>{const value=document.createElement(tag);value.className=style;return value;};
  function choices(peer) {
    const group=ctx?.groups.of(peer);
    if(ctx?.groups.isGroup(peer))return !group?.joined || group.reactionMode==='none'?[]:group.reactionMode==='selected'?emojis.filter(emoji=>group.allowedReactions.includes(emoji)):emojis;
    return emojis;
  }
  function eligible(bubble) {
    const state=ctx.getState(),message=ctx.message(Number(bubble?.dataset.seq));
    return state.ready && bubble?.isConnected && state.peer && message && !message.deleted
      && !bubble.classList.contains('is-voice-expired') && choices(state.peer).length;
  }
  function close() {
    clearTimeout(hoverTimer);clearTimeout(hideTimer);candidate=null;target=null;
    hoverTimer=null;hideTimer=null;
    if(host){host.hidden=true;picker.hidden=true;trigger.setAttribute('aria-expanded','false');}
  }
  function position() {
    const bubble=target?.bubble;if(!bubble || !eligible(bubble)){close();return false;}
    const bounds=$('messages').getBoundingClientRect(),box=bubble.getBoundingClientRect();
    if(box.bottom<=bounds.top || box.top>=bounds.bottom){close();return false;}
    const left=Math.max(bounds.left+5,Math.min(box.left-10,bounds.right-34));
    const top=Math.max(bounds.top+5,Math.min(box.bottom-14,bounds.bottom-34));
    host.style.left=left+'px';host.style.top=top+'px';
    const width=Math.min(340,bounds.width-12,innerWidth-20);
    picker.style.width=width+'px';
    picker.style.left=Math.max(bounds.left+6-left,Math.min(0,bounds.right-6-width-left))+'px';
    picker.classList.toggle('opens-below',top-picker.offsetHeight-8<bounds.top);
    return true;
  }
  function choiceButton(emoji,peer,seq,mine) {
    const button=node('button','message-reaction-choice');button.type='button';button.textContent=emoji;
    button.setAttribute('aria-label',(mine?'取消 ':'回应 ')+emoji);button.setAttribute('aria-pressed',String(mine));
    button.addEventListener('click',()=>react(peer,seq,emoji,button));return button;
  }
  function buildPicker() {
    if(!target)return;const message=ctx.message(target.seq),values=choices(target.peer),mine=message?.reactions?.find(value=>value.mine)?.emoji;
    picker.replaceChildren();picker.classList.toggle('is-expanded',expanded);
    for(const emoji of (expanded?values:values.slice(0,6)))picker.append(choiceButton(emoji,target.peer,target.seq,emoji===mine));
    if(values.length>6){const more=node('button','message-reaction-more');more.type='button';more.textContent=expanded?'⌃':'⌄';more.setAttribute('aria-label',expanded?'收起表情':'更多表情');more.setAttribute('aria-expanded',String(expanded));more.addEventListener('click',()=>{expanded=!expanded;buildPicker();position();picker.querySelector('button').focus({preventScroll:true});});picker.append(more);}
  }
  function expand(focus=false) {
    clearTimeout(hideTimer);hideTimer=null;if(!target || !eligible(target.bubble)){close();return;}
    if(picker.hidden){expanded=false;buildPicker();picker.hidden=false;trigger.setAttribute('aria-expanded','true');position();
      const duration=ctx.motionDuration(180);if(duration)picker.animate([{opacity:0,transform:'translateY(6px) scale(.9)'},{opacity:1,transform:'none'}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'});}
    if(focus)picker.querySelector('button')?.focus({preventScroll:true});
  }
  function reveal(bubble,open=false) {
    if(!eligible(bubble))return;
    const state=ctx.getState();target={bubble,peer:state.peer,seq:Number(bubble.dataset.seq),accountId:state.accountId,epoch:state.epoch};
    candidate=bubble;host.hidden=false;picker.hidden=true;trigger.setAttribute('aria-expanded','false');
    const mine=ctx.message(target.seq)?.reactions?.find(value=>value.mine)?.emoji;
    if(mine)trigger.textContent=mine;else trigger.innerHTML='<svg aria-hidden="true"><use href="#i-smile"/></svg>';position();
    const duration=ctx.motionDuration(160);if(duration)trigger.animate([{opacity:0,transform:'scale(.55)'},{opacity:1,transform:'scale(1)'}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'});
    if(open)expand(true);
  }
  function move(event) {
    if(event.pointerType==='touch')return;
    if(event.buttons){close();return;}
    if(host.contains(event.target)){clearTimeout(hideTimer);hideTimer=null;return;}
    const bubble=event.target instanceof Element?event.target.closest('.bubble[data-seq]'):null;
    if(!bubble || !$('messages').contains(bubble) || !eligible(bubble)) {
      clearTimeout(hoverTimer);candidate=null;if(target && !hideTimer)hideTimer=setTimeout(()=>{hideTimer=null;close();},350);return;
    }
    clearTimeout(hideTimer);hideTimer=null;
    if(candidate!==bubble){close();candidate=bubble;hoverTimer=setTimeout(()=>{if(candidate===bubble)reveal(bubble);},2000);}
    if(target?.bubble===bubble){const box=trigger.getBoundingClientRect();if(Math.hypot(event.clientX-(box.left+box.width/2),event.clientY-(box.top+box.height/2))<28)expand();}
  }
  async function react(peer,seq,emoji,button) {
    const state=ctx.getState(),message=ctx.message(seq);
    if(!state.ready || peer!==state.peer || !message || message.deleted || !choices(peer).includes(emoji))return;
    const key=state.accountId+':'+peer+':'+seq;if(busy.has(key))return;
    busy.add(key);mutation++;button.disabled=true;button.classList.add('is-sending');
    try {
      const data=await ctx.post('/api/reactions',{peer,seq:String(seq),emoji,topic:state.topic});
      const current=ctx.getState();if(current.accountId!==state.accountId)return;
      if(current.peer===peer && current.epoch===state.epoch){ctx.applyMessages([data.message]);close();
        const bubble=ctx.nodes().get(seq),chip=Array.from(bubble?.querySelectorAll('.message-reaction-chip') || []).find(value=>value.dataset.emoji===emoji);
        const duration=ctx.motionDuration(260);if(chip && duration)chip.animate([{transform:'scale(.75)'},{transform:'scale(1.15)'},{transform:'scale(1)'}],{duration,easing:'cubic-bezier(.2,.8,.2,1)'});}
    }catch(error){ctx.showStatus(ctx.errorText(error));}
    finally{mutation++;busy.delete(key);button.disabled=false;button.classList.remove('is-sending');}
  }
  function render(bubble,message,peer) {
    let row=bubble.querySelector(':scope > .message-reactions');
    const values=(message.reactions || []).filter(value=>emojis.includes(value.emoji)&&Number.isSafeInteger(value.count)&&value.count>0);
    if(message.deleted || bubble.classList.contains('is-voice-expired') || !values.length){row?.remove();bubble.classList.remove('has-reactions');return;}
    const stamp=JSON.stringify(values);if(row?.dataset.state===stamp)return;
    if(!row){row=node('div','message-reactions');row.setAttribute('aria-label','消息表情回应');bubble.append(row);}
    bubble.classList.add('has-reactions');row.dataset.state=stamp;row.replaceChildren();
    for(const value of values){const button=node('button','message-reaction-chip');button.type='button';button.dataset.emoji=value.emoji;
      const emoji=node('span','message-reaction-emoji'),count=node('span','message-reaction-count');emoji.textContent=value.emoji;count.textContent=String(value.count);button.append(emoji,count);
      button.setAttribute('aria-pressed',String(!!value.mine));button.setAttribute('aria-label',value.emoji+' · '+value.count+' 人回应'+(value.mine?' · 点击取消':' · 点击回应'));
      button.disabled=!choices(peer).includes(value.emoji);button.addEventListener('click',()=>react(peer,message.seq,value.emoji,button));row.append(button);}
  }
  async function poll() {
    if(pollBusy || !ctx)return;const state=ctx.getState();if(!state.ready || !state.peer || document.hidden)return;
    const bounds=$('messages').getBoundingClientRect(),sequences=[];
    for(const [seq,bubble] of ctx.nodes()){const box=bubble.getBoundingClientRect();if(bubble.isConnected&&box.bottom>=bounds.top-80&&box.top<=bounds.bottom+80)sequences.push(seq);}
    if(target?.peer===state.peer&&!sequences.includes(target.seq))sequences.push(target.seq);
    if(!sequences.length)return;pollBusy=true;const version=mutation;
    try{for(let offset=0;offset<sequences.length;offset+=40){
      const data=await ctx.api('/api/reactions?'+new URLSearchParams({peer:state.peer,topic:state.topic,seqs:sequences.slice(offset,offset+40).join(',')}));
      const current=ctx.getState();if(version!==mutation || busy.size || current.peer!==state.peer || current.accountId!==state.accountId || current.epoch!==state.epoch)return;
      ctx.applyStates(data.states || []);
    }}catch{/* The next poll retries transient failures. */}finally{pollBusy=false;}
  }
  function open(menuTarget) {close();if(menuTarget?.peer===ctx.getState().peer)reveal(ctx.nodes().get(menuTarget.seq),true);}
  function refresh() {if(target){const state=ctx.getState();if(state.peer!==target.peer||state.accountId!==target.accountId||state.epoch!==target.epoch)close();else position();}}
  function init(context) {
    if(ctx)return;ctx=context;host=node('div','message-reaction-hover');host.hidden=true;
    trigger=node('button','message-reaction-trigger');trigger.type='button';trigger.setAttribute('aria-label','回应这条消息');trigger.setAttribute('aria-haspopup','true');trigger.setAttribute('aria-expanded','false');
    picker=node('div','message-reaction-picker');picker.hidden=true;picker.setAttribute('role','group');picker.setAttribute('aria-label','选择表情回应');host.append(trigger,picker);document.body.append(host);
    trigger.addEventListener('pointerenter',()=>expand());trigger.addEventListener('focus',()=>expand());trigger.addEventListener('click',()=>expand(true));
    document.addEventListener('pointermove',move,{passive:true});
    document.addEventListener('pointerdown',event=>{if(!host.contains(event.target)&&!event.target.closest('.message-reaction-chip'))close();});
    host.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();$('message-input').focus({preventScroll:true});return;}
      if(!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const buttons=Array.from(picker.querySelectorAll('button:not(:disabled)'));if(!buttons.length)return;
      event.preventDefault();const index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;buttons[next].focus({preventScroll:true});});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!host.hidden)close();});
    $('messages').addEventListener('scroll',close,{passive:true});window.addEventListener('resize',close,{passive:true});window.addEventListener('blur',close);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
  }
  return {init,render,poll,open,refresh,close,choices};
})();
