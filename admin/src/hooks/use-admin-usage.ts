import { useUsageReport, type UsageHookOptions } from './use-personal-usage';
/** Separate hook instance and caches; selected retained user is never the actor. */
export function useAdminUsage(options: UsageHookOptions) { return useUsageReport(options,'admin'); }
