import { runInContext, createContext as vmCreateContext } from 'node:vm';
import seedrandom from 'seedrandom';
import { createRandomUUID } from './uuid.js';

export interface CreateContextOptions {
  seed: string;
  // Fixed timestamp for deterministic Date operations
  fixedTimestamp: number;
}

/**
 * Creates a Node.js `vm.Context` configured for deterministic workflow execution,
 * with additional hardening to reduce sandbox-escape risk.
 */
export function createContext(options: CreateContextOptions) {
  let { fixedTimestamp } = options;
  const { seed } = options;
  const rng = seedrandom(seed);

  /**
   * IMPORTANT SECURITY FIX:
   * - Disable code generation from strings (blocks Function("...") and eval("..."))
   * - Disable wasm codegen too
   */
  const context = vmCreateContext(Object.create(null), {
    name: 'workflow-vm',
    codeGeneration: { strings: false, wasm: false },
  });

  const g: typeof globalThis = runInContext('globalThis', context);

  /**
   * Harden intrinsics INSIDE the VM context (do not freeze host prototypes).
   * This reduces common prototype-chain escapes like `this.constructor.constructor`.
   */
  runInContext(
    `
    'use strict';
    (function hardenIntrinsics() {
      // Remove dangerous globals if present
      try { globalThis.eval = undefined; } catch {}
      try { globalThis.Function = undefined; } catch {}

      // Break classic constructor-chain escape: this.constructor.constructor
      // (Tradeoff: code relying on constructor may break, but it is safer)
      try {
        Object.defineProperty(Object.prototype, 'constructor', {
          value: null, writable: false, configurable: false, enumerable: false,
        });
      } catch {}

      try {
        Object.defineProperty(Function.prototype, 'constructor', {
          value: null, writable: false, configurable: false, enumerable: false,
        });
      } catch {}

      // Freeze core prototypes to prevent prototype pollution inside the sandbox
      try { Object.freeze(Object.prototype); } catch {}
      try { Object.freeze(Function.prototype); } catch {}
      try { Object.freeze(Array.prototype); } catch {}
      try { Object.freeze(String.prototype); } catch {}
      try { Object.freeze(Number.prototype); } catch {}
      try { Object.freeze(Boolean.prototype); } catch {}
      try { Object.freeze(RegExp.prototype); } catch {}
      try { Object.freeze(Date.prototype); } catch {}
    })();
  `,
    context
  );

  // -------------------------
  // Deterministic Math.random()
  // -------------------------
  g.Math.random = rng;

  // -------------------------
  // Deterministic Date
  // -------------------------
  const Date_ = g.Date;

  // Shadow global Date constructor to make it deterministic
  (g as any).Date = function Date(
    ...args: Parameters<(typeof globalThis)['Date']>
  ) {
    if (args.length === 0) {
      return new Date_(fixedTimestamp);
    }
    // @ts-expect-error - Date constructor arguments
    return new Date_(...args);
  };

  (g as any).Date.prototype = Date_.prototype;
  Object.setPrototypeOf(g.Date, Date_);
  g.Date.now = () => fixedTimestamp;

  // -------------------------
  // Deterministic crypto (safe wrapper; no host mutation)
  // -------------------------
  const originalCrypto = globalThis.crypto;
  const originalSubtle = originalCrypto.subtle;
  const boundDigest = originalSubtle.digest.bind(originalSubtle);

  function getRandomValues(array: Uint8Array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(rng() * 256);
    }
    return array;
  }

  const randomUUID = createRandomUUID(rng);

  // Provide a minimal crypto surface; avoid Proxying host crypto if possible
  (g as any).crypto = Object.freeze({
    getRandomValues,
    randomUUID,
    subtle: Object.freeze({
      digest: boundDigest,
    }),
  });

  // -------------------------
  // SECURITY FIX: Do NOT expose host process.env
  // -------------------------
  (g as any).process = Object.freeze({
    env: Object.freeze({}),
  });

  // -------------------------
  // Stateless + synchronous Web APIs (only if required)
  // NOTE: Passing host references into the sandbox increases coupling.
  // Keep this minimal.
  // -------------------------
  g.Headers = globalThis.Headers;
  g.TextEncoder = globalThis.TextEncoder;
  g.TextDecoder = globalThis.TextDecoder;
  g.URL = globalThis.URL;
  g.URLSearchParams = globalThis.URLSearchParams;
  g.structuredClone = globalThis.structuredClone;

  // Wrap console (avoid exposing raw console object directly)
  (g as any).console = Object.freeze({
    log: (...args: any[]) => console.log(...args),
    warn: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args),
  });

  // HACK: Shim exports/module for the bundle
  (g as any).exports = {};
  (g as any).module = { exports: (g as any).exports };

  return {
    context,
    globalThis: g,
    updateTimestamp: (timestamp: number) => {
      fixedTimestamp = timestamp;
    },
  };
}
