declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  export default function test(name: string, body: TestBody): void;
}

declare module "node:assert/strict" {
  type ThrowsMatcher = RegExp | ((error: unknown) => boolean);

  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(block: () => unknown, error?: ThrowsMatcher, message?: string): void;
    rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      error?: ThrowsMatcher,
      message?: string,
    ): Promise<void>;
  };

  export default assert;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function realpath(path: string): Promise<string>;
  export function stat(path: string): Promise<{ isFile(): boolean }>;
  export function symlink(target: string, path: string): Promise<void>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export function sep(): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      shell?: boolean;
      signal?: AbortSignal;
    },
  ): {
    stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
    stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
    kill(signal?: string): void;
  };
}

declare const Buffer: {
  from(data: Uint8Array | string): {
    includes(value: number): boolean;
    toString(encoding?: string): string;
  };
};

declare const process: {
  execPath: string;
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  cwd(): string;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};
