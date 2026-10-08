// Hand the user a file from this tab (a backup, an order export): a Blob URL, clicked, revoked. Nothing leaves the device.
export function downloadText(name: string, text: string, type = "application/json"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
