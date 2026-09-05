import { Router, type Request, type Response } from "express";
import { getAllTraces } from "./agentTraceStore";
import {
  buildDashboardSnapshot,
  type DashboardFilters,
  type DashboardRange,
} from "./dashboardAnalytics";

export const dashboardRouter = Router();

const VALID_RANGES = new Set<DashboardRange>(["24h", "7d", "30d", "all"]);

function sendDashboard(req: Request, res: Response): void {
  const requestedRange = getQueryValue(req, "range") as DashboardRange | undefined;
  const filters: DashboardFilters = {
    range: requestedRange && VALID_RANGES.has(requestedRange) ? requestedRange : "30d",
    from: getQueryValue(req, "from"),
    to: getQueryValue(req, "to"),
    agentType: getQueryValue(req, "agentType"),
    model: getQueryValue(req, "model"),
  };

  res.json(buildDashboardSnapshot(getAllTraces(), filters));
}

dashboardRouter.get("/api/dashboards", sendDashboard);
dashboardRouter.get("/api/telemetry/dashboards", sendDashboard);

function getQueryValue(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
