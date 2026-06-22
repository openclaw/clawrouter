import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app-shell";
import { useConsoleController } from "./use-console-controller";
import "./style.css";

function App() { return <AppShell controller={useConsoleController()} />; }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
