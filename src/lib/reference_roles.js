// Reference labels describe assets supplied to H3; local uploads are optional observations.
// This is deliberately narrow; it is not a general natural-language intent parser.
const VIDEO_MENTION = /\b(?:video|clip)\b/i;
const ACT_LIKE = /\b(?:act|move|dance|perform|behave)\s+(?:exactly\s+)?like\b/i;
const MOTION = /\b(?:motion|movements?|choreography|gestures?|dance moves|body language)\b/i;
const TRANSFER = /\b(?:use|copy|match|follow|transfer|take|from|source|reference)\b/i;
const NEGATED = /\b(?:do not|don't|never|ignore|avoid|without|not|no)\b/i;

export function motionReferenceRoles(brief, assets) {
  const clauses = brief.split(/[.\n;]+/).filter(c => VIDEO_MENTION.test(c) && (ACT_LIKE.test(c) || (MOTION.test(c) && TRANSFER.test(c))) && !NEGATED.test(c));
  if (!clauses.length) return [];
  const videos = assets.filter(a => a.type === 'video');
  const roles = new Map();
  for (const clause of clauses) {
    const numbers = [...new Set([...clause.matchAll(/\bVideo\s+(\d+)\b/gi)].map(m => m[1]))];
    // Mixed roles in one clause need model interpretation; don't assign all its videos to motion.
    if (numbers.length > 1) continue;
    if (!numbers.length && videos.length > 1) {
      throw new Error('Name the motion source as it will be numbered in H3, for example <Video 1>.');
    }
    const tags = numbers.length ? numbers.map(n => `<Video ${n}>`) : [videos[0]?.reference || '<Video 1>'];
    for (const tag of tags) {
      roles.set(tag, { reference: tag, role: 'motion' });
    }
  }
  return [...roles.values()];
}

export function motionRoleInstructions(roles, duration) {
  if (!roles.length) return '';
  const span = Number.isFinite(duration) ? `the full ${duration}-second duration` : 'the full requested duration';
  return `Write the final Ref2VA prompt for PERSON REPLACEMENT: replace the person performing in the reference video with the person shown in the reference image. The image supplies WHO appears; the video supplies exactly WHAT they do, WHEN and HOW they do it. Preserve the original performance from beginning to end while changing the performer's identity and clothing to match the image. Do not write a new performance for the image subject. Explicit user changes take precedence. Keep the six sections below, in order. Describe the actual uploaded picture in useful detail; do not replace it with a generic template or invent a different location. The reference video is supplied directly to H3, so no local video upload is required.

subject_definitions:
Define each target performer as <Subject N>, describing the visible identity, hair, face, clothing and accessories from the assigned picture. Define that <Picture N> as the visual anchor for the subject's appearance AND the pictured environment, lighting, colors, depth of field and framing, unless the user assigns a narrower role or requests a change. A character sheet depicts one person, not multiple performers or a grid of scenes.
${roles.map(({reference}) => `Define ${reference} as the motion/performance reference: ALL movement, timing, rhythm and choreography come from this video. Keep this Video label as the explicit motion source throughout the prompt.`).join('\n')}

summary:
Use [reference generation]. Explicitly state that the person from the assigned picture replaces the performer in the assigned Video reference, performing that video's complete unchanged sequence while preserving the picture's appearance and visual context.

retention_analysis:
Use fully_preserved for the subject's referenced appearance, the picture's referenced environment/lighting, and the video's motion, except for explicit user changes. Video motion does not replace the picture's identity, costume or environment, and does not supply audio unless requested.

detailed_description:
Describe the visual style and environment actually established by the picture, then [Shot 1] with the visible subject and clothing. Bind the performance directly to the Video reference in the shot itself:
${roles.map(({reference}) => `The target <Subject N> performs the complete performance sequence from ${reference} with identical motion, timing, rhythm and energy across ${span}; every gesture, pose transition and choreographic element follows ${reference} exactly.`).join('\n')}
Replace <Subject N> with the actual target subject label. This binding IS the action description: do not follow or precede it with an invented routine, individual gestures, pose changes, hair play, gaze changes or an ending. A still-image pose is not a performance sequence. Keep camera framing consistent with the picture and the camera static unless the user requests different camera work. Preserve requested shots, transitions, visible text and camera directions. Use grounded visual detail, not extra action prose to meet a word count.

overall_soundscape:
Use the user's sound direction, or restrained ambient sound appropriate to the pictured setting. Do not invent dialogue or claim to have heard the video. If an Audio reference is requested unchanged, use it as the unchanged final soundtrack, with audio reuse in summary and fully_copy in retention_analysis.

non_diegetic_music:
N/A unless the user requests music. Return only the finished prompt, with actual reference numbers and the requested duration.`;
}

export function motionBindingViolations(prompt, roles = []) {
  const detailed = prompt.match(/^\s*detailed_description\s*:\s*([\s\S]*?)(?=^\s*(?:overall_soundscape|non_diegetic_music)\s*:|(?![\s\S]))/im)?.[1] || '';
  const definitions = prompt.match(/^\s*subject_definitions\s*:\s*([\s\S]*?)(?=^\s*summary\s*:|(?![\s\S]))/im)?.[1] || '';
  return roles.filter(({reference}) => {
    const number = reference.match(/\d+/)[0];
    const tag = new RegExp(`\\bVideo\\s+${number}\\b`, 'i');
    const motionSubjects = definitions.split('\n').filter(line => tag.test(line) && /\b(?:motion|performance|choreography|movements?|actions?)\b/i.test(line)).map(line => line.match(/^\s*(<Subject\s+\d+>)/i)?.[1]).filter(Boolean);
    return !detailed.split(/(?<=[.!?])\s+|\n/).some(sentence =>
      (tag.test(sentence) || motionSubjects.some(subject => sentence.includes(subject))) &&
      /\b(?:motion|movements?|actions?|performance|performs?|choreography|gestures?|timing|pacing|rhythm|behavio[u]?r|acts?|moves?|dances?)\b/i.test(sentence) &&
      !/\b(?:do not|don't|never|avoid|not)\s+(?:use|using|copy|copying|follow|following|retain|retaining|match|matching|perform|performing)\b|\bignore\b/i.test(sentence));
  }).map(({reference}) => `detailed_description must explicitly use ${reference} for the requested motion, performance and timing; listing it only in the reference inventory is insufficient`);
}
