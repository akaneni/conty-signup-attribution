// Horários de entrada exigem fuso explícito (Z ou ±hh:mm). Precisão de ms.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // Date.parse "rola" dias inexistentes (31/02); confere o dia civil.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export const DAY_MS = 24 * 60 * 60 * 1000;
