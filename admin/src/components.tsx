export function EntityName({ brandIcon, icon: Icon, title, subtitle }: { brandIcon?: BrandIcon; icon?: IconComponent; title: string; subtitle: string }) {
  return (
    <span className="entityName">
      <span className="entityMark"><BrandMark brandIcon={brandIcon} fallback={Icon} className="entityLogo" /></span>
      <span><span className="entityTitle">{title}</span><small>{subtitle}</small></span>
    </span>
  );
}

export function InspectorHeader({ brandIcon, icon: Icon, title, subtitle }: { brandIcon?: BrandIcon; icon?: IconComponent; title: string; subtitle: string }) {
  return (
    <div className="inspectorHeader">
      <span className="inspectorIcon"><BrandMark brandIcon={brandIcon} fallback={Icon} /></span>
      <div><h2>{title}</h2><p>{subtitle}</p></div>
    </div>
  );
}

export function MiniListItem({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return onClick
    ? <button type="button" className="miniListItem" onClick={onClick}>{children}</button>
    : <div className="miniListItem">{children}</div>;
}

export function BrandMark({ brandIcon, fallback: Fallback, className = "" }: { brandIcon?: BrandIcon; fallback?: IconComponent; className?: string }) {
  if (brandIcon?.body && !brandIcon.body.includes("undefined")) {
    return <svg className={className ? `brandSvg ${className}` : "brandSvg"} viewBox={brandIcon.viewBox ?? "0 0 24 24"} aria-hidden="true" dangerouslySetInnerHTML={{ __html: brandIcon.body }} />;
  }
  return Fallback ? <Fallback className={className || undefined} aria-hidden="true" /> : null;
}

export function PanelTitle({ icon: Icon, title, meta }: { icon?: IconComponent; title: string; meta: string }) {
  return <div className="panelTitle">{Icon ? <Icon className="panelIcon" aria-hidden="true" /> : null}<div><h2>{title}</h2><span>{meta}</span></div></div>;
}

export function InlineError({ message }: { message: string }) {
  return <div className="inlineError" role="alert"><CircleSlash2 aria-hidden="true" /><span>{message}</span></div>;
}

export function InlineNote({ children }: { children: React.ReactNode }) {
  return <div className="inlineNote">{children}</div>;
}

export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  const dark = value === "dark", next = dark ? "light" : "dark";
  return <button className={`themeToggle${dark ? " active" : ""}`} type="button" role="switch" aria-checked={dark} aria-label={`${dark ? "Dark" : "Light"} mode`} title={`Switch to ${next} mode`} onClick={() => onChange(next)}><span>{dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}</span></button>;
}

export function Status({ label, tone }: { label: string; tone: OutcomeTone }) {
  const Icon = tone === "active" ? CheckCircle2 : tone === "revoked" ? CircleSlash2 : null;
  return <span className={`status ${tone}`}>{Icon ? <Icon aria-hidden="true" /> : null}{label}</span>;
}

export function OutcomeStatus({ outcome }: { outcome: ServiceOutcome }) {
  return <Status label={outcome.label} tone={outcome.tone} />;
}

export function ReadinessStatus({ readiness }: { readiness?: ProviderReadiness }) {
  if (!readiness) return <span className="status neutral">unknown</span>;
  return <Status label={readinessLabel(readiness)} tone={readinessTone(readiness)} />;
}

export function viewTitle(view: View) {
  return ({ "my-usage": "My usage", home: "Dashboard", catalog: "Catalog", playground: "Playground", policies: "Access", users: "Users", usage: "Usage", subscriptions: "Subscriptions" } as const)[view];
}

export function viewSubtitle(view: View) {
  return {
    home: "Services, quotas, and gateway posture",
    "my-usage": "Tokens & costs",
    catalog: "Service access catalog",
    playground: "Run through the same access path",
    policies: "Policies, credentials, and principal bindings",
    users: "Cloudflare Access identities",
    usage: "Request audit and policy budgets",
    subscriptions: "Quota and traffic",
  }[view];
}

export const navItems: Array<{ id: View; label: string; icon: IconComponent; section: "workspace" | "admin" }> = [
  { id: "home", label: "Dashboard", icon: LayoutDashboard, section: "workspace" },
  { id: "my-usage", label: "My usage", icon: BarChart3, section: "workspace" },
  { id: "catalog", label: "Catalog", icon: Boxes, section: "workspace" },
  { id: "playground", label: "Playground", icon: FlaskConical, section: "workspace" },
  { id: "policies", label: "Access", icon: KeyRound, section: "admin" },
  { id: "users", label: "Users", icon: Users, section: "admin" },
  { id: "subscriptions", label: "Subscriptions", icon: Boxes, section: "admin" },
  { id: "usage", label: "Usage", icon: BarChart3, section: "admin" },
];

export function viewIcon(view: View): IconComponent {
  return navItems.find((item) => item.id === view)?.icon ?? Boxes;
}

export function kindIcon(kind: string): IconComponent {
  if (kind === "model" || kind === "model_provider" || kind.includes("llm")) return FlaskConical;
  if (kind === "tool" || kind === "tool_provider" || kind === "oauth_platform") return ServerCog;
  return Boxes;
}
import React from "react";
import { BarChart3, Boxes, CheckCircle2, CircleSlash2, FlaskConical, KeyRound, LayoutDashboard, Moon, ServerCog, Sun, Users } from "lucide-react";
import { readinessLabel, readinessTone } from "./domain";
import type { BrandIcon, IconComponent, OutcomeTone, ProviderReadiness, ServiceOutcome, Theme, View } from "./ui-types";

export function EntityTable({ columns, columnTemplate, rows }: { columns: string[]; columnTemplate?: string; rows: Array<{ id: string; active?: boolean; onClick?: () => void; cells: React.ReactNode[]; detail?: React.ReactNode }> }) {
  return (
    <div className="entityTable" style={{ "--cols": columns.length, "--columns": columnTemplate } as React.CSSProperties}>
      <div className="tableHead">{columns.map((column) => <span key={column}>{column}</span>)}</div>
      <div className="tableBody">{rows.map((row) => {
        const content = row.cells.map((cell, index) => <span key={index} data-label={columns[index]}>{cell}</span>);
        const className = `tableRow${row.active ? " selected" : ""}${row.onClick ? " interactive" : ""}`;
        return <React.Fragment key={row.id}>
          {row.onClick
            ? <button type="button" className={className} onClick={row.onClick}>{content}</button>
            : <div className={className}>{content}</div>}
          {row.detail ? <div className="tableRowDetail">{row.detail}</div> : null}
        </React.Fragment>;
      })}</div>
    </div>
  );
}

export function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>;
}
