const CACHE_NAME='signal-desk-pwa-v17';
const STATIC_ASSETS=[
  '/',
  '/static/style.css?v=15',
  '/static/app.js?v=14',
  '/static/data-view.js?v=2',
  '/static/share.js?v=14',
  '/static/pwa.js?v=8',
  '/static/login.js?v=8',
  '/icon.svg',
  '/static/apple-touch-icon.png',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(STATIC_ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

// CSS/JS 用 network-first：cache-first 会让样式和脚本的更新迟迟到不了用户手上
// （旧 SW 在新版本激活前仍然发旧文件，表现为改了 CSS 但页面毫无变化）
function isVersionedAsset(pathname){
  return /\.(css|js)$/.test(pathname);
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(isVersionedAsset(url.pathname)){
    event.respondWith(fetch(request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
      return response;
    }).catch(()=>caches.match(request)));
    return;
  }
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
      return response;
    }).catch(()=>caches.match(request).then(response=>response||caches.match('/'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    const copy=response.clone();
    caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
    return response;
  })));
});
