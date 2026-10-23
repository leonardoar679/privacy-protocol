// Hand the user a file from this tab (a backup, an order export): a Blob URL, clicked, revoked. Nothing leaves the device.

/**
 * How long a file's Blob URL stays readable after the click (audit round 2, n37): iOS Safari reads it only once the user has
 * answered its "Download?" prompt, and a URL revoked after a second gave a backup file that never saved. A minute, as
 * FileSaver.js keeps its own (40 s); the memory is the file's, freed then.
 */
export const DOWNLOAD_URL_MS = 60_000;

export function downloadText(name: string, text: string, type = "application/json"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_MS);
}
