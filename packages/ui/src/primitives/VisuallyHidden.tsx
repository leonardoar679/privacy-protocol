// Text for assistive technology only (spec §19).
import * as RV from "@radix-ui/react-visually-hidden";
import type { ReactNode } from "react";

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <RV.Root>{children}</RV.Root>;
}
