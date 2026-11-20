/** Validate original controls before Date.parse can normalize an invalid calendar.
 * This UI helper does not decide retention, future bounds or authorization. */
export interface UsageRangeInput { from: string; to: string; timezone: string }
export function parseUsageRangeInput(input: UsageRangeInput): {from:number;to:number} {
  const {timezone}=input;
  if (!timezone || timezone.length>100 || /^[+-]/.test(timezone)) throw new Error('Use a supported IANA timezone.');
  let formatter: Intl.DateTimeFormat;
  try { formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch { throw new Error('Use a supported IANA timezone.'); }
  function instant(value:string) {
    const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Use calendar dates or RFC3339 instants with Z or an explicit offset.');
    const date=value.slice(0,10),utc=Date.parse(date+'T00:00:00Z');
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0,10)!==date) throw new Error('Invalid calendar date.');
    if (!dateOnly) { const at=Date.parse(value);if(!Number.isSafeInteger(at))throw new Error('Invalid RFC3339 instant.');return at; }
    // Same first-local-date boundary as usageDateTools: includes fractional
    // offsets and midnight gaps/folds, without guessing an offset from UTC.
    let low=utc-36*3600000,high=utc+36*3600000;
    for(let i=0;low<high&&i<29;i++){
      const mid=low+Math.floor((high-low)/2),parts=formatter.formatToParts(mid);
      const part=(name:string)=>parts.find(p=>p.type===name)!.value;
      const label=part('year')+'-'+part('month')+'-'+part('day');
      if(label<date)low=mid+1;else high=mid;
    }
    return low;
  }
  const from=instant(input.from),to=instant(input.to);
  if(from>=to)throw new Error('Use a positive range; end is exclusive.');
  return {from,to};
}
