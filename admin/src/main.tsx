import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app-shell";
import { ConsoleControllerProvider, useConsole } from "./console-controller-context";
import { LoginScreen } from "./screens/login";
import "@fontsource-variable/archivo/standard.css";
import "@fontsource-variable/spline-sans-mono";
import "./style.css";

function Gate() {
  const { session, refresh } = useConsole();
  if (session.loginRequired) return <LoginScreen gatewayOrigin={session.gatewayOrigin} onSuccess={() => { session.setLoginRequired(false); void refresh(); }} />;
  return <AppShell />;
}
function App() { return <ConsoleControllerProvider><Gate /></ConsoleControllerProvider>; }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
