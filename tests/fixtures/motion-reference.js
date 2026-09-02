export const motionBrief = 'Make the girl in <Picture 1> act like the girl in the uploaded video.';
export const motionPrompt = `subject_definitions:
<Picture 1> defines the target character's appearance.
<Video 1> supplies motion and performance timing.

summary:
[reference generation] Apply the source performance to the target character.

retention_analysis:
<Picture 1>: fully_preserved - retain the target identity.
<Video 1>: partially_preserved - use its performance, not its performer's identity.

detailed_description:
[Shot 1] Keep the appearance of the character in <Picture 1>. Have her follow the movement, performance order, timing and pacing of <Video 1> throughout the clip. Preserve that motion without adding invented gestures or a new ending.

overall_soundscape:
N/A

non_diegetic_music:
N/A`;
export const inventedMotionPrompt = motionPrompt.replaceAll('<Video 1>', 'an imagined routine').replace('Have her follow the movement, performance order, timing and pacing of an imagined routine throughout the clip.', 'She spins around, waves and takes a bow.');
