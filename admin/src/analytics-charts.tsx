import React, { useEffect, useMemo, useRef, useState } from "react";
import { ServerCog } from "lucide-react";
import { BrandMark } from "./components";
import { formatCount } from "./ui-helpers";
import { presentAccountedSpend } from "./cost-presentation";
import { niceChartMaximum, providerChartRows, usageTimeline } from "./usage-analytics";
import type { ProviderUsageSummary, ServiceItem, UsageDailySummary, UsageSnapshot } from "./ui-types";

export function TrafficAreaChart({ usage, compact = false }: { usage: UsageSnapshot; compact?: boolean }) {
  const points = useMemo(() => usageTimeline(usage), [usage]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = 900;
  const height = compact ? 214 : 264;
  const inset = { top: 18, right: 18, bottom: 34, left: 46 };
  const chartWidth = width - inset.left - inset.right;
  const chartHeight = height - inset.top - inset.bottom;
  const maximum = niceChartMaximum(Math.max(0, ...points.map((point) => point.requestCount)));
  const x = (index: number) => inset.left + (index / Math.max(1, points.length - 1)) * chartWidth;
  const y = (value: number) => inset.top + chartHeight - (value / maximum) * chartHeight;
  const coordinates = points.map((point, index) => ({ x: x(index), y: y(point.requestCount) }));
  const line = smoothPath(coordinates);
  const area = `${line} L ${x(points.length - 1)} ${inset.top + chartHeight} L ${x(0)} ${inset.top + chartHeight} Z`;
  const tickIndexes = [...new Set([0, 7, 14, 21, points.length - 1].filter((index) => index >= 0 && index < points.length))];
  const selected = activeIndex === null ? null : points[activeIndex];
  const selectedX = activeIndex === null ? 0 : x(activeIndex);
  const hasTraffic = points.some((point) => point.requestCount > 0);
  const trendAvailable = usage.daily !== undefined;
  const timelineTotal = points.reduce((total, point) => total + point.requestCount, 0);
  const chartLabel = trendAvailable
    ? `${formatCount(timelineTotal)} requests across the last 30 UTC calendar days; peak ${formatCount(Math.max(0, ...points.map((point) => point.requestCount)))} requests in one day`
    : `${formatCount(usage.summary.requestCount)} requests in the ledger; daily trend data is unavailable`;
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || activeIndex === null || viewport.scrollWidth <= viewport.clientWidth) return;
    const target = (activeIndex / Math.max(1, points.length - 1)) * viewport.scrollWidth;
    viewport.scrollTo({ left: Math.max(0, target - viewport.clientWidth / 2), behavior: "auto" });
  }, [activeIndex, points.length]);
  function selectWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!hasTraffic || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") return setActiveIndex(0);
    if (event.key === "End") return setActiveIndex(points.length - 1);
    setActiveIndex((current) => event.key === "ArrowLeft"
      ? current === null ? points.length - 1 : Math.max(0, current - 1)
      : current === null ? 0 : Math.min(points.length - 1, current + 1));
  }

  return (
    <div className={`trafficChart${compact ? " compact" : ""}`} role={hasTraffic ? "group" : undefined} aria-label={hasTraffic ? "Interactive request activity chart. Use left and right arrow keys to inspect each day." : undefined}>
      <div className="trafficChartScroll" ref={scrollRef} tabIndex={hasTraffic ? 0 : undefined} onFocus={() => setActiveIndex(points.length - 1)} onBlur={() => setActiveIndex(null)} onKeyDown={selectWithKeyboard}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartLabel} onMouseLeave={() => setActiveIndex(null)}>
        <defs>
          <linearGradient id="trafficAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chartAreaStart" />
            <stop offset="100%" className="chartAreaEnd" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = (maximum / 4) * tick;
          const tickY = y(value);
          return <g key={tick}><line className="chartGridLine" x1={inset.left} x2={width - inset.right} y1={tickY} y2={tickY} /><text className="chartAxisLabel" x={inset.left - 9} y={tickY + 4} textAnchor="end">{formatCount(value)}</text></g>;
        })}
        {tickIndexes.map((index) => <text className="chartAxisLabel" key={index} x={x(index)} y={height - 9} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{formatChartDay(points[index].dayStartMs)}</text>)}
        {hasTraffic ? <>
          <path className="chartArea" d={area} fill="url(#trafficAreaFill)" />
          <path className="chartLine" d={line} />
          {points.map((point, index) => point.errorCount ? <circle className="chartErrorPoint" key={point.dayStartMs} cx={x(index)} cy={y(point.requestCount)} r={compact ? 2.2 : 2.8}><title>{`${point.errorCount} errors on ${formatChartDay(point.dayStartMs, true)}`}</title></circle> : null)}
        </> : null}
        {trendAvailable && hasTraffic ? points.map((point, index) => <rect key={point.dayStartMs} className="chartHitTarget" x={x(index) - chartWidth / points.length / 2} y={inset.top} width={chartWidth / points.length} height={chartHeight} onMouseEnter={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)} />) : null}
        {selected ? <g className="chartFocus" pointerEvents="none">
          <line x1={selectedX} x2={selectedX} y1={inset.top} y2={inset.top + chartHeight} />
          <circle cx={selectedX} cy={y(selected.requestCount)} r="4" />
        </g> : null}
      </svg></div>
      {!hasTraffic ? <div className="chartEmpty"><strong>{trendAvailable ? "No request activity" : "Trend data unavailable"}</strong><span>{trendAvailable ? "Traffic will appear here as requests pass through the gateway." : "The ledger has totals, but this deployment has not returned daily buckets yet."}</span></div> : null}
      {selected ? <ChartTooltip point={selected} xPercent={(activeIndex ?? 0) / Math.max(1, points.length - 1)} /> : null}
      <div className="chartLegend" aria-hidden="true"><span><i className="requests" />Requests</span><span><i className="errors" />Days with errors</span></div>
    </div>
  );
}

