// The motion helpers (spec v2.0 §5): the token durations as CSS transitions, and the user's reduced-motion preference
// for the few places a component animates from script. The keyframes live in keyframes.css (imported by base.css).
import { MOTION } from "../tokens/index";

export type Speed = "fast" | "base" | "slow";

/** A CSS transition over the token duration and easing, e.g. transition("opacity", "fast"). */
export const transition = (property: string, speed: Speed = "base"): string => `${property} var(--motion-${speed}) var(--ease)`;

/** The duration in milliseconds, 0 when the user asked for reduced motion. */
export function durationMs(speed: Speed = "base"): number {
  return prefersReducedMotion() ? 0 : MOTION[speed];
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
