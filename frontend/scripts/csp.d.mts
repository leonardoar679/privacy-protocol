// Types of scripts/csp.mjs for vite.config.ts and the tests (the script itself stays plain JavaScript: Node runs it).
import type { Plugin } from "vite";

export declare const SECURITY_HEADERS: Readonly<Record<string, string>>;
export declare function originOf(value: unknown): string | null;
export declare function connectHosts(env?: Record<string, string | undefined>, extra?: string[]): string[];
export declare function zkapiHosts(configPath?: string): string[];
export declare function buildCsp(env?: Record<string, string | undefined>, extra?: string[]): string;
export declare function cspMeta(env?: Record<string, string | undefined>, extra?: string[]): { tag: "meta"; attrs: Record<string, string>; injectTo: "head-prepend" };
export declare function cspPlugin(env?: Record<string, string | undefined>, extra?: string[]): Plugin;
export declare function cspOfHtml(html: string): string | null;
