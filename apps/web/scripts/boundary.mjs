// A build-level boundary (the sixth review round, 2026-11-03): the gates over the source read import specifiers with regular
// expressions, which a `/`-rooted id, a template-literal dynamic import or a glob can pass. Here every module Vite actually
// resolves is held to the app's own tree, the workspace packages, node_modules and the allowed extras; a module from a
// forbidden tree (the Classic app's) fails the build whatever specifier reached it.
import { resolve, sep } from "node:path";

const inside = (p, base) => p === base || p.startsWith(base + sep);
const normal = (p) => resolve(p).replace(/\//g, sep);

/**
 * `root`: the app; `allowed`: other trees it may import from; `forbidden`: trees it may never import from; `modules`: where else the
 * workspace installs its dependencies (the repository's root node_modules, two levels above the app, by default).
 */
export function boundaryPlugin({ root, allowed = [], forbidden = [], modules }) {
  const base = normal(root);
  const ok = [base, ...allowed.map(normal)];
  const bad = forbidden.map(normal);
  // node_modules where the workspace installs them (the eleventh review round, 2026-11-04, H11-1): the repository's root, and inside the app's
  // own and the allowed trees — a file under any directory named node_modules had passed, another clone's beside the repository with it
  const deps = (modules ?? [resolve(root, "..", "..", "node_modules")]).map(normal);
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
      if (abs.includes(`${sep}node_modules${sep}`)) {
        if (deps.some((d) => inside(abs, d)) || ok.some((b) => inside(abs, b))) return null;
        this.error(`${file} lies in a node_modules outside the workspace's own (the repository's root, this application's and the allowed trees)`);
      }
      if (!ok.some((b) => inside(abs, b))) this.error(`${file} lies outside this application's own tree, the workspace packages and node_modules`);
      return null;
    },
  };
}
