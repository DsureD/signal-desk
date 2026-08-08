(function(){
  if(!('serviceWorker' in navigator))return;
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(error){
      console.warn('PWA service worker registration failed',error);
    });
  });
})();
