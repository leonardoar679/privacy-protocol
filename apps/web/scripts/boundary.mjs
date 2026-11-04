// A build-level boundary (the sixth review round, 2026-11-03): the gates over the source read import specifiers with regular
// expressions, which a `/`-rooted id, a template-literal dynamic import or a glob can pass. Here every module Vite actually
// resolves is held to the app's own tree, the workspace packages, node_modules and the allowed extras; a module from a
// forbidden tree (the Classic app's) fails the build whatever specifier reached it.
import { resolve, sep } from "node:path";

const inside = (p, base) => p === base || p.startsWith(base + sep);
const normal = (p) => resolve(p).replace(/\//g, sep);

/** `root`: the app; `allowed`: other trees it may import from; `forbidden`: trees it may never import from. */
export function boundaryPlugin({ root, allowed = [], forbidden = [] }) {
  const base = normal(root);
  const ok = [base, ...allowed.map(normal)];
  const bad = forbidden.map(normal);
  return {
    name: "privacy-wallet-boundary",
    enforce: "pre",
    transform(_code, id) {
      const file = id.split("?")[0];
      // a virtual or bare id, or one of Vite's own dev modules (/@vite/client, /@react-refresh, /@id/…): not a file of a tree.
      // The dev server's client module had been refused and no fixture page ever became ready
      if (file.startsWith("\0") || file.startsWith("/@") || !/^(?:[A-Za-z]:[\\/]|\/)/.test(file)) return null;
      const abs = normal(file);
      if (bad.some((b) => inside(abs, b))) this.error(`${file} lies in a tree this application may not import from (rule 9: the two share no runtime code)`);
      if (abs.includes(`${sep}node_modules${sep}`)) return null;
      if (!ok.some((b) => inside(abs, b))) this.error(`${file} lies outside this application's own tree, the workspace packages and node_modules`);
      return null;
    },
  };
}
