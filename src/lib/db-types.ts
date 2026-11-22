import { db } from "@/db";

/** Drizzle transaction handle passed to explicit write workflows. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A database handle that is either the pool-backed client or an open transaction. */
export type DbQueryable = typeof db | DbTransaction;
