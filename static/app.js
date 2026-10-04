(() => {
  const $ = (id) => document.getElementById(id);
  const SENSOR_RANGES={water_level:[0,20],temperature:[-5,60],turbidity:[0,1000]},STALE_AFTER_MS=15000,PUMP_DRY_RUN_MIN_CM=.5,PUMP_TARGET_MIN_CM=3.1,PUMP_TARGET_MAX_CM=6,PUMP_RUNTIME_MIN_SEC=10,PUMP_RUNTIME_MAX_SEC=120;
  let pumpTargetCm=5,pumpMaxRuntimeMs=60000,acknowledgedAlerts=new Set(),currentAlertKey='';
  try{const settings=JSON.parse(localStorage.getItem('aquafixPumpSettings')||'{}');if(Number.isFinite(settings.target)&&settings.target>=PUMP_TARGET_MIN_CM&&settings.target<=PUMP_TARGET_MAX_CM)pumpTargetCm=settings.target;if(Number.isFinite(settings.maxRuntimeSec)&&settings.maxRuntimeSec>=PUMP_RUNTIME_MIN_SEC&&settings.maxRuntimeSec<=PUMP_RUNTIME_MAX_SEC)pumpMaxRuntimeMs=settings.maxRuntimeSec*1000;acknowledgedAlerts=new Set(JSON.parse(localStorage.getItem('aquafixAcknowledgedAlerts')||'[]'));currentAlertKey=localStorage.getItem('aquafixCurrentAlertKey')||'';}catch{}
  let running = false, timer = null, step = 0, rows = [], allRows = [], rangeLimit = 60, charts = {}, selectedField = 0, fieldMap = null, mapMarkers = [], pumpOn = false, simulatedWater = null, pumpStartedAt = 0, pumpSafetyTimer = null, sensorIssueOverride = null, pumpNotice = '', lastQualityState = '';

  function initCharts() {
    if (!window.Chart) return;
    Chart.defaults.color = '#829a95'; Chart.defaults.font.family = "'DM Sans', sans-serif"; Chart.defaults.font.size = 9;
    const shared = {responsive:true, maintainAspectRatio:false, animation:{duration:350}, interaction:{intersect:false,mode:'index'}, plugins:{legend:{display:false},tooltip:{backgroundColor:'#102729',borderColor:'#294344',borderWidth:1,titleColor:'#e8f5ee',bodyColor:'#abc2b9',padding:9}}, scales:{x:{grid:{display:false},ticks:{maxTicksLimit:7,maxRotation:0}},y:{grid:{color:'rgba(115,150,142,.12)'},ticks:{maxTicksLimit:5}}}};
    const fieldColors=['#38bdf8','#4ade80','#fbbf24','#fb7185'];
    const fieldSets=['Field A · simulated','Field B · illustrative','Field C · illustrative','Field D · illustrative'].map((label,i)=>({label,data:[],borderColor:fieldColors[i],backgroundColor:fieldColors[i],fill:false,borderWidth:i===selectedField?2.5:1.5,pointRadius:0,pointHoverRadius:4,tension:.28}));
    fieldSets.push({label:'Minimum guide · 3 cm',data:[],borderColor:'#94a3b8',borderDash:[5,5],borderWidth:1,pointRadius:0,fill:false});
    charts.water = new Chart($('waterChart'),{type:'line',data:{labels:[],datasets:fieldSets},options:{...shared,scales:{...shared.scales,y:{...shared.scales.y,min:0,max:6,title:{display:true,text:'Water level (cm)'}}}}});
    charts.trend = new Chart($('trendChart'),{type:'line',data:{labels:[],datasets:[{label:'Temperature (°C)',data:[],borderColor:'#f1c66f',pointRadius:1.5,borderWidth:2,tension:.32,yAxisID:'y'},{label:'Turbidity (NTU)',data:[],borderColor:'#75b8e7',pointRadius:1.5,borderWidth:2,tension:.32,yAxisID:'y1'}]},options:{...shared,scales:{x:shared.scales.x,y:{...shared.scales.y,position:'left',title:{display:true,text:'°C'}},y1:{...shared.scales.y,position:'right',title:{display:true,text:'NTU'},grid:{drawOnChartArea:false}}}}});
  }
  function drawFallback(canvas, series, colors, labels, separateScales=false) {
    const ctx=canvas.getContext('2d'), box=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
    if (!box.width || !box.height) return;
    canvas.width=box.width*dpr; canvas.height=box.height*dpr; ctx.scale(dpr,dpr);
    const w=box.width,h=box.height,p={l:35,r:12,t:12,b:22}; ctx.clearRect(0,0,w,h);
    const ranges=series.map(arr=>{const values=arr.filter(Number.isFinite);if(!values.length)return null;let min=Math.min(...values),max=Math.max(...values);if(max===min){max+=1;min-=1;}const gap=(max-min)*.12;return {min:min-gap,max:max+gap};});if(!ranges.some(Boolean))return;
    const combined=series.flat().filter(Number.isFinite);let sharedRange={min:Math.min(...combined),max:Math.max(...combined)};if(sharedRange.min===sharedRange.max){sharedRange.min-=1;sharedRange.max+=1;}else{const gap=(sharedRange.max-sharedRange.min)*.08;sharedRange={min:sharedRange.min-gap,max:sharedRange.max+gap};}
    ctx.font='9px sans-serif';ctx.fillStyle='#78918c';ctx.strokeStyle='rgba(115,150,142,.14)';ctx.lineWidth=1;
    for(let i=0;i<4;i++){let y=p.t+(h-p.t-p.b)*i/3;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();const left=separateScales?ranges[0]:sharedRange;if(left)ctx.fillText((left.max-(left.max-left.min)*i/3).toFixed(1),2,y+3);const right=separateScales&&ranges[1];if(right)ctx.fillText((right.max-(right.max-right.min)*i/3).toFixed(1),w-27,y+3);}
    series.forEach((arr,j)=>{const range=separateScales?ranges[j]:sharedRange;if(!arr.length||!range)return;ctx.beginPath();arr.forEach((v,i)=>{const x=p.l+(w-p.l-p.r)*(arr.length===1?.5:i/(arr.length-1)),y=p.t+(h-p.t-p.b)*(1-(v-range.min)/(range.max-range.min));i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle=colors[j];ctx.lineWidth=2;ctx.stroke();});
    labels.forEach((label,i)=>{if(i%Math.max(1,Math.ceil(labels.length/5))===0){let x=p.l+(w-p.l-p.r)*(labels.length===1?.5:i/(labels.length-1));ctx.fillStyle='#78918c';ctx.fillText(label,x-13,h-4)}});
  }
  function exampleLevels(id){
    const n=Number(id)||0;
    return [4.55+.22*Math.sin(n*.11),3.55+.28*Math.sin(n*.09+1.2),2.75+.2*Math.sin(n*.1+2.1)]
      .map(value=>Math.round(value*10)/10);
  }
  function selectField(index){
    selectedField=index;
    mapMarkers.forEach((marker,i)=>{
      const pin=marker.getElement()?.querySelector('.map-pin');
      if(pin)pin.classList.toggle('selected',i===index);
    });
    if(charts.water){
      const colors=['#38bdf8','#4ade80','#fbbf24','#fb7185'];
      charts.water.data.datasets.slice(0,4).forEach((dataset,i)=>{
        dataset.borderColor=colors[i];dataset.borderWidth=i===index?2.8:1.3;
      });
      charts.water.update('none');
    }
  }
  function readingQuality(reading=allRows.at(-1)){
    if(!reading)return {state:'missing',detail:'No reading received'};
    for(const [key,[minimum,maximum]] of Object.entries(SENSOR_RANGES)){
      if(reading[key]===null||reading[key]===undefined||reading[key]==='')return {state:'missing',detail:`${key.replaceAll('_',' ')} is missing`};
      const value=Number(reading[key]);
      if(!Number.isFinite(value)||value<minimum||value>maximum)return {state:'out_of_range',detail:`${key.replaceAll('_',' ')} outside ${minimum}–${maximum}`};
    }
    const timestamp=Date.parse(reading.timestamp),age=Date.now()-timestamp;
    if(!Number.isFinite(timestamp))return {state:'missing',detail:'Reading timestamp is invalid'};
    if(age< -5000)return {state:'missing',detail:'Reading timestamp is in the future'};
    if(age>STALE_AFTER_MS)return {state:'stale',detail:`No fresh reading for ${Math.floor(age/1000)} sec`};
    return {state:'valid',detail:'Sensor values in configured range'};
  }
  function updateDataHealth(){
    const badge=$('sensorHealth'),ageLabel=$('lastReadingAge'),reading=allRows.at(-1),quality=sensorIssueOverride||readingQuality(reading);
    badge.dataset.state=quality.state;badge.textContent=quality.state==='valid'?'DATA VALID':quality.state==='stale'?'STALE READING':quality.state==='out_of_range'?'OUT OF RANGE':'NO READING';badge.title=quality.detail;
    const stamp=reading?Date.parse(reading.timestamp):NaN,age=Number.isFinite(stamp)?Math.max(0,Math.floor((Date.now()-stamp)/1000)):null;
    ageLabel.textContent=age===null?'Last reading —':`Last reading ${age<60?`${age} sec ago`:`${Math.floor(age/60)} min ago`}`;
    if(pumpOn&&quality.state!=='valid')stopPump(`Stopped: ${quality.detail}. Pump requires fresh, valid readings.`);
    updatePumpUI(reading?.water_level);
    if(quality.state!==lastQualityState){
      lastQualityState=quality.state;
      if(reading)paintAlerts(reading,trend(rows,'water_level'),trend(rows,'turbidity'));
      else if(quality.state==='missing')$('alertsList').innerHTML='<div class="alert-item warning"><span>⚠</span><div><b>Sensor data missing</b><p>Waiting for the first valid reading; pump control remains unavailable.</p></div></div>';
    }
  }
  function pumpStartBlock(reading=allRows.at(-1)){
    const quality=sensorIssueOverride||readingQuality(reading);
    if(quality.state!=='valid')return quality.detail;
    if(reading.water_level<PUMP_DRY_RUN_MIN_CM)return 'Water is too low for the dry-run safeguard.';
    if(reading.water_level>=pumpTargetCm)return 'Target level reached; pump cannot start.';
    return '';
  }
  function updatePumpUI(waterLevel){
    const control=document.querySelector('.pump-control'),status=$('pumpStatus'),guidance=$('pumpGuidance'),button=$('pumpButton');
    control.classList.toggle('is-running',pumpOn&&running);
    status.textContent=`${pumpOn?'ON':'OFF'} · SOFTWARE SIMULATION`;
    button.textContent=pumpOn?'Stop simulated pump':'Start simulated pump';
    button.setAttribute('aria-pressed',String(pumpOn));
    button.disabled=!pumpOn&&Boolean(pumpStartBlock());
    if(pumpOn&&running)guidance.textContent=`Raising Field A toward ${pumpTargetCm} cm; current level ${fmt(waterLevel??0)} cm. Auto-stop at target or after ${Math.round(pumpMaxRuntimeMs/1000)} sec.`;
    else if(pumpOn)guidance.textContent='Pump simulation active. New readings are required to verify the target and safety limits.';
    else if(pumpNotice)guidance.textContent=pumpNotice;
    else if(button.disabled)guidance.textContent=`Pump unavailable: ${pumpStartBlock()}`;
    else guidance.textContent=`Ready. Auto-stop at ${pumpTargetCm} cm or after ${Math.round(pumpMaxRuntimeMs/1000)} sec; simulation does not operate hardware.`;
    if($('pumpTimer'))$('pumpTimer').textContent=pumpOn?`Auto-stop in ${Math.max(0,Math.ceil((pumpMaxRuntimeMs-(Date.now()-pumpStartedAt))/1000))} sec · target ${pumpTargetCm} cm`:`Target ${pumpTargetCm} cm · maximum run ${Math.round(pumpMaxRuntimeMs/1000)} sec`;
    for(const input of document.querySelectorAll('.pump-settings input'))input.disabled=pumpOn;
  }
  function initFieldMap(){
    const container=$('fieldMap'),fallback=container.querySelector('.map-fallback');
    if(!window.L){fallback.textContent='Map library did not load. Check internet and refresh.';return;}
    fallback.textContent='Loading Kedah map…';
    fieldMap=L.map(container,{zoomControl:true,scrollWheelZoom:true}).setView([5.3969167,100.4646389],16);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(fieldMap);
    tiles.on('tileerror',()=>{fallback.textContent='Map tiles need an internet connection.';});
    tiles.once('load',()=>fallback.remove());
    // Illustrative sub-field pins clustered near the supplied Kampung Terus address.
    const points=[[5.3969167,100.4646389],[5.3974,100.4653],[5.3964,100.4654],[5.3963,100.4640]];
    const letters=['A','B','C','D'];
    mapMarkers=points.map((point,index)=>{
      const icon=L.divIcon({className:'map-div-icon',html:`<span class="map-pin map-pin-${letters[index].toLowerCase()}${index===selectedField?' selected':''}"><b>${letters[index]}</b></span>`,iconSize:[36,40],iconAnchor:[18,38]});
      const marker=L.marker(point,{icon}).addTo(fieldMap);
      marker.bindPopup(`<strong>Field ${letters[index]}</strong><br><span>${index===0?'Simulation reading':'Illustrative example'}</span>`);
      marker.on('click',()=>selectField(index));
      return marker;
    });
  }
  function renderCharts() {
    const labels=rows.map(r=>new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    const examples=rows.map(r=>exampleLevels(r.id||0));
    const waterSeries=[rows.map(r=>r.water_level),examples.map(v=>v[0]),examples.map(v=>v[1]),examples.map(v=>v[2])];
    $('waterEmpty').style.display=rows.length?'none':'grid'; $('trendEmpty').style.display=rows.length?'none':'grid';
    if(charts.water){charts.water.data.labels=labels;waterSeries.forEach((values,i)=>charts.water.data.datasets[i].data=values);charts.water.data.datasets[4].data=rows.map(()=>3);charts.water.update('none');charts.trend.data.labels=labels;charts.trend.data.datasets[0].data=rows.map(r=>r.temperature);charts.trend.data.datasets[1].data=rows.map(r=>r.turbidity);charts.trend.update('none');}
    else {drawFallback($('waterChart'),waterSeries,['#38bdf8','#4ade80','#fbbf24','#fb7185'],labels);drawFallback($('trendChart'),[rows.map(r=>r.temperature),rows.map(r=>r.turbidity)],['#f1c66f','#75b8e7'],labels,true);}
  }
  const fmt=(n,d=1)=>Number(n).toFixed(d);
  function trend(rows,key){if(rows.length<2)return 0;return rows[rows.length-1][key]-rows[Math.max(0,rows.length-5)][key]}
  function paintAlerts(r, waterDelta, turbDelta) {
    let kind='calm',icon='✓',title='Conditions stable';
    let body='Water conditions are within the prototype reference range.';
    const signals=[];
    if(r.risk==='High Risk'){
      kind='critical';icon='🔴';title='High risk condition';
      body=`Water is ${fmt(r.water_level)} cm; estimated at ${fmt(r.predicted_water_level)} cm in 3 hours. Check irrigation.`;
    }else if(r.risk==='Medium Risk'){
      kind='warning';icon='⚠';title='Water level needs attention';
      body=`Estimated water level is ${fmt(r.predicted_water_level)} cm in 3 hours. Prepare irrigation.`;
    }
    if(r.ml_status==='Abnormal'){
      kind='critical';icon='🔴';title='Abnormal sensor pattern';
      body=`${r.ml_explanation}. Verify readings and inspect field conditions.`;
    }else if(r.ml_status==='Warning'&&kind==='calm'){
      kind='warning';icon='⚠';title='Sensor pattern needs review';
      body=`${r.ml_explanation}. Verify the readings and continue monitoring.`;
    }else if(r.ml_status!=='Normal') signals.push(`ML check: ${r.ml_status} (${r.ml_explanation})`);
    if(waterDelta < -0.25) signals.push('Water level has been decreasing recently.');
    if(turbDelta > 1.2) signals.push('Turbidity has increased recently.');
    if(kind==='calm'&&signals.length){kind='warning';icon='⚠';title='Trend to watch';body='Readings show a recent change.';}
    if(signals.length) body+=` ${signals.join(' ')}`;
    const quality=sensorIssueOverride||readingQuality(r);
    const lowWater=r.water_level<3;
    let nextStep=lowWater?'Confirm the sensor reading, inspect the inlet and water supply, then irrigate only if the field check confirms it.':r.ml_status==='Abnormal'?'Verify sensor readings against a manual check, then inspect the field for the issue identified by the model.':r.risk==='High Risk'?'Verify the sensors and inspect the field before changing irrigation.':r.risk==='Medium Risk'?'Monitor the water level closely and prepare irrigation if the field check confirms it.':'Continue monitoring; recheck if the trend worsens.';
    if(quality.state!=='valid'){
      kind=quality.state==='stale'?'warning':'critical';icon='⚠';title=quality.state==='stale'?'Sensor reading stale':quality.state==='out_of_range'?'Sensor value out of range':'Sensor data missing';
      body=quality.detail;nextStep='Check the sensor connection and mounting. Confirm the reading manually before acting on the water level.';
    }
    const alertKey=quality.state!=='valid'?`sensor:${quality.state}`:lowWater?'low-water':r.ml_status==='Abnormal'?'ml:abnormal':r.ml_status==='Warning'?'ml:warning':r.risk!=='Normal'?`risk:${r.risk}`:kind==='warning'?'trend':'';
    if(alertKey!==currentAlertKey){currentAlertKey=alertKey;acknowledgedAlerts.clear();try{localStorage.removeItem('aquafixAcknowledgedAlerts');if(alertKey)localStorage.setItem('aquafixCurrentAlertKey',alertKey);else localStorage.removeItem('aquafixCurrentAlertKey')}catch{}}
    const acknowledged=Boolean(alertKey&&acknowledgedAlerts.has(alertKey));
    $('alertCount').textContent=kind==='calm'&&!signals.length?'0 active':acknowledged?'1 acknowledged':'1 active';
    const pumpBlock=pumpOn?'':pumpStartBlock(r);
    const pumpAction=lowWater||pumpOn?`<div class="alert-pump"><button class="button ${pumpOn?'':'primary'}" type="button" data-pump-action ${pumpBlock?'disabled':''}>${pumpOn?'Turn pump off':'Turn on pump'}</button><small>${pumpBlock?`Unavailable: ${pumpBlock}`:'Software simulation only · no hardware connected'}</small></div>`:'';
    const acknowledgeAction=alertKey?`<button class="button alert-ack" type="button" data-ack-alert="${alertKey}" aria-pressed="${acknowledged}" ${acknowledged?'disabled':''}>${acknowledged?'Acknowledged':'Acknowledge'}</button>`:'';
    $('alertsList').innerHTML=`<div class="alert-item ${kind}"><span>${icon}</span><div class="alert-copy"><b>${title}</b><p>${body}</p><p class="alert-next-step"><strong>Next step:</strong> ${nextStep}</p>${pumpAction}${acknowledgeAction}</div></div>`;
  }
  function paint(r) {
    if(!r || !r.water_level && r.water_level!==0)return;
    $('waterValue').textContent=fmt(r.water_level);$('tempValue').textContent=fmt(r.temperature);$('turbidityValue').textContent=fmt(r.turbidity);
    $('riskValue').textContent=r.risk.toUpperCase();$('riskValue').className=`risk-pill risk-${r.risk.toLowerCase().replaceAll(' ','-')}`;$('confidenceValue').textContent=`${Math.round(r.confidence*100)}%`;
    const mlClass=r.ml_status.toLowerCase();$('mlValue').textContent=mlClass.toUpperCase();$('mlValue').className=`ml-${mlClass}`;$('mlValue').title=`Isolation Forest decision score: ${r.anomaly_score}`;
    $('mlStatusText').textContent=r.ml_status;$('mlStatusText').className=`ml-${mlClass}`;$('mlExplanation').textContent=r.ml_explanation;
    $('forecastValue').textContent=fmt(r.predicted_water_level);
    $('recommendation').textContent=pumpOn
      ? (r.water_level<pumpTargetCm-.2?`Simulated pump is raising Field A toward the ${pumpTargetCm} cm target.`:`Field A is near the ${pumpTargetCm} cm target. The simulated pump will stop automatically.`)
      : r.recommendation;
    const wd=trend(rows,'water_level'),td=trend(rows,'turbidity');
    $('waterTrend').textContent=rows.length>1?(wd<-.08?`↓ ${fmt(Math.abs(wd))} cm recently`:wd>.08?`↑ ${fmt(wd)} cm recently`:'→ Holding steady'):'Trend building';$('waterTrend').className=`trend ${wd<-.08?'down':wd>.08?'up':''}`;
    $('turbidityTrend').textContent=td>.2?`↑ ${fmt(td)} NTU recently`:'Water clarity indicator';
    $('forecastDirection').textContent=r.predicted_water_level<r.water_level?'↓ Decreasing':'→ Holding steady';
    $('trendSummary').textContent=rows.length>1?`Recent trend: water ${wd<-.08?'decreasing':wd>.08?'increasing':'steady'} · estimate uses the median change across recent readings.`:'Trend will appear after a few readings.';
    $('pipeSensors').textContent='Reading received';$('pipeSensorValues').textContent=`${fmt(r.water_level)} cm · ${fmt(r.temperature)}° · ${fmt(r.turbidity)} NTU`;
    $('pipeRisk').textContent=`Risk: ${r.risk} · ML: ${r.ml_status}`;$('pipeConfidence').textContent=`Risk model confidence ${Math.round(r.confidence*100)}%`;$('pipeForecast').textContent=`${fmt(r.predicted_water_level)} cm in 3 hours`;$('pipeRecommendation').textContent=r.recommendation.split('—')[0].trim();
    $('latestTime').textContent=new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    updatePumpUI(r.water_level);paintAlerts(r,wd,td);paintFields(r);updateDataHealth();
  }
  function paintFields(r) {
    const examples=exampleLevels(r.id||0);
    const fields=[['Field A',r.risk==='High Risk'?'High Risk':r.risk==='Medium Risk'?'Monitor':'Normal',r.water_level],['Field B','Normal',examples[0]],['Field C','Monitor',examples[1]],['Field D','High Risk',examples[2]]];
    $('fieldList').innerHTML=fields.map(([name,status,level])=>`<div class="field-row status-${status.toLowerCase().replaceAll(' ','-')}"><span class="field-name">${name}<small>${name==='Field A'?'simulation':'example'}</small></span><span class="field-meter"><span class="field-water">${fmt(level)} cm</span><span class="level-track"><i style="width:${Math.min(100,Math.max(0,level/6*100))}%"></i></span></span><span class="field-status status-${status.toLowerCase().replaceAll(' ','-')}">${status.toUpperCase()}</span></div>`).join('');
    fields.forEach(([name,status,level],index)=>{
      const marker=mapMarkers[index];
      if(marker)marker.setPopupContent(`<strong>${name}</strong><br>${fmt(level)} cm · ${status}<br><span>${index===0?'Simulation reading':'Illustrative example'}</span>`);
    });
  }
  function applyRange(){rows=allRows.slice(-rangeLimit);renderCharts();}
  async function refresh() {const response=await fetch('/api/history');if(!response.ok)throw new Error('History request failed');allRows=await response.json();if(allRows.length)simulatedWater=allRows[allRows.length-1].water_level;applyRange();if(allRows.length)paint(allRows[allRows.length-1]);}
  async function postReading(values) {const response=await fetch('/api/sensor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({water_level:values[0],temperature:values[1],turbidity:values[2]})});if(!response.ok){const error=await response.json();if(error.data_quality==='out_of_range')sensorIssueOverride={state:'out_of_range',detail:error.error};throw new Error(error.error||'Could not save reading')}sensorIssueOverride=null;const r=await response.json();allRows.push(r);allRows=allRows.slice(-60);applyRange();paint(r);}
  function noisy(value,scale,minimum){return Math.max(minimum,Math.round((value+(Math.random()-.5)*scale)*10)/10)}
  function simulationValues(index){
    // A bounded 2.5-minute cycle: about half the readings are below the 3 cm guide.
    const phase=index%60;let water,temp,turbidity;
    if(phase<25){
      water=5.0+Math.sin(index*.31)*.12;temp=28.5+Math.sin(index*.19)*.35;turbidity=5.2+Math.sin(index*.27)*.5;
    }else if(phase<30){
      const progress=(phase-25)/4;water=4.4-2.0*progress;temp=28.5+4.0*progress;turbidity=5.2+13.5*progress;
    }else if(phase<55){
      water=2.4+Math.sin(index*.23)*.08;temp=32.5+Math.sin(index*.16)*.25;turbidity=18.7+Math.sin(index*.21)*.4;
    }else{
      const progress=(phase-55)/4;water=2.4+2.0*progress;temp=32.5-4.0*progress;turbidity=18.7-13.5*progress;
    }
    if(simulatedWater===null)simulatedWater=water;
    if(pumpOn)simulatedWater+=Math.min(.18,Math.max(0,pumpTargetCm-simulatedWater));
    else simulatedWater=water;
    return [noisy(simulatedWater,pumpOn ? .06 : .12,.8),noisy(temp,.28,20),noisy(turbidity,.6,.5)];
  }
  async function tick(){const values=simulationValues(step);await postReading(values);step++;}
  function start(){if(running)return;running=true;$('simState').textContent='Simulated readings updating · every 2.5 sec';$('pauseBtn').textContent='Ⅱ  Pause';updatePumpUI(allRows.at(-1)?.water_level);tick().catch(showError);timer=setInterval(()=>tick().catch(showError),2500)}
  function stopPump(reason){if(!pumpOn)return;pumpOn=false;pumpStartedAt=0;clearInterval(pumpSafetyTimer);pumpSafetyTimer=null;pumpNotice=reason;updatePumpUI(allRows.at(-1)?.water_level);if(allRows.length)paintAlerts(allRows.at(-1),trend(rows,'water_level'),trend(rows,'turbidity'));}
  function checkPumpSafety(){
    if(!pumpOn)return;
    const reading=allRows.at(-1),quality=sensorIssueOverride||readingQuality(reading);
    if(!running){stopPump('Stopped because readings are paused; the sensor cannot be checked.');return;}
    if(quality.state!=='valid'){stopPump(`Safety stop: ${quality.detail}.`);return;}
    if(reading.water_level>=pumpTargetCm){stopPump(`Target reached (${pumpTargetCm} cm); pump stopped automatically.`);return;}
    if(reading.water_level<PUMP_DRY_RUN_MIN_CM){stopPump('Safety stop: water level is below the dry-run limit.');return;}
    if(Date.now()-pumpStartedAt>=pumpMaxRuntimeMs)stopPump(`Maximum run time reached (${Math.round(pumpMaxRuntimeMs/1000)} sec); pump stopped automatically.`);
  }
  function pause(){if(pumpOn)stopPump('Stopped because readings were paused; the sensor cannot be checked.');running=false;clearInterval(timer);timer=null;$('simState').textContent='Readings paused';$('pauseBtn').textContent='▶  Resume';updatePumpUI(allRows.at(-1)?.water_level)}
  async function reset(){pause();if(pumpOn)stopPump('Stopped because readings were reset.');pumpOn=false;simulatedWater=null;updatePumpUI();step=0;allRows=[];rows=[];renderCharts();$('simState').textContent='Readings reset';try{await postReading(simulationValues(step));step++;start()}catch(e){showError(e)}}
  function showError(e){$('simState').textContent=sensorIssueOverride?'Reading rejected':`Connection error: ${e.message}`;$('simState').style.color='#ff9290';if(sensorIssueOverride){$('sensorHealth').dataset.state=sensorIssueOverride.state;$('sensorHealth').textContent='OUT OF RANGE';$('sensorHealth').title=sensorIssueOverride.detail;updatePumpUI(allRows.at(-1)?.water_level);if(pumpOn)stopPump('Stopped: the latest sensor submission was out of range.')}}
  function updateClock(){const clock=$('liveClock');if(clock)clock.textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});updateDataHealth();}
  $('pauseBtn').addEventListener('click',()=>running?pause():start());$('resetBtn').addEventListener('click',reset);
  function togglePump(){
    if(pumpOn){stopPump('Pump simulation stopped by user.');}
    else{
      const block=pumpStartBlock();
      if(block){pumpNotice=`Pump blocked: ${block}.`;updatePumpUI(allRows.at(-1)?.water_level);return;}
      pumpOn=true;pumpNotice='';pumpStartedAt=Date.now();updatePumpUI(allRows.at(-1)?.water_level);pumpSafetyTimer=setInterval(checkPumpSafety,500);if(!running)start();
    }
    if(allRows.length)paint(allRows.at(-1));
  }
  function applyPumpSettings(){
    const targetInput=$('pumpTargetInput'),runtimeInput=$('pumpRuntimeInput'),target=targetInput.valueAsNumber,maxRuntimeSec=runtimeInput.valueAsNumber;
    if(!Number.isFinite(target)||target<PUMP_TARGET_MIN_CM||target>PUMP_TARGET_MAX_CM||!Number.isFinite(maxRuntimeSec)||maxRuntimeSec<PUMP_RUNTIME_MIN_SEC||maxRuntimeSec>PUMP_RUNTIME_MAX_SEC){
      targetInput.value=String(pumpTargetCm);runtimeInput.value=String(Math.round(pumpMaxRuntimeMs/1000));pumpNotice=`Settings must be within ${PUMP_TARGET_MIN_CM}–${PUMP_TARGET_MAX_CM} cm and ${PUMP_RUNTIME_MIN_SEC}–${PUMP_RUNTIME_MAX_SEC} sec.`;updatePumpUI(allRows.at(-1)?.water_level);return;
    }
    pumpTargetCm=Math.round(target*10)/10;pumpMaxRuntimeMs=Math.round(maxRuntimeSec)*1000;pumpNotice='';
    try{localStorage.setItem('aquafixPumpSettings',JSON.stringify({target:pumpTargetCm,maxRuntimeSec:Math.round(maxRuntimeSec)}))}catch{}
    updatePumpUI(allRows.at(-1)?.water_level);if(allRows.length)paint(allRows.at(-1));
  }
  function initPumpSettings(){
    $('pumpTargetInput').value=String(pumpTargetCm);$('pumpRuntimeInput').value=String(Math.round(pumpMaxRuntimeMs/1000));
    $('pumpTargetInput').addEventListener('change',applyPumpSettings);$('pumpRuntimeInput').addEventListener('change',applyPumpSettings);
  }
  $('pumpButton').addEventListener('click',togglePump);
  $('alertsList').addEventListener('click',(event)=>{
    if(event.target.closest('[data-pump-action]')){togglePump();return;}
    const acknowledge=event.target.closest('[data-ack-alert]');if(!acknowledge)return;
    acknowledgedAlerts.add(acknowledge.dataset.ackAlert);try{localStorage.setItem('aquafixAcknowledgedAlerts',JSON.stringify([...acknowledgedAlerts]));localStorage.setItem('aquafixCurrentAlertKey',acknowledge.dataset.ackAlert)}catch{}
    const latest=allRows.at(-1);if(latest)paintAlerts(latest,trend(rows,'water_level'),trend(rows,'turbidity'));
  });
  $('historyRange').addEventListener('change',(event)=>{rangeLimit=Number(event.target.value);applyRange();if(allRows.length)paint(allRows[allRows.length-1]);});
  window.addEventListener('resize',()=>{if(!window.Chart)renderCharts()});
  initCharts();initFieldMap();selectField(0);initPumpSettings();updatePumpUI();updateClock();setInterval(updateClock,1000);refresh().catch(showError).finally(start);
})();
