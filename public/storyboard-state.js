// Shared validation keeps the browser's review state and the server's approval in sync.
export const IMAGE_KINDS = ['character_sheet', 'character_view', 'storyboard_sheet', 'storyboard_panel'];
export const REF_ROLES = ['character', 'composition', 'first_frame', 'last_frame'];
export const CLIP_MODES = ['Reference', 'I2VA', 'FL2VA', 'L2VA'];
export const CONNECTIONS = ['opening', 'continuation', 'angle_cut', 'scene_change'];
export const ASPECTS = ['16:9', '9:16', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'];
const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
const text = (value, name, max = 3000, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? '1' : '0'}–${max} characters.`);
  return value.trim();
};
const id = (value) => {
  if (typeof value !== 'string' || !identifier.test(value) || Object.hasOwn(Object.prototype, value) || value === 'prototype') throw new Error('Invalid storyboard identifier.');
  return value;
};
const choice = (value, values, name) => {
  if (!values.includes(value)) throw new Error(`Choose a valid ${name}.`);
  return value;
};
const list = (value, name, max) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} accepts at most ${max} entries.`);
  return value;
};
function unique(values, name) {
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicate entries.`);
}
export function emptyPlan() {
  return { version: 1, title: '', story: '', scene: '', aspect: '16:9', characters: [], clips: [], images: [] };
}
export function normalizePlan(value) {
  if (!value || value.version !== 1) throw new Error('Unsupported storyboard plan.');
  const characters = list(value.characters, 'Characters', 8).map(c => ({ id: id(c.id), name: text(c.name, 'Character name', 100, true), description: text(c.description, 'Character description', 2000, true) }));
  unique(characters.map(c => c.id), 'Characters');
  const images = list(value.images, 'Reference library', 64).map(i => ({ asset_id: id(i.asset_id), kind: choice(i.kind, IMAGE_KINDS, 'image type'), description: text(i.description || '', 'Image description', 1500) }));
  unique(images.map(i => i.asset_id), 'Reference library');
  const clips = list(value.clips, 'Clips', 12).map(c => {
    if (!Number.isFinite(c.duration) || c.duration < 2 || c.duration > 15) throw new Error('Each storyboard clip must last 2–15 seconds.');
    const character_ids = list(c.character_ids, 'Clip characters', 8).map(id);
    unique(character_ids, 'Clip characters');
    if (character_ids.some(key => !characters.some(character => character.id === key))) throw new Error('A clip refers to a missing character.');
    const references = list(c.references, 'Clip references', 9).map(r => ({ asset_id: id(r.asset_id), role: choice(r.role, REF_ROLES, 'reference role'), character_id: r.character_id ? id(r.character_id) : '', notes: text(r.notes || '', 'Reference instructions', 1500) }));
    unique(references.map(r => r.asset_id), 'Clip references');
    return { id: id(c.id), title: text(c.title, 'Clip title', 150, true), duration: c.duration, mode: choice(c.mode, CLIP_MODES, 'H3 mode'),
      camera: text(c.camera, 'Camera', 1500, true), action: text(c.action, 'Action', 2000, true), dialogue: text(c.dialogue || '', 'Dialogue', 3000),
      start_state: text(c.start_state, 'Start state', 1500, true), end_state: text(c.end_state, 'End state', 1500, true),
      connection: choice(c.connection, CONNECTIONS, 'connection'), continuity: text(c.continuity || '', 'Connection notes', 2000), character_ids, references };
  });
  if (!clips.length) throw new Error('Add at least one clip.');
  unique(clips.map(c => c.id), 'Clips');
  return { version: 1, title: text(value.title, 'Story title', 150, true), story: text(value.story, 'Story', 16000, true), scene: text(value.scene, 'Shared scene details', 5000, true), aspect: choice(value.aspect, ASPECTS, 'aspect ratio'), characters, clips, images };
}
export function validateReferences(plan, assets) {
  for (const image of plan.images) {
    if (!assets.some(a => a.id === image.asset_id && a.type === 'image' && a.mode === 'Storyboard')) throw new Error('A storyboard image is missing. Remove its assignment or upload it again.');
  }
  for (const [index, clip] of plan.clips.entries()) {
    if ((index === 0) !== (clip.connection === 'opening')) throw new Error('Only the first clip must use the Opening connection. Review clip order.');
    if (index > 0 && !clip.continuity.trim()) throw new Error(`Add connection notes for “${clip.title}” before approving.`);
    if (!clip.references.length) throw new Error(`Assign a character or storyboard reference to “${clip.title}”.`);
    for (const ref of clip.references) {
      const image = plan.images.find(i => i.asset_id === ref.asset_id);
      if (!image) throw new Error(`“${clip.title}” has a reference outside the reviewed image library.`);
      if (ref.role === 'character') {
        if (!['character_sheet', 'character_view'].includes(image.kind) || !clip.character_ids.includes(ref.character_id)) throw new Error('Character references must identify a character present in that clip and use a character sheet/view.');
      } else {
        if (ref.character_id) throw new Error('Only character references may assign a character ID.');
        if (!['storyboard_sheet', 'storyboard_panel'].includes(image.kind)) throw new Error('Composition and frame references must use storyboard images.');
        if (image.kind === 'storyboard_sheet' && (!ref.notes || ref.role !== 'composition')) throw new Error('For a full storyboard sheet, identify the panel in reference notes, or crop it. Sheets cannot be endpoint frames.');
      }
    }
    const roles = clip.references.map(r => r.role);
    const expected = { I2VA: ['first_frame'], L2VA: ['last_frame'], FL2VA: ['first_frame', 'last_frame'] }[clip.mode];
    if (expected && (roles.length !== expected.length || !expected.every(role => roles.filter(r => r === role).length === 1))) throw new Error(`${clip.mode} needs exactly ${expected.join(' and ')}. Use Ref2VA for character/composition references.`);
    if (clip.mode === 'Reference' && roles.some(r => r === 'first_frame' || r === 'last_frame')) throw new Error('Choose an image-to-video mode for exact first/last frame constraints.');
  }
  return plan;
}
export function reviewKey(value, assets) {
  const plan = normalizePlan(value);
  // Include even unassigned uploads: imported/replaced images require another human review.
  const library = assets.filter(a => a.mode === 'Storyboard').map(a => ({ id: a.id, filename: a.filename, size: a.size, width: a.width, height: a.height, crop: a.crop || null })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ plan, library });
}
export function imagePlanKey(value) {
  const plan = normalizePlan(value);
  return JSON.stringify({ ...plan, images: [], clips: plan.clips.map(c => ({ ...c, references: [] })) });
}
export function continuityChecks(value) {
  const plan = normalizePlan(value);
  return plan.clips.slice(1).map((clip, index) => {
    const previous = plan.clips[index];
    return { from: previous.id, to: clip.id, connection: clip.connection,
      previous_end: previous.end_state, next_start: clip.start_state,
      guidance: clip.connection === 'continuation' ? 'Check pose, prop positions, hand used, movement direction and action phase.' : clip.connection === 'angle_cut' ? 'Check camera side, eyelines, screen direction and action phase. Different angles do not need identical framing.' : 'Confirm the intended time/location change and what should remain consistent.',
      notes: clip.continuity };
  });
}
export function clipReferences(plan, clip, assets) {
  const ordered = [...clip.references].sort((a, b) => (a.role === 'last_frame' ? 1 : 0) - (b.role === 'last_frame' ? 1 : 0));
  return ordered.map((r, index) => {
    const asset = assets.find(a => a.id === r.asset_id);
    const image = plan.images.find(i => i.asset_id === r.asset_id);
    const safeName = asset.filename.replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(-140);
    return { ...r, kind: image.kind, description: image.description, filename: asset.filename,
      download_name: `clip_${String(plan.clips.findIndex(c => c.id === clip.id) + 1).padStart(2, '0')}_ref_${String(index + 1).padStart(2, '0')}_${safeName}`,
      label: clip.mode === 'Reference' ? `<Picture ${index + 1}>` : r.role === 'last_frame' ? 'Last frame' : 'First frame' };
  });
}
export function storyboardExport(plan, results, assets) {
  const text = [`# ${plan.title}`, plan.story, `## Shared scene\n${plan.scene}`, `Frame shape: ${plan.aspect}`, ...plan.characters.map(c => `Character ${c.name}: ${c.description}`)];
  plan.clips.forEach((clip, index) => {
    text.push(`## Clip ${String(index + 1).padStart(2, '0')} — ${clip.title}`, `${clip.duration}s · ${clip.mode} · ${clip.connection}`, `Camera: ${clip.camera}`, `Start: ${clip.start_state}`, `End: ${clip.end_state}`, `Connection notes: ${clip.continuity || 'Opening clip'}`);
    for (const ref of clipReferences(plan, clip, assets)) text.push(`${ref.label} → ${ref.download_name} · ${ref.role}${ref.character_id ? ` · ${plan.characters.find(c => c.id === ref.character_id)?.name}` : ''}${ref.notes ? ` · ${ref.notes}` : ''}`);
    text.push(`### H3 prompt\n${results[clip.id]?.prompt || '(not generated)'}`);
  });
  text.push('Manual handoff: load each clip’s listed references in order into your compatible ComfyUI workflow. Prompts do not embed images. Nothing is submitted automatically.');
  return text.join('\n\n');
}
