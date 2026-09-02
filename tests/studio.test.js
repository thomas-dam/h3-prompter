import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { storyPlan, storyboardReply } from './fixtures/storyboard.js';

const root = await fs.mkdtemp(join(tmpdir(), 'h3-studio-test-'));
process.env.H3_CACHE_ROOT = join(root, 'cache');
process.env.H3_DATA_DIR = join(root, 'projects');
process.env.H3_SETTINGS_PATH = join(root, 'settings.json');
const { MediaStore, STORE, CACHE_ROOT, avMetadata, ffprobeJson } = await import('../src/lib/media.js');
const { prepareClip, runMedia, validateRange } = await import('../src/lib/video.js');
const { ProjectStore } = await import('../src/lib/projects.js');
const { analyzeClip, videoAssembly, validateAnalysis, kreaPrompt } = await import('../src/lib/studio_models.js');
const { createServer } = await import('../src/server.js');
const { JOB } = await import('../src/lib/jobs.js');
const { clipMatchesRange, promptIsCurrent, parseEvents } = await import('../public/workflow.js');
const { localBaseUrl } = await import('../src/lib/settings.js');
const { providerUrlAndHeaders } = await import('../src/lib/generation.js');
const { StoryboardApprovals, cropStoryboardImage, storyboardAssembly, developStoryboard, storyboardImages, generateStoryboardClips } = await import('../src/lib/storyboard.js');
const { normalizePlan, validateReferences, reviewKey, clipReferences } = await import('../public/storyboard-state.js');
const ctx = () => ({ signal: new AbortController().signal, progress() {}, onDelta() {} });
const modelBody = { provider:'lmstudio', model_id:'test-vision' };
let fixture, server, base;
before(async () => {
  await fs.mkdir(CACHE_ROOT, { recursive:true });
  fixture = join(root,'source.mp4');
  await runMedia('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc2=size=120x160:rate=25:duration=5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=5','-c:v','libx264','-g','100','-bf','3','-pix_fmt','yuv420p','-c:a','aac','-shortest',fixture]);
  server = createServer({projects:new ProjectStore()}).listen(0, '127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve=>server.close(resolve));if(base)await assert.rejects(fetch(base+'/h3studio/status',{signal:AbortSignal.timeout(1000)}));await fs.rm(root,{recursive:true,force:true}); });
async function addSource(store, sessionId, path=fixture) {
  const dir=join(CACHE_ROOT,sessionId,randomUUID());await fs.mkdir(dir,{recursive:true});await fs.copyFile(path,join(dir,'original.mp4'));
  const s=await store.add(sessionId,'VideoSource','example.mp4','video/mp4',join(dir,'original.mp4'));
  return store.get(sessionId,s.id);
}
async function makeClip(store=new MediaStore()) {
  const sessionId=randomUUID(),source=await addSource(store,sessionId);
  const publicClip=await prepareClip({source,start:1.28,end:4.28,store,sessionId,...ctx()});
  return {store,sessionId,source,clip:store.get(sessionId,publicClip.id)};
}
test('non-keyframe trim preserves portrait dimensions, H.264/AAC and synchronized duration', async () => {
  const {clip,source}=await makeClip();
  assert.equal(clip.width,120);assert.equal(clip.height,160);assert.ok(Math.abs(clip.duration-3)<0.08);
  const info=await ffprobeJson(clip._original_path),v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio');
  assert.equal(v.codec_name,'h264');assert.equal(a.codec_name,'aac');assert.ok(Math.abs(Number(v.start_time)-Number(a.start_time))<0.05);
  assert.ok(Math.abs(Number(v.duration)-Number(a.duration))<0.08);assert.ok(Number(v.start_time)<0.05);
  assert.ok(clip._frames.length>=14&&clip._frames.length<=16);assert.equal(clip._frames[0].timestamp,0);
  const expected=join(root,'expected.png'), actual=join(root,'actual.png');
  for(const [src,offset,dest] of [[source._original_path,'1.28',expected],[clip._original_path,'0',actual]]) await runMedia('ffmpeg',['-v','error','-y','-ss',offset,'-i',src,'-frames:v','1',dest]);
  const x=await sharp(expected).raw().toBuffer(),y=await sharp(actual).raw().toBuffer();
  assert.equal(x.length,y.length);assert.ok(x.reduce((n,p,i)=>n+Math.abs(p-y[i]),0)/x.length<8,'export starts at the selected frame, not the prior keyframe');
  assert.equal((await avMetadata(source._original_path)).duration,5);
});
test('silent rotated input is exported upright without fabricated audio', async () => {
  const silent=join(root,'silent.mp4'),rotated=join(root,'rotated.mp4');
  await runMedia('ffmpeg',['-v','error','-y','-i',fixture,'-an','-c:v','copy',silent]);
  await runMedia('ffmpeg',['-v','error','-y','-display_rotation','90','-i',silent,'-c','copy',rotated]);
  const rotation=(await ffprobeJson(rotated)).streams[0].side_data_list?.find(s=>s.rotation!==undefined)?.rotation;
  assert.equal(Math.abs(rotation),90,'the fixture must actually carry rotation metadata');
  const store=new MediaStore(),sessionId=randomUUID(),source=await addSource(store,sessionId,rotated);
  const clip=await prepareClip({source,start:0.36,end:2.36,store,sessionId,...ctx()});
  assert.equal(clip.has_audio,false);assert.equal(clip.width,160);assert.equal(clip.height,120);
});
test('range validation rejects nonfinite, short, long and out-of-source selections',()=>{
  for(const range of [[-1,2,5],[0,1,5],[0,16,20],[1,7,5],[NaN,3,5]]) assert.throws(()=>validateRange(...range));
  validateRange(1.28,4.28,5);
});
test('cancellation does not replace a successful clip or leave partial output',async()=>{
  const {store,sessionId,source,clip}=await makeClip(),before=await fs.readdir(join(CACHE_ROOT,sessionId));
  const controller=new AbortController();controller.abort();
  await assert.rejects(prepareClip({source,start:0,end:2,store,sessionId,...ctx(),signal:controller.signal}));
  assert.equal(store.get(sessionId,clip.id),clip);assert.deepEqual(await fs.readdir(join(CACHE_ROOT,sessionId)),before);
});
test('analysis reads exported frames, resamples uncertainty, and preserves the previous analysis on failure',async()=>{
  const {clip}=await makeClip();let batches=0;
  const chatCompletion=async({payload})=>{
    let content;
    if(Array.isArray(payload.messages[0].content)) {batches++;assert.ok(payload.messages[0].content.filter(p=>p.type==='image_url').length<=6);content=JSON.stringify({notes:'At 00:00.000 the pattern moves continuously.',uncertain_times:batches===1?[0.5]:[]});}
    else content=JSON.stringify({summary:'A colored moving test pattern.',shots:[{start:0,description:'Continuous motion, static camera.'}],uncertainties:[]});
    return {choices:[{message:{content},finish_reason:'stop'}]};
  };
  const result=await analyzeClip(modelBody,clip,{...ctx(),chatCompletion});
  assert.ok(batches>=4);assert.equal(result.analysis.clip_id,clip.id);assert.ok(result.analysis.frame_count<=100);assert.match(result.analysis.text,/Audio: track present, not interpreted/);
  const original=clip.analysis;
  await assert.rejects(analyzeClip(modelBody,clip,{...ctx(),chatCompletion:async()=>({choices:[{message:{content:'I cannot see images.'}}]})}),/valid analysis JSON/);
  assert.equal(clip.analysis,original);
});
test('video prompts bind the trimmed clip and exclusive picture roles, with audio opt-in',async()=>{
  const {store,clip,sessionId}=await makeClip();clip.analysis={id:randomUUID(),text:'One continuous shot of a dancer.'};
  const dir=join(CACHE_ROOT,sessionId,randomUUID());await fs.mkdir(dir,{recursive:true});await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toFile(join(dir,'image.png'));
  const picture=await store.add(sessionId,'Video','person.png','image/png',join(dir,'image.png'));
  const body={...modelBody,analysis_id:clip.analysis.id,aspect_ratio:'9:16',image_roles:{[picture.id]:'subject appearance'}};
  const request=videoAssembly(body,clip,store),text=request.messages.at(-1).content;
  assert.match(text,/<Video 1>/);assert.match(text,/<Picture 1> replaces ONLY subject appearance/);assert.match(text,/Ignore source audio/);
  assert.equal(request.input.duration_seconds,clip.duration);assert.equal(request.media_inputs.find(x=>x.type==='video').asset_id,clip.id);
  assert.ok(!request.input.media_manifest.assets.some(a=>a.id===clip.source_id));
  const audio=videoAssembly({...body,use_audio:true},clip,store);assert.ok(audio.input.media_manifest.assets.some(a=>a.reference==='<Audio 1>'));
  const motion=videoAssembly({...body,creative_brief:'Use Video 1 for motion.'},clip,store);
  assert.ok(!motion.messages.some(m=>m.name==='motion_transfer_contract'), 'reviewed observations must not inherit the unavailable-video restriction');
  assert.throws(()=>videoAssembly({...body,analysis_id:'old'},clip,store),/Analyze the current/);
  assert.throws(()=>validateAnalysis({summary:'x',shots:[{start:0,description:'x'},{start:4,description:'y'}],uncertainties:[]},3),/invalid shot timings/);
});
test('projects restore clips, references and revisions after restart; failed save preserves previous snapshot',async()=>{
  const {store,sessionId,clip}=await makeClip();clip.analysis={id:randomUUID(),text:'Reviewed analysis.'};
  const projects=new ProjectStore(),state={fields:{videoBrief:'Change the subject'},outputs:{video:{prompt:'Saved prompt'}},revisions:{video:[{prompt:'Previous prompt'}]}};
  const saved=await projects.save({name:'Clip project',state,sessionId,store});
  const freshStore=new MediaStore(),restored=await new ProjectStore().open(saved.id,freshStore);
  assert.deepEqual(restored.state,state);assert.notEqual(restored.session_id,sessionId);
  const restoredClip=freshStore.get(restored.session_id,clip.id);assert.deepEqual(await fs.readFile(restoredClip._original_path),await fs.readFile(clip._original_path));
  assert.equal(restoredClip.analysis.text,'Reviewed analysis.');assert.ok(restoredClip._frames.every(f=>f.path.startsWith(CACHE_ROOT)));
  const badSession=randomUUID();store.assets(badSession).push({id:randomUUID(),_original_path:join(root,'missing','original.mp4')});
  await assert.rejects(projects.save({id:saved.id,name:'Broken update',state:{},sessionId:badSession,store}));
  assert.equal((await projects.info(saved.id)).name,'Clip project');
  const second=await projects.save({id:saved.id,name:'Renamed',state,sessionId:restored.session_id,store:freshStore});assert.notEqual(second.snapshot,saved.snapshot);
  await projects.remove(saved.id);assert.ok((await fs.stat(fixture)).isFile());assert.ok((await fs.stat(restoredClip._original_path)).isFile());
  await assert.rejects(projects.remove('../../outside'),/Invalid project/);
});
test('missing saved media is reported without partially registering a restored session',async()=>{
  const {store,sessionId,clip}=await makeClip(),projects=new ProjectStore(),saved=await projects.save({name:'Missing media',state:{},sessionId,store});
  await fs.rm(join(process.env.H3_DATA_DIR,saved.id,saved.snapshot,'media',clip.id),{recursive:true});
  const fresh=new MediaStore();await assert.rejects(projects.open(saved.id,fresh),/missing or damaged/);assert.equal(fresh.sessions.size,0);
});
test('Krea intent and constraints are kept separate from H3 format',async()=>{
  for(const intent of ['explore','direct']) {
    const result=await kreaPrompt({...modelBody,session_id:randomUUID(),intent,idea:'Three red chairs',mustKeep:'Exactly three chairs'},new MediaStore(),{...ctx(),chatCompletion:async({payload})=>{
      assert.match(payload.messages[0].content,/single polished paragraph/);assert.doesNotMatch(payload.messages[0].content,/subject_definitions/);assert.match(payload.messages[1].content[0].text,/Exactly three chairs/);return {choices:[{message:{content:'Three red chairs in soft window light.'},finish_reason:'stop'}]};
    }});assert.match(result.prompt,/Three red chairs/);
  }
  await assert.rejects(kreaPrompt({...modelBody,session_id:randomUUID(),intent:'reference',idea:'A chair'},new MediaStore(),ctx()),/needs a style image/);
});
test('UI export gate invalidates changed trim, analysis, and adaptation but supports matched revisions',()=>{
  const source={id:'source'},clip={id:'clip',source_id:'source',range_start:1,range_end:4,analysis:{id:'analysis'}},out={clip_id:'clip',analysis_id:'analysis',signature:'v1'};
  assert.ok(clipMatchesRange(clip,source,1,4));assert.ok(promptIsCurrent(out,clip,true,'v1'));
  assert.equal(clipMatchesRange(clip,source,1.1,4),false);assert.equal(promptIsCurrent(out,clip,true,'v2'),false);assert.equal(promptIsCurrent(out,{...clip,analysis:{id:'new'}},true,'v1'),false);
});
test('stream parser tolerates arbitrary byte boundaries and final unterminated event',async()=>{
  const text='data: {"type":"delta","content":"✦"}\n\ndata: {"type":"complete","result":{}}',bytes=new TextEncoder().encode(text);
  const events=[];for await(const e of parseEvents(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}})))events.push(e);
  assert.equal(events[0].content,'✦');assert.equal(events[1].type,'complete');
});
test('configurable LAN endpoint is used consistently and rejects unsafe URL shapes',()=>{
  assert.equal(providerUrlAndHeaders('lmstudio',{lmstudio_base_url:'http://192.168.1.178:1234/v1/'},'m').url,'http://192.168.1.178:1234/v1/chat/completions');
  assert.throws(()=>localBaseUrl({lmstudio_base_url:'file:///tmp'}));assert.throws(()=>localBaseUrl({lmstudio_base_url:'http://user:password@localhost/v1'}));
});
test('HTTP media supports range playback and MP4 downloads; all pages share one server',async()=>{
  const {clip,sessionId}=await makeClip(STORE);
  const url=`${base}/h3studio/media/${clip.id}/content?session_id=${sessionId}`;
  const partial=await fetch(url,{headers:{Range:'bytes=0-99'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,100);
  const download=await fetch(url+'&download=1');assert.match(download.headers.get('content-disposition'),/attachment/);assert.match(download.headers.get('content-type'),/video\/mp4/);await download.arrayBuffer();
  const html=await (await fetch(base)).text();assert.match(html,/Video → Prompt/);assert.match(html,/Krea 2/);assert.doesNotMatch(html,/onclick=/);
  const response=await fetch(`${base}/h3studio/clips/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId,source_id:clip.source_id,start:0,end:1})});
  const events=[];for await(const e of parseEvents(response.body))events.push(e);assert.equal(events.at(-1).type,'error');assert.equal(JOB.phase,'idle');
});

async function storyboardFixture(store=new MediaStore()) {
  const sessionId=randomUUID(),dir=join(CACHE_ROOT,sessionId,randomUUID());await fs.mkdir(dir,{recursive:true});
  const blue=await sharp({create:{width:100,height:100,channels:3,background:'blue'}}).png().toBuffer();
  await sharp({create:{width:200,height:100,channels:3,background:'red'}}).composite([{input:blue,left:100,top:0}]).png().toFile(join(dir,'sheet.png'));
  const sheet=await store.add(sessionId,'Storyboard','character_sheet.png','image/png',join(dir,'sheet.png'));
  const panel=await cropStoryboardImage({sessionId,assetId:sheet.id,rect:{x:.5,y:0,width:.5,height:1},store});
  const plan=storyPlan();plan.images=[{asset_id:sheet.id,kind:'character_sheet',description:'Two views of Sara.'},{asset_id:panel.id,kind:'storyboard_panel',description:'Framing for the letter scene.'}];
  plan.clips.forEach(c=>c.references=[{asset_id:sheet.id,role:'character',character_id:'sara',notes:'Appearance only.'},{asset_id:panel.id,role:'composition',character_id:'',notes:'Camera framing only.'}]);
  return {sessionId,store,sheet,panel,plan};
}
const storyboardModel=async({payload})=>({choices:[{message:{content:storyboardReply(payload)},finish_reason:'stop'}]});
test('storyboard crops are exact separate files and survive project restore with their reference mapping',async()=>{
  const {sessionId,store,sheet,panel,plan}=await storyboardFixture();
  const source=store.get(sessionId,sheet.id),cropped=store.get(sessionId,panel.id);
  assert.equal((await sharp(source._original_path).metadata()).width,200);
  const pixel=await sharp(cropped._original_path).raw().toBuffer({resolveWithObject:true});assert.equal(pixel.info.width,100);assert.equal(pixel.info.height,100);assert.equal(pixel.data[2],255);assert.equal(pixel.data[0],0);
  await assert.rejects(cropStoryboardImage({sessionId,assetId:sheet.id,rect:{x:.9,y:0,width:.5,height:1},store}),/entirely within/);
  await assert.rejects(cropStoryboardImage({sessionId,assetId:sheet.id,rect:{x:0,y:0,width:.01,height:.01},store}),/16/);
  const projects=new ProjectStore(join(root,'storyboards'));
  const saved=await projects.save({name:'Connected scene',state:{storyboard:{plan,approval:null}},sessionId,store});
  const restored=await projects.open(saved.id,new MediaStore());assert.deepEqual(restored.state.storyboard.plan,plan);
  assert.deepEqual(restored.assets.find(a=>a.id===panel.id).crop,panel.crop);
  assert.equal(reviewKey(plan,restored.assets),reviewKey(plan,store.list(sessionId)));
  assert.deepEqual(clipReferences(plan,plan.clips[1],restored.assets).map(r=>r.label),['<Picture 1>','<Picture 2>']);
});
test('human approval is bound to session, complete plan and media and cannot be supplied by model JSON',async()=>{
  const {sessionId,store,plan}=await storyboardFixture();const approvals=new StoryboardApprovals(),assets=store.list(sessionId);
  assert.throws(()=>approvals.require(sessionId,plan,assets,'fake'),/Human Control/);
  assert.throws(()=>approvals.approve(sessionId,plan,assets,false),/Confirm/);
  const receipt=approvals.approve(sessionId,plan,assets,true);
  assert.deepEqual(approvals.require(sessionId,plan,assets,receipt.token),normalizePlan(plan));
  assert.throws(()=>approvals.require(randomUUID(),plan,assets,receipt.token),/Human Control/);
  for(const mutate of [p=>p.story+=' New ending.',p=>p.clips.reverse(),p=>p.clips[0].camera='Reverse angle',p=>p.images[0].kind='storyboard_sheet',p=>p.clips[0].references[0].notes='Use background too',p=>p.characters[0].description='Red coat']) {
    const changed=structuredClone(plan);mutate(changed);assert.throws(()=>approvals.require(sessionId,changed,assets,receipt.token),/changed/);
  }
  assert.throws(()=>approvals.require(sessionId,plan,assets.slice(1),receipt.token),/changed/);
  approvals.revoke(sessionId);assert.throws(()=>approvals.require(sessionId,plan,assets,receipt.token),/Human Control/);
  const modelPlan=await developStoryboard({...modelBody,idea:'A woman lifts a letter.',clip_count:2},{...ctx(),chatCompletion:async()=>({choices:[{message:{content:JSON.stringify({...storyPlan(),approval:{token:'fake'},images:plan.images,clips:plan.clips})},finish_reason:'stop'}]})});
  assert.equal(modelPlan.plan.approval,undefined);assert.deepEqual(modelPlan.plan.images,[]);assert.ok(modelPlan.plan.clips.every(c=>c.references.length===0));
});
test('storyboard roles support sheets or panels and endpoint modes reject accidental collages',async()=>{
  const {store,sessionId,plan,panel}=await storyboardFixture(),assets=store.list(sessionId);
  for(const role of ['character','composition']) {const only=structuredClone(plan);only.clips.forEach(c=>c.references=c.references.filter(r=>r.role===role));validateReferences(normalizePlan(only),assets);}
  const frames=structuredClone(plan);frames.clips.forEach(c=>{c.mode='I2VA';c.references=[{asset_id:panel.id,role:'first_frame',character_id:'',notes:''}];});validateReferences(normalizePlan(frames),assets);
  frames.images[1].kind='storyboard_sheet';assert.throws(()=>validateReferences(normalizePlan(frames),assets),/cannot be endpoint/);
  const bad=structuredClone(plan);bad.clips[0].references[0].character_id='missing';assert.throws(()=>validateReferences(normalizePlan(bad),assets),/Character references/);
  const full=structuredClone(plan);full.images[1].kind='storyboard_sheet';full.clips.forEach(c=>c.references[1].notes='');assert.throws(()=>validateReferences(normalizePlan(full),assets),/identify the panel/);
});
test('coordinated prompts remap images per clip and contain only approved roles plus neighboring states',async()=>{
  const {store,sessionId,plan,sheet,panel}=await storyboardFixture();
  plan.clips[1].references.reverse();
  const {assembled,references}=storyboardAssembly({...modelBody,session_id:sessionId},plan,plan.clips[1],store);
  assert.deepEqual(references.map(r=>[r.asset_id,r.label]),[[panel.id,'<Picture 1>'],[sheet.id,'<Picture 2>']]);
  const content=assembled.messages.find(m=>m.role==='user').content;
  assert.match(content,/Multiple views depict this ONE subject/);assert.match(content,/previous_clip_end/);assert.match(content,/Letter held in her right hand/);assert.match(content,/Never render the storyboard grid/);
  assert.deepEqual(assembled.media_inputs.map(i=>i.asset_id),[panel.id,sheet.id]);
  const seen=[];const result=await generateStoryboardClips({...modelBody,session_id:sessionId},plan,store,{...ctx(),chatCompletion:async args=>{seen.push(args);return storyboardModel(args);}});
  assert.equal(Object.keys(result.results).length,2);assert.ok(seen.every(r=>r.url.startsWith('http://127.0.0.1:1234/')));
  assert.ok(seen.every(r=>r.payload.messages[1].content.filter(p=>p.type==='image_url').length===2));
  assert.equal(result.results.clip1.prompt_audit.repair_required,false);
  assert.equal(result.results.clip1.debug_input_sequence,undefined);
  const secondSpeaker=structuredClone(plan);secondSpeaker.characters.push({id:'alex',name:'Alex',description:'A man in a gray shirt.'});
  secondSpeaker.clips[1].character_ids=['alex'];secondSpeaker.clips[1].references.find(r=>r.role==='character').character_id='alex';
  const speakerContent=storyboardAssembly({...modelBody,session_id:sessionId},secondSpeaker,secondSpeaker.clips[1],store).assembled.messages.find(m=>m.role==='user').content;
  const clipContract=JSON.parse(speakerContent.split('Approved plan for this clip:\n')[1]);
  assert.deepEqual(clipContract.characters.map(c=>[c.id,c.speaker_id]),[['alex','S2']]);
});
test('story and image model failures or cancellation preserve input state without cloud fallback',async()=>{
  const plan=storyPlan(),original=structuredClone(plan);let calls=0;
  const images=await storyboardImages({...modelBody,plan},{...ctx(),chatCompletion:storyboardModel});
  assert.equal(images.prompts.length,2);assert.match(images.sheet,/exactly 2 panels/);assert.match(images.prompts[0].prompt,/navy coat/);
  await assert.rejects(storyboardImages({...modelBody,plan},{...ctx(),chatCompletion:async()=>{calls++;throw new Error('local model offline');}}),/offline/);assert.equal(calls,1);assert.deepEqual(plan,original);
  const controller=new AbortController();controller.abort();await assert.rejects(storyboardImages({...modelBody,plan},{...ctx(),signal:controller.signal,chatCompletion:storyboardModel}));
  await assert.rejects(developStoryboard({...modelBody,idea:'The letter.',clip_count:2},{...ctx(),chatCompletion:async()=>({choices:[{message:{content:'not JSON'},finish_reason:'stop'}]})}),/invalid storyboard JSON/);
  for(const content of ['null','{"clips":[null]}']) await assert.rejects(developStoryboard({...modelBody,idea:'The letter.',clip_count:2},{...ctx(),chatCompletion:async()=>({choices:[{message:{content},finish_reason:'stop'}]})}),/invalid storyboard plan/);
  for(const id of ['__proto__','constructor','toString']) {const unsafe=structuredClone(plan);unsafe.clips[0].id=id;assert.throws(()=>normalizePlan(unsafe),/Invalid storyboard identifier/);}
});
test('HTTP storyboard generation rejects unapproved, changed and revoked plans',async()=>{
  const {sessionId,plan}=await storyboardFixture(STORE);
  const post=async(path,body)=>fetch(base+'/h3studio/storyboard/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId,...body})});
  assert.equal((await post('generate',{...modelBody,plan,approval_token:'forged'})).status,409);
  assert.equal((await post('approve',{plan,reviewed:false})).status,409);
  const approved=await (await post('approve',{plan,reviewed:true})).json();assert.ok(approved.approval.token);
  const changed=structuredClone(plan);changed.clips[0].end_state='The letter is in the left hand.';
  assert.equal((await post('generate',{...modelBody,plan:changed,approval_token:approved.approval.token})).status,409);
  await post('revoke',{});assert.equal((await post('generate',{...modelBody,plan,approval_token:approved.approval.token})).status,409);
});
