import { newSessionId, copyTextField } from './workflow.js';
import { emptyPlan, normalizePlan, validateReferences, reviewKey, imagePlanKey, continuityChecks, clipReferences, storyboardExport, IMAGE_KINDS, REF_ROLES, CLIP_MODES, CONNECTIONS, ASPECTS } from './storyboard-state.js';

const labels = { character_sheet:'Character sheet · multiple angles', character_view:'Character · single view', storyboard_sheet:'Storyboard · complete sheet', storyboard_panel:'Storyboard · single panel', character:'Character identity / clothing', composition:'Composition / pose', first_frame:'Exact first frame', last_frame:'Exact last frame', Reference:'Ref2VA · assigned references', I2VA:'I2VA · first frame', FL2VA:'FL2VA · first + last', L2VA:'L2VA · last frame', opening:'Opening', continuation:'Continue the action', angle_cut:'Cut to another angle', scene_change:'New scene / time' };
const el = (tag, text, className) => { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; };
const option = (value, label=labels[value]||value) => new Option(label,value);
const initial = () => ({ idea:'', plan:emptyPlan(), imageBundle:null, results:{}, histories:{}, approval:null });
export function createStoryboard({host, getState, modelBody, request, post, stream, refreshMedia, setBusy, dirty, status, toast, guarded, downloadText}) {
  let board=initial(), revokePromise=Promise.resolve(), cropAsset=null, selectedClip='', selectedImage='', cropRect={x:0,y:0,width:1,height:1};
  const $=id=>document.getElementById(id);
  const assets=()=>getState().assets.filter(a=>a.mode==='Storyboard');
  const key=()=>{try{return reviewKey(board.plan,assets());}catch{return '';}};
  const approved=()=>!!board.approval && board.approval.signature===key() && board.approval.expires_at>Date.now();
  const currentResult=()=>board.results[selectedClip];
  const resultCurrent=()=>approved() && !!currentResult()?.prompt && currentResult().signature===board.approval.fingerprint;
  const imageCurrent=()=>{try{return board.imageBundle?.signature===imagePlanKey(board.plan);}catch{return false;}};
  const validPlan=()=>{try{normalizePlan(board.plan);return true;}catch{return false;}};
  host.innerHTML=`
    <ol class="story-steps"><li>Story</li><li>Storyboard prompts</li><li>Generate / import images</li><li><strong>Human Control</strong></li><li>H3 clip prompts</li></ol>
    <div class="story-status"><p id="sbStatus" class="status" role="status" aria-live="polite">Ready.</p><button id="sbCancel" class="button secondary small" hidden>Cancel operation</button></div>
    <section class="card story-section"><h3>1 · Develop your story</h3><p class="note">Use the selected local LLM, or explicitly choose OpenRouter. No automatic cloud fallback. Nothing is sent to ComfyUI.</p>
      <label for="sbIdea">Idea or existing story</label><textarea id="sbIdea" maxlength="16000" placeholder="A woman finds an unopened letter in a quiet café. Plan a wide shot and two connected close-ups…"></textarea>
      <div class="field-row"><div><label for="sbCount">Draft clips</label><select id="sbCount"></select></div><div><label for="sbAspect">Frame shape</label><select id="sbAspect"></select></div></div>
      <div class="actions"><button id="sbDevelop" class="button primary small">Develop story & plan clips</button></div>
      <details id="sbStoryDetails"><summary>Review the story, characters and shared scene</summary>
        <label for="sbTitle">Story title</label><input id="sbTitle" maxlength="150"><label for="sbStory">Editable story</label><textarea id="sbStory" maxlength="16000"></textarea>
        <label for="sbScene">Shared setting, lighting, props and spatial layout</label><textarea id="sbScene" maxlength="5000" placeholder="Describe what stays consistent across the clips."></textarea>
        <div id="sbCharacters"></div><button id="sbAddCharacter" class="button secondary small">Add character</button>
      </details>
    </section>
    <div class="two-col story-columns">
      <section class="card story-section"><h3>2 · Plan the clips and angles</h3><p id="sbClipSummary" class="note"></p><div id="sbClips"></div><button id="sbAddClip" class="button secondary small">Add clip</button></section>
      <section class="card story-section"><h3>Storyboard image prompts</h3><p class="note">Review the story and clip cards first. These prompts describe still images. Generate images in your chosen tool, then import them below.</p>
        <button id="sbImageGenerate" class="button primary small">Use this story · write image prompts</button>
        <label for="sbImageChoice">Panel or complete sheet</label><select id="sbImageChoice"></select><label for="sbImagePrompt">Editable image prompt</label><textarea id="sbImagePrompt" class="output" spellcheck="false"></textarea>
        <p id="sbImageStatus" class="note"></p><div class="actions"><button id="sbCopyImage" class="button secondary small">Copy image prompt</button><button id="sbDownloadImage" class="button secondary small">Download image prompt</button><button id="sbDownloadImages" class="button secondary small">Download all image prompts</button></div>
      </section>
    </div>
    <section class="card story-section"><h3>3 · Import character sheets or storyboard images</h3><p class="note">Keep full sheets as references or select a panel crop. Character views represent one subject, not several people. Up to 64 library images, 9 references per Ref2VA clip.</p>
      <label for="sbImportKind">Type of images to import</label><select id="sbImportKind"></select><label for="sbFiles">Choose images</label><input id="sbFiles" type="file" accept="image/*" multiple>
      <div id="sbLibrary" class="story-library"></div>
    </section>
    <section class="card story-section human-control"><h3>4 · Human Control</h3><p class="note">You choose the images, clip order, crops, characters and reference roles. The model cannot approve them. Assign references to every clip, then review each connection.</p>
      <div id="sbAssignments"></div><div id="sbConnections"></div>
      <label class="check"><input id="sbReviewed" type="checkbox">I have reviewed the story, images, clip order, connections and reference assignments.</label>
      <div class="actions"><button id="sbApprove" class="button primary small">Approve this plan</button><button id="sbRevoke" class="button secondary small">Reopen review</button></div><p id="sbApprovalStatus" class="status" role="status"></p>
    </section>
    <section class="card story-section"><h3>5 · Coordinated H3 clip prompts</h3><p class="note">Generate after human approval. Each prompt has its own numbered reference mapping. Export prompts and images, then load them into your H3 workflow manually.</p>
      <div class="actions"><button id="sbGenerateAll" class="button primary small">Generate all clip prompts</button><button id="sbGenerateOne" class="button secondary small">Generate selected clip</button></div>
      <label for="sbResultChoice">Clip</label><select id="sbResultChoice"></select><label for="sbResult">Review and edit H3 prompt</label><textarea id="sbResult" class="output" spellcheck="false"></textarea>
      <p id="sbResultStatus" class="note"></p><div id="sbReferenceMap"></div>
      <div class="actions"><button id="sbCopyResult" class="button secondary small">Copy H3 prompt</button><button id="sbDownloadResult" class="button secondary small">Download H3 prompt</button><button id="sbDownloadAll" class="button secondary small">Download all prompts + reference map</button></div>
      <label for="sbHistory">Previous versions of this clip prompt</label><select id="sbHistory"></select><button id="sbRestore" class="button secondary small">Restore revision</button>
    </section>
    <dialog id="sbCropDialog" class="story-crop-dialog"><h3>Select a panel or character view</h3><p class="note">Drag over the image, enter percentages, or select a grid cell. A new PNG is created; the original stays unchanged.</p>
      <div id="sbCropCanvas" class="story-crop-canvas"><img id="sbCropImage" alt="Reference image to crop" draggable="false"><div id="sbCropOverlay"></div></div>
      <div class="story-crop-fields" id="sbCropFields"></div>
      <div class="field-row"><div><label for="sbCropColumns">Grid columns</label><input id="sbCropColumns" type="number" min="1" max="12" value="2"></div><div><label for="sbCropRows">Rows</label><input id="sbCropRows" type="number" min="1" max="12" value="2"></div><div><label for="sbCropCell">Cell (reading order)</label><input id="sbCropCell" type="number" min="1" value="1"></div></div>
      <div class="actions"><button id="sbCropGrid" class="button secondary small">Select grid cell</button><button id="sbCropSave" class="button primary small">Create panel crop</button><button id="sbCropClose" class="button secondary small">Close</button></div><p id="sbCropStatus" class="status" role="status"></p>
    </dialog>`;
  for(let n=1;n<=8;n++)$('sbCount').add(option(String(n)));$('sbCount').value='3';
  for(const aspect of ASPECTS)$('sbAspect').add(option(aspect));
  for(const kind of IMAGE_KINDS)$('sbImportKind').add(option(kind));$('sbImportKind').value='storyboard_panel';
  function invalidate() {
    if(board.approval) {
      const session=getState().session;board.approval=null;
      revokePromise=post('/h3studio/storyboard/revoke',{session_id:session}).catch(()=>{});
    }
    $('sbReviewed').checked=false;dirty();update();
  }
  function touch() { dirty();update(); }
  function field(parent,label,value,change,{multiline=false,type='text',max=2000}={}) {
    const input=el(multiline?'textarea':'input');input.id=`sb-field-${newSessionId()}`;if(!multiline)input.type=type;input.value=value;input.maxLength=max;
    const caption=el('label',label);caption.htmlFor=input.id;parent.append(caption,input);
    input.addEventListener('input',()=>{change(type==='number'?Number(input.value):input.value);invalidate();});return input;
  }
  function select(parent,label,values,value,change) {
    const input=el('select');input.id=`sb-select-${newSessionId()}`;
    for(const item of values)input.add(typeof item==='string'?option(item):option(item.value,item.label));input.value=value;
    const caption=el('label',label);caption.htmlFor=input.id;parent.append(caption,input);input.onchange=()=>{change(input.value);invalidate();};return input;
  }
  function button(parent,label,action) {const b=el('button',label,'button secondary small');b.type='button';b.onclick=guarded(action);parent.append(b);return b;}
  function saveRevision(clipId,result) {const history=board.histories[clipId]||=[];history.unshift(structuredClone(result));history.splice(30);}
  function renderCharacters() {
    $('sbCharacters').replaceChildren();
    for(const character of board.plan.characters) {
      const card=el('div',undefined,'story-subcard');
      field(card,'Character name',character.name,value=>{character.name=value;renderClips();renderAssignments();},{max:100});
      field(card,'Appearance and clothing',character.description,value=>character.description=value,{multiline:true});
      button(card,'Remove character',()=>{if(!confirm('Remove this character and their reference assignments?'))return;board.plan.characters=board.plan.characters.filter(c=>c.id!==character.id);for(const c of board.plan.clips){c.character_ids=c.character_ids.filter(id=>id!==character.id);c.references=c.references.filter(r=>r.character_id!==character.id);}invalidate();render();});
      $('sbCharacters').append(card);
    }
  }
  function repairOrder() {board.plan.clips.forEach((c,i)=>{if(!i)c.connection='opening';else if(c.connection==='opening'){c.connection='angle_cut';c.continuity='';}});}
  function renderClips() {
    $('sbClips').replaceChildren();
    board.plan.clips.forEach((clip,index)=>{
      const card=el('details',undefined,'story-clip');card.open=board.plan.clips.length<=3;
      const heading=el('summary',`${index+1} · ${clip.title||'Untitled clip'}`);card.append(heading);
      field(card,'Clip title',clip.title,value=>{clip.title=value;heading.textContent=`${index+1} · ${value}`;},{max:150});
      field(card,'Duration (2–15 seconds)',clip.duration,value=>clip.duration=value,{type:'number'});
      select(card,'H3 mode',CLIP_MODES,clip.mode,value=>{clip.mode=value;renderAssignments();});
      field(card,'Camera angle, framing and direction',clip.camera,value=>clip.camera=value,{multiline:true,max:1500});
      field(card,'Action during this clip',clip.action,value=>clip.action=value,{multiline:true});
      field(card,'Exact dialogue and speaker (optional)',clip.dialogue,value=>clip.dialogue=value,{multiline:true,max:3000});
      field(card,'Start state · pose, position, props',clip.start_state,value=>clip.start_state=value,{multiline:true,max:1500});
      field(card,'End state · handoff to next clip',clip.end_state,value=>clip.end_state=value,{multiline:true,max:1500});
      select(card,'Connection from previous clip',index?CONNECTIONS.filter(c=>c!=='opening'):['opening'],clip.connection,value=>clip.connection=value);
      field(card,'Connection / continuity notes',clip.continuity,value=>clip.continuity=value,{multiline:true});
      const chars=el('fieldset');chars.append(el('legend','Characters visible in this clip'));
      for(const character of board.plan.characters) {const label=el('label',undefined,'check'),check=el('input');check.type='checkbox';check.checked=clip.character_ids.includes(character.id);label.append(check,document.createTextNode(character.name));check.onchange=()=>{clip.character_ids=check.checked?[...clip.character_ids,character.id]:clip.character_ids.filter(id=>id!==character.id);clip.references=clip.references.filter(r=>!r.character_id||clip.character_ids.includes(r.character_id));invalidate();renderAssignments();};chars.append(label);}card.append(chars);
      const actions=el('div',undefined,'actions');
      if(index)button(actions,'Move earlier',()=>{[board.plan.clips[index-1],board.plan.clips[index]]=[clip,board.plan.clips[index-1]];repairOrder();invalidate();render();});
      if(index<board.plan.clips.length-1)button(actions,'Move later',()=>{[board.plan.clips[index+1],board.plan.clips[index]]=[clip,board.plan.clips[index+1]];repairOrder();invalidate();render();});
      button(actions,'Remove clip',()=>{if(!confirm('Remove this clip from the plan?'))return;board.plan.clips.splice(index,1);repairOrder();invalidate();render();});card.append(actions);$('sbClips').append(card);
    });
  }
  function renderLibrary() {
    $('sbLibrary').replaceChildren();
    for(const image of board.plan.images) {
      const asset=assets().find(a=>a.id===image.asset_id);if(!asset)continue;
      const card=el('div',undefined,'story-subcard');const preview=el('img');preview.src=asset.preview_url||asset.content_url;preview.alt=asset.filename;preview.className='story-reference-image';card.append(preview,el('p',asset.filename,'note'));
      select(card,'Image type',IMAGE_KINDS,image.kind,value=>{image.kind=value;renderAssignments();});
      field(card,'What is shown / view notes',image.description,value=>image.description=value,{multiline:true,max:1500});
      const actions=el('div',undefined,'actions');button(actions,'Select panel / crop',()=>openCrop(asset));
      const download=el('a','Download image','button secondary small');download.href=asset.content_url+'&download=1';download.download=asset.filename;actions.append(download);
      button(actions,'Remove image',async()=>{if(!confirm('Remove this library image and its assignments? Original files on disk are untouched.'))return;setBusy(true);try{await request(`/h3studio/media/${asset.id}?session_id=${getState().session}`,{method:'DELETE'});board.plan.images=board.plan.images.filter(i=>i.asset_id!==asset.id);for(const c of board.plan.clips)c.references=c.references.filter(r=>r.asset_id!==asset.id);invalidate();await refreshMedia();render();}finally{setBusy(false);}});card.append(actions);$('sbLibrary').append(card);
    }
  }
  function renderAssignments() {
    $('sbAssignments').replaceChildren();
    for(const [index,clip] of board.plan.clips.entries()) {
      const card=el('div',undefined,'story-subcard');card.append(el('h4',`${index+1} · ${clip.title}`),el('p',`${labels[clip.mode]} — assign only the images this clip uses.`,'note'));
      for(const ref of clip.references) {
        const row=el('div',undefined,'story-reference-row');
        select(row,'Reference image',[{value:'',label:'Choose image…'},...board.plan.images.map(i=>({value:i.asset_id,label:assets().find(a=>a.id===i.asset_id)?.filename||'Missing image'}))],ref.asset_id,value=>{ref.asset_id=value;});
        select(row,'Reference role',REF_ROLES,ref.role,value=>{ref.role=value;ref.character_id=value==='character'?(clip.character_ids[0]||''):'';renderAssignments();});
        if(ref.role==='character')select(row,'Character',[{value:'',label:'Choose character…'},...board.plan.characters.filter(c=>clip.character_ids.includes(c.id)).map(c=>({value:c.id,label:c.name}))],ref.character_id,value=>ref.character_id=value);
        field(row,'Panel, view or conflict-resolution notes',ref.notes,value=>ref.notes=value,{multiline:true,max:1500});
        button(row,'Remove assignment',()=>{clip.references=clip.references.filter(r=>r!==ref);invalidate();renderAssignments();});card.append(row);
      }
      button(card,'Add reference',()=>{const image=board.plan.images.find(i=>!clip.references.some(r=>r.asset_id===i.asset_id));if(!image)throw new Error('Import another image or crop a panel first.');const role=image.kind.startsWith('character')?'character':'composition';clip.references.push({asset_id:image.asset_id,role,character_id:role==='character'?(clip.character_ids[0]||''):'',notes:''});invalidate();renderAssignments();});$('sbAssignments').append(card);
    }
  }
  function renderConnections() {
    $('sbConnections').replaceChildren();
    try {for(const check of continuityChecks(board.plan)){const item=el('div',undefined,'story-connection');item.append(el('strong',`${board.plan.clips.find(c=>c.id===check.from).title} → ${board.plan.clips.find(c=>c.id===check.to).title}`),el('p',`Previous end: ${check.previous_end}`,'note'),el('p',`Next start: ${check.next_start}`,'note'),el('p',check.guidance,'note'),el('p',check.notes||'Add connection notes in the clip card.','note'));$('sbConnections').append(item);}} catch { $('sbConnections').append(el('p','Complete the story and clip fields to review connections.','note')); }
  }
  function renderImageOutput() {
    const prompts=board.imageBundle?.prompts||[];
    $('sbImageChoice').replaceChildren(...prompts.map((p,i)=>option(p.clip_id,`${i+1} · ${board.plan.clips.find(c=>c.id===p.clip_id)?.title||'Previous clip'}`)));
    if(prompts.length)$('sbImageChoice').add(option('sheet','Complete storyboard sheet'));
    if(![...$('sbImageChoice').options].some(o=>o.value===selectedImage))selectedImage=prompts[0]?.clip_id||'';
    $('sbImageChoice').value=selectedImage;$('sbImagePrompt').value=selectedImage==='sheet'?board.imageBundle?.sheet||'':prompts.find(p=>p.clip_id===selectedImage)?.prompt||'';
  }
  function renderResults() {
    $('sbResultChoice').replaceChildren(...board.plan.clips.map((c,i)=>option(c.id,`${i+1} · ${c.title}`)));
    if(!board.plan.clips.some(c=>c.id===selectedClip))selectedClip=board.plan.clips[0]?.id||'';
    $('sbResultChoice').value=selectedClip;$('sbResult').value=currentResult()?.prompt||'';
    $('sbHistory').replaceChildren(option('','Choose a revision…'),...(board.histories[selectedClip]||[]).map((r,i)=>option(String(i),`${new Date(r.created_at).toLocaleString()} · ${r.prompt.slice(0,42)}`)));
    renderReferenceMap();update();
  }
  function renderReferenceMap() {
    $('sbReferenceMap').replaceChildren();
    const clip=board.plan.clips.find(c=>c.id===selectedClip);if(!clip)return;
    try {for(const ref of clipReferences(normalizePlan(board.plan),clip,assets())){const asset=assets().find(a=>a.id===ref.asset_id),row=el('p',`${ref.label} → ${ref.download_name} · ${labels[ref.role]} `,'note');const link=el('a','Download reference');link.href=asset.content_url+'&download=1&download_name='+encodeURIComponent(ref.download_name);link.download=ref.download_name;row.append(link);$('sbReferenceMap').append(row);}}catch{}
  }
  function render() {
    $('sbIdea').value=board.idea;$('sbTitle').value=board.plan.title;$('sbStory').value=board.plan.story;$('sbScene').value=board.plan.scene;$('sbAspect').value=board.plan.aspect;
    renderCharacters();renderClips();renderLibrary();renderAssignments();renderConnections();renderImageOutput();renderResults();update();
  }
  function update() {
    const busy=getState().busy;
    for(const node of host.querySelectorAll('input,textarea,select,button'))node.disabled=busy;
    $('sbCancel').hidden=!busy;$('sbCancel').disabled=false;
    $('sbDevelop').disabled=busy||!board.idea.trim();$('sbImageGenerate').disabled=busy||!validPlan();
    $('sbAddClip').disabled=busy||board.plan.clips.length>=12;$('sbAddCharacter').disabled=busy||board.plan.characters.length>=8;
    for(const id of ['sbCopyImage','sbDownloadImage','sbDownloadImages'])$(id).disabled=busy||!imageCurrent()||!$('sbImagePrompt').value.trim();
    $('sbImageStatus').textContent=board.imageBundle?(imageCurrent()?'Image prompts ready. Review, generate images externally, then import them.':'Image prompts are from an older plan. Regenerate before export.'):'No image prompts yet.';
    let reviewError='';try{validateReferences(normalizePlan(board.plan),assets());}catch(error){reviewError=error.message;}
    $('sbApprove').disabled=busy||!$('sbReviewed').checked||!!reviewError;
    $('sbRevoke').disabled=busy||!board.approval;
    $('sbApprovalStatus').textContent=approved()?'Approved by you. Changes require a new review.':reviewError||'Ready for your review. Check the confirmation box and approve.';
    $('sbGenerateAll').disabled=busy||!approved();$('sbGenerateOne').disabled=busy||!approved()||!selectedClip;
    for(const id of ['sbCopyResult','sbDownloadResult'])$(id).disabled=busy||!resultCurrent();
    $('sbDownloadAll').disabled=busy||!approved()||!board.plan.clips.every(c=>board.results[c.id]?.prompt&&board.results[c.id].signature===board.approval.fingerprint);
    const result=currentResult();$('sbResultStatus').textContent=!result?'No H3 prompt for this clip yet.':!resultCurrent()?'Previous prompt retained. Review the current plan and regenerate if it changed before exporting.':result.prompt_audit?.repair_required?'Ready for manual review; the format audit flagged issues. Inspect before using.':'Prompt ready. Review it and load the listed references in order.';
    $('sbRestore').disabled=busy||!$('sbHistory').value;
    $('sbClipSummary').textContent=`${board.plan.clips.length} clips · ${board.plan.clips.reduce((total,c)=>total+(Number(c.duration)||0),0).toFixed(1)} seconds planned. Changes require another human review.`;
    renderConnections();
  }
  for(const [id,property] of [['sbTitle','title'],['sbStory','story'],['sbScene','scene'],['sbAspect','aspect']])$(id).addEventListener('input',()=>{board.plan[property]=$(id).value;invalidate();});
  $('sbIdea').oninput=()=>{board.idea=$('sbIdea').value;touch();};
  $('sbDevelop').onclick=guarded(async()=>{if(board.plan.clips.length&&!confirm('Replace the story and clip plan with a new draft? Imported images and prior outputs remain.'))return;const result=await stream('/h3studio/storyboard/develop',{...modelBody(),idea:board.idea,clip_count:Number($('sbCount').value),aspect:board.plan.aspect});const images=board.plan.images;invalidate();board.plan={...result.plan,images};render();$('sbStoryDetails').open=true;status('Draft ready. Review the story and clip cards before writing image prompts.');});
  $('sbAddCharacter').onclick=()=>{board.plan.characters.push({id:newSessionId(),name:'New character',description:''});invalidate();renderCharacters();renderClips();renderAssignments();update();};
  $('sbAddClip').onclick=()=>{board.plan.clips.push({id:newSessionId(),title:`Clip ${board.plan.clips.length+1}`,duration:5,mode:'Reference',camera:'',action:'',dialogue:'',start_state:'',end_state:'',connection:board.plan.clips.length?'angle_cut':'opening',continuity:'',character_ids:[],references:[]});invalidate();renderClips();renderAssignments();renderResults();};
  $('sbImageGenerate').onclick=guarded(async()=>{const result=await stream('/h3studio/storyboard/images',{...modelBody(),plan:normalizePlan(board.plan)});board.imageBundle=result;renderImageOutput();touch();status('Storyboard image prompts ready. Generate the images externally, then import them for Human Control.');});
  $('sbImageChoice').onchange=()=>{selectedImage=$('sbImageChoice').value;renderImageOutput();update();};
  $('sbImagePrompt').oninput=()=>{if(!board.imageBundle)return;if(selectedImage==='sheet')board.imageBundle.sheet=$('sbImagePrompt').value;else{const p=board.imageBundle.prompts.find(p=>p.clip_id===selectedImage);if(p)p.prompt=$('sbImagePrompt').value;}touch();};
  async function copy(field) {toast(await copyTextField(field)?'Prompt copied.':'Text selected. Press ⌘C / Ctrl+C to copy.');}
  $('sbCopyImage').onclick=guarded(()=>{if(imageCurrent())return copy($('sbImagePrompt'));});
  $('sbDownloadImage').onclick=()=>{if(imageCurrent())downloadText(`storyboard_${selectedImage==='sheet'?'sheet':String(board.plan.clips.findIndex(c=>c.id===selectedImage)+1).padStart(2,'0')}_image_prompt.txt`,$('sbImagePrompt').value);};
  $('sbDownloadImages').onclick=()=>{if(imageCurrent())downloadText('storyboard_image_prompts.md',`# ${board.plan.title}\n\n${board.imageBundle.prompts.map((p,i)=>`## Panel ${i+1}\n${p.prompt}`).join('\n\n')}\n\n## Complete sheet\n${board.imageBundle.sheet}`,'text/markdown');};
  $('sbFiles').onchange=guarded(async()=>{
    const files=[...$('sbFiles').files];if(!files.length)return;
    if(files.length>12){$('sbFiles').value='';throw new Error('Import at most 12 images at a time.');}
    const kind=$('sbImportKind').value,form=new FormData();form.append('session_id',getState().session);form.append('mode','Storyboard');files.forEach(f=>form.append('file',f));
    setBusy(true);try{const result=await request('/h3studio/media/upload',{method:'POST',body:form});board.plan.images.push(...result.assets.map(a=>({asset_id:a.id,kind,description:''})));invalidate();await refreshMedia();renderLibrary();renderAssignments();status('Images imported. Review types, crop panels, and assign references in Human Control.');}finally{$('sbFiles').value='';setBusy(false);}
  });
  $('sbReviewed').onchange=update;
  $('sbApprove').onclick=guarded(async()=>{if(!$('sbReviewed').checked)throw new Error('Confirm the human review first.');const plan=validateReferences(normalizePlan(board.plan),assets()),signature=key();setBusy(true);try{await revokePromise;const result=await post('/h3studio/storyboard/approve',{session_id:getState().session,plan,reviewed:true});board.approval={...result.approval,signature};touch();status('Plan approved by you. H3 clip prompt generation is now available.');}finally{setBusy(false);}});
  $('sbRevoke').onclick=()=>{invalidate();status('Review reopened. Approve again before generating H3 prompts.');};
  async function generateClips(one=false) {
    if(!approved())throw new Error('Complete Human Control first.');
    const signature=board.approval.fingerprint;const result=await stream('/h3studio/storyboard/generate',{...modelBody(),plan:normalizePlan(board.plan),approval_token:board.approval.token,...(one?{clip_id:selectedClip}:{})});
    for(const [id,value] of Object.entries(result.results)){if(board.results[id])saveRevision(id,board.results[id]);board.results[id]={...value,signature};}
    renderResults();touch();status('H3 clip prompts ready. Review and export; nothing was sent to ComfyUI.');
  }
  $('sbGenerateAll').onclick=guarded(()=>generateClips());$('sbGenerateOne').onclick=guarded(()=>generateClips(true));
  $('sbResultChoice').onchange=()=>{selectedClip=$('sbResultChoice').value;renderResults();};
  $('sbResult').onchange=()=>{if(!currentResult())return;saveRevision(selectedClip,currentResult());board.results[selectedClip]={...currentResult(),prompt:$('sbResult').value,created_at:new Date().toISOString(),prompt_audit:null};touch();};
  $('sbHistory').onchange=update;$('sbRestore').onclick=()=>{const previous=board.histories[selectedClip]?.[Number($('sbHistory').value)];if(!previous)return;if(currentResult())saveRevision(selectedClip,currentResult());board.results[selectedClip]=structuredClone(previous);renderResults();touch();};
  $('sbCopyResult').onclick=guarded(()=>{if(resultCurrent())return copy($('sbResult'));});
  $('sbDownloadResult').onclick=()=>{if(resultCurrent())downloadText(`clip_${String(board.plan.clips.findIndex(c=>c.id===selectedClip)+1).padStart(2,'0')}_h3_prompt.txt`,$('sbResult').value);};
  $('sbDownloadAll').onclick=()=>{if(!approved()||!board.plan.clips.every(c=>board.results[c.id]?.signature===board.approval.fingerprint))return;downloadText('storyboard_h3_prompts_and_references.md',storyboardExport(normalizePlan(board.plan),board.results,assets()),'text/markdown');};
  $('sbCancel').onclick=guarded(async()=>{status('Cancelling…');await post('/h3studio/cancel',{});});
  function cropOverlay() {
    Object.assign($('sbCropOverlay').style,{left:`${cropRect.x*100}%`,top:`${cropRect.y*100}%`,width:`${cropRect.width*100}%`,height:`${cropRect.height*100}%`});
    for(const key of ['x','y','width','height'])$(`sbCrop-${key}`).value=String(Math.round(cropRect[key]*10000)/100);
  }
  for(const property of ['x','y','width','height']){const label=el('label',`${property} (%)`),input=el('input');input.id=`sbCrop-${property}`;input.type='number';input.min='0';input.max='100';input.step='0.1';label.htmlFor=input.id;const group=el('div');group.append(label,input);$('sbCropFields').append(group);input.oninput=()=>{cropRect[property]=Number(input.value)/100;Object.assign($('sbCropOverlay').style,{left:`${cropRect.x*100}%`,top:`${cropRect.y*100}%`,width:`${cropRect.width*100}%`,height:`${cropRect.height*100}%`});};}
  function openCrop(asset) {cropAsset=asset;cropRect={x:0,y:0,width:1,height:1};$('sbCropImage').src=asset.preview_url||asset.content_url;$('sbCropStatus').textContent='';cropOverlay();$('sbCropDialog').showModal();}
  let dragStart=null;
  const point=e=>{const r=$('sbCropCanvas').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
  $('sbCropCanvas').onpointerdown=e=>{if(getState().busy)return;e.preventDefault();dragStart=point(e);$('sbCropCanvas').setPointerCapture(e.pointerId);};
  $('sbCropCanvas').onpointermove=e=>{if(!dragStart)return;const p=point(e);cropRect={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:Math.abs(p.x-dragStart.x),height:Math.abs(p.y-dragStart.y)};cropOverlay();};
  $('sbCropCanvas').onpointerup=()=>{dragStart=null;};$('sbCropCanvas').onpointercancel=()=>{dragStart=null;};
  $('sbCropGrid').onclick=guarded(()=>{const columns=Number($('sbCropColumns').value),rows=Number($('sbCropRows').value),cell=Number($('sbCropCell').value)-1;if(![columns,rows,cell].every(Number.isInteger)||columns<1||rows<1||columns>12||rows>12||cell<0||cell>=columns*rows)throw new Error('Choose a valid grid and cell.');cropRect={x:(cell%columns)/columns,y:Math.floor(cell/columns)/rows,width:1/columns,height:1/rows};cropOverlay();});
  $('sbCropSave').onclick=async()=>{try{const source=board.plan.images.find(i=>i.asset_id===cropAsset.id);const result=await stream('/h3studio/storyboard/crop',{session_id:getState().session,asset_id:cropAsset.id,rect:cropRect});board.plan.images.push({asset_id:result.asset.id,kind:source.kind.startsWith('character')?'character_view':'storyboard_panel',description:''});invalidate();await refreshMedia();renderLibrary();renderAssignments();$('sbCropDialog').close();status('Panel crop created. Assign it to a clip and review before approval.');}catch(error){$('sbCropStatus').textContent=error.message;status(error.message,true);}};
  $('sbCropClose').onclick=()=>$('sbCropDialog').close();
  $('sbCropDialog').addEventListener('cancel',e=>{if(getState().busy)e.preventDefault();});
  render();
  return {
    update, render,
    syncAssets() {const available=new Set(assets().map(a=>a.id));if(board.plan.images.some(i=>!available.has(i.asset_id))){board.plan.images=board.plan.images.filter(i=>available.has(i.asset_id));for(const c of board.plan.clips)c.references=c.references.filter(r=>available.has(r.asset_id));invalidate();renderLibrary();renderAssignments();}update();},
    snapshot() {return structuredClone({...board,approval:null});},
    restore(value) {board=value?.plan?.version===1?structuredClone({...initial(),...value,approval:null}):initial();$('sbReviewed').checked=false;render();$('sbStoryDetails').open=!!board.plan.story;},
    reset() {if(board.approval)invalidate();board=initial();selectedClip='';selectedImage='';$('sbReviewed').checked=false;render();},
  };
}
