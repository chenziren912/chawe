'use strict';
// Wait for control before assigning the first media URL, independently of notification permission.
window.chaweMediaCacheReady=new Promise(resolve => {
  if(!isSecureContext || !('serviceWorker' in navigator)){resolve(false);return;}
  let worker, finished=false;
  const finish=value => {
    if(finished)return;finished=true;clearTimeout(timer);
    worker?.removeEventListener('statechange',check);navigator.serviceWorker.removeEventListener('controllerchange',check);resolve(value);
  };
  const check=() => {if(worker?.state==='activated' && navigator.serviceWorker.controller===worker)finish(true);};
  const timer=setTimeout(() => finish(false),4000);
  let registration;
  try {registration=navigator.serviceWorker.register('/notification-worker.js',{scope:'/',updateViaCache:'none'});}
  catch {finish(false);return;}
  registration.then(registration => {
    if(finished)return;
    worker=registration.installing || registration.waiting || registration.active;
    if(!worker){finish(false);return;}
    worker.addEventListener('statechange',check);navigator.serviceWorker.addEventListener('controllerchange',check);check();
  }).catch(() => finish(false));
});
