'use strict';
window.chaweGroups = (() => {
  const $ = id => document.getElementById(id), groups = new Map(), selectedTopics = new Map();
  const permissions = {text:'发送文字消息',photos:'发送图片',videos:'发送视频',files:'发送文件',voice:'发送语音',articles:'发送文章',addMembers:'添加成员',changeInfo:'修改群资料',topics:'创建话题',pinMessages:'置顶消息'};
  const rights = {changeInfo:'修改群资料和设置',deleteMessages:'删除他人消息',inviteUsers:'邀请成员及管理链接',banUsers:'移除成员',manageTopics:'管理话题',pinMessages:'管理置顶消息'};
  const emojis = ['👍','❤️','😂','🔥','🎉','👏','😍','🤔','👎','😢','😮','💯'];
  let ctx, creation = null, editing = null, page = 'main', pageData = null, draft = null, busy = false, confirmation = null, filterFocus = false;
  let mutationBusy = false, pollBusy = false, renderHost = null, settingsSheet = null;
  const sheetAnimations = new Set(), sheetScroll = new Map();
  const node = (tag,cls,text) => { const element=document.createElement(tag); if(cls)element.className=cls;if(text!==undefined)element.textContent=text;return element; };
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  const isGroup = peer => /^group:[a-f0-9]{32}$/.test(peer || '');
  const of = peer => groups.get(isGroup(peer)?peer.slice(6):peer);
  const topicOf = peer => isGroup(peer)?selectedTopics.get(peer.slice(6)) || 'general':'general';
  const canManage = (g,right) => !!g?.joined && (g.superAdmin || g.myRole==='owner' || g.myRole==='admin' && g.myRights.includes(right));
  const can = (g,permission) => {if(!g?.joined)return false;const right={changeInfo:'changeInfo',addMembers:'inviteUsers',topics:'manageTopics',pinMessages:'pinMessages'}[permission];return g.superAdmin||g.myRole==='owner'||g.permissions.includes(permission)||g.myRole==='admin'&&(!right||g.myRights.includes(right));};
  const current = () => groups.get(editing);
  const creationContacts = () => creation?.contacts || ctx.contacts();
  const icon = name => '<svg aria-hidden="true"><use href="#i-'+name+'"/></svg>';
  const errorCopy = error => ({group_invite_changed:'这条链接的设置已被修改，已重新载入，请确认后再保存。',
    group_invite_limit_below_used:'人数上限不能小于已使用次数，0 表示不限；请按最新用量重新设置。',
    group_invite_settings_invalid:'有效天数须为 0–3650，人数上限须为 0–100000。'})[error.message] || ctx.errorText(error);
  function selectionCheck() {
    const check=node('span','group-selection-check');check.setAttribute('aria-hidden','true');
    check.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 13 4 4L19 7"/></svg>';return check;
  }
  function button(label,name,action,cls='group-row') {
    const result=node('button',cls);result.type='button';if(name){const mark=node('span','group-row-icon');mark.innerHTML=icon(name);result.append(mark);}
    result.append(node('span','group-row-label',label));result.addEventListener('click',action);return result;
  }
  function textField(label,value,maximum,multiline=false) {
    const wrap=node('label','group-field'), input=node(multiline?'textarea':'input');
    if(!multiline)input.type='text';else input.rows=3;
    input.value=value || '';input.maxLength=maximum*2;const counter=node('small','group-field-counter');
    const count=()=>{const points=Array.from(input.value);if(points.length>maximum)input.value=points.slice(0,maximum).join('');counter.textContent=Array.from(input.value).length+'/'+maximum;};
    input.addEventListener('input',count);count();wrap.append(node('span','group-field-label',label),input,counter);return {wrap,input};
  }
  function choices(label,options,value,onChange) {
    const host=node('div','group-choices');host.setAttribute('role','group');host.setAttribute('aria-label',label);
    for(const [key,title,description] of options){
      const row=button(title,null,()=>{value=key;paint();onChange(key);},'group-choice');row.dataset.value=key;
      const mark=node('span','group-choice-mark');mark.setAttribute('aria-hidden','true');row.prepend(mark);
      if(description)row.querySelector('.group-row-label').append(node('small','',description));host.append(row);
    }
    function paint(){for(const row of host.children)row.setAttribute('aria-pressed',String(row.dataset.value===value));}paint();return host;
  }
  function checkbox(label,checked,change,disabled=false) {
    const wrap=node('label','settings-toggle group-toggle'), copy=node('span','setting-copy'),input=node('input');
    copy.append(node('strong','',label));input.type='checkbox';input.checked=checked;input.disabled=disabled;input.addEventListener('change',()=>change(input.checked));
    wrap.append(copy,input,node('span','setting-switch'));return wrap;
  }
  function note(text,cls='group-note'){return node('p',cls,text);}
  function creationError(error){ctx.showStatus(ctx.errorText(error));if(creation){creation.error=ctx.errorText(error);ctx.panel()==='group-preview'?renderPreview():renderSelection();}}
  function memberRow(person,role,action){
    const row=button('',null,action,'group-member-row');row.replaceChildren(ctx.avatar(person.username,false,true));
    const copy=node('span','group-member-copy');copy.append(node('strong','',person.username===ctx.account()?ctx.myName():ctx.title(person.username)),node('small','',role || '@'+person.username));row.append(copy);return row;
  }
  function remember(values){
    for(const g of values || [])if(g?.kind==='group' && /^[a-f0-9]{32}$/.test(g.id)){
      if((groups.get(g.id)?.version || 0)>g.version)continue;groups.set(g.id,g);ctx?.rememberPeople(g.members || []);
      if(!g.topicsEnabled || !g.topics.some(t=>t.id===topicOf('group:'+g.id)))selectedTopics.set(g.id,'general');
    }
  }
  function paintAvatar(target,g,url='') {
    target.replaceChildren(node('span','avatar-initial',(Array.from(g?.name || '群')[0] || '群').toUpperCase()));
    if(url || g?.avatarUrl){const image=node('img');image.alt='';image.src=url || g.avatarUrl;image.addEventListener('error',()=>image.remove(),{once:true});target.append(image);}
  }
  function paintPhoto(target,g,url=''){paintAvatar(target,g,url);if(!url&&!g?.avatarUrl)target.innerHTML=icon('group-camera');}
  function appearance(enabled){filterFocus=enabled;ctx.filterAppearance(enabled);}
  function filterSearch(){return ['group-select','group-add'].includes(ctx?.panel());}
  function searchFocus(){if(!filterSearch())return false;appearance(true);return true;}
  function filter(value){if(!filterSearch())return false;creation.query=value.trim().toLowerCase();renderSelection();return true;}
  function clearFilter(){if(!filterFocus)return false;appearance(false);$('search').value='';if(creation){creation.query='';renderSelection();}$('search').blur();return true;}
  function confirm(options){
    confirmation?.cleanup?.();
    confirmation=options;$('group-confirm-title').textContent=options.title;$('group-confirm-copy').textContent=options.copy || '';
    $('group-confirm-submit').textContent=options.label || '确认';$('group-confirm-submit').classList.toggle('danger-action',!!options.danger);
    $('group-confirm-input-wrap').hidden=!options.input;$('group-confirm-input').value=options.value || '';
    $('group-confirm-input').maxLength=(options.max || 80)*2;$('group-confirm-input-label').textContent=options.input || '';
    $('group-confirm-extra').replaceChildren();if(options.extra)$('group-confirm-extra').append(options.extra);
    $('group-confirm-error').hidden=true;$('group-confirm-submit').disabled=false;$('group-confirm-cancel').disabled=false;
    ctx.openModal('group-confirm-dialog');if(options.input)$('group-confirm-input').focus({preventScroll:true});
  }
  async function submitConfirm(){
    const task=confirmation;if(!task || busy)return;busy=true;$('group-confirm-submit').disabled=true;$('group-confirm-cancel').disabled=true;ctx.changed();
    try{await task.action($('group-confirm-input').value);ctx.closeModal('group-confirm-dialog');confirmation=null;}
    catch(error){$('group-confirm-error').textContent=ctx.errorText(error);$('group-confirm-error').hidden=false;}
    finally{busy=false;$('group-confirm-submit').disabled=false;$('group-confirm-cancel').disabled=false;ctx.changed();}
  }
  async function crop(file){
    if(file.size>10*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('invalid_avatar');
    const image=await createImageBitmap(file);try{const size=Math.min(image.width,image.height),canvas=document.createElement('canvas');canvas.width=canvas.height=512;
      canvas.getContext('2d').drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,512,512);
      return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('invalid_avatar')),'image/png'));}finally{image.close();}
  }
  function chooseAvatar(mode){$('group-avatar-input').dataset.mode=mode;$('group-avatar-input').value='';$('group-avatar-input').click();}
  async function avatarSelected(){
    const file=$('group-avatar-input').files[0],mode=$('group-avatar-input').dataset.mode;if(!file || busy)return;
    try{const blob=await crop(file),url=URL.createObjectURL(blob),image=node('img','group-confirm-photo');image.src=url;image.alt='群头像预览';
      confirm({title:'设置这张群头像？',copy:'头像会自动裁切为 512 × 512。',label:'确认设置',extra:image,cleanup:()=>URL.revokeObjectURL(url),action:async()=>{
        if(mode==='create'){if(creation.avatarUrl)URL.revokeObjectURL(creation.avatarUrl);creation.avatar=blob;creation.avatarUrl=URL.createObjectURL(blob);renderPreview();}
        else {const g=current(),data=await ctx.api('/api/groups/avatar?'+new URLSearchParams({id:g.id,version:g.version}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob});remember([data]);ctx.refresh();showPage('main');}
      }});
    }catch(error){creation?creationError(error):ctx.showStatus(ctx.errorText(error));}
  }
  function disposeCreation(){if(creation?.avatarUrl)URL.revokeObjectURL(creation.avatarUrl);creation=null;appearance(false);}
  async function startCreation(mode='create',group=null,resumeDraft=null){
    if(ctx.isBusy())return;ctx.closeMenus();disposeCreation();creation={mode,group,resumeDraft,id:id(),selected:new Set(),name:'',query:'',avatar:null,avatarUrl:'',busy:false,loading:true,error:'',contacts:ctx.contacts().slice(),contactRequest:0};
    ctx.setPanel(mode==='create'?'group-select':'group-add');$('group-select-title').textContent=mode==='create'?'添加群成员':'添加成员';
    $('group-select-copy').textContent='从你的联系人中选择成员';renderSelection();await refreshCreationContacts();
  }
  async function refreshCreationContacts(){
    const c=creation;if(!c||c.busy)return;const request=++c.contactRequest;c.loading=true;c.error='';renderSelection();
    try{const people=await ctx.loadContacts();if(creation===c&&request===c.contactRequest){c.contacts=people;ctx.rememberPeople(people);}}
    catch(error){if(creation===c&&request===c.contactRequest)c.error=ctx.errorText(error);}
    finally{if(creation===c&&request===c.contactRequest){c.loading=false;renderSelection();}}
  }
  function selectionControls(){
    if(!creation)return;$('group-select-list').setAttribute('aria-busy',String(creation.loading));
    $('group-selected-count').textContent='已选择 '+creation.selected.size+' 人';
    $('group-selection-next').disabled=!creation.selected.size || creation.busy || creation.loading || !!creation.error;
    $('group-selection-next').dataset.mode=creation.busy||creation.loading?'loading':'ready';
    $('group-selection-next').setAttribute('aria-label',creation.mode==='add'?'添加所选成员':'下一步：群聊预览');
  }
  function renderSelection(){
    if(!creation)return;const list=$('group-select-list'),scroll=list.scrollTop;list.replaceChildren();
    const existing=new Set(creation.group?.members.map(m=>m.id) || []),query=creation.query;
    const people=creationContacts().filter(p=>p.username!==ctx.account()&&!existing.has(p.id)&&!p.blockedByMe && (!query || ctx.title(p.username).toLowerCase().includes(query) || p.username.toLowerCase().includes(query)));
    for(const person of people){const selected=creation.selected.has(person.id),row=memberRow(person,'@'+person.username,()=>{
      if(creation.busy||creation.loading)return;const on=creation.selected.has(person.id);on?creation.selected.delete(person.id):creation.selected.add(person.id);
      row.classList.toggle('is-selected',!on);row.setAttribute('aria-pressed',String(!on));selectionControls();
    });row.classList.toggle('is-selected',selected);row.setAttribute('aria-pressed',String(selected));row.append(selectionCheck());row.disabled=creation.busy||creation.loading;list.append(row);}
    if(!people.length&&!creation.loading&&!creation.error)list.append(note(creationContacts().length?'没有符合条件的联系人':'还没有可添加的联系人'));
    if(creation.error)list.append(note(creation.error,'dialog-error'),button('重新加载联系人',null,()=>refreshCreationContacts()));
    selectionControls();list.scrollTop=scroll;
  }
  async function nextCreation(){
    if(!creation || creation.busy || creation.loading || creation.error || !creation.selected.size)return;
    if(creation.mode==='add'){
      const c=creation;c.busy=true;renderSelection();try{const data=await ctx.post('/api/groups/members/add',{id:c.group.id,members:Array.from(c.selected).join(',')});remember([data]);disposeCreation();ctx.setPanel('chats');await ctx.refresh();openSettings('group:'+data.id,'members',c.resumeDraft);}
      catch(error){if(creation)creation.busy=false;creationError(error);}return;
    }
    const people=creationContacts().filter(p=>creation.selected.has(p.id));if(!creation.name)creation.name=[ctx.myName(),...people.slice(0,2).map(p=>ctx.title(p.username))].join('、')+'的群组';
    creation.name=Array.from(creation.name).slice(0,128).join('');ctx.setPanel('group-preview');renderPreview();$('group-name-input').focus({preventScroll:true});
  }
  function renderPreview(){
    if(!creation)return;$('group-name-input').value=creation.name;paintPhoto($('group-create-avatar'),{name:creation.name},creation.avatarUrl);
    const list=$('group-preview-members');list.replaceChildren();const me=ctx.me();list.append(memberRow(me,'群主 · 你',()=>{}));
    for(const person of creationContacts().filter(p=>creation.selected.has(p.id)))list.append(memberRow(person,'@'+person.username,()=>{}));
    if(creation.error)list.append(note(creation.error,'dialog-error'));
    $('group-preview-count').textContent=(creation.selected.size+1)+' 位成员';$('group-create-submit').disabled=creation.busy || !creation.name.trim();
    $('group-create-submit').dataset.mode=creation.busy?'loading':'ready';$('group-name-input').disabled=creation.busy;$('group-create-photo').disabled=creation.busy;
  }
  async function createGroup(){
    const c=creation;if(!c || c.busy || !c.name.trim())return;c.busy=true;renderPreview();
    try{let data=await ctx.post('/api/groups/create',{id:c.id,name:c.name,members:Array.from(c.selected).join(',')});remember([data]);
      if(c.avatar)try{data=await ctx.api('/api/groups/avatar?'+new URLSearchParams({id:data.id,version:data.version}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:c.avatar});remember([data]);}
      catch(error){ctx.showStatus('群聊已创建，头像未保存，可在群设置中重试。');}
      disposeCreation();ctx.setPanel('chats');await ctx.openChat('group:'+data.id);ctx.refresh();
    }catch(error){if(creation===c)c.busy=false;creationError(error);}
  }
  function creationBack(){if(creation?.busy)return;if(ctx.panel()==='group-preview'){creation.query='';ctx.setPanel('group-select');renderSelection();}else{const c=creation,group=c?.mode==='add'?c.group:null;disposeCreation();ctx.setPanel('chats');if(group)openSettings('group:'+group.id,'members',c.resumeDraft);}}
  function panelId(name){return name==='group-select'||name==='group-add'?'group-select-panel':name==='group-preview'?'group-preview-panel':null;}
  function panelChanged(name){if(!filterSearch())appearance(false);if(!panelId(name)){if(creation && !creation.busy)disposeCreation();}}
  function joinDialog(g,token=''){
    const extra=node('div','group-join-preview'),portrait=node('span','avatar');paintAvatar(portrait,g);extra.append(portrait,note(g.memberCount+' 位成员'));
    confirm({title:'加入「'+g.name+'」？',copy:g.description || '加入后可以与群内成员交流。',label:'加入群聊',extra,action:async()=>{
      const data=await ctx.post('/api/groups/join',{id:g.id,token});remember([data]);ctx.closeModal('group-confirm-dialog');await ctx.openChat('group:'+data.id);ctx.refresh();
    }});
  }
  async function handleInvite(token){if(!/^[a-f0-9]{32}$/.test(token || ''))return;try{const g=await ctx.api('/api/groups/invite?token='+token);remember([g]);if(g.joined)await ctx.openChat('group:'+g.id);else joinDialog(g,token);}catch(error){ctx.showStatus(ctx.errorText(error));}}

  function closeSettings(immediate=false){if((busy||mutationBusy)&&!immediate)return;ctx.setPopup('group-settings',false,'translateX(calc(100% + 16px))',360,immediate);ctx.profileAccess();editing=null;draft=null;}
  function openSettings(peer,initial='main',resumeDraft=null){const g=of(peer);if(!g?.joined||busy)return;ctx.closeMenus();ctx.closeProfile();editing=g.id;draft=resumeDraft || {name:g.name,description:g.description};sheetScroll.clear();showPage(initial,false);ctx.setPopup('group-settings',true,'translateX(calc(100% + 16px))',360);ctx.profileAccess();$('group-settings-back').focus({preventScroll:true});}
  function backSettings(){if(busy)return;if(page==='main')closeSettings();else showPage(page==='admin'?'admins':page==='invite'||page==='invite-create'?'invites':'main');}
  function finishSheetMotion(){for(const animation of sheetAnimations)animation.cancel();sheetAnimations.clear();for(const child of Array.from($('group-settings-content').children))if(child!==settingsSheet)child.remove();}
  async function mutate(action,values={}){if(mutationBusy)throw Error('group_changed');const wasBusy=busy;mutationBusy=true;busy=true;ctx.changed();$('group-settings').classList.add('is-busy');
    try{const data=await ctx.post('/api/groups/'+action,{id:editing,...values});if(data.kind==='group')remember([data]);await ctx.refresh();return data;}
    catch(error){ctx.showStatus(errorCopy(error));if(['group_changed','group_invite_changed','group_invite_limit_below_used'].includes(error.message)){
      const data=await ctx.api('/api/groups/profile?id='+editing);remember([data]);
      if(page==='invite'&&values.token)showPage('invite',true,values.token);
    }throw error;}
    finally{mutationBusy=false;busy=wasBusy;$('group-settings').classList.remove('is-busy');ctx.changed();}}
  function safe(action){return ()=>Promise.resolve().then(action).catch(error=>ctx.showStatus(errorCopy(error)));}
  function section(){const s=node('section','group-setting-card');renderHost.append(s);return s;}
  function settingsRow(parent,label,value,name,action,disabled=false){const row=button(label,name,action);if(value)row.querySelector('.group-row-label').append(node('small','',value));row.disabled=disabled;parent.append(row);return row;}
  function saveFields(values){return mutate('save',{version:current().version,...values});}
  function showPage(next,animate=true,data=null){
    const g=current();if(!g)return;const previous=page,viewport=$('group-settings-content'),outgoing=settingsSheet;
    if(outgoing)sheetScroll.set(previous,outgoing.scrollTop);
    const host=node('div','group-settings-page');host.tabIndex=-1;renderHost=host;page=next;pageData=data;
    const titles={main:'编辑群聊',type:'群类型',permissions:'成员权限',reactions:'消息回应',admins:'管理员',admin:'管理员权限',invites:'邀请链接',invite:'编辑邀请链接','invite-create':'创建邀请链接',members:'成员',topics:'话题'};
    $('group-settings-title').textContent=titles[next] || '群设置';$('group-settings-save').hidden=next!=='main';$('group-settings-save').disabled=!can(g,'changeInfo');
    const owner=g.myRole==='owner'||g.superAdmin,manager=canManage(g,'changeInfo');
    if(next==='main'){
      if(!draft)draft={name:g.name,description:g.description};const photo=button('设置群头像',null,()=>chooseAvatar('edit'),'group-settings-photo');const image=node('span','avatar');paintPhoto(image,g);photo.prepend(image);photo.disabled=!can(g,'changeInfo');host.append(photo);
      if(g.avatarUrl){const reset=button('恢复默认群头像',null,()=>confirm({title:'恢复默认群头像？',label:'确认恢复',action:async()=>{await mutate('avatar/reset',{version:current().version});showPage('main');}}),'group-reset-avatar');reset.disabled=!can(g,'changeInfo');host.append(reset);}
      const card=section(),name=textField('群名称',draft.name,128),description=textField('简介',draft.description,255,true);name.input.disabled=description.input.disabled=!can(g,'changeInfo');
      name.input.addEventListener('input',()=>draft.name=name.input.value);description.input.addEventListener('input',()=>draft.description=description.input.value);card.append(name.wrap,description.wrap,note('简介最多 255 字'));
      settingsRow(card,'群类型',g.type==='public'?'公开 · @'+g.handle:'私密','lock',()=>showPage('type'),!owner);
      settingsRow(card,'成员权限',g.permissions.length+'/'+Object.keys(permissions).length,'document',()=>showPage('permissions'),!owner);
      settingsRow(card,'消息回应',g.reactionMode==='all'?'所有表情':g.reactionMode==='none'?'关闭':g.allowedReactions.length+' 个表情','smile',()=>showPage('reactions'),!manager);
      settingsRow(card,'管理员',String(g.members.filter(m=>m.superAdmin||m.role!=='member').length),'user',()=>showPage('admins'));
      settingsRow(card,'邀请链接',String(g.invites.filter(i=>!i.revoked).length),'link',()=>showPage('invites'),!canManage(g,'inviteUsers'));
      card.append(checkbox('启用话题',g.topicsEnabled,safe(async()=>{await saveFields({topicsEnabled:String(!g.topicsEnabled)});ctx.header();showPage('main');}),!manager),note('启用后可在不同话题中分别交流。'));
      if(g.topicsEnabled)settingsRow(card,'管理话题',String(g.topics.length),'article',()=>showPage('topics'));
      const people=section();settingsRow(people,'成员',String(g.memberCount),'users',()=>showPage('members'));
      people.append(checkbox('新成员可见完整历史',g.history,safe(async()=>{await saveFields({history:String(!g.history)});showPage('main');}),!manager),note('关闭后，新成员最多看到加入前的 100 条消息。'));
      if(owner)section().append(button('解散群聊','trash',()=>deleteOrLeave('group:'+g.id,true),'group-row danger-action'));
      else host.append(note('群主及超级管理员可修改群类型、成员权限和管理员。'));
    }else if(next==='type'){
      const card=section(),field=textField('公开群用户名',g.handle,32);let type=g.type;
      const select=choices('群类型',[['private','私密群','只能通过邀请链接或成员邀请加入'],['public','公开群','可以搜索群名称或群用户名加入']],type,value=>{type=value;field.wrap.hidden=value!=='public';});
      field.wrap.hidden=type!=='public';card.append(select,field.wrap,note('公开群用户名为 5–32 位小写字母、数字或下划线，以字母开头。'),button('保存','sent',safe(async()=>{await saveFields({type,handle:field.input.value});showPage('main');})));
    }else if(next==='permissions'){
      const card=section(),chosen=new Set(g.permissions);for(const [key,label]of Object.entries(permissions))card.append(checkbox(label,chosen.has(key),value=>value?chosen.add(key):chosen.delete(key)));
      card.append(note('以上限制针对普通成员；管理员的管理权限单独设置。'),button('保存权限','sent',safe(async()=>{await saveFields({permissions:Array.from(chosen).join(',')});showPage('main');})));
    }else if(next==='reactions'){
      const card=section(),chosen=new Set(g.allowedReactions),grid=node('div','group-reaction-grid');let mode=g.reactionMode;
      const select=choices('消息回应',[['all','所有表情'],['selected','指定表情'],['none','关闭回应']],mode,value=>{mode=value;grid.hidden=value!=='selected';});grid.hidden=mode!=='selected';
      for(const emoji of emojis){const b=button(emoji,null,()=>{chosen.has(emoji)?chosen.delete(emoji):chosen.add(emoji);b.setAttribute('aria-pressed',String(chosen.has(emoji)));},'group-emoji');b.setAttribute('aria-pressed',String(chosen.has(emoji)));grid.append(b);}
      card.append(select,grid,button('保存','sent',safe(async()=>{await saveFields({reactionMode:mode,allowedReactions:Array.from(chosen).join(',')});showPage('main');})));
    }else if(next==='members'||next==='admins'){
      const card=section(),members=next==='admins'?g.members.filter(m=>m.superAdmin||m.role!=='member'):g.members;
      for(const p of members)card.append(memberRow(p,p.superAdmin?(p.role==='owner'?'超级管理员 · 群主':'超级管理员'):p.role==='owner'?'群主':p.role==='admin'?'管理员':'成员',()=>memberActions(p)));
      if(next==='members'&&can(g,'addMembers'))host.append(button('添加成员','plus',()=>{const resume={...draft};closeSettings();startCreation('add',g,resume);},'group-floating-action'));
      if(next==='admins'&&owner){host.append(note('点击成员可设置管理员和权限。'));host.append(button('选择管理员','plus',()=>showPage('members')));}
    }else if(next==='admin'){
      const person=data,card=section(),chosen=new Set(person.rights || []);card.append(memberRow(person,'管理员权限',()=>{}));
      for(const [key,label]of Object.entries(rights))card.append(checkbox(label,chosen.has(key),v=>v?chosen.add(key):chosen.delete(key)));
      card.append(button('保存管理员','sent',safe(async()=>{await mutate('members/role',{userId:person.id,role:'admin',rights:Array.from(chosen).join(',')});showPage('admins');})));
      if(person.role==='admin')card.append(button('撤销管理员','trash',()=>confirm({title:'撤销「'+ctx.title(person.username)+'」的管理员身份？',label:'确认撤销',action:async()=>{await mutate('members/role',{userId:person.id,role:'member',rights:''});showPage('admins');}}),'group-row danger-action'));
    }else if(next==='invites'){
      host.append(note('每条链接的有效期、人数上限和使用次数独立计算。'));
      for(const link of g.invites){const card=section(),url=location.origin+'/app?invite='+link.token;
        card.append(note(link.revoked?'已撤销':link.expires&&link.expires<=Date.now()?'已过期':link.limit&&link.used>=link.limit?'名额已用完':'有效邀请'),note(url,'group-invite-url'),
          note('有效期：'+(link.expires?'至 '+new Date(link.expires).toLocaleString('zh-CN'):'永久有效')),
          note('人数上限：'+(link.limit?link.limit+' 人':'不限')+' · 已使用 '+link.used+' 次'+(link.limit?' · 剩余 '+Math.max(0,link.limit-link.used)+' 个名额':'')));
        if(!link.revoked){card.append(button('编辑链接','edit',()=>showPage('invite',true,link.token)),
          button('复制链接','link',safe(async()=>{try{await navigator.clipboard.writeText(url);ctx.showStatus('邀请链接已复制。');}catch{ctx.showStatus('无法复制，请选择链接文字手动复制。');}})),
          button('撤销链接','trash',()=>confirm({title:'撤销这条邀请链接？',copy:'撤销后无法再通过此链接加入。',label:'撤销',danger:true,action:async()=>{await mutate('invites/revoke',{token:link.token});showPage('invites');}}),'group-row danger-action'));}}
      section().append(button('创建邀请链接','plus',()=>showPage('invite-create')));
    }else if(next==='invite'||next==='invite-create'){
      const creating=next==='invite-create',link=creating?null:g.invites.find(link=>link.token===data);
      if(!creating&&(!link||link.revoked)){section().append(note('这条邀请链接已被撤销或不存在。'),button('返回邀请链接','back',()=>showPage('invites')));}
      else {
        if(link)section().append(note(location.origin+'/app?invite='+link.token,'group-invite-url'),
          note('当前有效期：'+(link.expires?'至 '+new Date(link.expires).toLocaleString('zh-CN'):'永久有效')),
          note('已使用 '+link.used+' 次 · 当前人数上限：'+(link.limit?link.limit+' 人':'不限')));
        const card=section(),days=textField(creating?'有效天数（0 表示永久）':'新的有效天数',creating?'0':'',4),limit=textField('人数上限（0 表示不限）',String(link?.limit || 0),6);
        days.input.inputMode=limit.input.inputMode='numeric';days.input.placeholder=creating?'0':'留空保留当前有效期';
        days.wrap.querySelector('.group-field-counter').hidden=limit.wrap.querySelector('.group-field-counter').hidden=true;
        card.append(days.wrap,note(creating?'从创建时开始计时，0 表示永久。':'留空保持原到期时间；填写后从保存时开始计时，0 表示永久。'),limit.wrap,
          note('人数上限仅作用于这条链接；保存不会重置已使用次数。'),button(creating?'创建链接':'保存此链接','sent',safe(async()=>{
            const daysText=days.input.value.trim(),limitText=limit.input.value.trim(),d=daysText===''&&!creating?null:Number(daysText),l=Number(limitText);
            if((d!==null&&(!/^\d+$/.test(daysText)||!Number.isInteger(d)||d>3650))||!/^\d+$/.test(limitText)||!Number.isInteger(l)||l>100000)throw Error('group_invite_settings_invalid');
            const values={limit:l,...(d===null?{}:{days:d})};
            if(link)Object.assign(values,{token:link.token,expectedExpires:link.expires,expectedLimit:link.limit});
            await mutate(creating?'invites/create':'invites/edit',values);showPage('invites');ctx.showStatus(creating?'邀请链接已创建。':'这条邀请链接的设置已保存。');
          })));
      }
    }else if(next==='topics'){
      const card=section();for(const t of g.topics)settingsRow(card,t.title,t.closed?'已关闭':'开放','article',()=>editTopic(t),!canManage(g,'manageTopics'));
      if(can(g,'topics'))card.append(button('新建话题','plus',()=>editTopic()));
    }
    const focused=outgoing?.contains(document.activeElement),start=outgoing?{opacity:getComputedStyle(outgoing).opacity,transform:getComputedStyle(outgoing).transform}:null;
    for(const animation of sheetAnimations)animation.cancel();sheetAnimations.clear();
    for(const child of Array.from(viewport.children))if(child!==outgoing)child.remove();
    viewport.append(host);settingsSheet=host;host.scrollTop=animate?sheetScroll.get(next)||0:0;
    if(focused)host.focus({preventScroll:true});
    const duration=animate?ctx.motionDuration(320):0;
    if(!duration){outgoing?.remove();return;}
    const returning=next==='main'||previous==='admin'&&next==='admins'||(previous==='invite'||previous==='invite-create')&&next==='invites',same=next===previous;
    if(outgoing){outgoing.inert=true;outgoing.setAttribute('aria-hidden','true');}
    const run=(sheet,frames,departing)=>{const animation=sheet.animate(frames,{duration,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});sheetAnimations.add(animation);animation.onfinish=()=>{animation.cancel();sheetAnimations.delete(animation);if(departing&&settingsSheet!==sheet)sheet.remove();};};
    if(outgoing)run(outgoing,[start,{opacity:0,transform:same?'none':returning?'translateX(32px)':'translateX(-24px)'}],true);
    run(host,[{opacity:0,transform:same?'none':returning?'translateX(-24px)':'translateX(32px)'},{opacity:1,transform:'none'}],false);
  }
  function memberActions(person){const g=current();if(!g)return;const extra=node('div','group-member-actions');
    const owner=g.myRole==='owner'||g.superAdmin,protectedMember=person.superAdmin&&!g.superAdmin;
    if(owner&&person.id!==g.ownerId&&!protectedMember){
      if(!person.superAdmin)extra.append(button(person.role==='admin'?'修改管理员权限':'设为管理员','settings',()=>{ctx.closeModal('group-confirm-dialog');showPage('admin',true,person);}));
      extra.append(button('设为群主','user',()=>{confirm({title:'将群主转让给「'+ctx.title(person.username)+'」？',copy:g.superAdmin?'现任群主将成为管理员。你的超级管理员权限继续保留。':'转让后你成为管理员，群主及超级管理员可管理群类型、成员权限及解散群聊。',label:'确认转让',action:async()=>{await mutate('members/role',{userId:person.id,role:'owner',rights:''});draft=null;showPage('main');}});}));}
    if((person.id!==g.ownerId||g.superAdmin&&person.username!==ctx.account())&&!protectedMember&&canManage(g,'banUsers')&&(person.role!=='admin'||owner))extra.append(button('移除成员','trash',()=>confirm({title:'移除「'+ctx.title(person.username)+'」？',copy:person.id===g.ownerId?'移除现任群主后，你将成为群主。':'',label:'确认移除',danger:true,action:async()=>{await mutate('members/remove',{userId:person.id});showPage('members');}}),'group-row danger-action'));
    if(person.superAdmin)extra.append(note('超级管理员拥有高于群主的权限，群内角色修改不会取消此权限。'));
    confirm({title:person.username===ctx.account()?ctx.myName():ctx.title(person.username),copy:'@'+person.username,extra,label:'关闭',action:async()=>{}});
  }
  function editTopic(t=null){const g=current();if(!g)return;const extra=node('div'),closed=node('input');closed.type='checkbox';closed.checked=!!t?.closed;const label=node('label','group-topic-closed','关闭此话题');label.prepend(closed);extra.append(label);
    confirm({title:t?'修改话题':'新建话题',input:'话题名称',value:t?.title || '',max:80,extra,label:'保存',action:async title=>{await mutate('topics/save',{topicId:t?.id || id(),title,closed:String(closed.checked)});showPage('topics');ctx.header();}});
  }
  function deleteOrLeave(peer,dissolve=false){const g=of(peer);if(!g?.joined)return;ctx.closeMenus();const owner=g.myRole==='owner'||dissolve&&g.superAdmin;
    confirm({title:owner?'删除群聊并退出？':'删除聊天并退出群聊？',copy:owner?'此群会对所有成员关闭。此操作无法撤销。你也可以先在成员设置中转让群主，再退出。':'退出后无法继续接收群消息。重新加入时历史可见范围由群设置决定。',label:owner?'删除群聊':'退出群聊',danger:true,action:async()=>{
      await ctx.post('/api/groups/'+(owner?'delete':'leave'),{id:g.id});groups.delete(g.id);closeSettings(true);ctx.leave(peer);await ctx.refresh();
    }});
  }
  function header(peer){const g=of(peer),host=$('group-topic-tabs');host.replaceChildren();host.hidden=!g?.joined || !g.topicsEnabled;if(host.hidden)return;
    for(const t of g.topics){const b=button(t.title+(t.closed?' · 已关闭':''),null,()=>selectTopic(peer,t.id),'group-topic-tab');b.setAttribute('aria-pressed',String(topicOf(peer)===t.id));host.append(b);}
    if(can(g,'topics'))host.append(button('+',null,()=>{editing=g.id;editTopic();},'group-topic-tab'));
  }
  async function selectTopic(peer,topic){if(topicOf(peer)===topic||ctx.isBusy())return;selectedTopics.set(peer.slice(6),topic);header(peer);await ctx.changeTopic(peer);}
  function decorate(bubble,message,peer){const g=of(peer);let author=bubble.querySelector('.group-message-author');
    if(g&&message.sender!==ctx.account()){if(!author){author=node('strong','group-message-author');bubble.insertBefore(author,bubble.querySelector('.message-text'));}author.textContent=ctx.title(message.sender);}else author?.remove();
    bubble.querySelector('.group-message-reactions')?.remove();
  }
  function reactMenu(target){const g=of(target?.peer);if(!g || g.reactionMode==='none')return;const extra=node('div','group-reaction-grid'),choices=g.reactionMode==='all'?emojis:g.allowedReactions;
    for(const emoji of choices)extra.append(button(emoji,null,safe(async()=>{const data=await ctx.post('/api/groups/react',{id:g.id,seq:target.seq,emoji});ctx.applyMessages([data.message]);ctx.closeModal('group-confirm-dialog');}),'group-emoji'));
    confirm({title:'回应消息',extra,label:'关闭',action:async()=>{}});
  }
  async function pollReactions(peer){if(!isGroup(peer)||pollBusy||!of(peer)?.joined)return;pollBusy=true;try{const data=await ctx.api('/api/groups/reactions?'+new URLSearchParams({id:peer.slice(6),topic:topicOf(peer),after:'0'}));if(ctx.active()===peer)ctx.applyStates(data.states || []);}catch{}finally{pollBusy=false;}}
  function onClose(){confirmation?.cleanup?.();confirmation=null;}
  function init(context){ctx=context;
    $('new-group-chat').addEventListener('click',()=>startCreation());$('group-select-back').addEventListener('click',creationBack);$('group-preview-back').addEventListener('click',creationBack);
    $('group-selection-next').addEventListener('click',nextCreation);$('group-create-submit').addEventListener('click',createGroup);$('group-create-photo').addEventListener('click',()=>chooseAvatar('create'));
    $('group-name-input').addEventListener('input',()=>{if(creation){const input=$('group-name-input');input.value=Array.from(input.value).slice(0,128).join('');creation.name=input.value; $('group-create-submit').disabled=!creation.name.trim();}});
    $('group-avatar-input').addEventListener('change',avatarSelected);$('group-confirm-submit').addEventListener('click',submitConfirm);$('group-confirm-cancel').addEventListener('click',()=>{if(!busy)ctx.closeModal('group-confirm-dialog');});
    $('group-settings-back').addEventListener('click',backSettings);$('group-settings-save').addEventListener('click',safe(async()=>{if(!draft)return;await saveFields({name:draft.name,description:draft.description});ctx.showStatus('群资料已保存。');closeSettings();}));
    $('edit-group').addEventListener('click',()=>openSettings(ctx.active()));$('leave-group').addEventListener('click',()=>deleteOrLeave(ctx.active()));
    document.addEventListener('chawe-ui-settings-change',finishSheetMotion);
  }
  return {init,isGroup,of,topicOf,remember,paintAvatar,panelId,panelChanged,startCreation,filterSearch,searchFocus,filter,clearFilter,
    isBusy:()=>busy || !!creation?.busy,modalBusy:()=>busy,confirm,handleInvite,joinDialog,can,canManage,openSettings,closeSettings,header,decorate,reactMenu,pollReactions,onClose};
})();
