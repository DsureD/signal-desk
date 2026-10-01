const state={aggregation:'raw',loadedAggregation:'raw',sources:[],selectedId:null,hours:24,refreshTimer:null,charts:new Map(),feeds:[],channel:{},feedsBySource:new Map(),channelsBySource:new Map(),cards:[],loading:false,requestToken:0,windowKey:'',lastEntryId:null,customStart:null,customEnd:null,noticeTimer:null,pendingDelete:null};
let sourceOrderSave=Promise.resolve();
let isDraggingSource=false;
let activeTouchReset=null;
let activePointerReset=null;
let suppressSourceClick=false;
let cardFieldSelections=[];
let activeCardSourceId=null;
const channelMetadataRequests=new Map();
const $=id=>document.getElementById(id);
const colors=TelemetryView.colors;
// 侧边栏折叠靠 .layout{transition:grid-template-columns .24s} 改变 .content 宽度，
// 窗口尺寸没变所以 window.resize 不触发，ECharts 会一直用旧宽度（右边缺一块或溢出一块）。
// 直接观察图表容器自身的尺寸，任何来源的宽度变化都能覆盖。
let pendingResize=null;
const chartResizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(entries=>{
  // 用 rAF 合并同一帧内的多次回调，避免过渡期间每帧重复 resize
  if(pendingResize)return;
  const elements=entries.map(entry=>entry.target);
  pendingResize=requestAnimationFrame(()=>{
    pendingResize=null;
    elements.forEach(element=>{
      const chart=echarts.getInstanceByDom?.(element);
      if(chart&&!chart.isDisposed?.())chart.resize();
    });
  });
}):null;
function observeChart(element){if(chartResizeObserver&&element)chartResizeObserver.observe(element)}
// 无 ResizeObserver 时的兜底：在过渡的 240ms 内按帧补 resize
function resizeChartsDuringTransition(){if(chartResizeObserver)return;const deadline=performance.now()+320;const tick=()=>{state.charts.forEach(chart=>{if(!chart.isDisposed?.())chart.resize()});if(performance.now()<deadline)requestAnimationFrame(tick)};requestAnimationFrame(tick)}
const chartNames={line:'折线图',bar:'柱状图',area:'面积图'};

