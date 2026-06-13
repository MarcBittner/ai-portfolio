/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as evals from "../evals.js";
import type * as extract from "../extract.js";
import type * as invoices from "../invoices.js";
import type * as lib_demoData from "../lib/demoData.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_parse from "../lib/parse.js";
import type * as lib_reconcile from "../lib/reconcile.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  evals: typeof evals;
  extract: typeof extract;
  invoices: typeof invoices;
  "lib/demoData": typeof lib_demoData;
  "lib/llm": typeof lib_llm;
  "lib/parse": typeof lib_parse;
  "lib/reconcile": typeof lib_reconcile;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
