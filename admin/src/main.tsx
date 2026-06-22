import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app-shell";
import { ConsoleControllerProvider } from "./console-controller-context";
import "./style.css";

function App() { return <ConsoleControllerProvider><AppShell /></ConsoleControllerProvider>; }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
