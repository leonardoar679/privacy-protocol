// The words of an error that leave a service (a V6 follow-up of 2026-10-15): a URL keeps its scheme and host and loses its
// credentials, path, query and fragment, where RPC and provider keys live (an Alchemy- or Infura-style RPC URL carries its
// key in the path, and viem writes the whole URL, with the request's body, into every error it throws).

const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'<>]+)([^\s"'<>]*)/gi;

/** Every URL in `text` as its scheme and host (and port), with "/…" where it had more. */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (_m, scheme: string, authority: string, rest: string) => {
    const host = authority.slice(authority.lastIndexOf("@") + 1); // credentials before an "@" go
    const path = rest.replace(/[),.;:\]]+$/, ""); // punctuation after a URL belongs to the sentence
    return `${scheme}://${host}${path && path !== "/" ? "/…" : ""}${rest.slice(path.length)}`;
  });
}
