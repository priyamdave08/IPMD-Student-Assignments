'use strict';
// Shared animation inputs: actual output audio drives amplitude and spectrum.
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const mod=(x,n)=>((x%n)+n)%n;
function seeded(seed){let s=seed>>>0;return()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
let activeMood='warm',isPlaying=false,analyserNode=null,calmMode=matchMedia('(prefers-reduced-motion: reduce)').matches;
const sparks=[],transitions=[];
const moods={warm:{color:'#FFD166'},calm:{color:'#7B4ED6'},anger:{color:'#C1121F'},sad:{color:'#3A6EA5'}};
function ignite(kind,strength){if(sparks.length<8)sparks.push({born:performance.now(),lifespan:.9,kind,strength});}
const $=id=>document.getElementById(id);
const clock=t=>Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0');
const API=(window.ECHOSPHERE_API_BASE||'').replace(/\/$/,'');
let video=null,focus=[],analysis=null,activeJob=null,working=false,focusDirty=false,unsavedFocus=false;
let selected={cx:.5,cy:.60,rx:.125,ry:.175},dragStart=null,results=[];
let mediaContext=null,mediaSource=null;
const source=$('sourceVideo'),canvas=$('focusCanvas'),preview=$('resultVideo');
const mp4Supported=!!source.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');

function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
let signingIn=null;
function signIn(){
  // Hosted servers set a key; it is exchanged once for an HttpOnly session cookie and never stored by the page.
  signingIn??=new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','signInTitle');
    const form=document.createElement('form');form.className='signin';
    const title=Object.assign(document.createElement('h2'),{id:'signInTitle',textContent:'Enter the access key'});
    const help=Object.assign(document.createElement('p'),{className:'helper',textContent:'This EchoSphere server is private.'});
    const input=Object.assign(document.createElement('input'),{type:'password',required:true,autocomplete:'current-password'});input.setAttribute('aria-label','Access key');
    const error=Object.assign(document.createElement('p'),{className:'helper'});error.setAttribute('role','alert');
    const button=Object.assign(document.createElement('button'),{type:'submit',className:'primary-button',textContent:'Sign in'});
    form.append(title,help,input,error,button);dialog.append(form);document.body.append(dialog);
    let done=false;
    const finish=(ok,reason)=>{done=true;dialog.close();dialog.remove();signingIn=null;ok?resolve():reject(new Error(reason));};
    form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;error.textContent='';
      try{const r=await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value}),signal:AbortSignal.timeout(20000)});
        if(r.ok){input.value='';finish(true);return;}
        let d;try{d=(await r.json()).detail;}catch{}error.textContent=typeof d==='string'?d:'Sign-in failed.';}
      catch{error.textContent='Could not reach the server.';}
      button.disabled=false;});
    dialog.addEventListener('cancel',e=>{e.preventDefault();finish(false,'Sign-in is required to use this server.');});
    dialog.showModal();input.focus();
  });
  return signingIn;
}
async function api(path,options={},retry=true){
  const response=await fetch(API+path,{...options,signal:options.signal||AbortSignal.timeout(120000)});
  if(response.status===401&&retry){await signIn();return api(path,options,false);}
  if(!response.ok){let body;try{body=await response.json();}catch{throw new Error('The server returned an unreadable response.');}
    throw new Error(typeof body.detail==='string'?body.detail:body.detail?.map?.(x=>x.msg).join('; ')||'Request failed.');}
  return response.json();
}
function jsonPost(path,body){return api(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});}
function busy(on){working=on;
  for(const id of ['referenceButton','fileInput','analyzeButton','generateButton','variationButton','saveFocus','analyzer','engine','savedVideos','deleteVideo','autoMood','focusTime','variations'])$(id).disabled=on;
  document.querySelectorAll('.mood-btn,.focus-numbers input,.focus-points button').forEach(el=>el.disabled=on);
  document.querySelectorAll('.focus-points button[data-first="true"]').forEach(el=>el.disabled=true);
  if(!on){$('analyzeButton').disabled=!video||!focus.length||unsavedFocus;$('generateButton').disabled=!analysis||focusDirty;$('deleteVideo').disabled=!video;}
  $('stageRoot').setAttribute('aria-busy',String(on));
  $('cancelButton').hidden=!on||!activeJob;
}
function theme(mood){
  if(!mood)return;
  if(activeMood!==mood&&!calmMode)transitions.push({born:performance.now()});
  activeMood=mood;
  const colors={warm:['#FFD166','255,209,102'],calm:['#B59BEA','123,78,214'],anger:['#F27982','193,18,31'],sad:['#98BEDF','58,110,165']};
  document.documentElement.style.setProperty('--accent',colors[mood][0]);document.documentElement.style.setProperty('--accent-rgb',colors[mood][1]);
  $('moodTitle').replaceChildren(document.createTextNode(mood[0].toUpperCase()+mood.slice(1)),Object.assign(document.createElement('span'),{textContent:'.'}));
  document.querySelectorAll('.mood-btn').forEach(b=>{b.classList.toggle('active',b.dataset.mood===mood);b.setAttribute('aria-pressed',String(b.dataset.mood===mood));});
  window.dispatchEvent(new Event('sphere-change'));
}
function setQuiet(on){calmMode=on;$('motionLabel').textContent=on?'Motion off':'Motion on';$('calmToggle').setAttribute('aria-pressed',String(on));document.body.classList.toggle('quiet',on);window.dispatchEvent(new Event('sphere-change'));}
$('calmToggle').addEventListener('click',()=>setQuiet(!calmMode));setQuiet(calmMode);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>setQuiet(e.matches));
$('creditsButton').onclick=()=>$('creditsDialog').showModal();$('closeCredits').onclick=()=>$('creditsDialog').close();

