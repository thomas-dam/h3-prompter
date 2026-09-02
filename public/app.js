import { createStoryboard } from './storyboard.js';
import { parseEvents, clipMatchesRange, promptIsCurrent, newSessionId, copyTextField } from './workflow.js';
const $ = (id) => document.getElementById(id);
const api = '/h3studio';
const state = { page:'h3', mode:'T2VA', intent:'explore', session:newSessionId(), assets:[], roles:{}, outputs:{}, revisions:{}, project:null, busy:false, dirty:false, settings:{} };
const fieldDefaults = Object.fromEntries([...document.querySelectorAll('[data-field]')].map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]));
let toastTimer;
let storyboard;
let localModelStatus=null;
function toast(message, error=false) { $('toast').textContent=message; $('toast').className=`toast show${error?' error':''}`; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4000); }
function status(message,error=false) { for(const id of ['status','sbStatus']) { const target=$(id);if(target){target.textContent=message;target.className=`status${error?' error':''}`;} } }
function changed() { state.dirty=true; updateButtons(); }
async function request(path, options={}) {
  const response=await fetch(path,{...options,headers:options.body instanceof FormData?undefined:{'Content-Type':'application/json',...options.headers}});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  return result;
}
function post(path,body) { return request(path,{method:'POST',body:JSON.stringify(body)}); }
function guarded(action) { return async(...args)=>{try { await action(...args); } catch(error) { status(error.message,true); toast(error.message,true); }}; }
const source=()=>state.assets.find(a=>a.mode==='VideoSource');
const clip=()=>state.assets.find(a=>a.mode==='Video'&&a.type==='video');
const rangeMatches=()=>clipMatchesRange(clip(),source(),Number($('trimStart').value),Number($('trimEnd').value));
const activeOutput=()=>state.outputs[state.page] || {prompt:''};
function videoSignature() { return JSON.stringify({clip_id:clip()?.id,analysis_id:clip()?.analysis?.id,text:$('analysisText').value,roles:state.roles,images:state.assets.filter(a=>a.mode==='Video'&&a.type==='image').map(a=>a.id),brief:$('videoBrief').value,audio:$('useAudio').checked,aspect:$('videoAspect').value}); }
function currentOutput() { return state.page!=='video'||promptIsCurrent(activeOutput(),clip(),rangeMatches(),videoSignature()); }
function updateButtons() {
  const video=state.page==='video', prompt=!!$('output').value.trim(), current=currentOutput();
  $('copyPrompt').disabled=state.busy||!prompt||!current;
  $('downloadPrompt').disabled=state.busy||!prompt||!current;
  $('refine').disabled=state.busy||!prompt||!current;
  $('downloadClip').hidden=!video; $('downloadAnalysis').hidden=!video;
  $('downloadClip').disabled=state.busy||!clip()||!rangeMatches();
  $('downloadAnalysis').disabled=state.busy||!clip()?.analysis||!rangeMatches();
  $('analyzeClip').disabled=state.busy||!clip()||!rangeMatches();
  $('generate').disabled=state.busy||(video&&(!clip()?.analysis||!rangeMatches()));
  $('cancel').hidden=!state.busy;
  for(const id of ['prepareClip','setStart','setEnd','saveProject','openProject','newProject','deleteProject','resetFields','saveSettings','restoreRevision']) $(id).disabled=state.busy;
  for(const el of document.querySelectorAll('#inputCard input,#inputCard textarea,#inputCard select,#inputCard .mode-tab,#inputCard .chip,.nav-links a')) {
    if(el.tagName==='A') el.setAttribute('aria-disabled',String(state.busy)); else el.disabled=state.busy;
  }
  for(const el of document.querySelectorAll('.media-list button,.media-list select')) el.disabled=state.busy;
  $('useAudio').disabled=state.busy||!clip()?.has_audio;
  $('output').readOnly=state.busy;
  storyboard?.update();
  if(video&&prompt&&!current) $('audit').textContent='Outdated prompt: the clip, analysis, or reference choices changed. Regenerate before copying or exporting.';
}
async function stream(path,body) {
  if(state.busy) throw new Error('Wait for the current operation.');
  state.busy=true; updateButtons(); status('Starting…');
  let draft='', result=null, completed=false;
  try {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok) { const e=await response.json(); throw new Error(e.error?.message||`HTTP ${response.status}`); }
    for await(const event of parseEvents(response.body)) {
      if(event.type==='phase') status(event.detail||event.phase);
      if(event.type==='delta') { draft+=event.content; $('output').value=draft; }
      if(event.type==='error') throw new Error(event.error.message);
      if(event.type==='cancelled') throw new Error('Cancelled. The previous result is unchanged.');
      if(event.type==='complete') { result=event.result; completed=true; }
    }
    if(!completed) throw new Error('Connection ended before the operation completed. Previous result retained.');
    return result;
  } finally { state.busy=false; $('output').value=activeOutput().prompt||''; updateButtons(); }
}
function remember(prompt, extra={}) {
  if(!prompt?.trim()) throw new Error('No prompt was returned.');
  state.outputs[state.page]={prompt,...extra};
  const revisions=state.revisions[state.page] ||= [];
  revisions.unshift({prompt,created_at:new Date().toISOString(),...extra});
  if(revisions.length>30) revisions.length=30;
  $('output').value=prompt; changed(); renderRevisions();
  $('audit').textContent=extra.prompt_audit?.official_format_pass == null ? '' : (extra.prompt_audit.repair_required?'Format needs review. Inspect the prompt before using it.':'Prompt format checked.');
}
function renderRevisions() {
  $('revisions').replaceChildren(new Option('Choose a revision…',''));
  (state.revisions[state.page]||[]).forEach((r,i)=>$('revisions').add(new Option(`${new Date(r.created_at).toLocaleString()} · ${r.prompt.slice(0,40)}`,String(i))));
}
function modelBody() {
  const provider=$('provider').value;
  return {session_id:state.session,provider,model_id:$('modelId').value.trim(),context_profile:$('context').value,kv_cache:$('kvCache').value,thinking:$('thinking').checked,...($('seed').value?{seed:Number($('seed').value)}:{})};
}
function h3Body() {
  const brief=[$('brief').value.trim(),$('style').value?`Visual style: ${$('style').value}`:'',$('referenceNotes').value.trim()].filter(Boolean).join('\n\n');
  if(!$('brief').value.trim()) throw new Error('Describe your video first.');
  if(brief.length>2000) throw new Error('Description, visual style and reference roles must total at most 2,000 characters.');
  return {...modelBody(),mode:state.mode,creative_brief:brief,aspect_ratio:$('aspect').value,duration_seconds:Number($('duration').value),...(state.mode==='Reference'?{description:$('brief').value.trim(),visual_style:$('style').value,reference_description:$('referenceNotes').value.trim()}:{}),...($('systemPrompt').value.trim()?{system_prompt_override:$('systemPrompt').value}: {})};
}
function videoBody() { return {...modelBody(),clip_id:clip()?.id,analysis_id:clip()?.analysis?.id,analysis_text:$('analysisText').value,creative_brief:$('videoBrief').value,aspect_ratio:$('videoAspect').value,use_audio:$('useAudio').checked,image_roles:state.roles}; }
function kreaBody() { return {...modelBody(),intent:state.intent,...Object.fromEntries(['idea','medium','composition','light','palette','mustKeep'].map(id=>[id,$(id).value]))}; }
async function generate(refine=false) {
  let body,path;
  if(state.page==='h3') { body=h3Body(); path=refine?`${api}/refine`:`${api}/generate`; }
  else if(state.page==='video') { if(!rangeMatches()) throw new Error('Prepare and analyze the selected clip first.'); body=videoBody(); path=`${api}/video/generate`; }
  else { body=kreaBody(); path=refine?'/kreastudio/refine':'/kreastudio/generate'; }
  if(refine) { if(!$('instruction').value.trim()) throw new Error('Write a revision instruction first.'); body={...body,current_prompt:$('output').value,instruction:$('instruction').value}; }
  const result=await stream(path,body);
  remember(result.prompt,{...result,...(state.page==='video'?{signature:videoSignature()}: {})});
  status('Prompt ready. Review it, then copy or download.');
}
async function refreshMedia() { state.assets=(await request(`${api}/media?session_id=${state.session}`)).assets; renderMedia(); }
function mediaList(id,assets,{roles=false,reorder=false}={}) {
  const host=$(id); host.replaceChildren();
  assets.forEach((a,index)=>{
    const item=document.createElement('div'); item.className='media-item';
    if(a.preview_url) { const img=document.createElement('img'); img.src=a.preview_url; img.alt=a.filename; item.append(img); }
    const meta=document.createElement('div'); meta.className='media-meta'; meta.textContent=`${a.reference||''} · ${a.filename}`;
    if(a.type==='video'||a.type==='audio') { const player=document.createElement(a.type); player.controls=true; player.preload='metadata'; player.src=a.content_url; meta.append(player); }
    if(roles) { const select=document.createElement('select'); select.setAttribute('aria-label',`Role for ${a.filename}`); for(const role of ['subject appearance','setting','visual style']) select.add(new Option(role,role)); select.value=state.roles[a.id]||'subject appearance'; select.disabled=state.busy; select.onchange=()=>{state.roles[a.id]=select.value;changed();}; meta.append(select); }
    const remove=document.createElement('button'); remove.className='button secondary small'; remove.textContent='×'; remove.setAttribute('aria-label',`Remove ${a.filename}`); remove.disabled=state.busy;
    remove.onclick=guarded(async()=>{await request(`${api}/media/${a.id}?session_id=${state.session}`,{method:'DELETE'}); delete state.roles[a.id]; await refreshMedia();changed();});
    item.append(meta,remove);
    if(reorder&&index>0) { const up=document.createElement('button'); up.textContent='↑';up.className='button secondary small';up.setAttribute('aria-label',`Move ${a.filename} earlier`);up.disabled=state.busy;up.onclick=guarded(async()=>{const ids=assets.map(x=>x.id);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];await post(`${api}/media/reorder`,{session_id:state.session,mode:state.mode,asset_ids:ids});await refreshMedia();changed();});item.append(up); }
    host.append(item);
  });
}
function setVideo(player,url) { if(player.getAttribute('src')!==url) { if(url) player.src=url;else {player.removeAttribute('src');player.load();} } player.hidden=!url; }
function renderMedia() {
  mediaList('h3Media',state.assets.filter(a=>a.mode===state.mode),{reorder:true});
  mediaList('videoMedia',state.assets.filter(a=>a.mode==='Video'&&a.type==='image'),{roles:true});
  mediaList('kreaMedia',state.assets.filter(a=>a.mode==='Krea'));
  const s=source(), c=clip(); setVideo($('sourcePlayer'),s?.content_url||'');setVideo($('clipPlayer'),rangeMatches()?c?.content_url||'':'');
  $('clipPlayer').poster=rangeMatches()?c?.preview_url||'':'';
  $('sourceInfo').textContent=s?`${s.filename} · ${s.duration}s · ${s.width} × ${s.height}`:'';
  $('trimControls').hidden=!s;
  $('clipInfo').textContent=c?(rangeMatches()?`Prepared: ${c.duration}s · ${c.width} × ${c.height} · ${c.has_audio?'audio retained':'no audio track'}`:'Selection changed. Prepare a new clip and analyze it before using the old prompt.'):'The original file is never modified.';
  $('useAudio').disabled=state.busy||!c?.has_audio;
  $('analysisFrames').replaceChildren();
  if(c&&rangeMatches()) for(const frame of c.frames.filter((_,i)=>i%Math.max(1,Math.floor(c.frames.length/8))===0).slice(0,8)) {
    const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption'); img.src=frame.url;img.alt=`Clip at ${frame.timestamp}s`;caption.textContent=`${frame.timestamp.toFixed(2)}s`;figure.append(img,caption);$('analysisFrames').append(figure);
  }
  storyboard?.syncAssets();
  updateButtons();
}
async function upload(input,files) {
  if(!files.length||state.busy) return;
  const mode={h3Files:state.mode,videoFiles:'Video',kreaFiles:'Krea',sourceFile:'VideoSource'}[input];
  // Validate a replacement source in a temporary session before discarding the current one.
  const replacing=input==='sourceFile', targetSession=replacing?newSessionId():state.session;
  const form=new FormData();form.append('session_id',targetSession);form.append('mode',mode);
  for(const file of (replacing?[files[0]]:[...files])) form.append('file',file);
  state.busy=true;updateButtons();status('Uploading and preparing media…');
  try {
    const result=await request(`${api}/media/upload`,{method:'POST',body:form});
    if(replacing) {
      // Server adopts the validated source into this workspace, without touching the original disk file.
      const adopted=await post(`${api}/clips/source`,{session_id:state.session,upload_session_id:targetSession,asset_id:result.assets[0].id});
      const s=adopted.source; $('trimStart').value='0';$('trimEnd').value=String(Math.min(15,s.duration));$('analysisText').value='';$('useAudio').checked=false;
    }
    await refreshMedia();changed();status('Media ready.');
  } finally { state.busy=false;updateButtons(); }
}
function switchPage(page) {
  if(state.busy) return;
  state.page=['h3','video','krea','storyboard'].includes(page)?page:'h3';
  for(const p of ['h3','video','krea']) $(`${p}Pane`).hidden=state.page!==p;
  document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===state.page));
  $('storyboardPane').hidden=state.page!=='storyboard';$('legacyWorkspace').hidden=state.page==='storyboard';
  const copy={storyboard:['Plan a story. Connect every clip.','Story · References · Human Control','Develop the story, create storyboard image prompts, review your visual references, then write coordinated H3 clip prompts.','Generate H3 Prompt ✦'],h3:['Write structured MiniMax H3 prompts','All 5 H3 modes · Local or cloud models','Describe your scene and shape a prompt with clear timing and reference roles. Ready to copy into your generation workflow.','Generate H3 Prompt ✦'],video:['Turn a clip into an H3 prompt','Analyze · Trim · Adapt · Export','See what happens in your clip, shape the result, and take the video and prompt into your own H3 or ComfyUI workflow.','Generate clip prompt ✦'],krea:['Write structured Krea 2 prompts','Image prompts · Style references','Choose a direction, describe your image, and generate a clean prompt. Optional reference images guide its visual style.','Shape my Krea 2 prompt ↗']}[state.page];
  ['title','eyebrow','lead','generate'].forEach((id,i)=>$(id).textContent=copy[i]);
  $('output').value=activeOutput().prompt||'';$('audit').textContent='';$('examples').hidden=state.page!=='krea';
  $('exportHint').textContent=state.page==='video'?'Load the downloaded MP4 into your ComfyUI video input and paste this prompt into its text input. Load replacement images in Picture order. No automatic sending.':'Copy the prompt into your generation tool. No automatic sending.';
  $('instruction').value='';renderRevisions();renderMode();renderMedia();status('Ready.');
}
function renderMode() {
  document.querySelectorAll('#h3Modes button').forEach(el=>el.classList.toggle('active',el.dataset.mode===state.mode));
  document.querySelectorAll('#kreaModes button').forEach(el=>el.classList.toggle('active',el.dataset.intent===state.intent));
  $('modeHint').textContent={T2VA:'Build a complete audiovisual timeline from text only.',I2VA:'One first-frame image. Develop the scene forward.',FL2VA:'Two images in order: first frame, then final frame.',L2VA:'One last-frame image. Build a path that reaches it.',Reference:'Up to 9 images, 3 videos, 3 audio files; at most 12 assets. Video/audio references: 2–15 seconds.'}[state.mode];
  $('h3References').hidden=state.mode==='T2VA';$('h3Files').accept=state.mode==='Reference'?'image/*,video/*,audio/*':'image/*';
}
function syncModelSelection() {
  const value=$('modelId').value.trim();
  $('modelList').value=[...$('modelList').options].some(option=>option.value===value)?value:'';
}
function renderModelList() {
  const local=$('provider').value==='lmstudio';
  $('localModelPicker').hidden=!local;
  const models=local?(localModelStatus?.models||[]):[];
  const placeholder=models.length?'Choose a model…':localModelStatus?.connected?'No models reported by LM Studio':'Model list unavailable';
  $('modelList').replaceChildren(new Option(placeholder,''));
  for(const model of models) $('modelList').add(new Option(model,model));
  $('modelList').disabled=!local||!models.length;
  $('modelListHint').textContent=models.length?`${models.length} models reported by LM Studio. You can also enter an ID below.`:localModelStatus?.connected?'LM Studio returned an empty list. Make a model available in LM Studio, then refresh.':'Check the saved server address and refresh. You can still enter a model ID manually.';
  syncModelSelection();
}
async function refreshProvider() {
  const data=await request(`${api}/provider-status`), p=data.providers[$('provider').value];
  $('providerStatus').textContent=p.message;$('providerStatus').className=`status${p.ready?'':' error'}`;
  localModelStatus=data.providers.lmstudio;renderModelList();
}
function showProvider() {
  const p=$('provider').value,s=state.settings;
  $('localSettings').hidden=p!=='lmstudio';$('cloudSettings').hidden=p!=='openrouter';
  $('modelId').value=s[`${p}_model_id`]||'';$('context').value=s[`${p}_context_profile`]||'auto';$('kvCache').value=s[`${p}_kv_cache`]||'auto';$('thinking').checked=!!s[`${p}_thinking`];
  renderModelList();
  $('privacyNote').textContent=p==='openrouter'?'Cloud selected: generation sends your text and prepared visual inputs to OpenRouter. There is no automatic fallback.':'Local/LAN selected: model requests go only to your configured LM Studio server.';
}
async function saveSettings() {
  const p=$('provider').value, settings={provider:p,lmstudio_base_url:$('baseUrl').value.trim(),[`${p}_model_id`]:$('modelId').value.trim(),[`${p}_context_profile`]:$('context').value,[`${p}_kv_cache`]:$('kvCache').value,[`${p}_thinking`]:$('thinking').checked};
  state.settings=(await request(`${api}/settings`,{method:'PUT',body:JSON.stringify(settings)})).settings;
  if($('apiKey').value.trim()) {await post(`${api}/settings/openrouter-key`,{key:$('apiKey').value.trim()});$('apiKey').value='';}
  await refreshProvider();toast('Model settings saved.');
}
function snapshot() { return {page:state.page,mode:state.mode,intent:state.intent,roles:state.roles,outputs:state.outputs,revisions:state.revisions,storyboard:storyboard.snapshot(),fields:Object.fromEntries([...document.querySelectorAll('[data-field]')].map(el=>[el.id,el.type==='checkbox'?el.checked:el.value]))}; }
async function refreshProjects() { const list=(await request(`${api}/projects`)).projects;$('projectList').replaceChildren(new Option('Choose a project…',''));for(const p of list)$('projectList').add(new Option(p.name,p.id));if(state.project)$('projectList').value=state.project.id; }
function downloadText(name,text,type='text/plain') { const url=URL.createObjectURL(new Blob([text],{type:`${type};charset=utf-8`}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function exportStem() { return (clip()?.filename.replace(/\.mp4$/i,'')||$('projectName').value||'prompt').replace(/[^\p{L}\p{N}_.-]+/gu,'_'); }

$('generate').onclick=guarded(()=>generate());$('refine').onclick=guarded(()=>generate(true));
$('cancel').onclick=guarded(async()=>{status('Cancelling…');await post(`${api}/cancel`,{});});
$('output').addEventListener('input',()=>{state.outputs[state.page]={...activeOutput(),prompt:$('output').value};changed();});
for(const el of document.querySelectorAll('[data-field]')) el.addEventListener('input',()=>{if(['trimStart','trimEnd'].includes(el.id)){renderMedia();}changed();});
$('prepareClip').onclick=guarded(async()=>{const result=await stream(`${api}/clips/prepare`,{session_id:state.session,source_id:source()?.id,start:Number($('trimStart').value),end:Number($('trimEnd').value)});$('analysisText').value='';$('useAudio').checked=false;await refreshMedia();$('videoAspect').value=[...$('videoAspect').options].map(o=>o.value).sort((a,b)=>{const ratio=x=>{const [w,h]=x.split(':').map(Number);return Math.abs(w/h-result.width/result.height);};return ratio(a)-ratio(b);})[0];changed();status('Clip prepared. Analyze it or download it now.');});
$('analyzeClip').onclick=guarded(async()=>{const result=await stream(`${api}/clips/analyze`,{...modelBody(),clip_id:clip()?.id});$('analysisText').value=result.analysis.text;$('analysisPanel').open=true;await refreshMedia();changed();status('Analysis ready. Review the description before generating.');});
for(const [id,field] of [['setStart','trimStart'],['setEnd','trimEnd']]) $(id).onclick=()=>{$(field).value=$('sourcePlayer').currentTime.toFixed(2);renderMedia();changed();};
for(const input of ['h3Files','sourceFile','videoFiles','kreaFiles']) $(input).onchange=guarded(async()=>{try{await upload(input,$(input).files);}finally{$(input).value='';}});
for(const zone of document.querySelectorAll('[data-drop]')) { const input=zone.dataset.drop;zone.tabIndex=0;zone.setAttribute('role','button');zone.setAttribute('aria-label',zone.textContent.trim());zone.onclick=(event)=>{if(event.target!==$(input)&&!state.busy)$(input).click();};zone.onkeydown=(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!state.busy)$(input).click();}};zone.ondragover=e=>e.preventDefault();zone.ondrop=guarded(async(e)=>{e.preventDefault();await upload(input,e.dataTransfer.files);}); }
for(const el of document.querySelectorAll('#h3Modes button')) el.onclick=()=>{state.mode=el.dataset.mode;renderMode();renderMedia();changed();};
for(const el of document.querySelectorAll('#kreaModes button')) el.onclick=()=>{state.intent=el.dataset.intent;renderMode();changed();};
document.querySelectorAll('[data-page]').forEach(el=>el.onclick=(e)=>{if(state.busy)e.preventDefault();else switchPage(el.dataset.page);});
window.addEventListener('hashchange',()=>switchPage(location.hash.slice(1)));
$('saveSettings').onclick=guarded(saveSettings);$('refreshProvider').onclick=guarded(refreshProvider);$('provider').onchange=guarded(async()=>{showProvider();await refreshProvider();});
$('modelList').onchange=()=>{if($('modelList').value)$('modelId').value=$('modelList').value;};
$('modelId').addEventListener('input',syncModelSelection);
$('deleteKey').onclick=guarded(async()=>{if(confirm('Remove the saved OpenRouter key from Keychain?')){await request(`${api}/settings/openrouter-key`,{method:'DELETE'});await refreshProvider();}});
$('copyPrompt').onclick=guarded(async()=>{if(!currentOutput())throw new Error('Regenerate the outdated prompt first.');const copied=await copyTextField($('output'));toast(copied?'Prompt copied.':'Prompt selected. Press ⌘C / Ctrl+C to copy, or download the prompt.');});
$('downloadPrompt').onclick=()=>{if(currentOutput())downloadText(`${state.page==='video'?exportStem():state.page}_prompt.txt`,$('output').value);};
$('downloadClip').onclick=()=>{if(rangeMatches()){const a=document.createElement('a');a.href=clip().content_url+'&download=1';a.download=clip().filename;a.click();}};
$('downloadAnalysis').onclick=()=>{if(rangeMatches())downloadText(`${exportStem()}_analysis.md`,`# ${clip().filename}\n\nDuration: ${clip().duration}s. Source selection: ${clip().range_start}–${clip().range_end}s.\n\n${$('analysisText').value}\n\n## H3 prompt\n\n${currentOutput()?$('output').value:'Prompt outdated; regenerate before use.'}`,'text/markdown');};
$('saveProject').onclick=guarded(async()=>{const name=$('projectName').value.trim();if(!name){$('projectName').focus();throw new Error('Give this project a name first.');}state.busy=true;updateButtons();try{state.project=(await post(`${api}/projects`,{id:state.project?.id,name,session_id:state.session,state:snapshot()})).project;state.dirty=false;await refreshProjects();toast('Project and media saved on this Mac.');}finally{state.busy=false;updateButtons();}});
$('openProject').onclick=guarded(async()=>{const id=$('projectList').value;if(!id)throw new Error('Choose a saved project.');if(state.dirty&&!confirm('Discard unsaved changes and open this project?'))return;state.busy=true;updateButtons();try{const result=await post(`${api}/projects/${id}/open`,{});state.session=result.session_id;state.assets=result.assets;state.project=result.project;storyboard.restore(result.state.storyboard);for(const key of ['mode','intent','roles','outputs','revisions'])state[key]=result.state[key]??({roles:{},outputs:{},revisions:{},mode:'T2VA',intent:'explore'}[key]);for(const [id,value] of Object.entries({...fieldDefaults,...result.state.fields}))if($(id)?.hasAttribute('data-field')){$(id).type==='checkbox'?$(id).checked=!!value:$(id).value=value;}$('projectName').value=result.project.name;state.dirty=false;state.busy=false;location.hash=result.state.page||'h3';switchPage(result.state.page);toast('Project restored with its media.');}finally{state.busy=false;updateButtons();}});
$('newProject').onclick=()=>{if(state.dirty&&!confirm('Discard unsaved changes and start a new project?'))return;storyboard.reset();state.session=newSessionId();state.assets=[];state.roles={};state.outputs={};state.revisions={};state.project=null;state.dirty=false;$('projectName').value='';for(const [id,value] of Object.entries(fieldDefaults)){$(id).type==='checkbox'?$(id).checked=value:$(id).value=value;}switchPage(state.page);};
$('deleteProject').onclick=guarded(async()=>{const id=$('projectList').value;if(!id)throw new Error('Choose a saved project.');if(!confirm('Delete this saved project and its app-managed media copies? Original files are untouched.'))return;await request(`${api}/projects/${id}`,{method:'DELETE'});if(state.project?.id===id){state.project=null;state.dirty=true;}await refreshProjects();toast('Saved project deleted. Current open draft is retained.');});
$('restoreRevision').onclick=()=>{const i=$('revisions').value;if(i==='')return;const r=state.revisions[state.page]?.[Number(i)];if(r){state.outputs[state.page]={...r};$('output').value=r.prompt;changed();}};
$('resetFields').onclick=()=>{if(!confirm('Reset the fields on this page? Uploaded media and saved projects remain.'))return;for(const el of $(`${state.page}Pane`).querySelectorAll('[data-field]')){el.type==='checkbox'?el.checked=fieldDefaults[el.id]:el.value=fieldDefaults[el.id];}if(state.page==='video')renderMedia();changed();};
for(const group of document.querySelectorAll('.chips'))group.onclick=e=>{const chip=e.target.closest('.chip');if(chip){const el=$(group.dataset.target);el.value=[el.value,chip.textContent].filter(Boolean).join(', ');changed();}};
const presets={editorial:{idea:'A ceramicist alone in a vast workshop, surrounded by unfinished vessels and long worktables',medium:'quiet editorial photography with a tactile documentary quality',composition:'wide off-center frame with generous negative space',light:'late afternoon window light catching dust in the air',palette:'chalk, raw clay, faded workwear blue'},graphic:{idea:'A stream of night cyclists flowing through dense city streets',medium:'bold two-color screen-printed poster with imperfect ink registration',composition:'exaggerated diagonal movement, compressed perspective',light:'electric nocturnal energy',palette:'acid yellow and deep ultramarine on warm paper'},product:{idea:'A strange translucent fragrance bottle presented like a rare geological specimen',medium:'tactile product still life with restrained surrealism',composition:'low frontal view, single object, severe crop',light:'raking side light that reveals internal refraction',palette:'smoky quartz, pale amber, wet black stone'}};
for(const el of document.querySelectorAll('[data-preset]'))el.onclick=()=>{if(state.busy)return;for(const [id,value]of Object.entries(presets[el.dataset.preset]))$(id).value=value;changed();toast('Starting point loaded.');};
window.addEventListener('beforeunload',event=>{if(state.dirty||state.busy){event.preventDefault();event.returnValue='';}});
storyboard=createStoryboard({host:$('storyboardPane'),getState:()=>state,modelBody,request,post,stream,refreshMedia,setBusy:value=>{state.busy=value;updateButtons();},dirty:changed,status,toast,guarded,downloadText});
await guarded(async()=>{state.settings=(await request(`${api}/settings`)).settings;$('provider').value=state.settings.provider;$('baseUrl').value=state.settings.lmstudio_base_url;showProvider();switchPage(location.hash.slice(1));await Promise.all([refreshProvider(),refreshProjects()]);})();
