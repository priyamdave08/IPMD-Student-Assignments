// A richer version of the original soft sphere: cached light, a few curves, bounded particles.
const FEELING_MOTION=[
  {speed:.86,drift:-18,breath:.96,flow:1,trail:.72,tilt:-.27},
  {speed:.38,drift:-4,breath:.65,flow:.65,trail:.42,tilt:.15},
  {speed:1.42,drift:-24,breath:1.5,flow:1.3,trail:1.2,tilt:-.43},
  {speed:.53,drift:15,breath:.76,flow:.78,trail:1.1,tilt:.33}
];
function createLivingScene(makeCanvas){
  const keys=['warm','calm','anger','sad'],TAU=Math.PI*2;
  const colors=keys.map(k=>moods[k].color.match(/[\da-f]{2}/gi).map(x=>parseInt(x,16)));
  const highlights=[[255,228,166],[190,162,248],[250,118,80],[152,204,237]];
  const secondary=[[230,131,114],[98,130,229],[161,52,106],[110,122,204]];
  const sprites=colors.map((c,index)=>{
    const rgba=(color,a)=>`rgba(${color.join(',')},${a})`;
    const make=(size,color,stops)=>{const canvas=makeCanvas(size,size),g=canvas.getContext('2d'),r=size/2;
      const gradient=g.createRadialGradient(r,r,0,r,r,r);stops.forEach(([at,alpha])=>gradient.addColorStop(at,rgba(color,alpha)));
      g.fillStyle=gradient;g.fillRect(0,0,size,size);return canvas;};
    const ribbon=makeCanvas(768,256),g=ribbon.getContext('2d');
    const gradient=g.createLinearGradient(0,0,768,0);
    gradient.addColorStop(0,rgba(c,0));gradient.addColorStop(.28,rgba(c,.7));
    gradient.addColorStop(.58,rgba(secondary[index],.85));gradient.addColorStop(.78,rgba(highlights[index],.35));gradient.addColorStop(1,rgba(c,0));
    g.strokeStyle=gradient;g.lineCap='round';
    // Many faint cached strokes form a soft falloff, without hard ribbon edges.
    for(let layer=24;layer>0;layer--){
      g.lineWidth=layer*6;g.globalAlpha=.033*(1-layer/30);g.beginPath();g.moveTo(-24,202);
      g.bezierCurveTo(128,202,135,15,342,85);g.bezierCurveTo(518,151,573,176,792,38);g.stroke();
    }
    // Fade the texture boundary too, so rotating the cached light never exposes a rectangle.
    g.globalAlpha=1;g.globalCompositeOperation='destination-in';
    const edge=g.createLinearGradient(0,0,0,256);edge.addColorStop(0,'rgba(0,0,0,0)');edge.addColorStop(.22,'rgba(0,0,0,1)');edge.addColorStop(.78,'rgba(0,0,0,1)');edge.addColorStop(1,'rgba(0,0,0,0)');
    g.fillStyle=edge;g.fillRect(0,0,768,256);
    // Fade all four boundaries to avoid a rectangular silhouette as the aurora turns.
    g.save();g.scale(3,1);const vignette=g.createRadialGradient(128,128,0,128,128,128);
    vignette.addColorStop(0,'rgba(0,0,0,1)');vignette.addColorStop(.5,'rgba(0,0,0,1)');vignette.addColorStop(1,'rgba(0,0,0,0)');
    g.fillStyle=vignette;g.fillRect(0,0,256,256);g.restore();g.globalCompositeOperation='source-over';
    return {
      core:make(512,c,[[0,.9],[.32,.7],[.65,.35],[.87,.1],[1,0]]),
      aura:make(256,c,[[0,.23],[.24,.13],[.58,.038],[1,0]]),
      mist:make(128,c,[[0,.24],[.35,.095],[1,0]]),
      pearl:make(64,highlights[index],[[0,.65],[.13,.35],[.4,.065],[1,0]]),
      colorMist:make(128,secondary[index],[[0,.16],[.4,.065],[1,0]]),ribbon
    };
  });
  // Blend each small light texture once per color step, not once per on-screen light.
  const blended=Object.fromEntries(Object.keys(sprites[0]).map(k=>[k,makeCanvas(sprites[0][k].width,sprites[0][k].height)]));
  let palette=sprites[0],paletteKey='';
  function preparePalette(weights){
    const dominant=weights.findIndex(v=>v>.997);
    if(dominant>=0){palette=sprites[dominant];return;}
    const key=weights.map(v=>Math.round(v*48)).join(',');
    if(key!==paletteKey){
      for(const kind in blended){const target=blended[kind],g=target.getContext('2d');g.clearRect(0,0,target.width,target.height);g.globalCompositeOperation='lighter';
        for(let i=0;i<4;i++)if(weights[i]>.002){g.globalAlpha=weights[i];g.drawImage(sprites[i][kind],0,0);}
        g.globalAlpha=1;g.globalCompositeOperation='source-over';}
      paletteKey=key;
    }
    palette=blended;
  }
  const backdrop=makeCanvas(1,1),backCtx=backdrop.getContext('2d');
  let backKey='',backTime=-Infinity;
  const rng=seeded(93117);
  const stars=Array.from({length:96},(_,i)=>({x:rng(),y:rng(),depth:.3+rng()*.7,phase:rng()*TAU,size:.5+rng()*1.2,group:i%3}));
  const orbiters=Array.from({length:36},(_,i)=>({angle:i/36*TAU,phase:rng()*TAU,speed:.1+rng()*.15,radius:.61+rng()*.7,size:.7+rng()*1.35}));
  const nebulae=Array.from({length:5},()=>({x:rng(),y:rng(),phase:rng()*TAU,size:.24+rng()*.2}));
  const px=new Float32Array(56),py=new Float32Array(56),angles=Array.from({length:56},(_,i)=>i/56*TAU);
  const starX=new Float32Array(96),starY=new Float32Array(96);
  function draw(ctx,w,h,s){
    const {time,weights,anchor,quiet=false,pointer={x:0,y:0},spectrum=[],ripples=[],glints=[]}=s;
    ctx.clearRect(0,0,w,h);
    const t=quiet?0:time,parX=quiet?0:pointer.x,parY=quiet?0:pointer.y;
    const amp=quiet?0:(s.amp||0),spark=quiet?0:(s.spark||0),bass=quiet?0:(s.bass||0),held=quiet?0:(s.held||0);
    const section=quiet?.58:(s.section??.58),phrase=quiet?0:(s.phrase||0);
    const motion={speed:0,drift:0,breath:0,flow:0,trail:0,tilt:0},rgb=[0,0,0],lit=[0,0,0],visible=[];
    for(let i=0;i<4;i++){
      for(const k in motion)motion[k]+=FEELING_MOTION[i][k]*weights[i];
      for(let c=0;c<3;c++){rgb[c]+=colors[i][c]*weights[i];lit[c]+=highlights[i][c]*weights[i];}
      if(weights[i]>.003)visible.push(i);
    }
    preparePalette(weights);
    const phase=quiet?0:(s.phase??t*motion.speed),wind=quiet?0:(s.wind??t*motion.drift),breathPhase=quiet?0:(s.breathPhase??t*motion.breath);
    // A steady ambient clock keeps every mood alive even with no mouse or audio.
    const ambient=t*.72+phase*.28;
    const color=rgb.map(Math.round).join(','),light=lit.map(Math.round).join(',');
    const cx=anchor.x+anchor.w/2+parX*15,cy=anchor.y+(anchor.h-48)/2+parY*12+(quiet?0:Math.sin(phase*.42)*3);
    const baseR=Math.max(85,Math.min(anchor.w*.37,(anchor.h-48)*.49,330));
    const inhale=(.5+.5*Math.sin(breathPhase));
    const r=baseR*(quiet?1:1+(inhale-.5)*.12+Math.min(.065,amp*.36)+bass*.065+spark*.015+held*.065);
    const stamp=(kind,x,y,radius,alpha,target=ctx)=>{target.globalAlpha=clamp(alpha,0,1);target.drawImage(palette[kind],x-radius,y-radius,radius*2,radius*2);target.globalAlpha=1;};
    const ribbon=(x,y,width,height,angle,alpha,target=ctx)=>{
      target.save();target.translate(x,y);target.rotate(angle);target.globalAlpha=clamp(alpha,0,1);
      target.drawImage(palette.ribbon,-width/2,-height/2,width,height);target.restore();
    };
    // Diffuse scenery needs less resolution and refresh than the sphere and particles.
    const newBackKey=w+':'+h+':'+quiet+':'+weights.map(v=>Math.round(v*32)).join(',');
    if(newBackKey!==backKey||Math.abs(t-backTime)>.06){
      const bw=Math.max(1,Math.round(w*.45)),bh=Math.max(1,Math.round(h*.45));
      if(backdrop.width!==bw||backdrop.height!==bh){backdrop.width=bw;backdrop.height=bh;}
      backCtx.setTransform(bw/w,0,0,bh/h,0,0);backCtx.clearRect(0,0,w,h);
      ribbon(w*.28+Math.sin(ambient*.38)*w*.12+parX*7,h*.32+Math.sin(ambient*.46)*h*.19,w*1.04,h*.54,-.32+Math.sin(ambient*.3)*.32,.82+section*.18,backCtx);
      ribbon(w*.74+Math.cos(ambient*.32)*w*.1-parX*10,h*.47+Math.cos(ambient*.37)*h*.17,w*.9,h*.48,2.78+Math.cos(ambient*.27)*.32,.76+phrase*.15,backCtx);
      for(let i=0;i<nebulae.length;i++){
        const n=nebulae[i],nx=n.x*w+Math.sin(ambient*.42+n.phase)*w*.14+parX*10,ny=n.y*h+Math.cos(ambient*.35+n.phase)*h*.13+parY*8;
        stamp(i%2?'colorMist':'mist',nx,ny,Math.min(w,h)*n.size,.74+section*.2,backCtx);
      }
      backKey=newBackKey;backTime=t;
    }
    ctx.drawImage(backdrop,0,0,w,h);
    // Far, middle and near particles share a current; trails are batched in three paths.
    for(let i=0;i<stars.length;i++){
      const p=stars[i];let x=p.x*w+parX*25*p.depth+Math.sin(ambient*.54+p.phase)*(22+motion.flow*18);
      let y=mod(p.y*h+(wind-t*6)*p.depth+Math.cos(ambient*.42+p.phase)*22,h)+parY*25*p.depth;
      if(!quiet){const dx=(pointer.x*.5+.5)*w-x,dy=(pointer.y*.5+.5)*h-y,dist=Math.hypot(dx,dy);if(dist<165){const pull=(1-dist/165)*.13;x+=dx*pull;y+=dy*pull;}}
      starX[i]=x;starY[i]=y;
    }
    if(!quiet)for(let group=0;group<3;group++){
      ctx.beginPath();
      for(let i=group;i<stars.length;i+=3){const p=stars[i],tail=(3+p.depth*9)*motion.trail;
        const dx=Math.cos(ambient*.54+p.phase)*tail*.7,dy=clamp(motion.drift/11,-1,1)*tail;
        ctx.moveTo(starX[i]-dx,starY[i]-dy);ctx.lineTo(starX[i],starY[i]);}
      ctx.strokeStyle=`rgba(${light},${.045+group*.022})`;ctx.lineWidth=.6+group*.2;ctx.stroke();
    }
    ctx.fillStyle=`rgb(${light})`;
    for(let i=0;i<stars.length;i++){
      const p=stars[i];ctx.globalAlpha=(.14+(.5+.5*Math.sin(ambient*.9+p.phase))*.34)*(.82+section*.22);
      ctx.beginPath();ctx.arc(starX[i],starY[i],p.size,0,TAU);ctx.fill();
    }
    ctx.globalAlpha=1;
    // A handful of defocused near lights gives the field depth without crowding it.
    for(let i=0;i<9;i++){const n=stars[i*9];stamp('pearl',starX[i*9],starY[i*9],9+n.depth*9,.12+(.5+.5*Math.sin(phase*.4+n.phase))*.1);}
    if(cy+r*3<0||cy-r*3>h)return;
    const auraScale=2.5+section*.27+inhale*.24+held*.2;
    stamp('aura',cx,cy,r*auraScale,.88+amp+spark*.035+phrase*.09);
    stamp('colorMist',cx+r*.5,cy+r*.1,r*1.45,.27+section*.08);
    // A continuous, slowly opening corona is visible while idle; no input is needed.
    // Two offset waves crossfade at their boundaries rather than flashing on reset.
    if(!quiet)for(let layer=0;layer<2;layer++){
      const u=mod(t/7.8+layer*.5,1),envelope=Math.sin(Math.PI*u)**1.4;
      const cr=r*(1.06+u*1.45);
      ctx.beginPath();ctx.ellipse(cx,cy,cr,cr*.94,.12*Math.sin(ambient*.3),0,TAU);
      ctx.strokeStyle=`rgba(${color},${envelope*.038})`;ctx.lineWidth=12;ctx.stroke();
      ctx.strokeStyle=`rgba(${color},${envelope*.15})`;ctx.lineWidth=1.3;ctx.stroke();
    }
    // Two orbital arcs imply volume around the familiar soft body.
    ctx.save();ctx.translate(cx,cy);ctx.rotate(motion.tilt+Math.sin(phase*.09)*.08);
    for(let layer=0;layer<2;layer++){
      ctx.beginPath();ctx.ellipse(0,0,r*(1.28+layer*.12),r*(.46+layer*.1),layer*.27,phase*.07+layer*2,phase*.07+layer*2+Math.PI*1.15);
      ctx.strokeStyle=`rgba(${color},${.095-layer*.027})`;ctx.lineWidth=.85;ctx.stroke();
    }
    ctx.restore();
    stamp('core',cx,cy,r,1);
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.clip();
    // Drift and rotation are integrated across mood changes so no particle jumps.
    for(let i=0;i<3;i++){
      const a=phase*(.2+i*.06)+i*2.1;
      stamp(i===1?'colorMist':'mist',cx+Math.cos(a)*r*(.2+i*.12),cy+Math.sin(a)*r*.34,r*(.65-i*.07),.68+spark*.065+held*.13);
    }
    ribbon(cx,cy,r*2.35,r*1.5,phase*.05-.35,.42+inhale*.16);
    stamp('pearl',cx-r*.29+Math.sin(phase*.18)*r*.08,cy-r*.32,r*.35,.16+inhale*.05);
    ctx.restore();
    // Orbiting dust and luminous short trails react to intensity, not random jitter.
    ctx.beginPath();
    for(const p of orbiters){const a=p.angle+phase*p.speed,rad=r*(p.radius+held*.07);
      const x=cx+Math.cos(a)*rad,y=cy+Math.sin(a)*rad*.73;
      ctx.moveTo(cx+Math.cos(a-.065*motion.trail)*rad,cy+Math.sin(a-.065*motion.trail)*rad*.73);ctx.lineTo(x,y);}
    ctx.strokeStyle=`rgba(${light},.14)`;ctx.lineWidth=.85;ctx.stroke();
    ctx.fillStyle=`rgb(${light})`;
    for(const p of orbiters){const a=p.angle+phase*p.speed,rad=r*(p.radius+held*.07),front=(Math.sin(a)+1)/2;
      ctx.globalAlpha=(.13+front*.3)*(.75+(.5+.5*Math.sin(phase+p.phase))*.4);
      ctx.beginPath();ctx.arc(cx+Math.cos(a)*rad,cy+Math.sin(a)*rad*.73,p.size*(.8+front*.35+amp*.4),0,TAU);ctx.fill();}
    ctx.globalAlpha=1;
    // Organic breathing rim, kept to one path with 56 smooth control points.
    for(let i=0;i<56;i++){
      const a=angles[i],sound=quiet?0:(spectrum[i]||0),soft=.6*sound+.2*(spectrum[(i+55)%56]||0)+.2*(spectrum[(i+1)%56]||0);
      const rr=r*(1.035+(quiet?0:soft*.12+Math.sin(a*3+phase*.65)*.032+Math.sin(a*5-phase*.3)*.011+bass*.022));
      px[i]=cx+Math.cos(a)*rr;py[i]=cy+Math.sin(a)*rr;
    }
    ctx.beginPath();ctx.moveTo((px[55]+px[0])/2,(py[55]+py[0])/2);
    for(let i=0;i<56;i++){const next=(i+1)%56;ctx.quadraticCurveTo(px[i],py[i],(px[i]+px[next])/2,(py[i]+py[next])/2);}
    ctx.closePath();ctx.strokeStyle=`rgba(${color},${.2+Math.min(.17,amp+spark*.04+held*.07)})`;ctx.lineWidth=1.2;ctx.stroke();
    // A short highlight rotates around the rim rather than uniformly brightening it.
    ctx.beginPath();ctx.ellipse(cx,cy,r*1.043,r*1.025,0,-2.65+phase*.065,-1.45+phase*.065);
    ctx.strokeStyle=`rgba(${light},${.17+inhale*.06})`;ctx.lineWidth=.9;ctx.stroke();
    if(!quiet){
      for(const tr of ripples){const life=tr.life||1.65,u=tr.age/life;if(u<0||u>1)continue;
        const envelope=Math.sin(Math.PI*u)**.85*(1-u*.35)*(tr.strength??1);
        const radius=r*(1.04+u*2.1);
        ctx.beginPath();ctx.arc(cx,cy,radius,0,TAU);
        ctx.lineWidth=5;ctx.strokeStyle=`rgba(${color},${envelope*.13})`;ctx.stroke();
        ctx.lineWidth=1.6;ctx.strokeStyle=`rgba(${light},${envelope*.38})`;ctx.stroke();}
      // Melody sparks and larger light releases share a bounded pool of 42 particles.
      ctx.beginPath();
      for(const g of glints){const u=g.age/g.life;if(u<0||u>1)continue;
        const angle=g.angle+u*.26,rad=r*(.85+u*(g.spread??.7)),x=cx+Math.cos(angle)*rad,y=cy+Math.sin(angle)*rad*.8;
        ctx.moveTo(x-Math.cos(angle)*(g.spread>1?22:10)*(1-u),y-Math.sin(angle)*(g.spread>1?18:7)*(1-u));ctx.lineTo(x,y);}
      ctx.strokeStyle=`rgba(${light},.22)`;ctx.lineWidth=1;ctx.stroke();
      ctx.fillStyle=`rgb(${light})`;
      for(const g of glints){const u=g.age/g.life;if(u<0||u>1)continue;const angle=g.angle+u*.26,rad=r*(.85+u*(g.spread??.7));
        ctx.globalAlpha=Math.sin(Math.PI*u)*.6*(g.strength||.6);ctx.beginPath();ctx.arc(cx+Math.cos(angle)*rad,cy+Math.sin(angle)*rad*.8,1.1+(1-u)*1.4,0,TAU);ctx.fill();}
      ctx.globalAlpha=1;
    }
  }
  return {draw};
}
function startLivingSphere(){
  const canvas=document.getElementById('sphereCanvas'),anchor=document.getElementById('sphereAnchor'),ctx=canvas.getContext('2d',{alpha:true});
  if(!ctx||!anchor)return;
  const scene=createLivingScene((w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;});
  const keys=['warm','calm','anger','sad'],weights=[1,0,0,0],wave=new Float32Array(128),bins=new Float32Array(64),spectrum=new Float32Array(56);
  const pointer={x:0,y:0},targetPointer={x:0,y:0},lights=[],waves=[];
  let w=1,h=1,rect={x:0,y:0,w:1,h:1},layoutDirty=true,sizeDirty=true;
  let raf=0,last=0,time=0,phase=0,wind=0,breathPhase=0,amp=0,costAverage=0,intervalAverage=16.7,frames=0,quality=1;
  let bassTarget=0,bass=0,heldTarget=0,held=0,sectionTarget=.58,section=.58,phrase=0,lastNoteAt=-Infinity,lastWaveAt=-Infinity,lastReleaseAt=-Infinity;
  function schedule(){if(!raf&&!document.hidden)raf=requestAnimationFrame(frame);}
  function addWave(strength=.7,life=1.65){waves.push({born:performance.now(),strength,life});if(waves.length>4)waves.shift();}
  function releaseLight(strength=.85){addWave(strength,2.8);for(let i=0;i<18;i++)addLight(i/18*Math.PI*2,strength,1.75);ignite('chord',strength*.8);lastReleaseAt=performance.now();schedule();}
  function addLight(angle,strength=.6,spread=.7){lights.push({born:performance.now(),life:spread>1?2.6:1.8,angle,strength,spread});if(lights.length>42)lights.shift();}
  function measure(){
    if(sizeDirty){w=window.innerWidth;h=window.innerHeight;const dpr=Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(1600000/(w*h)))*quality;
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);sizeDirty=false;}
    const r=anchor.getBoundingClientRect();rect={x:r.left,y:r.top,w:r.width,h:r.height};layoutDirty=false;
  }
  function frame(now){
    raf=0;if(document.hidden)return;
    const interval=Math.min(50,Math.max(1,now-last||16.7));
    intervalAverage=intervalAverage*.97+interval*.03;
    const dt=interval/1000;last=now;
    if(layoutDirty)measure();
    const blend=calmMode?1:1-Math.exp(-dt*2.5),motionBlend=1-Math.exp(-dt*5);
    let speed=0,drift=0,breath=0;
    for(let i=0;i<4;i++){weights[i]+=((keys[i]===activeMood?1:0)-weights[i])*blend;speed+=FEELING_MOTION[i].speed*weights[i];drift+=FEELING_MOTION[i].drift*weights[i];breath+=FEELING_MOTION[i].breath*weights[i];}
    if(!calmMode){time+=dt;phase+=dt*speed;wind+=dt*drift;breathPhase+=dt*breath;}
    pointer.x+=((calmMode?0:targetPointer.x)-pointer.x)*motionBlend;pointer.y+=((calmMode?0:targetPointer.y)-pointer.y)*motionBlend;
    let loudness=0;
    if(analyserNode&&isPlaying&&!calmMode){analyserNode.getFloatTimeDomainData(wave);analyserNode.getFloatFrequencyData(bins);for(const n of wave)loudness+=n*n;loudness=Math.sqrt(loudness/wave.length);}
    amp+=(loudness-amp)*(1-Math.exp(-dt*8));
    for(let i=0;i<56;i++){const bin=bins[1+Math.floor(i/56*36)],value=isPlaying&&!calmMode&&Number.isFinite(bin)?clamp((bin+80)/60,0,1):0;spectrum[i]+=(value-spectrum[i])*(1-Math.exp(-dt*8));}
    bassTarget*=Math.exp(-dt*5);bass+=(bassTarget-bass)*(1-Math.exp(-dt*12));
    held+=((calmMode?0:heldTarget)-held)*(1-Math.exp(-dt*4));
    section+=((isPlaying?sectionTarget:.58)-section)*(1-Math.exp(-dt*.85));phrase*=Math.exp(-dt*1.4);
    let spark=0;
    for(let i=sparks.length-1;i>=0;i--){const e=sparks[i],age=(now-e.born)/1000;if(age>e.lifespan){sparks.splice(i,1);continue;}const u=age/e.lifespan;spark+=Math.sin(clamp(u,0,1)*Math.PI)*(1-u)*e.strength;}
    const ripples=[];
    for(let i=transitions.length-1;i>=0;i--){const age=(now-transitions[i].born)/1000;if(age>1.65)transitions.splice(i,1);else ripples.push({age,life:1.65,strength:.9});}
    for(let i=waves.length-1;i>=0;i--){const e=waves[i],age=(now-e.born)/1000;if(age>e.life)waves.splice(i,1);else ripples.push({age,life:e.life,strength:e.strength});}
    const glints=[];
    for(let i=lights.length-1;i>=0;i--){const e=lights[i],age=(now-e.born)/1000;if(age>e.life)lights.splice(i,1);else glints.push({...e,age});}
    const began=performance.now();scene.draw(ctx,w,h,{time,phase,wind,breathPhase,weights,anchor:rect,quiet:calmMode,amp,spark:Math.min(2,spark),bass,held,section,phrase,pointer,spectrum,ripples,glints});
    costAverage=costAverage*.95+(performance.now()-began)*.05;frames++;
    if(frames>150&&(costAverage>10||intervalAverage>24)&&quality>.72){quality=Math.max(.72,quality*.85);layoutDirty=sizeDirty=true;frames=0;}
    if(!calmMode)schedule();
  }
  window.addEventListener('sphere-note',e=>{
    if(calmMode||document.hidden)return;
    const n=e.detail,now=performance.now();
    // The same light release used by clicking now follows strong musical entries.
    if((n.track==='kick'||n.track==='bass'||n.kind==='chord')&&n.velocity>.2&&now-lastReleaseAt>2700)releaseLight(clamp(n.velocity,.55,.9));
    if(n.track==='kick'||n.track==='bass')bassTarget=Math.max(bassTarget,n.velocity*(n.track==='kick'?1:.65));
    if(n.track==='lead'&&now-lastNoteAt>120){const angle=((n.midi??60)%12)/12*Math.PI*2+phase*.05;addLight(angle,n.velocity);addLight(angle+.22,n.velocity*.65);lastNoteAt=now;}
    if(n.kind==='chord'&&now-lastWaveAt>1800){addWave(.28,2);lastWaveAt=now;}
  });
  window.addEventListener('sphere-section',e=>{sectionTarget=e.detail.energy??.58;if(!calmMode){phrase=.7;if(performance.now()-lastReleaseAt>900)releaseLight(.7);else addWave(.45,2.5);}});
  window.addEventListener('pointermove',e=>{targetPointer.x=clamp(e.clientX/w*2-1,-1,1);targetPointer.y=clamp(e.clientY/h*2-1,-1,1);},{passive:true});
  document.documentElement.addEventListener('pointerleave',()=>{targetPointer.x=0;targetPointer.y=0;heldTarget=0;});
  const layoutChange=()=>{layoutDirty=true;schedule();};
  window.addEventListener('resize',()=>{sizeDirty=true;layoutChange();},{passive:true});window.addEventListener('scroll',layoutChange,{passive:true});
  new ResizeObserver(layoutChange).observe(anchor);
  window.addEventListener('sphere-change',()=>{if(calmMode){heldTarget=0;lights.length=0;waves.length=0;bassTarget=0;}schedule();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;heldTarget=0;}else{last=performance.now();layoutChange();}});
  const touch=document.getElementById('sphereTouch');
  touch.addEventListener('pointerdown',()=>{if(!calmMode){heldTarget=1;schedule();}});
  const release=()=>{heldTarget=0;};window.addEventListener('pointerup',release,{passive:true});window.addEventListener('pointercancel',release,{passive:true});window.addEventListener('blur',release);
  touch.addEventListener('keydown',e=>{if(!calmMode&&(e.key===' '||e.key==='Enter'))heldTarget=1;});touch.addEventListener('keyup',release);touch.addEventListener('blur',release);
  touch.addEventListener('click',()=>{if(!calmMode)releaseLight(.95);});
  schedule();
}
startLivingSphere();
