import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUsageRangeInput } from '../src/usage-range.ts';
// Fixed public calendar expectations, not a second implementation of the helper.
for (const [timezone,from,to,start,end] of [
 ['Asia/Kathmandu','2024-02-29','2024-03-01','2024-02-28T18:15:00Z','2024-02-29T18:15:00Z'],
 ['America/New_York','2026-03-08','2026-03-09','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z'],
 ['America/New_York','2026-11-01','2026-11-02','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z'],
 ['America/Sao_Paulo','2018-11-04','2018-11-05','2018-11-04T03:00:00Z','2018-11-05T02:00:00Z'],
 ['America/Havana','2026-11-01','2026-11-02','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z'],
 ['Pacific/Apia','2011-12-29','2011-12-31','2011-12-29T10:00:00Z','2011-12-30T10:00:00Z'],
 ['Australia/Lord_Howe','2026-10-04','2026-10-05','2026-10-03T13:30:00Z','2026-10-04T13:00:00Z'],
 ['Pacific/Auckland','2024-02-29T23:59:59.123456789+13:00','2024-02-29T23:59:59.124+13:00','2024-02-29T10:59:59.123Z','2024-02-29T10:59:59.124Z'],
]) test('calendar and instant boundaries: '+timezone+' '+from,()=>{
 assert.deepEqual(parseUsageRangeInput({from,to,timezone}),{from:Date.parse(start),to:Date.parse(end)});
});
for (const input of [
 {from:'2026-02-30T00:00:00Z'}, {to:'2026-04-31T01:00:00-04:00'}, {from:'2025-02-29'},
 {from:'2026-00-10'}, {from:'2026-13-10'}, {from:'2026-02-28T24:00:00Z'},
 {from:'2026-02-28T12:60:00Z'}, {from:'2026-02-28T12:00:60Z'}, {from:'2026-02-28T12:00:00+24:00'},
 {from:'2026-02-28T12:00:00'}, {from:'02/28/2026'}, {from:''}, {to:'2026-02-28T00:00:00Z'},
 {timezone:''}, {timezone:'Invalid/Timezone'}, {timezone:'+05:45'},
 {from:'2011-12-30',to:'2011-12-31',timezone:'Pacific/Apia'},
]) test('invalid original input is never normalized: '+JSON.stringify(input),()=>{
 assert.throws(()=>parseUsageRangeInput({from:'2026-02-28T00:00:00Z',to:'2026-03-01T00:00:00Z',timezone:'UTC',...input}),/calendar|RFC3339|positive range|IANA/);
});
