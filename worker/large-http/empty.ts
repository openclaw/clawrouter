import {bounded} from './capacity.ts';
// A forwarded Request may have a body stream containing zero bytes.
export async function emptyBody(r:Request):Promise<boolean> {
  if (!r.body) return true;
  const reader = r.body.getReader();
  try { return (await bounded(reader.read(),250)).done === true; }
  catch { return false; }
  finally { void reader.cancel().catch(() => {}); }
}
