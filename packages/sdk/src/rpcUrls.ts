// The configured RPC endpoints, each once (the ninth review round, 2026-11-04, D-10: a URL listed twice had counted as two). A module of
// its own, free of the chain client: Home's posture and the Privacy Center count the endpoints without loading viem.
// One URL however it is spelled (the tenth review round, B10-12): a trailing slash or the host's case had counted as a second endpoint in the quorum.
const sameUrl = (u: string): string => {
  const t = u.trim().replace(/\/+$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i.exec(t);
  return m ? m[1].toLowerCase() + m[2] : t;
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