function pointAt(time){
  if(!focus.length)return selected;
  if(time<=focus[0].time)return {...focus[0]};
  for(let i=1;i<focus.length;i++)if(time<=focus[i].time){const a=focus[i-1],b=focus[i],t=(time-a.time)/(b.time-a.time);return Object.fromEntries(['cx','cy','rx','ry'].map(k=>[k,a[k]+(b[k]-a[k])*t]));}
  return {...focus.at(-1)};
}
function bounded(p){p.rx=clamp(p.rx,.025,.5);p.ry=clamp(p.ry,.025,.5);p.cx=clamp(p.cx,p.rx,1-p.rx);p.cy=clamp(p.cy,p.ry,1-p.ry);return p;}
function drawFocus(){
  if(!source.videoWidth)return;
  canvas.width=source.videoWidth;canvas.height=source.videoHeight;
  const g=canvas.getContext('2d'),w=canvas.width,h=canvas.height,p=selected;
  g.fillStyle='rgba(0,0,0,.64)';g.fillRect(0,0,w,h);
  g.globalCompositeOperation='destination-out';g.beginPath();g.ellipse(p.cx*w,p.cy*h,p.rx*w,p.ry*h,0,0,Math.PI*2);g.fill();g.globalCompositeOperation='source-over';
  g.strokeStyle='#FFD166';g.lineWidth=Math.max(2,w/400);g.stroke();
  for(const [id,v] of [['focusCx',p.cx*100],['focusCy',p.cy*100],['focusWidth',p.rx*200],['focusHeight',p.ry*200]])$(id).value=v.toFixed(1);
}
function dirty(pending=true){focusDirty=true;unsavedFocus=pending;$('generateButton').disabled=true;$('analyzeButton').disabled=pending||!focus.length;$('focusHint').textContent='Save this focus point, then read the sphere again.';}
function position(e){const r=canvas.getBoundingClientRect();return{x:clamp((e.clientX-r.left)/r.width,0,1),y:clamp((e.clientY-r.top)/r.height,0,1)};}
canvas.addEventListener('pointerdown',e=>{if(working)return;dragStart=position(e);canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!dragStart)return;const p=position(e);selected=bounded({cx:(p.x+dragStart.x)/2,cy:(p.y+dragStart.y)/2,rx:Math.abs(p.x-dragStart.x)/2,ry:Math.abs(p.y-dragStart.y)/2});dirty();drawFocus();});
canvas.addEventListener('pointerup',()=>{dragStart=null;});canvas.addEventListener('pointercancel',()=>{dragStart=null;});
for(const id of ['focusCx','focusCy','focusWidth','focusHeight'])$(id).addEventListener('change',()=>{
  selected=bounded({cx:Number($('focusCx').value)/100,cy:Number($('focusCy').value)/100,rx:Number($('focusWidth').value)/200,ry:Number($('focusHeight').value)/200});dirty();drawFocus();
});
source.addEventListener('loadedmetadata',()=>{selected=pointAt(0);drawFocus();});
source.addEventListener('seeked',drawFocus);
$('focusTime').addEventListener('input',()=>{const t=Number($('focusTime').value);source.currentTime=t;selected=pointAt(t);unsavedFocus=false;$('analyzeButton').disabled=!focus.length;$('focusClock').textContent=clock(t);drawFocus();});
function focusChips(){
  $('focusPoints').replaceChildren();
  for(const point of focus){const span=document.createElement('span');span.className='focus-chip';const jump=document.createElement('button');jump.textContent=point.time.toFixed(2)+' s';jump.title='View focus at this time';jump.onclick=()=>{$('focusTime').value=point.time;$('focusTime').dispatchEvent(new Event('input'));};
    const remove=document.createElement('button');remove.textContent='×';remove.dataset.first=String(point.time===0);remove.setAttribute('aria-label','Remove focus point at '+point.time+' seconds');remove.disabled=point.time===0;remove.onclick=()=>{focus=focus.filter(p=>p!==point);dirty(false);focusChips();};span.append(jump,remove);$('focusPoints').append(span);}
}
$('saveFocus').onclick=()=>{
  const time=focus.length?Number($('focusTime').value):0;
  if(!focus.length&&Number($('focusTime').value)>.025){message('Save your first sphere selection at 0:00.',true);return;}
  focus=focus.filter(p=>Math.abs(p.time-time)>.025);
  if(focus.length>=16){message('Use at most 16 focus points.',true);return;}
  focus.push({cx:selected.cx,cy:selected.cy,rx:selected.rx,ry:selected.ry,time});focus.sort((a,b)=>a.time-b.time);dirty(false);focusChips();$('analyzeButton').disabled=false;$('focusHint').textContent='Focus saved. Check later frames before analyzing.';
};

