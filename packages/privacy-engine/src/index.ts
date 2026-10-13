// The privacy engine (doc §59, §64–§65; spec v2.0 §14): the wallet's one network edge — the HTTP transport and its policy,
// the PrivacyTransport every chain read and broadcast goes through — and the privacy measures.
export {
  POLICY,
  TransportRefusal,
  allowHosts,
  allowedHosts,
  checkUrl,
  fetchFor,
  fetchJson,
  hostOf,
  isStrict,
  onRequest,
  secureFetch,
  setStrict,
  viemTransport,
  type JsonResult,
  type Purpose,
  type RequestRecord,
} from "./transport/http";
export { privacyTransport, publicClientFor, type ChainBlock, type ContractRead, type LogQuery, type PrivacyTransport } from "./transport/chain";
export { computePrivacy, type PrivacyFactors, type PrivacyReport, type Risk } from "./privacyScore";
