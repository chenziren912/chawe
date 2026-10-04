'use strict';
// Shared by auth and chat, including dynamically mounted dialogs and long textareas.
// Rails are portals so replacing message/list children cannot delete them or change scrollHeight.
window.chaweScrollbars = (() => {
  const entries = new Map();
  let frame = 0, scanAll = true, animateUntil = 0;
  const pending = new Set();
  const scrollable = value => /^(auto|scroll|overlay)$/.test(value);
  const isRail = node => node instanceof Element && !!node.closest('.chawe-scrollbar');
  function refresh() { if (!frame && !document.hidden) frame = requestAnimationFrame(paint); }
  function settle() { animateUntil = performance.now() + 900; refresh(); }
  function discover(node) {
    if (!(node instanceof Element) || isRail(node)) return;
    if (node === document.scrollingElement || node.matches('script,style,link,meta,svg,svg *,video,img,canvas')) return;
    const style = getComputedStyle(node);
    if (scrollable(style.overflowX) || scrollable(style.overflowY)) register(node);
  }
  function scan(node) {
    discover(node);
    if (node instanceof Element && !isRail(node)) for (const child of node.querySelectorAll('*')) discover(child);
  }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  function register(element) {
    if (entries.has(element)) return;
    const entry = {element,bars:{},drag:null,addedTab:false,keyboard:false}; entries.set(element,entry);
    resize?.observe(element);
  }
  function maximum(entry,axis) {
    const e = entry.element;
    return Math.max(0,axis === 'y' ? e.scrollHeight-e.clientHeight : e.scrollWidth-e.clientWidth);
  }
  function position(entry,axis) { return axis === 'y' ? entry.element.scrollTop : entry.element.scrollLeft; }
  function move(entry,axis,value) {
    value = Math.max(0,Math.min(maximum(entry,axis),value));
    if (axis === 'y') entry.element.scrollTop = value; else entry.element.scrollLeft = value;
    refresh();
  }
  function cancelDrag(entry) {
    const drag = entry.drag; entry.drag = null;
    if (!drag) return;
    drag.bar.rail.classList.remove('is-dragging');
    if (drag.bar.rail.hasPointerCapture(drag.id)) drag.bar.rail.releasePointerCapture(drag.id);
  }
  function createBar(entry,axis) {
    const rail = document.createElement('div'), thumb = document.createElement('span');
    rail.className = 'chawe-scrollbar'; rail.dataset.axis = axis; rail.hidden = true;
    rail.setAttribute('aria-hidden','true'); thumb.className = 'chawe-scrollbar-thumb'; rail.append(thumb);
    document.body.append(rail);
    const bar = {rail,thumb,travel:0,size:0}; entry.bars[axis] = bar;
    rail.addEventListener('pointerdown',event => {
      if (event.button !== 0 || !event.isPrimary || rail.hidden || !bar.travel) return;
      event.preventDefault(); event.stopPropagation();
      const box = rail.getBoundingClientRect(), coordinate = axis === 'y' ? event.clientY : event.clientX;
      const start = axis === 'y' ? box.top : box.left;
      const offset = position(entry,axis)/maximum(entry,axis)*bar.travel;
      if (coordinate-start < offset || coordinate-start > offset+bar.size)
        move(entry,axis,(coordinate-start-bar.size/2)/bar.travel*maximum(entry,axis));
      cancelDrag(entry);
      entry.drag = {id:event.pointerId,bar,axis,start:coordinate,scroll:position(entry,axis)};
      rail.classList.add('is-dragging'); rail.setPointerCapture(event.pointerId);
      // Keep focus inside the real dialog/menu, where keyboard scrolling also works.
      if (entry.element !== document.scrollingElement) entry.element.focus({preventScroll:true});
    });
    rail.addEventListener('pointermove',event => {
      const drag = entry.drag;
      if (!drag || drag.id !== event.pointerId || drag.bar !== bar) return;
      event.preventDefault();
      const coordinate = axis === 'y' ? event.clientY : event.clientX;
      move(entry,axis,drag.scroll+(coordinate-drag.start)*maximum(entry,axis)/Math.max(1,bar.travel));
    });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) rail.addEventListener(type,() => cancelDrag(entry));
    rail.addEventListener('click',event => { event.preventDefault(); event.stopPropagation(); });
    rail.addEventListener('contextmenu',event => { event.preventDefault(); event.stopPropagation(); });
    rail.addEventListener('wheel',event => {
      event.preventDefault(); event.stopPropagation();
      const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? entry.element.clientHeight : 1;
      const delta = axis === 'y' ? event.deltaY : event.deltaX || event.deltaY;
      move(entry,axis,position(entry,axis)+delta*unit);
    },{passive:false});
    return bar;
  }
  function bounds(element) {
    const root = element === document.scrollingElement;
    if (!root && (!element.getClientRects().length || element.closest('[hidden],[inert]'))) return null;
    const rect = root ? {left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight} : element.getBoundingClientRect();
    const sx = root ? 1 : rect.width/(element.offsetWidth || rect.width), sy = root ? 1 : rect.height/(element.offsetHeight || rect.height);
    const box = {left:rect.left+(root ? 0 : element.clientLeft*sx),top:rect.top+(root ? 0 : element.clientTop*sy),
      right:root ? rect.right : rect.left+(element.clientLeft+element.clientWidth)*sx,
      bottom:root ? rect.bottom : rect.top+(element.clientTop+element.clientHeight)*sy};
    const viewport = window.visualViewport;
    const clip = {left:viewport?.offsetLeft || 0,top:viewport?.offsetTop || 0,
      right:viewport ? viewport.offsetLeft+viewport.width : innerWidth,
      bottom:viewport ? viewport.offsetTop+viewport.height : innerHeight};
    let z = 1;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .02) return null;
      // Avoid a detached rail during a sliding/scaling panel's transition.
      if (node.getAnimations().some(animation => animation.playState === 'running' &&
          animation.effect?.getKeyframes().some(key => key.transform != null))) return null;
      const index = Number.parseInt(style.zIndex,10); if (Number.isFinite(index)) z = Math.max(z,index+1);
      if (node === element) continue;
      if (node !== document.body && node !== document.documentElement) {
        const ancestor = node.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)) {
          clip.left = Math.max(clip.left,ancestor.left); clip.right = Math.min(clip.right,ancestor.right);
        }
        if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)) {
          clip.top = Math.max(clip.top,ancestor.top); clip.bottom = Math.min(clip.bottom,ancestor.bottom);
        }
      }
    }
    return {box,clip,z};
  }
  function hide(entry,axis) {
    const bar = entry.bars[axis]; if (!bar) return;
    if (entry.drag?.bar === bar) cancelDrag(entry);
    bar.rail.hidden = true;
  }
  function paintBar(entry,axis,geometry,enabled,otherEnabled) {
    const max = maximum(entry,axis);
    if (!geometry || !enabled || max <= 1) { hide(entry,axis); return; }
    const {box,clip,z} = geometry, vertical = axis === 'y';
    const edge = (vertical ? box.right : box.bottom)-15;
    // Do not move an offscreen container's rail into the middle of its parent.
    if (vertical ? edge < clip.left || edge+14 > clip.right : edge < clip.top || edge+14 > clip.bottom) { hide(entry,axis); return; }
    const start = Math.max(vertical ? box.top : box.left,vertical ? clip.top : clip.left)+5;
    const end = Math.min(vertical ? box.bottom : box.right,vertical ? clip.bottom : clip.right)-5-(otherEnabled ? 14 : 0);
    const length = end-start;
    if (length < 32) { hide(entry,axis); return; }
    const bar = entry.bars[axis] || createBar(entry,axis), e = entry.element;
    const client = vertical ? e.clientHeight : e.clientWidth, total = vertical ? e.scrollHeight : e.scrollWidth;
    bar.size = Math.min(length-8,Math.max(28,Math.min(88,length*client/total))); bar.travel = length-bar.size;
    bar.rail.hidden = false;
    Object.assign(bar.rail.style,{left:(vertical ? edge : start)+'px',top:(vertical ? start : edge)+'px',
      [vertical ? 'height' : 'width']:length+'px',zIndex:String(z)});
    bar.thumb.style[vertical ? 'height' : 'width'] = bar.size+'px';
    bar.thumb.style.transform = 'translate'+(vertical ? 'Y' : 'X')+'('+Math.max(0,Math.min(1,position(entry,axis)/max))*bar.travel+'px)';
    if (!entry.addedTab && !e.hasAttribute('tabindex') && !e.matches('textarea,input,button,a,html,body')) {
      e.tabIndex = 0; entry.addedTab = true; e.classList.add('chawe-scroll-viewport');
    }
    if (!entry.keyboard && !e.matches('textarea,input,button,a,html,body')) {
      entry.keyboard = true;
      e.addEventListener('keydown',event => {
        if (event.target !== e || event.altKey || event.ctrlKey || event.metaKey) return;
        const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y';
        const page = (axis === 'y' ? e.clientHeight : e.clientWidth)*.85;
        const targets = {ArrowDown:e.scrollTop+40,ArrowUp:e.scrollTop-40,ArrowLeft:e.scrollLeft-40,
          ArrowRight:e.scrollLeft+40,PageDown:e.scrollTop+page,PageUp:e.scrollTop-page,Home:0,End:maximum(entry,axis)};
        if (!(event.key in targets) || maximum(entry,axis) <= 1) return;
        event.preventDefault(); event.stopPropagation(); move(entry,axis,targets[event.key]);
      });
    }
  }
  function paint() {
    frame = 0;
    if (scanAll) { scanAll = false; scan(document.body); }
    for (const node of pending) scan(node); pending.clear();
    let transitioning = false;
    for (const [element,entry] of entries) {
      if (!element.isConnected) {
        cancelDrag(entry); resize?.unobserve(element);
        for (const bar of Object.values(entry.bars)) bar.rail.remove();
        entries.delete(element); continue;
      }
      const style = getComputedStyle(element), root = element === document.scrollingElement;
      const bodyStyle = root ? getComputedStyle(document.body) : null;
      const rootX = root && !/hidden|clip/.test(style.overflowX) && !/hidden|clip/.test(bodyStyle.overflowX);
      const rootY = root && !/hidden|clip/.test(style.overflowY) && !/hidden|clip/.test(bodyStyle.overflowY);
      const x = (rootX || !root && scrollable(style.overflowX)) && maximum(entry,'x') > 1;
      const y = (rootY || !root && scrollable(style.overflowY)) && maximum(entry,'y') > 1;
      const geometry = x || y ? bounds(element) : null;
      paintBar(entry,'y',geometry,y,x); paintBar(entry,'x',geometry,x,y);
      if ((x || y) && element.getClientRects().length && !element.closest('[hidden],[inert]') && !geometry) transitioning = true;
    }
    if (performance.now() < animateUntil || transitioning && document.getAnimations().some(a => a.playState === 'running')) refresh();
  }
  const observer = new MutationObserver(records => {
    let changed = false, transitioning = false;
    for (const record of records) {
      if (isRail(record.target)) continue;
      changed = true;
      if (record.type === 'attributes') { discover(record.target); transitioning = true; }
      else for (const node of record.addedNodes) if (node instanceof Element && !isRail(node)) pending.add(node);
    }
    if (changed) { if (transitioning) settle(); else refresh(); }
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','inert','open'],characterData:true});
  register(document.scrollingElement);
  document.addEventListener('scroll',refresh,{capture:true,passive:true});
  document.addEventListener('input',refresh,{capture:true,passive:true});
  document.addEventListener('load',refresh,{capture:true,passive:true});
  document.addEventListener('transitionrun',settle,{capture:true,passive:true});
  document.addEventListener('transitionend',refresh,{capture:true,passive:true});
  document.addEventListener('animationstart',settle,{capture:true,passive:true});
  document.addEventListener('animationend',refresh,{capture:true,passive:true});
  window.addEventListener('resize',() => { scanAll = true; settle(); });
  window.visualViewport?.addEventListener('resize',refresh);
  window.visualViewport?.addEventListener('scroll',refresh);
  document.fonts?.ready.then(refresh);
  document.addEventListener('visibilitychange',() => {
    if (document.hidden) { if (frame) cancelAnimationFrame(frame); frame = 0; for (const entry of entries.values()) cancelDrag(entry); }
    else settle();
  });
  settle();
  return {refresh};
})();
