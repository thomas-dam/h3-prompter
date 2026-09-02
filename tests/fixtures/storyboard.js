export function storyPlan(count=2) {
  return {version:1,title:'The letter',story:'Sara lifts a letter with her right hand and opens it.',scene:'A quiet café. Morning light comes from screen left. Sara wears a navy coat. A red cup stays on the table to her left.',aspect:'16:9',characters:[{id:'sara',name:'Sara',description:'One woman with short dark hair and a navy coat.'}],images:[],clips:Array.from({length:count},(_,i)=>({id:`clip${i+1}`,title:i?'Reading the letter':'Picking up the letter',duration:5,mode:'Reference',camera:i?'Close-up from the same side of the table, looking down toward her hands.':'Wide shot from the front-left of the café table.',action:i?'Sara opens the letter using her left hand while holding it in her right.':'Sara lifts the letter with her right hand.',dialogue:'',start_state:i?'Letter held in her right hand above the table.':'Letter on the table in front of Sara.',end_state:i?'Open letter held in both hands.':'Letter held in her right hand above the table.',connection:i?'angle_cut':'opening',continuity:i?'Continue with the letter in the right hand; keep the red cup on her left and the light from screen left.':'',character_ids:['sara'],references:[]}))};
}
export function storyboardReply(payload) {
  const messages=JSON.stringify(payload.messages);
  if(messages.includes('STORYBOARD_PLAN')) {
    const count=Number(messages.match(/Write (\d+) clips/)?.[1]||2);
    return JSON.stringify(storyPlan(count));
  }
  if(messages.includes('STORYBOARD_IMAGE'))return 'One woman with short dark hair wearing a navy coat sits at a café table, a letter held in her right hand, a red cup on her left. Morning light enters from screen left. A single cinematic 16:9 frame, preserving the planned camera angle.';
  if(messages.includes('STORYBOARD_H3')) {
    const hasSecond=messages.includes('<Picture 2>');
    return `subject_definitions:\n<Picture 1> supplies the approved appearance or composition.${hasSecond?'\n<Picture 2> supplies the approved framing and pose.':''}\n\nsummary:\n[reference generation] Sara handles the letter.\n\nretention_analysis:\n<Picture 1>: partially_preserved - use only its assigned role.${hasSecond?'\n<Picture 2>: partially_preserved - use only its assigned role.':''}\n\ndetailed_description:\n[Shot 1] Sara holds a letter in her right hand at a café table. Her navy coat and short dark hair remain consistent. Morning light comes from screen left and the red cup stays to her left. The camera keeps the approved angle during this continuous shot. She opens the letter with her left hand while holding it in her right.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A`;
  }
  return null;
}
