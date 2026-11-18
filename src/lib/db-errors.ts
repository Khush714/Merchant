/** Drizzle wraps driver errors, so SQLSTATE can live on the error itself or on a cause. */
export function isUniqueViolation(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
