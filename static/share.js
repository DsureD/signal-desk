const shareToken=decodeURIComponent(location.pathname.split('/').pop());
const shareColors=TelemetryView.colors;
let shareChart=null;
let shareLoading=false;
let shareSelectedWindow=null;
let shareAutoRefresh=false;
let shareAutoRefreshTimer=null;
let shareAggregation='raw';
let shareLoadedAggregation='raw';
let shareController=null;
let shareRequestToken=0;
let shareLoadedWindow=null;
const SHARE_AUTO_REFRESH_MS=60000;
const share$=id=>document.getElementById(id);
function shareEscape(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function shareNotice(message){share$('shareNotice').textContent=message;share$('shareNotice').classList.remove('hidden')}
function shareWindowLabel(value){return({0:'自定义时间',1:'最近 1 小时',6:'最近 6 小时',12:'最近 12 小时',24:'最近 24 小时',72:'最近 3 天',168:'最近 7 天',720:'最近 30 天'})[Number(value)]||'最近 24 小时'}
function updateShareAutoRefreshStatus(){const status=share$('shareAutoRefreshStatus');if(status)status.textContent=shareAutoRefresh?'每 60 秒':'关闭';const input=share$('shareAutoRefresh');if(input)input.checked=shareAutoRefresh}
function stopShareAutoRefresh(){if(shareAutoRefreshTimer){clearInterval(shareAutoRefreshTimer);shareAutoRefreshTimer=null}}
function setShareAutoRefresh(enabled){shareAutoRefresh=Boolean(enabled);stopShareAutoRefresh();if(shareAutoRefresh){shareAutoRefreshTimer=setInterval(()=>{if(!document.hidden&&!shareLoading)loadShareData()},SHARE_AUTO_REFRESH_MS)}updateShareAutoRefreshStatus()}
function renderShareWindowOptions(options,selected){share$('shareWindowOptions').innerHTML=options.map(value=>`<button type="button" class="${Number(value)===Number(selected)?'active':''}" aria-pressed="${Number(value)===Number(selected)}" data-window="${value}">${shareWindowLabel(value).replace('最近 ','')}</button>`).join('');share$('shareWindowOptions').querySelectorAll('button').forEach(button=>button.onclick=()=>{shareSelectedWindow=button.dataset.window;renderShareWindowOptions(options,shareSelectedWindow);loadShareData()})}
function shareSelections(card){const raw=Array.isArray(card.field_selections)?card.field_selections:(card.field_numbers||[]).map(number=>({source_id:card.source_id,field_number:number}));return raw.map(item=>({source_id:Number(item.source_id),field_number:Number(item.field_number)})).filter(item=>item.source_id&&item.field_number>=1&&item.field_number<=8)}
function shareDataset(data,sourceId){return data.source_data?.[String(sourceId)]||(Number(sourceId)===Number(data.card.source_id)?{source:data.source,channel:data.channel||{},fields:data.fields||[],feeds:data.feeds||[]}:null)}
function shareSelectionInfo(data,selection){const dataset=shareDataset(data,selection.source_id)||{};const number=selection.field_number;const field=dataset.fields?.find(item=>Number(item.field_number)===number);return{sourceName:dataset.source?.name||`数据源 ${selection.source_id}`,name:dataset.channel?.[`field${number}`]||field?.name||`Field ${number}`}}
function shareSelectionName(data,selection,selections){const meta=shareSelectionInfo(data,selection);return new Set(selections.map(item=>item.source_id)).size>1?`${meta.sourceName} · ${meta.name}`:meta.name}
function shareStats(data,selections){
  const container=share$('shareStats');
  if(!data.card.show_stats){container.innerHTML='';return}
  const summaries=selections.map(selection=>TelemetryView.metrics(shareDataset(data,selection.source_id)?.feeds||[],`field${selection.field_number}`,shareLoadedAggregation));
  container.innerHTML=TelemetryView.metricLabels(shareLoadedAggregation).map((label,metric)=>`<div class="stat-block"><small>${label}</small><div>${selections.map((selection,index)=>{
    const name=shareSelectionName(data,selection,selections);
    return `<span style="--swatch:${shareColors[index%shareColors.length]}" title="${shareEscape(name)}"><em>${shareEscape(name)}</em><b>${TelemetryView.format(summaries[index][metric])}</b></span>`;
  }).join('')}</div></div>`).join('');
}
function mobileShareChartMode(){return window.matchMedia?.('(max-width:900px)').matches}
function renderShare(data){
  const mobile=mobileShareChartMode(),mode=shareLoadedAggregation,card=data.card;
  const selections=shareSelections(card),names=selections.map(selection=>shareSelectionName(data,selection,selections));
  const options=(data.available_windows||card.share_windows||[24]).map(Number);
  shareSelectedWindow=String(data.selected_window??shareSelectedWindow??options[0]);
  renderShareWindowOptions(options,shareSelectedWindow);
  share$('shareSourceTitle').textContent=data.source.name;
  share$('shareSourceMeta').textContent=`只读访问 · ${data.share_window||shareWindowLabel(shareSelectedWindow)}`;
  share$('shareWindowLabel').textContent=data.share_window||shareWindowLabel(shareSelectedWindow);
  share$('shareCardTitle').textContent=card.title;
  share$('shareFieldLabel').textContent=names.join(' · ');
  share$('shareDataMode').textContent=`${TelemetryView.labels[mode]}${mode==='raw'?'':' · 总均值按样本数加权'}`;
  const sourceIds=new Set(selections.map(selection=>selection.source_id));
  const totalPoints=Array.from(sourceIds).reduce((total,sourceId)=>total+(shareDataset(data,sourceId)?.feeds?.length||0),0);
  share$('shareCount').textContent=`${totalPoints} 个${mode==='raw'?'采样点':'时间段'}`;
  share$('shareUpdated').textContent=`UPDATED ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`;
  shareStats(data,selections);
  TelemetryView.table(share$('shareDataTable'),selections.map(selection=>({name:shareSelectionName(data,selection,selections),field:`field${selection.field_number}`,feeds:shareDataset(data,selection.source_id)?.feeds||[]})),mode);
  const shareZoom=readShareDataZoom(shareChart);
  if(shareChart){shareChart.dispose();shareChart=null}
  share$('shareChart').replaceChildren();
  const visibleSelections=selections.filter(selection=>(shareDataset(data,selection.source_id)?.feeds||[]).some(feed=>TelemetryView.number(feed[`field${selection.field_number}`])!==null));
  const fullscreenButton=share$('shareFullscreenBtn');
  fullscreenButton.classList.remove('hidden');
  fullscreenButton.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await share$('shareCard').requestFullscreen()}catch(error){shareNotice('当前浏览器不支持全屏访问')}};
  if(!visibleSelections.length){share$('shareChart').innerHTML='<div class="chart-empty"><span>NO DATA</span><strong>暂无可用数据</strong></div>';return}
  const type=card.chart_type==='area'?'line':card.chart_type;
  shareChart=echarts.init(share$('shareChart'),null,{renderer:mobile?'svg':'canvas'});
  observeShareChart(share$('shareChart'));
  shareChart.setOption({
    animation:!mobile,animationDuration:mobile?0:450,backgroundColor:'transparent',color:shareColors,
    tooltip:{trigger:type==='bar'?'item':'axis',confine:true,formatter:TelemetryView.tooltip(mode),axisPointer:{type:'line'},backgroundColor:'#16212b',borderColor:'#314352',textStyle:{color:'#e8eef2'}},
    legend:{show:true,type:'scroll',top:0,right:0,textStyle:{color:'#94a3af',fontSize:11}},
    grid:{left:48,right:mobile?16:24,top:38,bottom:38},
    xAxis:{type:'time',minInterval:({hour:3600000,day:86400000,month:2419200000})[mode],splitNumber:mobile?4:6,boundaryGap:card.chart_type==='bar',axisLine:{lineStyle:{color:'#30404d'}},axisLabel:{color:'#718391',fontSize:10,hideOverlap:true,formatter:value=>TelemetryView.date(value,mode)}},
    yAxis:{type:'value',min:card.y_axis_min===null?null:Number(card.y_axis_min),splitLine:{lineStyle:{color:'#23313c'}},axisLabel:{color:'#718391',fontSize:10}},
    dataZoom:[{type:'inside',...shareZoom},{type:'slider',height:14,bottom:0,borderColor:'#263442',backgroundColor:'#111a22',fillerColor:'#2d3d48',...shareZoom}],
    series:visibleSelections.map(selection=>{
      const slot=selections.findIndex(item=>item.source_id===selection.source_id&&item.field_number===selection.field_number);
      const {color,symbol,lineType}=TelemetryView.style(slot),feeds=shareDataset(data,selection.source_id)?.feeds||[];
      const item={name:shareSelectionName(data,selection,selections),type,smooth:mode==='raw'&&!mobile&&card.chart_type!=='bar',connectNulls:mode==='raw',sampling:mode==='raw'&&mobile&&type==='line'?'lttb':undefined,showSymbol:true,symbol,symbolSize:mode==='raw'?(mobile?3:5):8,showAllSymbol:'auto',emphasis:{scale:true,symbolSize:8},data:TelemetryView.points(feeds,`field${selection.field_number}`,mode),lineStyle:{width:2,color,type:lineType,cap:'round',join:'round'},itemStyle:{color},endLabel:{show:false},areaStyle:card.chart_type==='area'?{opacity:.14,color}:undefined};
      if(type==='bar')item.barMaxWidth=20;
      return item;
    })
  });
}
async function loadShareData(){
  if(shareController)shareController.abort();
  const controller=new AbortController();shareController=controller;
  const token=++shareRequestToken,mode=shareAggregation;
  shareLoading=true;share$('shareRefreshBtn').disabled=true;
  share$('shareCard').setAttribute('aria-busy','true');
  share$('shareNotice').classList.add('hidden');
  share$('shareAggregationHint').textContent=`正在读取${TelemetryView.labels[mode]}… 原图保留至读取完成`;
  try{
    const query=new URLSearchParams({aggregation:mode});
    if(shareSelectedWindow!==null)query.set('window',shareSelectedWindow);
    const response=await fetch(`/api/share/${encodeURIComponent(shareToken)}?${query}`,{signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(token!==shareRequestToken)return;
    if(!response.ok)throw new Error(data.error||'分享链接不可用');
    if(shareLoadedAggregation!==mode||shareLoadedWindow!==shareSelectedWindow){if(shareChart){shareChart.dispose();shareChart=null}}
    shareLoadedAggregation=mode;
    renderShare(data);
    shareLoadedWindow=shareSelectedWindow;
    share$('shareAggregationHint').textContent=TelemetryView.hint(mode);
  }catch(error){
    if(error.name==='AbortError'||token!==shareRequestToken)return;
    shareNotice(error.message);
    share$('shareAggregationHint').textContent=`读取失败：${error.message}。下方保留上次成功加载的${TelemetryView.labels[shareLoadedAggregation]}。`;
  }finally{
    if(token===shareRequestToken){shareLoading=false;shareController=null;share$('shareRefreshBtn').disabled=false;share$('shareCard').setAttribute('aria-busy','false')}
  }
}
function resizeShareChart(){if(shareChart)requestAnimationFrame(()=>shareChart.resize())}
// 容器宽高变化（全屏切换、地址栏收起等）时同步图表尺寸
let sharePendingResize=null;
const shareResizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{
  if(sharePendingResize)return;
  sharePendingResize=requestAnimationFrame(()=>{sharePendingResize=null;if(shareChart&&!shareChart.isDisposed?.())shareChart.resize()});
}):null;
function observeShareChart(element){if(shareResizeObserver&&element){shareResizeObserver.disconnect();shareResizeObserver.observe(element)}}
// 刷新时保留用户缩放过的时间范围
function readShareDataZoom(chart){try{const item=chart?.getOption?.()?.dataZoom?.[0];if(!item)return{};const{start,end}=item;if(typeof start!=='number'||typeof end!=='number')return{};if(start<=0&&end>=100)return{};return{start,end}}catch(error){return{}}}
document.addEventListener('fullscreenchange',resizeShareChart);
window.addEventListener('resize',resizeShareChart);
window.addEventListener('orientationchange',()=>setTimeout(resizeShareChart,250));
share$('shareRefreshBtn').onclick=()=>loadShareData();
share$('shareAutoRefresh').onchange=event=>setShareAutoRefresh(event.target.checked);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&shareAutoRefresh)updateShareAutoRefreshStatus()});
TelemetryView.bindControls(share$('shareAggregationButtons'),mode=>{shareAggregation=mode;loadShareData()});
updateShareAutoRefreshStatus();
loadShareData();
