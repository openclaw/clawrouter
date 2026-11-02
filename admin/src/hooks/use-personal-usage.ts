import { useEffect, useMemo, useRef, useState } from 'react';
import type { PersonalUsageEvents, PersonalUsageReport } from '../../../shared/usage-report';
import type { ConsoleRequest } from '../dashboard-fetch';
import type { CapturedSessionScope } from '../session-scope';
import { refreshUsageQuery, resolvedUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString, type PersonalUsageQuery } from '../personal-usage';

interface ReadState<T> { key: string; value?: T; loading: boolean; error: string }
interface Pagination { anchor: string; cursor: string | null; previousCursors: Array<string | null> }
const firstPage: Pagination = { anchor: '', cursor: null, previousCursors: [] };
export function usePersonalUsage({ request, scope, active, full }: { request: ConsoleRequest; scope: CapturedSessionScope; active: boolean; full: boolean }) {
  const [query, setQuery] = useState<PersonalUsageQuery>(() => rollingUsageQuery());
  const [revision, setRevision] = useState(0);
  const [eventsRevision, setEventsRevision] = useState(0);
  const [pagination, setPagination] = useState<Pagination>(firstPage);
  const [report, setReport] = useState<ReadState<PersonalUsageReport>>({ key: '', loading: false, error: '' });
  const [events, setEvents] = useState<ReadState<PersonalUsageEvents>>({ key: '', loading: false, error: '' });
  const cache = useRef(new UsageQueryCache<PersonalUsageReport>());
  const scopeKey = JSON.stringify([scope.origin, scope.epoch, scope.session.tenantId, scope.session.email, scope.session.subject]);
  const queryKey = scopeKey + ':' + usageQueryString(query);
  function reportAnchor(value: PersonalUsageReport) {
    return scopeKey + ':' + usageQueryString({ ...resolvedUsageQuery(query, value), rollingDays: undefined });
  }
  function acceptReport(value: PersonalUsageReport) {
    const anchor = reportAnchor(value);
    // A cached or fresh report may resolve to a different server-time range.
    // Retire both page coordinates before publishing those confirmed bounds.
    setPagination(previous => previous.anchor === anchor ? previous : { ...firstPage, anchor });
    setReport({ key: queryKey, value, loading: false, error: '' });
  }
  useEffect(() => () => cache.current.clear(), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let current = true;
    if (scope.demo) { setReport({ key: queryKey, loading: false, error: 'Personal reporting is not connected in local demo mode. No live usage is shown.' }); return; }
    const cached = cache.current.get(queryKey);
    if (cached) { acceptReport(cached); return; }
    setReport({ key: queryKey, loading: true, error: '' });
    void request<PersonalUsageReport>(scope.origin, '/v1/session/usage/report?' + usageQueryString(query), { signal: controller.signal }).then(value => {
      if (!current || !scope.isCurrent()) return;
      cache.current.set(queryKey, value); acceptReport(value);
    }).catch(error => { if (current && scope.isCurrent()) setReport({ key: queryKey, loading: false, error: String(error instanceof Error ? error.message : error) }); });
    return () => { current = false; controller.abort(); };
  }, [active, queryKey, revision]);
  const visibleReport: ReadState<PersonalUsageReport> = report.key === queryKey ? report : { key: queryKey, loading: active, error: '' };
  // Rolling controls show their server-time anchor; custom controls keep the
  // original usable request, even when retention clips it to an empty interval.
  // The summary already displays report.range independently of these controls.
  const displayQuery = useMemo(() => query.rollingDays && visibleReport.value ? resolvedUsageQuery(query, visibleReport.value) : query, [query, visibleReport.value]);
  const eventQuery = visibleReport.value ? usageQueryString({ ...resolvedUsageQuery(query, visibleReport.value), rollingDays: undefined }) : '';
  const eventAnchor = visibleReport.value ? scopeKey + ':' + eventQuery : '';
  // Also gate reads during scope/query transitions: no render can pair a new
  // anchor with an old cursor, independently of React's state-update batching.
  const { cursor, previousCursors } = pagination.anchor === eventAnchor ? pagination : firstPage;
  const eventKey = queryKey + ':' + eventQuery + ':' + (cursor ?? '');
  useEffect(() => {
    if (!active || !full || !visibleReport.value || scope.demo) return;
    const value = visibleReport.value;
    if (value.range.from === value.range.to) {
      // A valid custom request can resolve wholly outside retention. Equal
      // bounds cannot be parsed as a new request; the report proves this page
      // empty, without inventing usage, prices or history coverage.
      setEvents({ key: eventKey, loading: false, error: '', value: { events: [], nextCursor: null, historyComplete: value.historyComplete, historySource: value.historySource, projectionComplete: value.projectionComplete } });
      return;
    }
    const controller = new AbortController();
    let current = true;
    setEvents({ key: eventKey, loading: true, error: '' });
    // Every page/retry shares the report's exact ISO bounds, not a new rolling
    // request. Cursor validation therefore has one stable server-time anchor.
    const params = new URLSearchParams(eventQuery); params.set('limit', '25');
    if (cursor) params.set('cursor', cursor);
    void request<PersonalUsageEvents>(scope.origin, '/v1/session/usage/events?' + params, { signal: controller.signal }).then(value => {
      if (current && scope.isCurrent()) setEvents({ key: eventKey, value, loading: false, error: '' });
    }).catch(error => { if (current && scope.isCurrent()) setEvents({ key: eventKey, loading: false, error: String(error instanceof Error ? error.message : error) }); });
    return () => { current = false; controller.abort(); };
  }, [active, full, eventKey, Boolean(visibleReport.value), revision, eventsRevision]);
  function changeQuery(next: PersonalUsageQuery) {
    setPagination(firstPage);
    // Selecting the already-active preset is still an explicit fresh read.
    if (next.rollingDays && usageQueryString(next) === usageQueryString(query)) {
      cache.current.clear(); setReport({ key: queryKey, loading: true, error: '' }); setRevision(value => value + 1);
    }
    setQuery(next);
  }
  function reload() { cache.current.clear(); setPagination(firstPage); setReport({ key: queryKey, loading: true, error: '' }); setQuery(refreshUsageQuery(query)); setRevision(value => value + 1); }
  // Home stays live without background work on other screens or moving a user's
  // paginated/detail view. Full reports keep their explicit range until Refresh.
  useEffect(() => {
    if (!active || full || scope.demo) return;
    const timer = setInterval(() => { if (scope.isCurrent() && (typeof document === 'undefined' || document.visibilityState === 'visible')) reload(); }, 30_000);
    return () => clearInterval(timer);
  }, [active, full, scopeKey, queryKey]);
  return { query: displayQuery, setQuery: changeQuery, report: visibleReport, events: events.key === eventKey ? events : { key: eventKey, loading: active && full, error: '' } as ReadState<PersonalUsageEvents>, reload,
    retryEvents: () => { setEvents({ key: eventKey, loading: true, error: '' }); setEventsRevision(value => value + 1); },
    page: previousCursors.length + 1,
    nextPage: () => { if (events.key !== eventKey || !events.value?.nextCursor) return; setPagination({ anchor: eventAnchor, previousCursors: [...previousCursors, cursor], cursor: events.value.nextCursor }); },
    previousPage: () => { setPagination({ anchor: eventAnchor, cursor: previousCursors.at(-1) ?? null, previousCursors: previousCursors.slice(0, -1) }); },
  };
}
export type PersonalUsageData = ReturnType<typeof usePersonalUsage>;
