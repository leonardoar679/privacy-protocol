// The configured RPC endpoints, each once (the ninth review round, 2026-11-04, D-10: a URL listed twice had counted as two). A module of
// its own, free of the chain client: Home's posture and the Privacy Center count the endpoints without loading viem.
// One URL however it is spelled (the tenth review round, B10-12): a trailing slash or the host's case had counted as a second endpoint in the quorum.
// The default port, a trailing host dot, an empty query or fragment too (the eleventh review round, 2026-11-04, B11-12): new URL() drops :443 and
// :80 and lowercases the scheme and the host; distinct paths and keys stay distinct.
const sameUrl = (u: string): string => {
  const t = u.trim();
  try {
    const x = new URL(t);
    const host = x.hostname.replace(/\.$/, "");
    const path = x.pathname.replace(/\/+$/, "");
    return `${x.protocol}//${x.username ? `${x.username}${x.password ? `:${x.password}` : ""}@` : ""}${host}${x.port ? `:${x.port}` : ""}${path}${x.search && x.search !== "?" ? x.search : ""}${x.hash && x.hash !== "#" ? x.hash : ""}`;
  } catch {
    const s = t.replace(/\/+$/, "");
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i.exec(s);
    return m ? m[1].toLowerCase() + m[2] : s;
  }
};
export const rpcUrlsOf = (d: { rpcUrl: string; rpcUrls?: readonly string[] }): string[] => {
  const seen = new Set<string>();
  return (d.rpcUrls?.length ? d.rpcUrls : [d.rpcUrl]).filter((u) => {
    const k = sameUrl(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
