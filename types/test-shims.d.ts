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
