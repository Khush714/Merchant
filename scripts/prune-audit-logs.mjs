import "dotenv/config";
import { Client } from "pg";

const apply = process.argv.includes("--apply");
const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("AUDIT_RETENTION_DAYS must be a whole number between 1 and 3650.");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");

const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
await client.connect();
try {
  const olderThan = "created_at < now() - make_interval(days => $1::int)";
  const eligible = (await client.query(`select count(*)::int as count from audit_logs where ${olderThan}`, [days])).rows[0].count;
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, retentionDays: days, eligible, deleted: 0 }));
  } else {
    let deleted = 0;
    const batchSize = 5000;
    for (;;) {
      const result = await client.query(`
        with doomed as (
          select id from audit_logs where ${olderThan}
          order by created_at limit $2 for update skip locked
        )
        delete from audit_logs a using doomed d where a.id = d.id
      `, [days, batchSize]);
      deleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < batchSize) break;
    }
    console.log(JSON.stringify({ dryRun: false, retentionDays: days, eligible, deleted }));
  }
} finally {
  await client.end();
}