const isTouchDevice=window.matchMedia?.('(pointer:coarse)').matches;
// 不能用 body{position:fixed;top:-Ypx} 锁滚动：那会把整个 body 上移，
// 而 .topbar 是 position:sticky，会跟着被移出视口（导航栏和菜单按钮一起消失）。
// 改为在根元素上设 overflow:hidden —— 根元素的 overflow 直接作用于视口，
// 页面停止滚动但不发生任何位移，sticky topbar 保持在原位。
function setScrollLock(locked){document.documentElement.classList.toggle('sidebar-locked',locked);document.body.classList.toggle('sidebar-open',locked)}
function setSidebarOpen(open){const shell=document.querySelector('.app-shell');const button=$('menuToggle');const desktop=window.innerWidth>900;shell?.classList.toggle('sidebar-collapsed',desktop&&!open);resizeChartsDuringTransition();shell?.classList.toggle('sidebar-open',!desktop&&open);setScrollLock(!desktop&&open);button?.setAttribute('aria-expanded',String(open));button?.setAttribute('aria-label',open?'关闭数据源菜单':'打开数据源菜单');const sidebar=document.querySelector('.sidebar');if(sidebar){if(desktop)sidebar.removeAttribute('aria-hidden');else sidebar.setAttribute('aria-hidden',String(!open))}}
function closeSidebar(){if(window.innerWidth<=900)setSidebarOpen(false)}
function toggleSidebar(){const shell=document.querySelector('.app-shell');const desktop=window.innerWidth>900;const open=desktop?!shell?.classList.contains('sidebar-collapsed'):shell?.classList.contains('sidebar-open');setSidebarOpen(!open)}
async function api(url,options={}){const res=await fetch(url,options);const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'请求失败');return data}
function showNotice(message){if(state.noticeTimer)clearTimeout(state.noticeTimer);$('notice').textContent=message;$('notice').classList.remove('hidden');state.noticeTimer=setTimeout(clearNotice,3200)}
function clearNotice(){if(state.noticeTimer){clearTimeout(state.noticeTimer);state.noticeTimer=null}$('notice').classList.add('hidden')}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function currentSource(){return state.sources.find(item=>item.id===state.selectedId)}
function fieldInfo(number){const source=currentSource();const field=source?.fields?.find(item=>item.field_number===number);return{name:state.channel[`field${number}`]||field?.name||`Field ${number}`,unit:field?.unit||''}}
function cardSelections(card){const raw=Array.isArray(card?.field_selections)?card.field_selections:(card?.field_numbers||[]).map(number=>({source_id:card.source_id||state.selectedId,field_number:number}));const seen=new Set();return raw.map(item=>({source_id:Number(item.source_id),field_number:Number(item.field_number)})).filter(item=>{const key=`${item.source_id}:${item.field_number}`;if(!item.source_id||item.field_number<1||item.field_number>8||seen.has(key))return false;seen.add(key);return true})}
function selectionKey(selection){return`${Number(selection.source_id)}:${Number(selection.field_number)}`}
function selectionInfo(selection){const source=state.sources.find(item=>item.id===Number(selection.source_id));const number=Number(selection.field_number);const field=source?.fields?.find(item=>item.field_number===number);const channel=state.channelsBySource.get(Number(selection.source_id))||{};return{sourceName:source?.name||`数据源 ${selection.source_id}`,name:channel[`field${number}`]||field?.name||`Field ${number}`,unit:field?.unit||''}}
function selectionName(selection,selections){const meta=selectionInfo(selection);const sourceCount=new Set(selections.map(item=>Number(item.source_id))).size;return sourceCount>1?`${meta.sourceName} · ${meta.name}`:meta.name}
async function ensureSourceChannel(sourceId){sourceId=Number(sourceId);if(state.channelsBySource.has(sourceId))return true;if(channelMetadataRequests.has(sourceId))return channelMetadataRequests.get(sourceId);const task=api(`/api/sources/${sourceId}/channel`).then(channel=>{state.channelsBySource.set(sourceId,channel||{});return true}).catch(error=>{showNotice(error.message);return false}).finally(()=>channelMetadataRequests.delete(sourceId));channelMetadataRequests.set(sourceId,task);return task}
async function activateCardSource(sourceId){activeCardSourceId=Number(sourceId);renderFieldSourceTabs();const source=state.sources.find(item=>item.id===activeCardSourceId);if(source?.enabled&&!state.channelsBySource.has(activeCardSourceId)){$('cardFields').setAttribute('aria-busy','true');$('cardFields').innerHTML='<div class="field-picker-loading"><span></span>读取 Field 名称</div>';await ensureSourceChannel(activeCardSourceId)}if(activeCardSourceId===Number(sourceId)){$('cardFields').removeAttribute('aria-busy');renderFieldPicker(activeCardSourceId)}}
function iconSvg(name){const paths={edit:'<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path>',share:'<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',fullscreen:'<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path>'};return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||''}</svg>`}
function mobileChartMode(){return window.matchMedia?.('(max-width:900px)').matches}
function clearSourceDragState(){document.querySelectorAll('#sourceList .source-item').forEach(item=>item.classList.remove('dragging','drag-over-top','drag-over-bottom','touch-dragging'))}
function resetSourceDragState(){if(activeTouchReset)activeTouchReset();if(activePointerReset)activePointerReset();clearSourceDragState();isDraggingSource=false}
function queueSourceOrderSave(){const sourceIds=state.sources.map(source=>source.id);sourceOrderSave=sourceOrderSave.then(()=>api('/api/sources/order',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_ids:sourceIds})})).catch(error=>{showNotice(error.message);return loadSources()})}
function moveSource(sourceId,targetId,after){const fromIndex=state.sources.findIndex(source=>source.id===sourceId);const targetIndex=state.sources.findIndex(source=>source.id===targetId);if(fromIndex<0||targetIndex<0||fromIndex===targetIndex)return;const [source]=state.sources.splice(fromIndex,1);let insertIndex=targetIndex+(after?1:0);if(fromIndex<insertIndex)insertIndex-=1;state.sources.splice(insertIndex,0,source);renderSources();queueSourceOrderSave()}
function renderSources(){const list=$('sourceList');list.innerHTML='';if(!state.sources.length){list.innerHTML='<div class="empty-mini">暂无数据源</div>';return}state.sources.forEach(source=>{const btn=document.createElement('button');btn.className=`source-item ${source.id===state.selectedId?'active':''} ${source.enabled?'':'source-disabled'}`;btn.draggable=!isTouchDevice;if(!isTouchDevice)btn.title='拖拽调整数据源顺序';else btn.title='长按拖拽调整顺序';btn.innerHTML=`<span class="source-name">${escapeHtml(source.name)}</span><span class="source-meta">CH ${escapeHtml(source.channel_id)}${source.enabled?'':' · DISABLED'}</span>${isTouchDevice?'<span class="source-drag-handle" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></span>':'<span class="source-drag-handle" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></span>'}`;btn.onclick=()=>{if(isDraggingSource)return;selectSource(source.id)};if(isTouchDevice){let touchTimer=null;let touchStartY=0;let initialRect=null;let offsetY=0;let wasDragging=false;const resetTouchState=()=>{if(touchTimer){clearTimeout(touchTimer);touchTimer=null}btn.style.transform='';btn.classList.remove('touch-dragging');clearSourceDragState();isDraggingSource=false;wasDragging=false};btn.addEventListener('touchstart',event=>{if(isDraggingSource)return;touchStartY=event.touches[0].clientY;initialRect=btn.getBoundingClientRect();offsetY=touchStartY-initialRect.top;wasDragging=false;touchTimer=setTimeout(()=>{isDraggingSource=true;wasDragging=true;btn.classList.add('touch-dragging');if(navigator.vibrate)navigator.vibrate(50)},500)},{passive:true});btn.addEventListener('touchmove',event=>{if(touchTimer&&Math.abs(event.touches[0].clientY-touchStartY)>10){clearTimeout(touchTimer);touchTimer=null;return}if(!isDraggingSource||!wasDragging)return;event.preventDefault();const touch=event.touches[0];const deltaY=touch.clientY-offsetY-initialRect.top;btn.style.transform=`translateY(${deltaY}px)`;const items=Array.from(list.querySelectorAll('.source-item:not(.touch-dragging)'));let targetItem=null;let insertAfter=false;for(const item of items){const rect=item.getBoundingClientRect();if(touch.clientY>=rect.top&&touch.clientY<=rect.bottom){targetItem=item;insertAfter=touch.clientY>rect.top+rect.height/2;break}}items.forEach(item=>item.classList.remove('drag-over-top','drag-over-bottom'));if(targetItem){targetItem.classList.add(insertAfter?'drag-over-bottom':'drag-over-top')}},{passive:false});btn.addEventListener('touchend',event=>{if(touchTimer){clearTimeout(touchTimer);touchTimer=null}if(!isDraggingSource||!wasDragging){resetTouchState();return}event.preventDefault();const touch=event.changedTouches[0];const items=Array.from(list.querySelectorAll('.source-item:not(.touch-dragging)'));let targetItem=null;let insertAfter=false;for(const item of items){const rect=item.getBoundingClientRect();if(touch.clientY>=rect.top&&touch.clientY<=rect.bottom){targetItem=item;insertAfter=touch.clientY>rect.top+rect.height/2;break}}resetTouchState();if(targetItem){const targetSource=state.sources.find(s=>targetItem.textContent.includes(s.name));if(targetSource&&targetSource.id!==source.id){moveSource(source.id,targetSource.id,insertAfter)}}},{passive:false});btn.addEventListener('touchcancel',()=>{resetTouchState()})}else{btn.addEventListener('dragstart',event=>{isDraggingSource=true;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',String(source.id));btn.classList.add('dragging')});btn.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';const rect=btn.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;const targetClass=after?'drag-over-bottom':'drag-over-top';const otherClass=after?'drag-over-top':'drag-over-bottom';if(!btn.classList.contains(targetClass)){document.querySelectorAll('#sourceList .source-item').forEach(item=>{if(item!==btn){item.classList.remove('drag-over-top','drag-over-bottom')}});btn.classList.remove(otherClass);btn.classList.add(targetClass)}});btn.addEventListener('dragleave',event=>{if(!btn.contains(event.relatedTarget)){btn.classList.remove('drag-over-top','drag-over-bottom')}});btn.addEventListener('drop',event=>{event.preventDefault();const sourceId=Number(event.dataTransfer.getData('text/plain'));const rect=btn.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;clearSourceDragState();moveSource(sourceId,source.id,after);setTimeout(()=>{isDraggingSource=false},0)});btn.addEventListener('dragend',()=>{clearSourceDragState();setTimeout(()=>{isDraggingSource=false},0)})}list.appendChild(btn)})}
async function loadSources(){try{state.sources=await api('/api/sources');if(state.sources.length&&!state.selectedId)state.selectedId=state.sources[0].id;renderSources();if(state.selectedId)await selectSource(state.selectedId);else resetView()}catch(error){showNotice(error.message)}}
async function selectSource(id){state.selectedId=id;closeSidebar();state.requestToken+=1;state.loading=false;state.windowKey='';state.lastEntryId=null;state.feeds=[];state.channel={};state.feedsBySource=new Map();state.channelsBySource=new Map();state.cards=[];clearCharts();renderSources();const source=currentSource();if(!source)return;$('sourceTitle').textContent=source.name;$('sourceDescription').textContent=source.description||`ThingSpeak Channel ${source.channel_id}`;$('editSourceBtn').disabled=false;$('addCardBtn').disabled=false;state.cards=source.cards||[];clearNotice();renderCards();await loadData(false)}
function resetView(){$('sourceTitle').textContent='选择一个数据源';$('sourceDescription').textContent='添加 ThingSpeak Channel 后，在这里查看实时数据。';$('editSourceBtn').disabled=true;$('addCardBtn').disabled=true;state.cards=[];state.feeds=[];state.channel={};state.feedsBySource=new Map();state.channelsBySource=new Map();clearCharts();renderCards()}
function requiredSourceIds(){const ids=new Set([Number(state.selectedId)]);state.cards.forEach(card=>cardSelections(card).forEach(selection=>ids.add(selection.source_id)));return state.sources.filter(source=>source.enabled&&ids.has(source.id)).map(source=>source.id)}
function dataQuery(incremental){const params=new URLSearchParams(incremental?{last:'1',offset:'0'}:{offset:'0'});params.set('aggregation',state.aggregation);if(!incremental){if(state.customStart||state.customEnd){if(state.customStart)params.set('start',new Date(state.customStart).toISOString());if(state.customEnd)params.set('end',new Date(state.customEnd).toISOString())}else{params.set('start',new Date(Date.now()-state.hours*3600000).toISOString());params.set('end',new Date().toISOString())}}return params}
let activeDataController=null;
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){
    resetSourceDragState();
    if(activeDataController)activeDataController.abort();
  }else if(state.selectedId&&Number($('refreshSelect')?.value)>0){
    loadData(false);
  }
});
window.addEventListener('pagehide',resetSourceDragState);
window.addEventListener('blur',resetSourceDragState);
window.addEventListener('pointerup',event=>{if(event.pointerType==='mouse'&&activePointerReset)activePointerReset()});
window.addEventListener('pointercancel',resetSourceDragState);
window.addEventListener('contextmenu',resetSourceDragState);
async function loadData(incremental=true){
  if(!state.selectedId)return;
  if(document.hidden&&incremental)return;
  if(incremental&&state.loading)return;
  if(activeDataController)activeDataController.abort();
  const controller=new AbortController();
  activeDataController=controller;
  const token=++state.requestToken;
  const key=`${state.selectedId}:${state.customStart||''}:${state.customEnd||''}:${state.hours}:${state.aggregation}`;
  const isIncremental=state.aggregation==='raw'&&incremental&&state.windowKey===key;
  const requestedMode=state.aggregation;
  const query=dataQuery(isIncremental);
  const sourceIds=requiredSourceIds();
  state.loading=true;
  clearNotice();
  $('cardsGrid').setAttribute('aria-busy','true');
  $('aggregationHint').textContent=`正在读取${TelemetryView.labels[requestedMode]}… 原图保留至读取完成`;
  try{
    const results=await Promise.all(sourceIds.map(async sourceId=>({sourceId,data:await api(`/api/sources/${sourceId}/data?${query}`,{signal:controller.signal})})));
    if(token!==state.requestToken)return;
    const nextFeeds=isIncremental?new Map(state.feedsBySource):new Map();
    const nextChannels=isIncremental?new Map(state.channelsBySource):new Map();
    const cutoff=state.customStart?new Date(state.customStart).getTime():Date.now()-state.hours*3600000;
    const ceiling=state.customEnd?new Date(state.customEnd).getTime():Infinity;
    results.forEach(({sourceId,data})=>{
      const incoming=data.feeds||[];
      if(data.channel)nextChannels.set(sourceId,data.channel);
      if(!isIncremental){nextFeeds.set(sourceId,incoming);return}
      const existing=nextFeeds.get(sourceId)||[];
      const merged=new Map(existing.map(feed=>[feed.entry_id||feed.created_at,feed]));
      incoming.forEach(feed=>merged.set(feed.entry_id||feed.created_at,feed));
      let feeds=Array.from(merged.values());
      const lastExisting=existing[existing.length-1];
      if(lastExisting&&incoming.some(feed=>new Date(feed.created_at).getTime()<new Date(lastExisting.created_at).getTime())){
        feeds.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
      }
      nextFeeds.set(sourceId,feeds.filter(feed=>{const timestamp=new Date(feed.created_at).getTime();return timestamp>=cutoff&&timestamp<=ceiling}));
    });
    if(state.loadedAggregation!==requestedMode||state.windowKey!==key)clearCharts();
    state.loadedAggregation=requestedMode;
    state.feedsBySource=nextFeeds;
    state.channelsBySource=nextChannels;
    state.feeds=nextFeeds.get(state.selectedId)||[];
    state.channel=nextChannels.get(state.selectedId)||{};
    state.windowKey=key;
    const lastFeed=state.feeds[state.feeds.length-1];
    state.lastEntryId=lastFeed?.entry_id||lastFeed?.created_at||null;
    renderCards();
    const total=Array.from(nextFeeds.values()).reduce((sum,feeds)=>sum+feeds.length,0);
    const pointLabel=requestedMode==='raw'?'采样点':'时间段';
    $('connectionStatus').textContent=sourceIds.length>1?`${sourceIds.length} 个数据源 · ${total} 个${pointLabel}`:`${total} 个${pointLabel}`;
    $('aggregationHint').textContent=TelemetryView.hint(requestedMode);
  }catch(error){
    if(error.name==='AbortError'||token!==state.requestToken)return;
    showNotice(error.message);
    $('connectionStatus').textContent='连接失败';
    $('aggregationHint').textContent=`读取失败：${error.message}。下方保留上次成功加载的${TelemetryView.labels[state.loadedAggregation]}。`;
  }finally{
    if(activeDataController===controller)activeDataController=null;
    if(token===state.requestToken){state.loading=false;$('cardsGrid').setAttribute('aria-busy','false')}
  }
};
let sourceOrderPending=null;
let sourceOrderSaving=false;
function queueSourceOrderSave(){
  sourceOrderPending=state.sources.map(source=>source.id);
  if(sourceOrderSaving)return;
  sourceOrderSaving=true;
  (async()=>{
    try{
      while(sourceOrderPending){
        const sourceIds=sourceOrderPending;
        sourceOrderPending=null;
        await api('/api/sources/order',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_ids:sourceIds})});
      }
    }catch(error){showNotice(error.message);await loadSources()}
    finally{sourceOrderSaving=false;if(sourceOrderPending)queueSourceOrderSave()}
  })();
}
function renderSources(){
  const list=$('sourceList');
  resetSourceDragState();
  list.innerHTML='';
  if(!state.sources.length){list.innerHTML='<div class="empty-mini">暂无数据源</div>';return}
  state.sources.forEach(source=>{
    const btn=document.createElement('button');
    btn.className=`source-item ${source.id===state.selectedId?'active':''} ${source.enabled?'':'source-disabled'}`;
    btn.dataset.sourceId=String(source.id);
    btn.draggable=false;
    btn.title=isTouchDevice?'长按拖拽调整顺序':'拖拽调整数据源顺序';
    btn.innerHTML=`<span class="source-name">${escapeHtml(source.name)}</span><span class="source-meta">CH ${escapeHtml(source.channel_id)}${source.enabled?'':' · DISABLED'}</span><span class="source-drag-handle" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></span>`;
    btn.onclick=()=>{if(isDraggingSource||suppressSourceClick){suppressSourceClick=false;return}selectSource(source.id)};
    if(isTouchDevice){
      let touchTimer=null, touchStartY=0, initialRect=null, offsetY=0, wasDragging=false, frame=null, lastTouchY=0, positions=[];
      const resolveDropPosition=y=>{
        if(!positions.length)return null;
        for(const item of positions){
          if(y<(item.top+item.bottom)/2)return{element:item.element,after:false};
        }
        return{element:positions[positions.length-1].element,after:true};
      };
      const resetTouchState=()=>{
        if(touchTimer){clearTimeout(touchTimer);touchTimer=null}
        if(frame){cancelAnimationFrame(frame);frame=null}
        if(activeTouchReset===resetTouchState)activeTouchReset=null;
        btn.style.transform='';clearSourceDragState();isDraggingSource=false;wasDragging=false;positions=[];
      };
      const updateDragPreview=()=>{
        frame=null;if(!isDraggingSource||!wasDragging)return;
        const deltaY=lastTouchY-offsetY-initialRect.top;
        btn.style.transform=`translateY(${deltaY}px)`;
        const placement=resolveDropPosition(lastTouchY);
        const targetItem=placement?.element;
        const insertAfter=Boolean(placement?.after);
        document.querySelectorAll('#sourceList .source-item').forEach(item=>item.classList.remove('drag-over-top','drag-over-bottom'));
        if(targetItem)targetItem.classList.add(insertAfter?'drag-over-bottom':'drag-over-top');
      };
      btn.addEventListener('touchstart',event=>{
        if(isDraggingSource)return;
        activeTouchReset=resetTouchState;
        touchStartY=event.touches[0].clientY;lastTouchY=touchStartY;initialRect=btn.getBoundingClientRect();offsetY=touchStartY-initialRect.top;wasDragging=false;
        touchTimer=setTimeout(()=>{if(document.hidden)return;isDraggingSource=true;wasDragging=true;btn.classList.add('touch-dragging');positions=Array.from(list.querySelectorAll('.source-item:not(.touch-dragging)')).map(element=>{const rect=element.getBoundingClientRect();return{element,top:rect.top,bottom:rect.bottom}});if(navigator.vibrate)navigator.vibrate(50)},450);
      },{passive:true});
      btn.addEventListener('touchmove',event=>{
        const touch=event.touches[0];lastTouchY=touch.clientY;
        if(touchTimer&&Math.abs(lastTouchY-touchStartY)>10){clearTimeout(touchTimer);touchTimer=null;return}
        if(!isDraggingSource||!wasDragging)return;
        if(event.cancelable)event.preventDefault();if(!frame)frame=requestAnimationFrame(updateDragPreview);
      },{passive:false});
      const finishTouchDrag=event=>{
        if(touchTimer){clearTimeout(touchTimer);touchTimer=null}
        if(!isDraggingSource||!wasDragging){resetTouchState();return}
        if(event.cancelable)event.preventDefault();lastTouchY=event.changedTouches[0].clientY;
        const placement=resolveDropPosition(lastTouchY);
        const targetItem=placement?.element;
        const insertAfter=Boolean(placement?.after);
        const targetSource=targetItem?state.sources.find(item=>item.id===Number(targetItem.dataset.sourceId)):null;
        resetTouchState();
        if(targetSource&&targetSource.id!==source.id)moveSource(source.id,targetSource.id,insertAfter);
      };
      btn.addEventListener('touchend',finishTouchDrag,{passive:false});
      btn.addEventListener('touchcancel',resetTouchState);
    }else{
      let pointerId=null,pointerStartY=0,pointerDragging=false,lastPointerY=0;
      const resolvePointerDropPosition=y=>{
        const items=Array.from(list.querySelectorAll('.source-item')).filter(item=>item!==btn);
        for(const item of items){
          const rect=item.getBoundingClientRect();
          if(y<(rect.top+rect.bottom)/2)return{item,after:false};
        }
        return items.length?{item:items[items.length-1],after:true}:null;
      };
      const resetPointerState=()=>{
        if(activePointerReset===resetPointerState)activePointerReset=null;
        const capturedPointerId=pointerId;
        pointerId=null;pointerDragging=false;lastPointerY=0;btn.style.transform='';
        if(capturedPointerId!==null&&btn.hasPointerCapture?.(capturedPointerId))btn.releasePointerCapture(capturedPointerId);
        clearSourceDragState();isDraggingSource=false;
      };
      const finishPointerDrag=event=>{
        if(pointerId===null||event.pointerId!==pointerId)return;
        const wasDragging=pointerDragging;
        const placement=wasDragging?resolvePointerDropPosition(event.clientY):null;
        const targetSource=placement?state.sources.find(item=>item.id===Number(placement.item.dataset.sourceId)):null;
        if(wasDragging&&event.cancelable)event.preventDefault();
        resetPointerState();
        if(wasDragging&&targetSource&&targetSource.id!==source.id)moveSource(source.id,targetSource.id,placement.after);
      };
      btn.addEventListener('pointerdown',event=>{
        if(event.pointerType!=='mouse'||event.button!==0||isDraggingSource)return;
        resetSourceDragState();
        pointerId=event.pointerId;pointerStartY=event.clientY;lastPointerY=event.clientY;pointerDragging=false;activePointerReset=resetPointerState;
      });
      btn.addEventListener('pointermove',event=>{
        if(pointerId===null||event.pointerId!==pointerId)return;
        lastPointerY=event.clientY;
        if(!pointerDragging&&Math.abs(event.clientY-pointerStartY)<5)return;
        if(!pointerDragging){
          pointerDragging=true;isDraggingSource=true;suppressSourceClick=true;btn.classList.add('dragging');
          btn.setPointerCapture?.(pointerId);
        }
        if(event.cancelable)event.preventDefault();
        const rect=btn.getBoundingClientRect();
        btn.style.transform=`translateY(${event.clientY-pointerStartY}px)`;
        const placement=resolvePointerDropPosition(event.clientY);
        document.querySelectorAll('#sourceList .source-item').forEach(item=>item.classList.remove('drag-over-top','drag-over-bottom'));
        if(placement)placement.item.classList.add(placement.after?'drag-over-bottom':'drag-over-top');
      });
      btn.addEventListener('pointerup',finishPointerDrag);
      btn.addEventListener('pointercancel',resetPointerState);
      btn.addEventListener('lostpointercapture',()=>{if(pointerId!==null)resetPointerState()});
    }
    list.appendChild(btn);
  });
}
function clearCharts(){state.charts.forEach(chart=>chart.dispose());state.charts.clear();if(chartResizeObserver)chartResizeObserver.disconnect()}
function visibleSelections(card){return cardSelections(card).filter(selection=>(state.feedsBySource.get(selection.source_id)||[]).some(feed=>{return TelemetryView.number(feed[`field${selection.field_number}`])!==null}))}
function fieldHasDataForSource(sourceId,number){return(state.feedsBySource.get(Number(sourceId))||[]).some(feed=>{const raw=feed[`field${number}`];return raw!==null&&raw!==undefined&&String(raw).trim()!==''&&Number.isFinite(Number(raw))})}
function fieldHasData(number){return fieldHasDataForSource(state.selectedId,number)}
function defaultCardSelections(){const source=currentSource();const fields=source?.fields||Array.from({length:8},(_,index)=>({field_number:index+1}));const dataLoaded=state.feedsBySource.has(Number(state.selectedId));const firstAvailable=fields.find(field=>!dataLoaded||fieldHasData(field.field_number));return[{source_id:Number(state.selectedId),field_number:Number(firstAvailable?.field_number||1)}]}
function cardPointCount(card){const ids=new Set(cardSelections(card).map(selection=>selection.source_id));return Array.from(ids).reduce((total,sourceId)=>total+(state.feedsBySource.get(sourceId)||[]).length,0)}
function cardRenderKey(card){return JSON.stringify([state.loadedAggregation,card.id,card.title,card.chart_type,card.y_axis_min,card.show_stats,card.share_enabled,card.field_selections,card.field_numbers])}
function renderCards(){clearCharts();const grid=$('cardsGrid');grid.innerHTML='';const hasSource=Boolean(state.selectedId);$('cardAddRow').classList.toggle('hidden',!hasSource||!state.cards.length);$('emptyState').classList.toggle('hidden',!hasSource||state.cards.length>0);if(!hasSource){grid.innerHTML='<div class="empty-state inline-empty"><div class="empty-icon">◌</div><h3>选择一个数据源开始</h3><p>从左侧选择已有数据源，或先创建一个新的 Channel。</p></div>';return}state.cards.forEach((card,index)=>{const article=document.createElement('article');article.className='dashboard-card';article.dataset.cardId=card.id;article.dataset.renderKey=cardRenderKey(card);const selections=cardSelections(card);const fieldLabel=selections.map(selection=>selectionName(selection,selections)).join(' · ');const points=cardPointCount(card);article.innerHTML=`<div class="card-head"><div class="card-heading"><span class="panel-kicker">CARD ${String(index+1).padStart(2,'0')} · ${escapeHtml(chartNames[card.chart_type]||'图表')}</span><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(fieldLabel)} <span class="card-count">${selections.length} fields</span></p></div><div class="card-actions"><button class="card-icon" data-action="edit" title="编辑卡片" aria-label="编辑卡片">${iconSvg('edit')}</button>${card.share_enabled?`<button class="card-icon" data-action="share" title="复制分享链接" aria-label="复制分享链接">${iconSvg('share')}</button>`:''}<button class="card-icon" data-action="fullscreen" title="全屏查看" aria-label="全屏查看">${iconSvg('fullscreen')}</button></div></div>${card.show_stats?'<div class="card-stats" id="stats-'+card.id+'"></div>':''}<p class="card-data-mode">${TelemetryView.labels[state.loadedAggregation]}${state.loadedAggregation==='raw'?'':' · 总均值按样本数加权'}</p><div class="card-chart" id="chart-${card.id}"></div><details class="data-table"></details><div class="card-foot"><span>${card.share_enabled?'SHARE ENABLED':'PRIVATE CARD'}</span><span>${points?`UPDATED ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`:'WAITING FOR DATA'}</span></div>`;article.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>cardAction(button.dataset.action,card,article));grid.appendChild(article);renderCardChart(card,article.querySelector('.card-chart'));renderCardTable(card,article);if(card.show_stats)renderCardStats(card,$(`stats-${card.id}`))})}
function renderCardChart(card,element){
  const mobile=mobileChartMode();
  const mode=state.loadedAggregation;
  const selections=visibleSelections(card);
  if(!selections.length){
    const old=state.charts.get(card.id);
    if(old){old.dispose();state.charts.delete(card.id)}
    element.innerHTML='<div class="chart-empty"><span>NO NUMERIC DATA</span><strong>暂无可用数据</strong></div>';
    return;
  }
  if(!state.charts.has(card.id)&&element.querySelector('.chart-empty'))element.innerHTML='';
  let chart=state.charts.get(card.id);
  if(!chart)chart=echarts.init(element,null,{renderer:mobile?'svg':'canvas'});
  state.charts.set(card.id,chart);
  observeChart(element);
  const zoom=readDataZoom(chart);
  const type=card.chart_type==='area'?'line':card.chart_type;
  const series=selections.map((selection,index)=>{
    const slot=cardSelections(card).findIndex(item=>selectionKey(item)===selectionKey(selection));
    const {color,symbol,lineType}=TelemetryView.style(slot);
    const feeds=state.feedsBySource.get(selection.source_id)||[];
    const dense=feeds.length>500;
    const item={name:selectionName(selection,selections),type,smooth:mode==='raw'&&!mobile&&card.chart_type!=='bar',connectNulls:mode==='raw',sampling:mode==='raw'&&type==='line'&&feeds.length>1000?'lttb':undefined,showSymbol:mode!=='raw'||mobile||!dense,symbol,symbolSize:mode==='raw'?(mobile?3:5):8,showAllSymbol:mobile?'auto':false,emphasis:{scale:true,symbolSize:8},data:TelemetryView.points(feeds,`field${selection.field_number}`,mode),lineStyle:{width:2,color,type:lineType,cap:'round',join:'round'},itemStyle:{color},endLabel:{show:false},areaStyle:card.chart_type==='area'?{opacity:.14,color}:undefined};
    if(type==='bar')item.barMaxWidth=20;
    return item;
  });
  const pointCount=series.reduce((total,item)=>total+item.data.length,0);
  chart.setOption({animation:!mobile&&pointCount<2000,animationDuration:mobile||pointCount>=2000?0:450,backgroundColor:'transparent',color:colors,tooltip:{trigger:type==='bar'?'item':'axis',confine:true,formatter:TelemetryView.tooltip(mode),backgroundColor:'#16212b',borderColor:'#314352',textStyle:{color:'#e8eef2'},axisPointer:{type:'line'}},legend:{show:!mobile,type:'scroll',top:0,right:0,textStyle:{color:'#94a3af',fontSize:11}},grid:{left:48,right:mobile?16:24,top:38,bottom:38},xAxis:{type:'time',minInterval:({hour:3600000,day:86400000,month:2419200000})[mode],splitNumber:mobile?4:6,boundaryGap:card.chart_type==='bar',axisLine:{lineStyle:{color:'#30404d'}},axisLabel:{color:'#718391',fontSize:10,hideOverlap:true,formatter:value=>TelemetryView.date(value,mode)}},yAxis:{type:'value',min:card.y_axis_min===null||card.y_axis_min===''?null:Number(card.y_axis_min),splitLine:{lineStyle:{color:'#23313c'}},axisLabel:{color:'#718391',fontSize:10}},dataZoom:[{type:'inside',...zoom},{type:'slider',height:14,bottom:0,borderColor:'#263442',backgroundColor:'#111a22',fillerColor:'#2d3d48',...zoom}],series},{notMerge:true});
  TelemetryView.touchLegend(chart);
  chart.resize();
}
// notMerge:true 会重置 dataZoom，自动刷新时把用户在手机上双指缩放的范围还原回去
function readDataZoom(chart){try{const item=chart.getOption?.()?.dataZoom?.[0];if(!item)return{};const{start,end}=item;if(typeof start!=='number'||typeof end!=='number')return{};if(start<=0&&end>=100)return{};return{start,end}}catch(error){return{}}}
function renderCardStats(card,container){
  if(!container)return;
  const selections=cardSelections(card),mode=state.loadedAggregation;
  const summaries=selections.map(selection=>TelemetryView.metrics(state.feedsBySource.get(selection.source_id)||[],`field${selection.field_number}`,mode));
  container.innerHTML=TelemetryView.metricLabels(mode).map((label,metric)=>`<div class="stat-block"><small>${label}</small><div>${selections.map((selection,index)=>{
    const name=selectionName(selection,selections),value=summaries[index][metric];
    return `<span style="--swatch:${colors[index%colors.length]}" title="${escapeHtml(name)}"><em>${escapeHtml(name)}</em><b>${TelemetryView.format(value)}</b></span>`;
  }).join('')}</div></div>`).join('');
}
function renderCardTable(card,article){const selections=cardSelections(card);TelemetryView.table(article.querySelector('.data-table'),selections.map(selection=>({name:selectionName(selection,selections),field:`field${selection.field_number}`,feeds:state.feedsBySource.get(selection.source_id)||[]})),state.loadedAggregation)}
function formatNumber(value){return Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3})}
function cardAction(action,card,article){if(action==='edit')return openCardDialog(card);if(action==='share')return copyShareLink(card);if(action==='fullscreen')return toggleFullscreen(article)}
function openDialog(source){closeSidebar();$('sourceId').value=source?.id||'';$('dialogTitle').textContent=source?'编辑数据源':'添加数据源';$('nameInput').value=source?.name||'';$('channelInput').value=source?.channel_id||'';$('keyInput').value='';$('keyInput').placeholder=source?'留空则保留当前 Key':'只保存在服务器';$('descriptionInput').value=source?.description||'';$('enabledInput').checked=source?source.enabled:true;$('deleteSourceFromDialogBtn').classList.toggle('hidden',!source);$('sourceDialog').showModal()}
async function saveSource(event){event.preventDefault();const id=$('sourceId').value;const payload={name:$('nameInput').value,channel_id:$('channelInput').value,read_api_key:$('keyInput').value,description:$('descriptionInput').value,enabled:$('enabledInput').checked};try{await api(id?`/api/sources/${id}`:'/api/sources',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});$('sourceDialog').close();state.selectedId=id?Number(id):null;await loadSources()}catch(error){showNotice(error.message)}}
function renderFieldSourceTabs(){const tabs=$('cardSourceTabs');tabs.innerHTML=state.sources.map(source=>{const count=cardFieldSelections.filter(selection=>selection.source_id===source.id).length;return `<button type="button" role="tab" aria-selected="${source.id===activeCardSourceId}" class="${source.id===activeCardSourceId?'active':''} ${source.enabled?'':'source-tab-disabled'}" data-source-id="${source.id}" title="ThingSpeak Channel ${escapeHtml(source.channel_id)}">${escapeHtml(source.name)}${count?` <span>${count}</span>`:''}</button>`}).join('');tabs.querySelectorAll('button').forEach(button=>button.onclick=()=>activateCardSource(button.dataset.sourceId))}
function renderFieldPicker(sourceId=activeCardSourceId){const source=state.sources.find(item=>item.id===Number(sourceId))||currentSource();if(!source){$('cardFields').innerHTML='';return}const fields=source.fields||Array.from({length:8},(_,index)=>({field_number:index+1,name:`Field ${index+1}`,unit:''}));const dataLoaded=state.feedsBySource.has(source.id);$('cardFields').innerHTML=fields.map(field=>{const number=field.field_number;const selection={source_id:source.id,field_number:number};const key=selectionKey(selection);const selected=cardFieldSelections.some(item=>selectionKey(item)===key);const unavailable=dataLoaded&&!fieldHasDataForSource(source.id,number);const locked=(!source.enabled||unavailable)&&!selected;const meta=selectionInfo(selection);return `<label class="field-option ${unavailable?'field-option-no-data':''} ${locked?'field-option-disabled':''} ${selected&&unavailable?'field-option-no-data-selected':''}"><input type="checkbox" value="${number}" data-source-id="${source.id}" ${selected?'checked':''} ${locked?'disabled':''}><span class="field-option-swatch" style="--swatch:${colors[(number-1)%colors.length]}"></span><span>${escapeHtml(meta.name)}</span><small>field${number}${meta.unit?` · ${escapeHtml(meta.unit)}`:''}${!source.enabled?' · 数据源已停用':unavailable?' · 暂无数据':''}</small></label>`}).join('');$('cardFields').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{const selection={source_id:Number(input.dataset.sourceId),field_number:Number(input.value)};const key=selectionKey(selection);cardFieldSelections=cardFieldSelections.filter(item=>selectionKey(item)!==key);if(input.checked)cardFieldSelections.push(selection);renderFieldSourceTabs();if(!input.checked&&(input.closest('.field-option')?.classList.contains('field-option-no-data')||!source.enabled)){input.disabled=true;input.closest('.field-option')?.classList.add('field-option-disabled')}}))}
function clearCardError(){$('cardFormError').textContent='';$('cardFormError').classList.add('hidden')}
function showCardError(message){$('cardFormError').textContent=message;$('cardFormError').classList.remove('hidden')}
function toLocalDateTime(value){if(!value)return'';const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value).slice(0,16);const offset=date.getTimezoneOffset();return new Date(date.getTime()-offset*60000).toISOString().slice(0,16)}
function getShareWindowOptions(){try{const options=JSON.parse($('shareWindowInput').value||'[]');return Array.isArray(options)?options.map(Number).filter(Number.isFinite):[]}catch(error){return[]}}
function updateShareWindowVisibility(){const enabled=$('cardShareInput').checked;const options=getShareWindowOptions();$('shareWindowSettings').classList.toggle('hidden',!enabled);$('shareWindowCustom').classList.toggle('hidden',!enabled||!options.includes(0))}
function setShareWindowOptions(options){const unique=[...new Set(options.map(Number))].filter(value=>[0,1,6,12,24,72,168,720].includes(value));$('shareWindowInput').value=JSON.stringify(unique.length?unique:[24]);document.querySelectorAll('#shareWindowOptions button').forEach(button=>button.classList.toggle('active',getShareWindowOptions().includes(Number(button.dataset.windowHours))));updateShareWindowVisibility()}
function toggleShareWindowOption(hours){const current=getShareWindowOptions();let next;if(hours===0){next=current.includes(0)?[24]:[0]}else{next=current.filter(value=>value!==0);if(next.includes(hours))next=next.filter(value=>value!==hours);else next.push(hours);if(!next.length)next=[24]}setShareWindowOptions(next)}
function openCardDialog(card=null){if(!currentSource())return;clearCardError();$('cardId').value=card?.id||'';$('cardDialogTitle').textContent=card?'编辑数据卡片':'新增数据卡片';$('cardTitleInput').value=card?.title||'实时趋势';$('cardChartType').value=card?.chart_type||'line';$('cardYAxisMin').value=card?.y_axis_min??'';$('cardStatsInput').checked=card?card.show_stats:true;$('cardShareInput').checked=card?card.share_enabled:false;setShareWindowOptions(card?.share_windows?.map(Number)||[Number(card?.share_hours??24)]);$('shareWindowStart').value=toLocalDateTime(card?.share_start);$('shareWindowEnd').value=toLocalDateTime(card?.share_end);$('deleteCardFromDialogBtn').classList.toggle('hidden',!card);cardFieldSelections=card?cardSelections(card):defaultCardSelections();activeCardSourceId=state.sources.some(source=>source.id===state.selectedId)?state.selectedId:(cardFieldSelections[0]?.source_id||state.sources[0]?.id);renderFieldSourceTabs();renderFieldPicker(activeCardSourceId);updateShareWindowVisibility();updateSharePreview(card);$('cardDialog').showModal();activateCardSource(activeCardSourceId)}
function updateSharePreview(card){const box=$('sharePreview');if(!$('cardShareInput').checked){box.classList.add('hidden');box.innerHTML='';return}const token=card?.share_token;const url=token?`${location.origin}/share/${token}`:'保存后生成分享链接';box.classList.remove('hidden');box.innerHTML=`<span>分享地址</span><code>${escapeHtml(url)}</code>`}
function restorePagePosition(x,y){if(typeof window.scrollTo==='function')window.scrollTo(x,y);window.requestAnimationFrame?.(()=>{if(typeof window.scrollTo==='function')window.scrollTo(x,y)})}
async function saveCard(event){event.preventDefault();clearCardError();const pageX=window.scrollX||0,pageY=window.scrollY||0;const id=$('cardId').value;const sourceOrder=new Map(state.sources.map((source,index)=>[source.id,index]));const fieldSelections=[...cardFieldSelections].sort((a,b)=>(sourceOrder.get(a.source_id)??999)-(sourceOrder.get(b.source_id)??999)||a.field_number-b.field_number);if(!fieldSelections.length){showCardError('请至少选择一个 Field 后再保存');return}const shareWindows=getShareWindowOptions();if(!shareWindows.length){showCardError('至少选择一个分享时间窗口');return}const shareHours=shareWindows[0];let shareStart='';let shareEnd='';if(shareWindows.includes(0)){if(!$('shareWindowStart').value||!$('shareWindowEnd').value){showCardError('请填写完整的分享起止时间');return}shareStart=new Date($('shareWindowStart').value).toISOString();shareEnd=new Date($('shareWindowEnd').value).toISOString();if(new Date(shareEnd)<=new Date(shareStart)){showCardError('分享结束时间必须晚于开始时间');return}}const payload={title:$('cardTitleInput').value,field_selections:fieldSelections,chart_type:$('cardChartType').value,y_axis_min:$('cardYAxisMin').value,show_stats:$('cardStatsInput').checked,share_enabled:$('cardShareInput').checked,share_hours:shareHours,share_windows:shareWindows,share_start:shareStart,share_end:shareEnd};try{const path=id?`/api/sources/${state.selectedId}/cards/${id}`:`/api/sources/${state.selectedId}/cards`;await api(path,{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});$('cardDialog').close();restorePagePosition(pageX,pageY);const source=currentSource();source.cards=await api(`/api/sources/${state.selectedId}/cards`);state.cards=source.cards;state.windowKey='';renderCards();await loadData(false);restorePagePosition(pageX,pageY)}catch(error){showCardError(error.message)}}
function requestDelete(type,item){state.pendingDelete={type,id:item.id};if(type==='source'){$('sourceDialog').close();$('confirmKicker').textContent='REMOVE SOURCE';$('confirmTitle').textContent='删除这个数据源？';$('confirmMessage').textContent=`将移除“${item.name}”及其字段、卡片配置，此操作无法撤销。`}else{$('cardDialog').close();$('confirmKicker').textContent='REMOVE CARD';$('confirmTitle').textContent='删除这张数据卡片？';$('confirmMessage').textContent=`将移除“${item.title}”及其图表配置，此操作无法撤销。`}$('confirmDialog').showModal()}
async function confirmDelete(){const pending=state.pendingDelete;if(!pending)return;$('confirmDialog').close();try{if(pending.type==='source'){await api(`/api/sources/${pending.id}`,{method:'DELETE'});state.selectedId=null;state.pendingDelete=null;await loadSources()}else{await api(`/api/sources/${state.selectedId}/cards/${pending.id}`,{method:'DELETE'});const source=currentSource();source.cards=await api(`/api/sources/${state.selectedId}/cards`);state.cards=source.cards;state.pendingDelete=null;renderCards()}}catch(error){state.pendingDelete=null;showNotice(error.message)}}
async function copyShareLink(card){if(!card.share_token)return;const url=`${location.origin}/share/${card.share_token}`;try{await navigator.clipboard.writeText(url);showNotice('分享链接已复制')}catch(error){window.prompt('复制分享链接',url)}}
async function toggleFullscreen(element){try{if(document.fullscreenElement)await document.exitFullscreen();else await element.requestFullscreen()}catch(error){showNotice('当前浏览器不支持全屏访问')}}
function deleteSelected(){const source=currentSource();if(source)requestDelete('source',source)}
let refreshGeneration=0;
function scheduleRefresh(){
  if(state.refreshTimer)clearTimeout(state.refreshTimer);
  const generation=++refreshGeneration;
  const seconds=Number($('refreshSelect').value);
  if(!seconds)return;
  const tick=async()=>{
    if(generation!==refreshGeneration)return;
    await loadData(true);
    if(generation===refreshGeneration)state.refreshTimer=setTimeout(tick,seconds*1000);
  };
  state.refreshTimer=setTimeout(tick,seconds*1000);
}
function refreshRenderedCards(){const articles=Array.from(document.querySelectorAll('#cardsGrid .dashboard-card'));if(articles.length!==state.cards.length)return false;return articles.every(article=>{const card=state.cards.find(item=>String(item.id)===article.dataset.cardId);if(!card||article.dataset.renderKey!==cardRenderKey(card))return false;const chartElement=article.querySelector('.card-chart');renderCardChart(card,chartElement);renderCardTable(card,article);const statsElement=article.querySelector('.card-stats');if(card.show_stats&&statsElement)renderCardStats(card,statsElement);const foot=article.querySelector('.card-foot span:last-child');if(foot)foot.textContent=cardPointCount(card)?`UPDATED ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`:'WAITING FOR DATA';return true})}
const rebuildCards=renderCards;
renderCards=function(){const pageX=window.scrollX||0,pageY=window.scrollY||0;if(state.selectedId&&state.cards.length&&refreshRenderedCards()){}else rebuildCards();restorePagePosition(pageX,pageY)};
document.addEventListener('DOMContentLoaded',()=>{$('addSourceBtn').onclick=()=>openDialog();$('editSourceBtn').onclick=()=>openDialog(currentSource());$('addCardBtn').onclick=()=>openCardDialog();$('emptyAddCardBtn').onclick=()=>openCardDialog();$('deleteSourceFromDialogBtn').onclick=deleteSelected;$('deleteCardFromDialogBtn').onclick=()=>{const card=state.cards.find(item=>String(item.id)===$('cardId').value);if(card)requestDelete('card',card)};$('confirmDeleteBtn').onclick=confirmDelete;$('cancelDeleteBtn').onclick=()=>{state.pendingDelete=null;$('confirmDialog').close()};$('refreshNowBtn').onclick=()=>loadData(false);TelemetryView.bindControls($('aggregationButtons'),mode=>{state.aggregation=mode;loadData(false)});$('refreshSelect').onchange=scheduleRefresh;$('sourceForm').addEventListener('submit',saveSource);$('closeSourceBtn').onclick=()=>$('sourceDialog').close();$('cancelSourceBtn').onclick=()=>$('sourceDialog').close();$('closeCardBtn').onclick=()=>$('cardDialog').close();$('cancelCardBtn').onclick=()=>$('cardDialog').close();$('cardForm').addEventListener('submit',saveCard);$('cardShareInput').onchange=()=>{updateSharePreview(state.cards.find(card=>String(card.id)===$('cardId').value));updateShareWindowVisibility()};$('shareWindowOptions').addEventListener('click',event=>{const button=event.target.closest('button');if(button)toggleShareWindowOption(Number(button.dataset.windowHours))});$('customToggle').onclick=()=>$('customRange').classList.toggle('hidden');$('applyCustomBtn').onclick=()=>{const start=$('customStart').value,end=$('customEnd').value;if(!start||!end||!Number.isFinite(new Date(start).getTime())||!Number.isFinite(new Date(end).getTime())||new Date(end)<=new Date(start)){showNotice('请填写有效的开始、结束时间，结束时间须晚于开始时间');return}state.customStart=start;state.customEnd=end;document.querySelectorAll('#rangeButtons button').forEach(button=>button.classList.remove('active'));state.windowKey='';loadData(false)};$('rangeButtons').addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;document.querySelectorAll('#rangeButtons button').forEach(item=>item.classList.remove('active'));button.classList.add('active');state.customStart=null;state.customEnd=null;state.hours=Number(button.dataset.hours);state.windowKey='';loadData(false)});$('menuToggle').onclick=toggleSidebar;$('sidebarBackdrop').onclick=closeSidebar;if(window.innerWidth<=900)document.querySelector('.sidebar')?.setAttribute('aria-hidden','true');document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSidebar()});document.addEventListener('fullscreenchange',()=>{requestAnimationFrame(()=>state.charts.forEach(chart=>chart.resize()))});window.addEventListener('orientationchange',()=>{setTimeout(()=>state.charts.forEach(chart=>chart.resize()),250)});window.addEventListener('resize',()=>{const shell=document.querySelector('.app-shell');if(window.innerWidth>900){shell?.classList.remove('sidebar-open');setScrollLock(false);document.querySelector('.sidebar')?.removeAttribute('aria-hidden')}else{shell?.classList.remove('sidebar-collapsed')}const button=$('menuToggle');const open=window.innerWidth>900?!shell?.classList.contains('sidebar-collapsed'):shell?.classList.contains('sidebar-open');button?.setAttribute('aria-expanded',String(open));button?.setAttribute('aria-label',open?'关闭数据源菜单':'打开数据源菜单');state.charts.forEach(chart=>chart.resize())});setInterval(()=>$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false}),1000);loadSources();scheduleRefresh()});
