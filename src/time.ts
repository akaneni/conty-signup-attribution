// Horários de entrada exigem fuso explícito (Z, ±hh:mm ou ±hhmm). Precisão de ms.
// Cada componente é validado por faixa; nada é "rolado" para o dia seguinte.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;

export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const frac = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  if (y < 1000 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // dias do mês (bissexto incluso)
  if (d < 1 || d > dim) return null;

  let offsetMin = 0;
  if (m[8] !== "Z") {
    const digits = m[8].slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[8][0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, s, frac) - offsetMin * 60_000;
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export const DAY_MS = 24 * 60 * 60 * 1000;