export function ProviderUsageChart({ providers, services, limit = 6 }: { providers: ProviderUsageSummary[]; services: ServiceItem[]; limit?: number }) {
  const visible = providerChartRows(providers, limit);
  const maximum = Math.max(1, ...visible.map((provider) => provider.requestCount));
  const serviceByProvider = new Map(services.map((service) => [service.provider, service]));
  return (
    <div className="providerChart" role="list" aria-label="Requests by provider">
      {visible.map((provider) => {
        const service = serviceByProvider.get(provider.provider);
        const providerLabel = provider.provider === "other-providers" ? "Other providers" : service?.name ?? provider.provider;
        const successWidth = (provider.successCount / maximum) * 100;
        const errorWidth = (provider.errorCount / maximum) * 100;
        const successRate = provider.requestCount ? Math.round((provider.successCount / provider.requestCount) * 100) : 0;
        const cost = presentAccountedSpend(provider);
        return (
          <div className="providerChartRow" role="listitem" key={provider.provider}>
            <span className="providerChartIdentity"><span className="providerChartMark"><BrandMark brandIcon={service?.brandIcon} fallback={ServerCog} /></span><span><strong>{providerLabel}</strong><small>{formatCount(provider.totalTokens)} tokens · {successRate}% success</small></span></span>
            <span className="providerChartTrack" role="img" aria-label={`${provider.requestCount} requests, ${provider.errorCount} errors`}><span className="providerChartSuccess" style={{ width: `${successWidth}%` }} /><span className="providerChartErrors" style={{ width: `${errorWidth}%` }} /></span>
            <span className="providerChartValue"><strong>{formatCount(provider.requestCount)}</strong><small title={cost.note}>{cost.value}</small></span>
          </div>
        );
      })}
      {visible.length ? <div className="providerChartLegend"><span><i className="success" />Successful</span><span><i className="errors" />Errors</span><span className="providerChartLegendMeta">Requests · accounted spend · may include estimates</span></div> : null}
      {!visible.length ? <div className="chartListEmpty"><ServerCog aria-hidden="true" /><strong>No provider activity</strong><span>Provider distribution will appear after the first routed request.</span></div> : null}
    </div>
  );
}

function ChartTooltip({ point, xPercent }: { point: UsageDailySummary; xPercent: number }) {
  const style = xPercent > 0.72 ? { right: `${(1 - xPercent) * 100}%` } : { left: `${xPercent * 100}%` };
  const cost = presentAccountedSpend(point);
  return <div className="chartTooltip" style={style} role="status" aria-live="polite"><strong>{formatChartDay(point.dayStartMs, true)}</strong><span>{formatCount(point.requestCount)} requests</span><span>{formatCount(point.totalTokens)} tokens</span><span>{cost.value} · {cost.label}</span><small>{cost.note}</small>{point.errorCount ? <em className="error">{point.errorCount} errors</em> : <em className="success">All successful</em>}</div>;
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const midpoint = (previous.x + point.x) / 2;
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function formatChartDay(timestamp: number, long = false) {
  return new Intl.DateTimeFormat("en", long ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }).format(timestamp);
}


