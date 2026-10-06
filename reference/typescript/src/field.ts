// BN254 scalar field modulus — must match FieldEncoding.FIELD_SIZE in the contracts and the circuit.
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const inField = (x: bigint): boolean => x >= 0n && x < FIELD;

export function requireField(x: bigint, label = "value"): bigint {
  if (!inField(x)) throw new Error(`${label} not in field: ${x}`);
  return x;
}
