import { NextRequest, NextResponse } from "next/server";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";
import { generateStatement, listStatements } from "@/lib/statements";

export const dynamic = "force-dynamic";

/** Immutable merchant-generated statements for closed periods. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    return NextResponse.json({ statements: await listStatements(business.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}

/** Owner-only generation. Re-calling with the same period returns the existing immutable statement. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "statement-generate", 10);
    const { user, business } = await requireBusiness("finance.write");
    const body = await readJson<{ from?: unknown; to?: unknown }>(request, 4096);
    if (typeof body.from !== "string" || typeof body.to !== "string") throw new ApiError("Choose a from and to date.");
    const statement = await generateStatement(business.id, { from: body.from, to: body.to, actorId: user.id });
    await recordAudit({ request, event: "statement.generate", outcome: "success", businessId: business.id, detail: { statementId: statement.id, periodFrom: statement.periodFrom, periodTo: statement.periodTo } });
    return NextResponse.json({ statement }, { status: 201 });
  } catch (error) { return fail(error, request); }
}
