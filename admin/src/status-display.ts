export type ConsoleStatusTone = "error" | "neutral" | "pending" | "success";

export function consoleStatusPresentation(status: string, demoMode: boolean, refreshFailed = false, refreshing = false) {
  const tone = refreshFailed ? "error" : refreshing ? "pending" : consoleStatusTone(status);
  return {
    tone,
    label: demoMode ? "Demo" : tone === "success" ? "Connected" : tone === "pending" ? "Working" : tone === "error" ? "Needs attention" : "Degraded",
    showBar: tone !== "success",
  } as const;
}

function consoleStatusTone(status: string): ConsoleStatusTone {
  if (status.includes("error") || status.includes("failed") || status.includes("select") || status.includes("invalid") || status.includes("must") || status.includes("returned") || status.includes("paste")) return "error";
  if (status === "loading" || ["saving", "running", "revoking", "rotating", "issuing", "enabling", "disabling", "connecting", "reconciling", "refreshing"].some((prefix) => status.startsWith(prefix))) return "pending";
  if (status.includes("loaded") || status.includes("saved") || status.includes("connected") || status.includes("ready") || status.includes("issued") || status.includes("rotated") || status.includes("revoked") || status.includes("reconciled") || status.includes("refreshed") || status.startsWith("enabled ") || status.startsWith("disabled ")) return "success";
  return "neutral";
}
