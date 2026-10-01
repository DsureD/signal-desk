// 主页面和分享页共用统计口径；均值由后端计算，浏览器只负责展示。
const TelemetryView=(()=>{
  const labels={raw:'原始值',hour:'小时均值',day:'日均值',month:'月均值'};
  const colors=['#c8f169','#70d6c5','#f7b267','#ff927d','#a8b6ff','#e6a8ff','#7ad7ff','#ffd166'];
  function number(raw){return raw===null||raw===undefined||String(raw).trim()===''||!Number.isFinite(Number(raw))?null:Number(raw)}
  function format(value){return value===null?'--':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3})}
  function date(value,mode='raw',full=false){
    const options=mode==='raw'?{}:{timeZone:'Asia/Shanghai'};
    if(full||mode==='month')options.year='numeric';
    options.month='2-digit';
    if(full||mode!=='month')options.day='2-digit';
    if(full||mode==='raw'||mode==='hour'){options.hour='2-digit';options.minute='2-digit';options.hourCycle='h23'}
    return new Date(value).toLocaleString('zh-CN',options);
  }
  function period(feed,mode){return mode==='raw'?date(feed.created_at,mode,true):`${date(feed.range_start||feed.created_at,mode,true)} 至 ${date(feed.range_end||feed.bucket_end,mode,true)}${feed.partial?' · 部分区间':''}`}
  function metrics(feeds,field,mode){
    let count=0,mean=0,min=null,max=null,last=null;
    feeds.forEach(feed=>{
      const value=number(feed[field]);
      if(value===null)return;
      const weight=mode==='raw'?1:Number(feed.counts?.[field]||0);
      if(weight<=0)return;
      const total=count+weight;
      mean=mean*(count/total)+value*(weight/total);
      count=total;min=min===null?value:Math.min(min,value);max=max===null?value:Math.max(max,value);last=value;
    });
    if(mode!=='raw')last=number(feeds[feeds.length-1]?.[field]);
    return [last,max,min,count?mean:null];
  }
  function metricLabels(mode){return mode==='raw'?['当前值','最大值','最小值','平均值']:['末段均值','最高均值','最低均值','样本总均值']}
  function hint(mode){return mode==='raw'?'按采集时间展示原始采样点':`${labels[mode]} · 有效样本算术平均；空段留空，首尾不足整段时标注“部分区间”。`}
  function bindControls(element,onChange){
    element.addEventListener('click',event=>{
      const button=event.target.closest('button[data-aggregation]');
      if(!button||button.getAttribute('aria-pressed')==='true')return;
      selectControl(element,button.dataset.aggregation);
      onChange(button.dataset.aggregation);
    });
  }
  function selectControl(element,mode){element.querySelectorAll('button').forEach(button=>{const active=button.dataset.aggregation===mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))})}
  function tooltip(mode){
    if(mode==='raw')return undefined;
    return params=>{
      const items=Array.isArray(params)?params:[params];
      const root=document.createElement('div');root.className='aggregate-tooltip';
      const heading=document.createElement('strong');
      const feed=items.find(item=>item.data?.bucket)?.data.bucket;
      heading.textContent=feed?period(feed,mode):'';root.appendChild(heading);
      items.forEach(item=>{
        const row=document.createElement('div');
        const value=number(item.value?.[1]);
        row.textContent=`${item.seriesName}：${format(value)} · ${item.data?.count||0} 个有效样本`;
        root.appendChild(row);
      });
      return root;
    };
  }
  function points(feeds,field,mode){return feeds.map(feed=>mode==='raw'?[new Date(feed.created_at).getTime(),number(feed[field])]:{value:[new Date(feed.created_at).getTime(),number(feed[field])],bucket:feed,count:feed.counts?.[field]||0})}
  // 超过八条序列时组合线型/符号，不单靠循环颜色区分；槽位来自卡片配置而非可见序列排名。
  function style(index){return{color:colors[index%colors.length],symbol:['circle','rect','triangle','diamond'][Math.floor(index/colors.length)%4],lineType:['solid','dashed','dotted'][Math.floor(index/colors.length)%3]}}
  function table(element,series,mode){
    if(!element)return;
    element._tableData={series,mode};
    if(!element._tableReady){
      element._tableReady=true;element._page=0;
      const summary=document.createElement('summary');summary.textContent='查看数据明细';element.appendChild(summary);
      const body=document.createElement('div');body.className='data-table-body';element.appendChild(body);
      element.addEventListener('toggle',()=>{if(element.open)renderTable(element)});
    }
    if(element.open)renderTable(element);
  }
  function renderTable(element){
    const {series,mode}=element._tableData;
    const total=series.reduce((sum,item)=>sum+item.feeds.length,0),size=100;
    element._page=Math.max(0,Math.min(element._page,Math.ceil(total/size)-1));
    const body=element.querySelector('.data-table-body');body.replaceChildren();
    const scroller=document.createElement('div');scroller.className='data-table-scroll';scroller.tabIndex=0;
    scroller.setAttribute('role','region');scroller.setAttribute('aria-label','数据明细，可横向滚动');
    const table=document.createElement('table');
    const caption=document.createElement('caption');caption.textContent=mode==='raw'?'已加载的原始采样点':`${labels[mode]} · 区间含起点、不含终点`;
    table.appendChild(caption);
    const head=document.createElement('thead'),tr=document.createElement('tr');
    ['时间 / 区间','字段',labels[mode],...(mode==='raw'?[]:['有效样本数'])].forEach(text=>{const th=document.createElement('th');th.scope='col';th.textContent=text;tr.appendChild(th)});
    head.appendChild(tr);table.appendChild(head);
    const tbody=document.createElement('tbody');let offset=0;
    series.forEach(item=>{
      const start=Math.max(0,element._page*size-offset),end=Math.min(item.feeds.length,(element._page+1)*size-offset);
      for(let i=start;i<end;i++){
        const feed=item.feeds[i],row=document.createElement('tr');
        const values=[period(feed,mode),item.name,format(number(feed[item.field])),...(mode==='raw'?[]:[String(feed.counts?.[item.field]||0)])];
        values.forEach(text=>{const td=document.createElement('td');td.textContent=text;row.appendChild(td)});tbody.appendChild(row);
      }
      offset+=item.feeds.length;
    });
    table.appendChild(tbody);scroller.appendChild(table);body.appendChild(scroller);
    const nav=document.createElement('div');nav.className='data-table-nav';
    const status=document.createElement('span');status.textContent=total?`${element._page+1} / ${Math.ceil(total/size)} 页 · 共 ${total} 行`:'暂无数据';
    nav.appendChild(status);
    [['上一页',-1,element._page===0],['下一页',1,(element._page+1)*size>=total]].forEach(([text,step,disabled])=>{
      const button=document.createElement('button');button.type='button';button.className='ghost-button';button.textContent=text;button.disabled=disabled;
      button.onclick=()=>{element._page+=step;renderTable(element)};nav.appendChild(button);
    });body.appendChild(nav);
  }
  // 使用原生滚动图例，避免手机上通过分页箭头查找曲线。
  const legendMedia=window.matchMedia('(max-width:900px)');
  legendMedia.addEventListener('change',()=>{
    document.querySelectorAll('.chart-touch-legend').forEach(element=>{
      const chart=echarts.getInstanceByDom(element.parentElement);
      if(chart)chart.setOption({legend:{show:!legendMedia.matches}});
    });
  });
  function touchLegend(chart){
    const host=chart.getDom();
    let legend=host.querySelector('.chart-touch-legend');
    if(!legend){
      legend=document.createElement('div');legend.className='chart-touch-legend';
      legend.setAttribute('role','group');legend.setAttribute('aria-label','图例，可左右滑动，点击切换显示');
      // 不让图例手势传给图表的缩放和提示层，保留浏览器原生滑动。
      ['pointerdown','touchstart','touchmove','mousedown','click'].forEach(type=>legend.addEventListener(type,event=>event.stopPropagation(),{passive:true}));
      host.appendChild(legend);
      chart.on('legendselectchanged',event=>{
        legend.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(event.selected[button.dataset.name]!==false)));
      });
    }
    const offset=legend.scrollLeft,option=chart.getOption(),selected=option.legend?.[0]?.selected||{};
    legend.replaceChildren();
    const names=new Set();
    option.series.forEach(item=>{
      if(names.has(item.name))return;
      names.add(item.name);
      const button=document.createElement('button');button.type='button';button.dataset.name=item.name;
      button.setAttribute('aria-pressed',String(selected[item.name]!==false));
      const swatch=document.createElement('span');swatch.className='chart-legend-swatch';swatch.style.backgroundColor=item.itemStyle?.color||colors[(names.size-1)%colors.length];
      swatch.setAttribute('aria-hidden','true');button.append(swatch,document.createTextNode(item.name));
      button.onclick=()=>chart.dispatchAction({type:'legendToggleSelect',name:item.name});
      legend.appendChild(button);
    });
    legend.scrollLeft=offset;
  }
  return{labels,colors,number,format,date,period,metrics,metricLabels,hint,bindControls,selectControl,tooltip,points,style,table,touchLegend};
})();
