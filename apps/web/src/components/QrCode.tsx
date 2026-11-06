// A QR code drawn as inline SVG (qrcode-generator: paths only, no style the page's policy would refuse): Receive's address, a WalletConnect
// pairing's link (the eleventh review round, slice 6c).
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** `label`: the image's accessible name, when the code stands for something no text beside it says. `large`: a code dense enough to need it. */
export function QrCode({ text, testId, label, large }: { text: string; testId: string; label?: string; large?: boolean }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return (
    <div
      className={large ? "ds-qr ds-qr-lg" : "ds-qr"}
      data-testid={testId}
      role={label ? "img" : undefined}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
