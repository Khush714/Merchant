import { validateProductionConfig } from "./lib/config";

/**
 * Next.js calls `register` once when a server instance starts. During `next build`
 * the module is loaded with NEXT_PHASE=phase-production-build, before Vercel injects
 * runtime secrets, so validation runs on boot instead of during the build.
 */
export function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "edge") return;

  const report = validateProductionConfig();
  for (const warning of report.warnings) console.warn(`[config] ${warning}`);
  if (!report.ok) {
    for (const error of report.errors) console.error(`[config] ${error}`);
    throw new Error(`Invalid production configuration: ${report.errors.join(" ")}`);
  }
}
