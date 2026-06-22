import { createContext, type ReactNode, useContext } from "react";
import { type ConsoleController, useConsoleController } from "./use-console-controller";

const ConsoleControllerContext = createContext<ConsoleController | null>(null);

export function ConsoleControllerProvider({ children }: { children: ReactNode }) {
  const controller = useConsoleController();
  return <ConsoleControllerContext.Provider value={controller}>{children}</ConsoleControllerContext.Provider>;
}

export function useConsole() {
  const controller = useContext(ConsoleControllerContext);
  if (!controller) throw new Error("useConsole must be used inside ConsoleControllerProvider");
  return controller;
}
