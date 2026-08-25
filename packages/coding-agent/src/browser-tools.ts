import type { JsonObject, ToolDefinition } from "../../ai/dist/index.js";

export type BrowserNavigateArgs = {
  url: string;
  headless?: boolean;
};

export type BrowserSnapshotArgs = {
  maxTextLength?: number;
};

export type BrowserClickArgs = {
  selector: string;
};

export type BrowserTypeArgs = {
  selector: string;
  text: string;
  submit?: boolean;
};

export type BrowserElementSummary = {
  tag: string;
  text?: string;
  selector?: string;
};

export type BrowserSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: BrowserElementSummary[];
};

export type BrowserAdapter = {
  navigate(args: BrowserNavigateArgs, signal?: AbortSignal): Promise<string>;
  snapshot(args?: BrowserSnapshotArgs, signal?: AbortSignal): Promise<BrowserSnapshot>;
  click(args: BrowserClickArgs, signal?: AbortSignal): Promise<string>;
  type(args: BrowserTypeArgs, signal?: AbortSignal): Promise<string>;
  close(signal?: AbortSignal): Promise<string>;
};

export type BrowserToolOptions = {
  adapter?: BrowserAdapter;
};

type PlaywrightPage = {
  goto(url: string): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  locator(selector: string): {
    click(): Promise<unknown>;
    fill(text: string): Promise<unknown>;
    press(key: string): Promise<unknown>;
  };
  evaluate<T>(fn: (maxTextLength: number) => T, maxTextLength: number): Promise<T>;
};

type PlaywrightBrowser = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<unknown>;
};

type PlaywrightModule = {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
  };
};

type PlaywrightLoader = () => Promise<PlaywrightModule>;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireUrl(value: unknown): string {
  const url = requireString(value, "url");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("browser_navigate only supports http and https URLs");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "browser_navigate only supports http and https URLs") throw error;
    throw new Error(`Invalid URL: ${url}`);
  }
  return url;
}

async function loadPlaywrightWith(loader: PlaywrightLoader): Promise<PlaywrightModule> {
  try {
    return await loader();
  } catch (error) {
    throw new Error(
      `Playwright is required for browser tools. Install it with "npm install -D playwright" and "npx playwright install chromium". Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return (await dynamicImport("playwright")) as PlaywrightModule;
}

export function createPlaywrightBrowserAdapter(options: { loadPlaywright?: PlaywrightLoader } = {}): BrowserAdapter {
  let browser: PlaywrightBrowser | undefined;
  let page: PlaywrightPage | undefined;

  async function ensurePage(headless = true): Promise<PlaywrightPage> {
    if (page) return page;
    const playwright = await loadPlaywrightWith(options.loadPlaywright ?? loadPlaywright);
    browser = await playwright.chromium.launch({ headless });
    page = await browser.newPage();
    return page;
  }

  return {
    async navigate(args, signal) {
      assertNotAborted(signal);
      const target = requireUrl(args.url);
      const activePage = await ensurePage(args.headless ?? true);
      await activePage.goto(target);
      return `Navigated to ${target}`;
    },
    async snapshot(args, signal) {
      assertNotAborted(signal);
      const activePage = await ensurePage();
      const maxTextLength = args?.maxTextLength ?? 4_000;
      return {
        url: activePage.url(),
        title: await activePage.title(),
        ...(await activePage.evaluate((limit) => {
          const text = (document.body?.innerText ?? "").slice(0, limit);
          const elements = [...document.querySelectorAll("a,button,input,textarea,select")]
            .slice(0, 40)
            .map((element, index) => {
              const tag = element.tagName.toLowerCase();
              const label =
                element.getAttribute("aria-label") ??
                element.getAttribute("placeholder") ??
                element.textContent?.trim() ??
                element.getAttribute("value") ??
                "";
              const id = element.id ? `#${CSS.escape(element.id)}` : undefined;
              const selector = id ?? `${tag}:nth-of-type(${index + 1})`;
              return { tag, text: label.slice(0, 120), selector };
            });
          return { text, elements };
        }, maxTextLength)),
      };
    },
    async click(args, signal) {
      assertNotAborted(signal);
      const selector = requireString(args.selector, "selector");
      const activePage = await ensurePage();
      await activePage.locator(selector).click();
      return `Clicked ${selector}`;
    },
    async type(args, signal) {
      assertNotAborted(signal);
      const selector = requireString(args.selector, "selector");
      const text = requireString(args.text, "text");
      const activePage = await ensurePage();
      const locator = activePage.locator(selector);
      await locator.fill(text);
      if (args.submit === true) await locator.press("Enter");
      return `Typed into ${selector}`;
    },
    async close(signal) {
      assertNotAborted(signal);
      await browser?.close();
      browser = undefined;
      page = undefined;
      return "Browser closed";
    },
  };
}

export function createBrowserTools(options: BrowserToolOptions = {}): ToolDefinition[] {
  const adapter = options.adapter ?? createPlaywrightBrowserAdapter();
  return [
    {
      name: "browser_navigate",
      description: "Navigate an isolated browser page to an http or https URL",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 1 },
          headless: { type: "boolean" },
        },
      },
      execute: (args, signal) => adapter.navigate(args as BrowserNavigateArgs, signal as AbortSignal | undefined),
    },
    {
      name: "browser_snapshot",
      description: "Return a compact text and element snapshot of the current browser page",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxTextLength: { type: "number", minimum: 1 },
        },
      },
      execute: (args, signal) => adapter.snapshot(args as BrowserSnapshotArgs, signal as AbortSignal | undefined),
    },
    {
      name: "browser_click",
      description: "Click a browser element by CSS selector from a previous snapshot",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector"],
        properties: {
          selector: { type: "string", minLength: 1 },
        },
      },
      execute: (args, signal) => adapter.click(args as BrowserClickArgs, signal as AbortSignal | undefined),
    },
    {
      name: "browser_type",
      description: "Fill a browser element by CSS selector and optionally submit with Enter",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector", "text"],
        properties: {
          selector: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          submit: { type: "boolean" },
        },
      },
      execute: (args, signal) => adapter.type(args as BrowserTypeArgs, signal as AbortSignal | undefined),
    },
    {
      name: "browser_close",
      description: "Close the active browser session",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: (_args: JsonObject, signal) => adapter.close(signal as AbortSignal | undefined),
    },
  ];
}
