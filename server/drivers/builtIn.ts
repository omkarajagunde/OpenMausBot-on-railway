import type { AnyProviderDriver } from "../contracts.ts";
import { ClaudeDriver } from "./claude.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [ClaudeDriver];