async function poll(id){
  activeJob=id;$('cancelButton').hidden=false;
  while(true){const job=await api('/v1/jobs/'+id);message(job.cancelled?'Cancellation requested. Waiting for the current operation to stop…':job.phase+'…');
    if(job.state==='complete'){activeJob=null;$('cancelButton').hidden=true;return job;}
    if(['failed','cancelled'].includes(job.state)){activeJob=null;$('cancelButton').hidden=true;throw new Error(job.error||'Job cancelled.');}
    await new Promise(r=>setTimeout(r,800));}
}
async function saved(){
  const rows=await api('/v1/videos');$('savedVideos').replaceChildren(new Option('Choose a video…',''));
  for(const row of rows)$('savedVideos').add(new Option(row.name+' · '+row.state,row.id));
  if(video)$('savedVideos').value=video.id;
}
function review(a){
  analysis=a;focusDirty=false;$('reviewPanel').hidden=false;
  $('interpretation').textContent=a.observations.join(' ');
  $('analysisMethod').textContent=(a.analyzer.semantic?'Local vision interpretation':'Color-palette suggestion')+(a.ambiguous?' · mixed cues; choose the intended feeling.':'. You can choose another feeling.')+' Motion can include camera movement.';
  $('autoMood').checked=!!a.mood&&!a.ambiguous;theme(a.mood||activeMood);
  $('evidence').replaceChildren();
  for(const frame of a.evidence){const f=document.createElement('figure'),im=document.createElement('img'),cap=document.createElement('figcaption');im.src=API+frame.url;im.alt='Analyzed sphere interior at '+frame.time+' seconds';cap.textContent=frame.time.toFixed(1)+' s';f.append(im,cap);$('evidence').append(f);}
  $('generateButton').disabled=false;
}
function showResult(job){
  preview.pause();preview.src=API+(mp4Supported?job.video_url:job.preview_url);
  $('resultPanel').hidden=false;$('audioDownload').href=API+job.audio_url;$('videoDownload').href=API+job.video_url;
  $('metadataDownload').href=API+'/v1/soundtracks/'+job.id+'/metadata';$('metadataDownload').hidden=false;
  const b=job.result.brief,prov=job.result.provenance,engine=({composer:'Instrument composer',ace:'ACE-Step',library:'Music library'})[prov.engine]||prov.engine;
  $('resultMeta').textContent=`${engine} · ${b.mood} · ${b.duration.toFixed(2)} s · seed ${b.requested_seed}. ${prov.track?`Music: ${prov.track.credit}. ${prov.track.edit_note} `:''}Preview and downloads use this saved take; MP4 audio is AAC-encoded.`;
  $('soundMeta').textContent=b.mood+' · '+b.duration.toFixed(1)+' seconds';theme(b.mood);$('variations').value=job.id;
}
function renderResults(){
  $('variations').replaceChildren();
  for(const job of results)$('variations').add(new Option(job.result.brief.mood+' · '+job.result.provenance.engine+' · seed '+job.result.brief.requested_seed,job.id));
  if(results.length)showResult(results[0]);else{$('resultPanel').hidden=true;preview.removeAttribute('src');preview.load();}
}
async function loadVideo(id){
  const row=await api('/v1/videos/'+id);video=row;analysis=null;focus=[];focusDirty=false;unsavedFocus=false;preview.pause();
  $('refStatus').textContent=row.name;$('reviewPanel').hidden=true;$('focusPanel').hidden=row.state!=='ready';
  $('deleteVideo').disabled=false;
  if(row.state==='ready'){
    focus=row.analysis?.focus||[];selected=focus.length?{...focus[0]}:{cx:.5,cy:.6,rx:.125,ry:.175};focusChips();
    $('focusHint').textContent=focus.length?'Saved focus restored. Scrub to inspect it.':'Save the first focus at 0:00.';
    $('focusTime').max=Math.max(0,row.metadata.duration-1/24);$('focusTime').value=0;$('focusClock').textContent='0:00';
    $('videoDuration').textContent=row.metadata.duration.toFixed(2)+' seconds';source.src=API+(mp4Supported?row.preview_url:row.webm_url);
    if(row.analysis)review(row.analysis);
  }
  results=row.jobs.filter(j=>j.kind==='soundtrack'&&j.state==='complete');renderResults();
  $('savedVideos').value=id;
  if(row.state==='failed')message(row.error||'Video import failed.',true);
  return row;
}
async function upload(file){
  if(!file||working)return;
  if(!file.name.toLowerCase().endsWith('.mp4')||file.size>100*1024*1024){message('Choose an MP4 up to 100 MB.',true);return;}
  busy(true);preview.pause();message('Uploading video…');
  try{const data=new FormData();data.append('file',file);const row=await api('/v1/videos',{method:'POST',body:data});await poll(row.job_id);await loadVideo(row.id);await saved();message('Select the sphere interior at the beginning, then check the zoom later in the clip.');}
  catch(e){message(e.message,true);}finally{activeJob=null;busy(false);$('fileInput').value='';}
}
$('referenceButton').onclick=()=>$('fileInput').click();$('fileInput').onchange=e=>upload(e.target.files[0]);
$('referenceButton').addEventListener('dragover',e=>e.preventDefault());$('referenceButton').addEventListener('drop',e=>{e.preventDefault();upload(e.dataTransfer.files[0]);});
$('analyzeButton').onclick=async()=>{
  if(working||!focus.length)return;
  busy(true);preview.pause();
  try{const job=await jsonPost('/v1/videos/'+video.id+'/analysis',{focus,analyzer:$('analyzer').value});await poll(job.id);await loadVideo(video.id);message('Sphere analyzed. Review the feeling, then create a soundtrack.');}
  catch(e){message(e.message,true);}finally{activeJob=null;busy(false);}
};
$('analyzer').onchange=()=>{if(analysis){focusDirty=true;$('generateButton').disabled=true;message('Read the sphere again to use this analysis method.');}};
document.querySelectorAll('.mood-btn').forEach(b=>b.onclick=()=>{$('autoMood').checked=false;theme(b.dataset.mood);});
$('autoMood').onchange=()=>{if($('autoMood').checked){if(!analysis?.mood){$('autoMood').checked=false;message('The analysis has no clear feeling. Choose one below.');}else theme(analysis.mood);}};
async function generate(){
  if(working||!analysis||focusDirty)return;
  busy(true);preview.pause();
  try{const seed=crypto.getRandomValues(new Uint32Array(1))[0],job=await jsonPost('/v1/soundtracks',{video_id:video.id,mood:$('autoMood').checked?'auto':activeMood,engine:$('engine').value,seed});
    const complete=await poll(job.id);results.unshift(complete);renderResults();message('Your soundtrack is ready. Listen to check its mood and ending.');}
  catch(e){message(e.message,true);}finally{activeJob=null;busy(false);}
}
$('generateButton').onclick=generate;$('variationButton').onclick=generate;
$('variations').onchange=()=>showResult(results.find(j=>j.id===$('variations').value));
$('cancelButton').onclick=async()=>{if(activeJob)try{await api('/v1/jobs/'+activeJob,{method:'DELETE'});message('Cancellation requested…');}catch(e){message(e.message,true);}};
$('savedVideos').onchange=async()=>{
  if(!$('savedVideos').value)return;busy(true);
  try{let row=await loadVideo($('savedVideos').value);const running=row.jobs.find(j=>['queued','running'].includes(j.state));if(running){await poll(running.id);row=await loadVideo(row.id);}message(row.state==='ready'?'Saved video restored.':row.error||'Video not ready.',row.state==='failed');}
  catch(e){message(e.message,true);}finally{activeJob=null;busy(false);}
};
$('deleteVideo').onclick=async()=>{
  if(!video||working||!confirm('Delete this local video, analyses and all generated soundtracks?'))return;
  busy(true);
  try{const row=await api('/v1/videos/'+video.id);if(row.jobs.some(j=>['queued','running'].includes(j.state)))throw new Error('Cancel or finish the video’s active jobs first.');
    for(const job of row.jobs.filter(j=>j.kind==='soundtrack'))await api('/v1/soundtracks/'+job.id,{method:'DELETE'});
    await api('/v1/videos/'+video.id,{method:'DELETE'});video=null;analysis=null;focus=[];results=[];preview.pause();source.removeAttribute('src');source.load();
    $('focusPanel').hidden=$('reviewPanel').hidden=$('resultPanel').hidden=true;$('refStatus').textContent='Add a video';await saved();message('Video and results deleted.');}
  catch(e){message(e.message,true);}finally{busy(false);}
};
preview.addEventListener('play',async()=>{
  try{if(!mediaContext){mediaContext=new AudioContext();analyserNode=mediaContext.createAnalyser();analyserNode.fftSize=128;mediaSource=mediaContext.createMediaElementSource(preview);mediaSource.connect(analyserNode);analyserNode.connect(mediaContext.destination);}await mediaContext.resume();isPlaying=true;}
  catch{isPlaying=true;}
});
for(const event of ['pause','ended','emptied'])preview.addEventListener(event,()=>{isPlaying=false;});
async function start(){
  try{const gate=await api('/auth/status',{signal:AbortSignal.timeout(8000)});if(gate.required&&!gate.authenticated)await signIn();
    const h=await api('/health',{signal:AbortSignal.timeout(8000)});$('connection').textContent=h.worker_online?'Server connected':'Worker not running';
    if(!h.worker_online)message('Start the worker with python -m server.worker, or use python run_local.py.',true);
    else if(!h.ffmpeg)message('Install FFmpeg and ffprobe before importing a video.',true);
    $('engine').querySelector('[value="library"]').disabled=!h.engines.library;
    $('engine').querySelector('[value="composer"]').disabled=!h.engines.composer;
    $('engine').querySelector('[value="ace"]').disabled=!h.engines.ace;
    $('analyzer').querySelector('[value="qwen"]').disabled=!h.vision.ready;
    $('engine').value=h.engines.library?'library':h.engines.composer?'composer':h.engines.ace?'ace':'library';
    await saved();
  }catch{$('connection').textContent='Local server needed';message('Start the local app with python run_local.py and open http://127.0.0.1:8765. This page needs the processing server.',true);}
  busy(false);
}
theme('warm');start();