/** Bounded personal-report buckets, not a legacy pooled UsageSnapshot. Nulls break the line. */
export function PersonalUsageTimeSeries({ points, label, formatValue, formatAxis = formatValue }: {
  points: ReadonlyArray<{ start: number; end: number; label: string; value: number | null; partial: boolean }>;
  label: string;
  formatValue: (value: number | null) => string;
  formatAxis?: (value: number) => string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setActiveIndex(null), [points]);
  const height = 226, inset = { left: 78, right: 14, top: 18, bottom: 32 };
  const plotWidth = width - inset.left - inset.right, plotHeight = height - inset.top - inset.bottom;
  const maximum = niceChartMaximum(Math.max(0, ...points.map(point => point.value ?? 0)));
  const x = (index: number) => inset.left + (points.length === 1 ? 0.5 : index / Math.max(1, points.length - 1)) * plotWidth;
  const y = (value: number) => inset.top + plotHeight * (1 - value / maximum);
  let path = '', connected = false;
  points.forEach((point, index) => {
    if (point.value === null) { connected = false; return; }
    path += `${connected ? " L" : " M"} ${x(index)} ${y(point.value)}`;
    connected = true;
  });
  const ticks = [...new Set(Array.from({ length: Math.min(4, points.length) }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, Math.min(4, points.length) - 1))))];
  const selected = activeIndex === null ? undefined : points[activeIndex];
  function inspect(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex(current => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : event.key === 'ArrowLeft' ? Math.max(0, (current ?? points.length) - 1) : Math.min(points.length - 1, (current ?? -1) + 1));
  }
  return <div className="personalTimeSeries" ref={viewport}>
    <div className="personalChartViewport" tabIndex={points.length ? 0 : undefined} role="group" aria-label={label + '. Use Left and Right arrows, Home or End to inspect daily values. Tap a day to inspect on touch screens.'} onKeyDown={inspect} onFocus={() => setActiveIndex(points.length ? points.length - 1 : null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label + '. Gaps mean no reported value; outlined points have partial coverage.'}>
        {[0, 1, 2].map(tick => <g key={tick}><line className="chartGridLine" x1={inset.left} x2={width - inset.right} y1={y(maximum / 2 * tick)} y2={y(maximum / 2 * tick)} /><text className="chartAxisLabel" x={inset.left - 8} y={y(maximum / 2 * tick) + 4} textAnchor="end">{formatAxis(maximum / 2 * tick)}</text></g>)}
        {ticks.map(index => <text key={index} className="chartAxisLabel" x={x(index)} y={height - 9} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index].label.replace(/^\d{4}-/, '').replace('-', '/')}</text>)}
        <path className="chartLine" d={path} />
        {points.map((point, index) => point.value !== null ? <circle className={point.partial ? 'personalChartPoint partial' : 'personalChartPoint'} key={point.start} cx={x(index)} cy={y(point.value)} r={point.partial ? 3.5 : 2.5} /> : null)}
        {selected ? <g className="chartFocus" pointerEvents="none"><line x1={x(activeIndex!)} x2={x(activeIndex!)} y1={inset.top} y2={inset.top + plotHeight} />{selected.value !== null ? <circle cx={x(activeIndex!)} cy={y(selected.value)} r="4" /> : null}</g> : null}
        {points.map((point, index) => {
          const left = index === 0 ? inset.left - 8 : (x(index - 1) + x(index)) / 2;
          const right = index === points.length - 1 ? width - inset.right + 8 : (x(index) + x(index + 1)) / 2;
          return <rect key={point.start} className="chartHitTarget" x={left} y={inset.top} width={right - left} height={plotHeight} onMouseEnter={() => setActiveIndex(index)} onClick={() => setActiveIndex(index)}><title>{point.label + ': ' + formatValue(point.value) + (point.partial ? ' · partial coverage' : '')}</title></rect>;
        })}
      </svg>
      {!points.some(point => point.value !== null) ? <div className="personalChartEmpty"><strong>No reported values</strong><span>Missing values are not shown as zero.</span></div> : null}
    </div>
    <div className="personalChartReadout" role="status" aria-live="polite">{selected ? <><span>{selected.label}</span><strong>{formatValue(selected.value)}</strong>{selected.partial ? <span>Partial coverage</span> : null}<small>{new Date(selected.start).toISOString()} → {new Date(selected.end).toISOString()} (exclusive)</small></> : <span>Hover, tap, or use arrow keys to inspect a day.</span>}</div>
  </div>;
}
