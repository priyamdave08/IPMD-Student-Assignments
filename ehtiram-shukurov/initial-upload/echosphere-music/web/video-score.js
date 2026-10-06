/* Adapter for the original v6 instrument renderer. Visual metrics are never
   passed off as extracted audio chords, beats or melodies. */
function composeVideoBrief(brief) {
  const p={...moods[brief.mood],mood:brief.mood};
  if (!p.lead || !Number.isFinite(brief.duration) || brief.duration<10 || brief.duration>60.05)
    throw new Error('Invalid visual musical brief.');
  const tail=Math.min(1.4,brief.duration*.12), body=brief.duration-tail-.06;
  const bounds=TEMPO_BOUNDS[p.mood],target=brief.tempo;
  const options=[];
  for(let bars=2;bars<=36;bars++) {
    const tempo=bars*240/body;
    if(tempo>=bounds[0]&&tempo<=bounds[1])options.push({bars,tempo,cost:Math.abs(tempo-target)+(bars%2?5:0)});
  }
  options.sort((a,b)=>a.cost-b.cost);
  const chosen=options[0]||{bars:Math.max(2,Math.round(body*target/240)),tempo:target};
  p.bars=chosen.bars;p.tempo=chosen.bars*240/body;
  p.density=clamp(p.density*.75+brief.energy*.35,.18,.85);
  p.filterFreq*=.85+clamp(brief.brightness,0,1)*.6;
  p.reverb=Math.min(p.reverb,1.3);
  const score=composeSong(p,brief.seed),spb=60/p.tempo;
  // Retain a complete cadence; reserve a real decay tail rather than speeding
  // up a long track or chopping a 16-bar arrangement at the video boundary.
  score.duration=brief.duration;
  score.endTime=brief.duration-tail;
  score.source='sphere-visual-brief';score.version='video-score-v1';
  for(const e of score.events) {
    const nearest=brief.energy_curve.reduce((a,b)=>Math.abs(a.time-e.time)<Math.abs(b.time-e.time)?a:b,{time:0,energy:brief.energy});
    const ending=e.beat>=(p.bars-1)*4;
    e.velocity=clamp(e.velocity*(ending?1:.85+nearest.energy*.4),.04,.92);
    e.duration=Math.max(.035,Math.min(e.duration,score.endTime-e.time));
  }
  // A ten-second miniature has little introduction space: introduce its motif
  // immediately, while keeping the original engine's final tonic and harmony.
  if(p.bars<=4 && !score.events.some(e=>e.track==='lead'&&e.time<spb*2)) {
    const rng=seeded(brief.seed),motif=MOTIFS[p.mood][Math.floor(rng()*MOTIFS[p.mood].length)];
    for(let i=0;i<3;i++)score.events.push({track:'lead',beat:i,time:.06+i*spb,duration:spb*.7,
      notes:[degreeNote(motif[i],rootNear(p.rootPC,p.leadAnchor),p.mode)],velocity:.48,kind:'note'});
  }
  score.events.sort((a,b)=>a.time-b.time||a.track.localeCompare(b.track));
  // The melody is monophonic. Chord notes and simultaneous different tracks
  // remain valid; only shorten overlapping notes of this one performer.
  const lead=score.events.filter(e=>e.track==='lead');
  for(let i=0;i<lead.length-1;i++)lead[i].duration=Math.min(lead[i].duration,Math.max(.035,lead[i+1].time-lead[i].time-.025));
  validateScore(score);
  return score;
}

async function renderVideoBrief(brief) {
  const ctx=new AudioContext();
  try {
    const score=composeVideoBrief(brief);
    const entries=await Promise.all(scoreInstruments(score).map(async n=>[n,await loadInstrument(n,ctx)]));
    const rendered=await renderSong(score,ctx,Object.fromEntries(entries));
    const blob=bufferToWaveBlob(rendered.buffer,score);
    const bytes=new Uint8Array(await blob.arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return {audio:btoa(binary),score,stats:rendered.stats};
  } finally { await ctx.close(); }
}
