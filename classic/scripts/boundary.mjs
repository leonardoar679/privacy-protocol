// A build-level boundary (the sixth review round, 2026-11-03): rule 9 — the Classic app shares no runtime code with the wallet —
// is kept at the source by regular expressions over import specifiers, which a `/`-rooted id, a template-literal dynamic import
// or a glob can pass. Here every module Vite actually resolves is held to classic/ and its node_modules; anything else fails the
// build whatever specifier reached it.
import { resolve, sep } from "node:path";

const inside = (p, base) => p === base || p.startsWith(base + sep);
const normal = (p) => resolve(p).replace(/\//g, sep);

export function boundaryPlugin({ root }) {
  const base = normal(root);
  return {
    name: "tornado-classic-boundary",
    enforce: "pre",
    transform(_code, id) {
      const file = id.split("?")[0];
      // a virtual or bare id, or one of Vite's own dev modules (/@vite/client, /@react-refresh, /@id/…): not a file of a tree.
      // The dev server's client module had been refused and no fixture page ever became ready
      if (file.startsWith("\0") || file.startsWith("/@") || !/^(?:[A-Za-z]:[\\/]|\/)/.test(file)) return null;
      const abs = normal(file);
      if (inside(abs, base)) return null;
      this.error(`${file} lies outside the Classic app (rule 9: its own tree and node_modules only)`);
      return null;
    },
  };
}
