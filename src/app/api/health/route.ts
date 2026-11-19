import { db } from "@/db";
import { sql } from "drizzle-orm";
import { logError } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (error) {
    logError("Database health check failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
