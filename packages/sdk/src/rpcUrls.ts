// The configured RPC endpoints, each once (the ninth review round, 2026-11-04, D-10: a URL listed twice had counted as two). A module of
// its own, free of the chain client: Home's posture and the Privacy Center count the endpoints without loading viem.
export const rpcUrlsOf = (d: { rpcUrl: string; rpcUrls?: readonly string[] }): string[] => [...new Set(d.rpcUrls?.length ? d.rpcUrls : [d.rpcUrl])];
