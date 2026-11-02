import { useEffect, useRef, useState } from 'react';
import type { PersonalUsageEvents, PersonalUsageReport } from '../../../shared/usage-report';
import type { ConsoleRequest } from '../dashboard-fetch';
import type { CapturedSessionScope } from '../session-scope';
import { refreshUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString, type PersonalUsageQuery } from '../personal-usage';

interface ReadState<T> { key: string; value?: T; loading: boolean; error: string }
export function usePersonalUsage({ request, scope, active, full }: { request: ConsoleRequest; scope: CapturedSessionScope; active: boolean; full: boolean }) {
  const [query, setQuery] = useState<PersonalUsageQuery>(() => rollingUsageQuery());
  const [revision, setRevision] = useState(0);
  const [eventsRevision, setEventsRevision] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<Array<string | null>>([]);
  const [report, setReport] = useState<ReadState<PersonalUsageReport>>({ key: '', loading: false, error: '' });
  const [events, setEvents] = useState<ReadState<PersonalUsageEvents>>({ key: '', loading: false, error: '' });
  const cache = useRef(new UsageQueryCache<PersonalUsageReport>());
  const scopeKey = JSON.stringify([scope.origin, scope.epoch, scope.session.tenantId, scope.session.email, scope.session.subject]);
  const queryKey = scopeKey + ':' + usageQueryString(query);
  const eventKey = queryKey + ':' + (cursor ?? '');
  useEffect(() => () => cache.current.clear(), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let current = true;
    if (scope.demo) { setReport({ key: queryKey, loading: false, error: 'Personal reporting is not connected in local demo mode. No live usage is shown.' }); return; }
    const cached = cache.current.get(queryKey);
    if (cached) { setReport({ key: queryKey, value: cached, loading: false, error: '' }); return; }
    setReport({ key: queryKey, loading: true, error: '' });
    void request<PersonalUsageReport>(scope.origin, '/v1/session/usage/report?' + usageQueryString(query), { signal: controller.signal }).then(value => {
      if (!current || !scope.isCurrent()) return;
      cache.current.set(queryKey, value); setReport({ key: queryKey, value, loading: false, error: '' });
    }).catch(error => { if (current && scope.isCurrent()) setReport({ key: queryKey, loading: false, error: String(error instanceof Error ? error.message : error) }); });
    return () => { current = false; controller.abort(); };
  }, [active, queryKey, revision]);
  const visibleReport: ReadState<PersonalUsageReport> = report.key === queryKey ? report : { key: queryKey, loading: active, error: '' };
  useEffect(() => {
    if (!active || !full || !visibleReport.value || scope.demo) return;
    const controller = new AbortController();
    let current = true;
    setEvents({ key: eventKey, loading: true, error: '' });
    const params = new URLSearchParams(usageQueryString(query)); params.set('limit', '25');
    if (cursor) params.set('cursor', cursor);
    void request<PersonalUsageEvents>(scope.origin, '/v1/session/usage/events?' + params, { signal: controller.signal }).then(value => {
      if (current && scope.isCurrent()) setEvents({ key: eventKey, value, loading: false, error: '' });
    }).catch(error => { if (current && scope.isCurrent()) setEvents({ key: eventKey, loading: false, error: String(error instanceof Error ? error.message : error) }); });
    return () => { current = false; controller.abort(); };
  }, [active, full, eventKey, Boolean(visibleReport.value), revision, eventsRevision]);
  function changeQuery(next: PersonalUsageQuery) { setCursor(null); setPreviousCursors([]); setQuery(next); }
  function reload() { cache.current.clear(); setCursor(null); setPreviousCursors([]); setReport({ key: queryKey, loading: true, error: '' }); setQuery(refreshUsageQuery(query)); setRevision(value => value + 1); }
  // Home stays live without background work on other screens or moving a user's
  // paginated/detail view. Full reports keep their explicit range until Refresh.
  useEffect(() => {
    if (!active || full || scope.demo) return;
    const timer = setInterval(() => { if (scope.isCurrent() && (typeof document === 'undefined' || document.visibilityState === 'visible')) reload(); }, 30_000);
    return () => clearInterval(timer);
  }, [active, full, scopeKey, queryKey]);
  return { query, setQuery: changeQuery, report: visibleReport, events: events.key === eventKey ? events : { key: eventKey, loading: active && full, error: '' } as ReadState<PersonalUsageEvents>, reload,
    retryEvents: () => { setEvents({ key: eventKey, loading: true, error: '' }); setEventsRevision(value => value + 1); },
    page: previousCursors.length + 1,
    nextPage: () => { if (!events.value?.nextCursor) return; setPreviousCursors(values => [...values, cursor]); setCursor(events.value.nextCursor); },
    previousPage: () => { setCursor(previousCursors.at(-1) ?? null); setPreviousCursors(values => values.slice(0, -1)); },
  };
}
export type PersonalUsageData = ReturnType<typeof usePersonalUsage>;
