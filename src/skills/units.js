const POINTS_PER_UNIT = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 };

function pointsPerUnit(unit) {
  if (!Object.hasOwn(POINTS_PER_UNIT, unit)) throw new Error(`Unsupported unit: ${unit}`);
  return POINTS_PER_UNIT[unit];
}

export function toPoints(value, unit) {
  if (!Number.isFinite(value)) throw new Error('Measurement must be finite');
  return value * pointsPerUnit(unit);
}

export function fromPoints(value, unit) {
  if (!Number.isFinite(value)) throw new Error('Measurement must be finite');
  return value / pointsPerUnit(unit);
}
