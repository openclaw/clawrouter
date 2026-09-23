import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app-shell";
import { ConsoleControllerProvider } from "./console-controller-context";
import "@fontsource-variable/archivo/standard.css";
import "@fontsource-variable/spline-sans-mono";
import "./style.css";

function App() { return <ConsoleControllerProvider><AppShell /></ConsoleControllerProvider>; }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
