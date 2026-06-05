import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Role = "owner" | "admin" | "billing" | "user" | "service" | "auditor";

interface ServiceRow {
  name: string;
  budget: string;
  groups: string[];
  status: "active" | "at-risk" | "blocked";
}

const services: ServiceRow[] = [
  {
    name: "openclaw-docs",
    budget: "$300 / month",
    groups: ["core-llm", "web-research"],
    status: "active",
  },
  {
    name: "release-validation",
    budget: "$75 / day",
    groups: ["premium-reasoning", "core-llm"],
    status: "at-risk",
  },
  {
    name: "maintainer-reports",
    budget: "$50 / month",
    groups: ["github-tools", "core-llm"],
    status: "active",
  },
];

function App() {
  const role: Role = "admin";
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>ClawRouter</h1>
          <p>Provider keys, OAuth grants, budgets, and service routing.</p>
        </div>
        <span className="role">{role}</span>
      </header>

      <section className="metrics" aria-label="usage summary">
        <Metric label="today" value="$18.42" />
        <Metric label="month" value="$241.09" />
        <Metric label="active keys" value="18" />
        <Metric label="providers" value="23" />
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Services</h2>
          <button type="button">New key</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Budget</th>
              <th>Groups</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.name}>
                <td>{service.name}</td>
                <td>{service.budget}</td>
                <td>{service.groups.join(", ")}</td>
                <td>
                  <span className={`status ${service.status}`}>{service.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
