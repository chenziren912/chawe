'use strict';
(() => {
  const DATABASE='chawe-media-cache-v1', BLOCK=512*1024, MAX_SIZE=200*1024*1024, LAST=Number.MAX_SAFE_INTEGER;
  let opening;
  function open() {
    return opening ||= new Promise((resolve,reject) => {
      const request=indexedDB.open(DATABASE,1);let failed=false;
      const fail=() => {failed=true;clearTimeout(timer);opening=null;reject((request.readyState==='done' ? request.error : null) || Error('media_storage_unavailable'));};
      const timer=setTimeout(fail,2000);
      request.onupgradeneeded=() => {
        const db=request.result, files=db.createObjectStore('files',{keyPath:'key'});
        files.createIndex('accessed','accessed'); files.createIndex('base','base');
        db.createObjectStore('chunks',{keyPath:['key','start']});
      };
      request.onsuccess=() => {
        const db=request.result;if(failed){db.close();return;}clearTimeout(timer);
        db.onversionchange=() => { db.close(); opening=null; }; resolve(db);
      };
      request.onerror=request.onblocked=fail;
    });
  }
  const bounds=(key,start=0,end=LAST) => IDBKeyRange.bound([key,start],[key,end]);
  async function span(key,position) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction('chunks','readonly'), store=tx.objectStore('chunks');
      let previous=null, next=null;
      store.openCursor(bounds(key,0,position),'prev').onsuccess=event => { previous=event.target.result?.value || null; };
      store.openKeyCursor(bounds(key,position+1)).onsuccess=event => { next=event.target.result?.primaryKey[1] ?? null; };
      tx.oncomplete=() => resolve({hit:previous?.end>position ? previous : null,next});
      tx.onerror=tx.onabort=() => reject(tx.error || Error('media_storage_unavailable'));
    });
  }
  async function touch(key,base) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction('files','readwrite'); tx.objectStore('files').put({key,base,accessed:Date.now()});
      tx.oncomplete=resolve; tx.onerror=tx.onabort=() => reject(tx.error || Error('media_storage_unavailable'));
    });
  }
  async function remove(key) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction(['files','chunks'],'readwrite'); tx.objectStore('files').delete(key);
      tx.objectStore('chunks').openCursor(bounds(key)).onsuccess=event => {
        const cursor=event.target.result; if(cursor){cursor.delete();cursor.continue();}
      };
      tx.oncomplete=resolve; tx.onerror=tx.onabort=() => reject(tx.error || Error('media_storage_unavailable'));
    });
  }
  async function revoke(base) {
    const db=await open(), keys=await new Promise((resolve,reject) => {
      const tx=db.transaction('files','readonly'), request=tx.objectStore('files').index('base').getAllKeys(base);
      request.onsuccess=() => resolve(request.result); request.onerror=() => reject(request.error);
    });
    for(const key of keys)await remove(key);
  }
  async function evict(current) {
    const db=await open(), key=await new Promise((resolve,reject) => {
      const tx=db.transaction('files','readonly'), request=tx.objectStore('files').index('accessed').openCursor();
      request.onsuccess=() => { const cursor=request.result;
        if(!cursor)return resolve(null); if(cursor.value.key===current)return cursor.continue(); resolve(cursor.value.key);
      };
      request.onerror=() => reject(request.error);
    });
    if(!key)return false; await remove(key); return true;
  }
  async function put(key,base,start,data) {
    const db=await open(), end=start+data.size;
    return new Promise((resolve,reject) => {
      const tx=db.transaction(['files','chunks'],'readwrite'), store=tx.objectStore('chunks');
      tx.objectStore('files').put({key,base,accessed:Date.now()});
      // Keep interval ends in increasing order. A contained interval must not hide a larger cached one.
      store.openCursor(bounds(key,0,start),'prev').onsuccess=event => {
        const previous=event.target.result?.value;
        if(previous?.end>=end)return;
        store.openCursor(bounds(key,start,end-1)).onsuccess=next => {
          const cursor=next.target.result;
          if(cursor){if(cursor.value.end<=end)cursor.delete();cursor.continue();}
          else store.put({key,start,end,data});
        };
      };
      tx.oncomplete=resolve; tx.onerror=tx.onabort=() => reject(tx.error || Error('media_storage_unavailable'));
    });
  }
  async function save(key,base,start,data) {
    for(let attempt=0;;attempt++){
      try {await put(key,base,start,data);return;}
      catch(error){if(error?.name!=='QuotaExceededError' || attempt>=4 || !await evict(key))throw error;}
    }
  }
  function rangeOf(value,size) {
    if(value===null)return {start:0,end:size-1,status:200};
    const match=/^bytes=(\d*)-(\d*)$/.exec(value);
    if(!match || !match[1]&&!match[2])return null;
    let start,end=size-1;
    if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)return null;start=Math.max(0,size-suffix);}
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size ? {start,end,status:206} : null;
  }
  function eligible(request) {
    const url=new URL(request.url);
    if(request.method!=='GET' || url.origin!==self.location.origin || url.pathname!=='/api/attachments/file')return null;
    // Legacy download links also go straight to the browser's download manager.
    if(url.searchParams.get('download')==='1')return null;
    const account=url.searchParams.get('accountId'), id=url.searchParams.get('id');
    return /^[a-f0-9]{32}$/.test(account)&&/^[a-f0-9]{32}$/.test(id) ? {base:account+':'+id} : null;
  }
  async function respond(request,media,finish) {
    const authHeaders=new Headers(request.headers); authHeaders.delete('Range'); authHeaders.delete('If-Range');
    // HEAD validates the live session, message reference and group membership without downloading the file.
    const authorization=await fetch(request.url,{method:'HEAD',headers:authHeaders,credentials:'same-origin',cache:'no-store',redirect:'error',signal:request.signal});
    if([401,403,404].includes(authorization.status))await revoke(media.base).catch(() => {});
    const size=Number(authorization.headers.get('Content-Length')), kind=authorization.headers.get('X-Chawe-Cache-Media');
    if(!authorization.ok || !['image','video'].includes(kind) || !Number.isSafeInteger(size) || size<1 || size>MAX_SIZE){finish();return fetch(request);}
    const range=rangeOf(request.headers.get('Range'),size), headers=new Headers(authorization.headers);
    if(!range){headers.set('Content-Range','bytes */'+size);headers.delete('Content-Length');finish();return new Response(null,{status:416,headers});}
    headers.set('Content-Length',String(range.end-range.start+1));
    if(range.status===206)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${size}`);else headers.delete('Content-Range');
    const key=media.base+':'+size;
    let position=range.start, network=null, cancelled=false, writable=true, readable=true, parts=[], buffered=0, bufferStart=position, activePull=Promise.resolve();
    try { await touch(key,media.base); } catch { writable=false; }
    async function flush() {
      if(!buffered)return;
      const data=new Blob(parts), start=bufferStart;parts=[];buffered=0;
      if(writable)try { await save(key,media.base,start,data); } catch { writable=false; }
    }
    async function remember(bytes,start) {
      if(!writable)return;
      let offset=0;
      while(offset<bytes.byteLength){
        if(!buffered)bufferStart=start+offset;
        const length=Math.min(BLOCK-buffered,bytes.byteLength-offset);
        parts.push(bytes.slice(offset,offset+length));buffered+=length;offset+=length;
        if(buffered===BLOCK)await flush();
      }
    }
    async function closeNetwork() {
      const previous=network;network=null;
      if(previous){if(previous.reader)await previous.reader.cancel().catch(() => {});previous.abort.abort();}
      await flush();
    }
    async function pull(controller) {
      try {
        if(cancelled)return;
        if(position>range.end){await closeNetwork();controller.close();finish();return;}
        if(network && position>network.end)await closeNetwork();
        if(!network){
          let cached={hit:null,next:null};
          if(readable)try { cached=await span(key,position); } catch { readable=false;writable=false; }
          if(cancelled)return;
          if(cached.hit){
            const end=Math.min(range.end+1,cached.hit.end), data=await cached.hit.data.slice(position-cached.hit.start,end-cached.hit.start).arrayBuffer();
            if(cancelled)return;position=end;controller.enqueue(new Uint8Array(data));
            if(position>range.end){controller.close();finish();}return;
          }
          const end=Math.min(range.end,cached.next===null ? range.end : cached.next-1), abort=new AbortController();
          // A gap may span the rest of the video. Stream it instead of eagerly fetching the whole body.
          network={end,abort,reader:null};
          const fetchHeaders=new Headers(request.headers);fetchHeaders.set('Range',`bytes=${position}-${end}`);fetchHeaders.delete('If-Range');
          const response=await fetch(request.url,{headers:fetchHeaders,credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal});
          if(cancelled){await response.body?.cancel();return;}
          if(response.status!==206 || response.headers.get('Content-Range')!==`bytes ${position}-${end}/${size}` || !response.body){
            await response.body?.cancel();throw Error('media_transfer_failed');
          }
          network.reader=response.body.getReader();
        }
        const result=await network.reader.read();
        if(cancelled && result.done)return;
        if(result.done || result.value.byteLength>network.end-position+1)throw Error('media_transfer_incomplete');
        const start=position;position+=result.value.byteLength;
        await remember(result.value,start);
        if(cancelled)return;
        controller.enqueue(result.value);
        if(position>range.end){await closeNetwork();controller.close();finish();}
      } catch(error) {
        await closeNetwork();if(!cancelled)controller.error(error);finish();
      }
    }
    const body=new ReadableStream({
      pull(controller){activePull=pull(controller);return activePull;},
      async cancel(){cancelled=true;network?.abort.abort();await activePull.catch(() => {});await closeNetwork();finish();}
    });
    return new Response(body,{status:range.status,headers});
  }
  self.addEventListener('fetch',event => {
    const media=eligible(event.request);if(!media)return;
    let finish;const lifetime=new Promise(resolve => { finish=resolve; });
    event.waitUntil(lifetime);
    event.respondWith(respond(event.request,media,finish).catch(() => { finish();return fetch(event.request); }));
  });
})();
