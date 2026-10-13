/** Joins class names, dropping the falsy ones. */
export const cx = (...xs: (string | false | null | undefined)[]): string => xs.filter(Boolean).join(" ");

let counter = 0;
/** A short unique id for aria relations (not a React 18 `useId` replacement: stable per call, fine for lists built at render). */
export const nextId = (prefix: string): string => `${prefix}-${++counter}`;
