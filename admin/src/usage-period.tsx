import { useMemo } from 'react';
import type { CompleteUsageQuery } from '../../shared/usage-report';

/** Wall clocks can repeat or run backwards across an offset change. */
export function UsagePeriod({ query: { from, to, timezone }, compact = false }: {
  query: Pick<CompleteUsageQuery, 'from' | 'to' | 'timezone'>; compact?: boolean;
}) {
  const { dates, offsets } = useMemo(() => ({
    dates: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }),
    offsets: new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }),
  }), [timezone]);
  const offsetAt = (at: number) => {
    const name = offsets.formatToParts(at).find(part => part.type === 'timeZoneName')!.value;
    return name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC');
  };
  const startOffset = offsetAt(from), endOffset = offsetAt(to);
  const changed = startOffset !== endOffset;
  if (compact && !changed) return dates.formatRange(from, to);
  return <><time dateTime={new Date(from).toISOString()}>{dates.format(from)}{changed ? ' ' + startOffset : ''}</time>{' – '}
    <time dateTime={new Date(to).toISOString()}>{dates.format(to)}{changed ? ' ' + endOffset : ''}</time></>;
}
