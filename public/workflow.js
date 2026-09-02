// randomUUID and the async Clipboard API require HTTPS (or localhost).
// LAN HTTP still has cryptographically secure getRandomValues and manual copying.
export function newSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function copyTextField(field) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(field.value); return true; }
    catch { /* Browser permissions may deny the modern API. Try user-initiated copy. */ }
  }
  field.focus();
  field.select();
  field.setSelectionRange(0,field.value.length);
  // Deprecated, but still needed for HTTP LAN access. Leave text selected if denied.
  try { return document.execCommand('copy'); }
  catch { return false; }
}

// Shared pure workflow checks are also exercised by Node tests.
export function clipMatchesRange(clip, source, start, end) {
  return !!clip && !!source && clip.source_id === source.id && clip.range_start === start && clip.range_end === end;
}
export function promptIsCurrent(output, clip, rangeMatches, signature) {
  return !!clip && rangeMatches && output.clip_id === clip.id && output.analysis_id === clip.analysis?.id && output.signature === signature;
}
export async function* parseEvents(stream) {
  if (!stream) throw new Error('No response stream.');
  const reader=stream.getReader(), decoder=new TextDecoder();
  let buffer='';
  try {
    while(true) {
      const {done,value}=await reader.read();
      buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      let newline;
      while((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
        if(line.startsWith('data:'))yield JSON.parse(line.slice(5).trim());
      }
      if(done) { if(buffer.trim().startsWith('data:'))yield JSON.parse(buffer.trim().slice(5));break; }
    }
  } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
}
