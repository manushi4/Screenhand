import { DEFAULT_ACTION_BUDGET } from "../config.js";
import type { TimelineLogger } from "../logging/timeline-logger.js";
import type {
  ActionBudget,
  ActionTelemetry,
  LocatedElement,
  LocatorAttempt,
  PageMeta,
  PressInput,
  RuntimeError,
  Target,
  ToolResult,
  TypeIntoInput,
} from "../types.js";
import type { AppAdapter } from "./app-adapter.js";
import type { LocatorCache } from "./locator-cache.js";

interface LocateResult {
  element: LocatedElement;
  attempts: LocatorAttempt[];
}

export class Executor {
  constructor(
    private readonly adapter: AppAdapter,
    private readonly cache: LocatorCache,
    private readonly logger: TimelineLogger,
  ) {}

  async press(input: PressInput): Promise<ToolResult<PageMeta>> {
    const telemetry = this.logger.start("press", input.sessionId);
    const budget = this.resolveBudget(input.budget);
    const attempts: LocatorAttempt[] = [];
    let lastError: RuntimeError | undefined;

    for (let retry = 0; retry <= budget.maxRetries; retry += 1) {
      telemetry.retries = retry;
      try {
        const siteKey = await this.currentSiteKey(input.sessionId);
        const actionKey = this.targetToKey(input.target);
        const locateResult = await this.locateWithBudget(
          input.sessionId,
          siteKey,
          actionKey,
          input.target,
          budget.locateMs,
          retry > 0,
        );
        attempts.push(...locateResult.attempts);
        telemetry.locateMs += locateResult.attempts.reduce(
          (sum, attempt) => sum + attempt.timeoutMs,
          0,
        );

        await this.timed(
          budget.actMs,
          async () => {
            await this.adapter.click(input.sessionId, locateResult.element);
          },
          "ACTION_FAILED",
        );
        telemetry.actMs += budget.actMs;

        if (input.verify) {
          const verified = await this.timed(
            budget.verifyMs,
            () => this.adapter.waitFor(input.sessionId, input.verify!, budget.verifyMs),
            "VERIFY_FAILED",
          );
          telemetry.verifyMs += budget.verifyMs;
          if (!verified) {
            throw this.runtimeError("VERIFY_FAILED", "Verification condition not met.");
          }
        }

        const page = await this.adapter.getPageMeta(input.sessionId);
        return this.success(page, telemetry);
      } catch (error) {
        lastError = this.asRuntimeError(error, attempts);
      }
    }

    return this.failure(
      lastError ??
        this.runtimeError("ACTION_FAILED", "Press failed with unknown runtime error."),
      telemetry,
    );
  }

  async typeInto(input: TypeIntoInput): Promise<ToolResult<PageMeta>> {
    const telemetry = this.logger.start("type_into", input.sessionId);
    const budget = this.resolveBudget(input.budget);
    const attempts: LocatorAttempt[] = [];

    try {
      const siteKey = await this.currentSiteKey(input.sessionId);
      const actionKey = `type:${this.targetToKey(input.target)}`;
      const locateResult = await this.locateWithBudget(
        input.sessionId,
        siteKey,
        actionKey,
        input.target,
        budget.locateMs,
        false,
      );
      attempts.push(...locateResult.attempts);
      telemetry.locateMs += budget.locateMs;

      await this.timed(
        budget.actMs,
        async () => {
          await this.adapter.setValue(
            input.sessionId,
            locateResult.element,
            input.text,
            input.clear ?? true,
          );
        },
        "ACTION_FAILED",
      );
      telemetry.actMs += budget.actMs;

      if (input.verifyValue ?? true) {
        const read = await this.adapter.getValue(input.sessionId, locateResult.element);
        if (read !== input.text) {
          throw this.runtimeError(
            "VERIFY_FAILED",
            `Field value mismatch. Expected "${input.text}", got "${read}".`,
          );
        }
      }

      if (input.verify) {
        const verified = await this.timed(
          budget.verifyMs,
          () => this.adapter.waitFor(input.sessionId, input.verify!, budget.verifyMs),
          "VERIFY_FAILED",
        );
        telemetry.verifyMs += budget.verifyMs;
        if (!verified) {
          throw this.runtimeError("VERIFY_FAILED", "Verification condition not met.");
        }
      }

      const page = await this.adapter.getPageMeta(input.sessionId);
      return this.success(page, telemetry);
    } catch (error) {
      return this.failure(this.asRuntimeError(error, attempts), telemetry);
    }
  }

  private async locateWithBudget(
    sessionId: string,
    siteKey: string,
    actionKey: string,
    target: Target,
    locateBudgetMs: number,
    skipCache: boolean,
  ): Promise<LocateResult> {
    const attempts: LocatorAttempt[] = [];
    const strategyBudget = Math.max(50, Math.floor(locateBudgetMs / 3));

    if (!skipCache) {
      const cachedLocator = this.cache.get(siteKey, actionKey);
      if (cachedLocator) {
        const cachedTarget: Target = { type: "selector", value: cachedLocator };
        const match = await this.tryLocate(
          sessionId,
          "cache",
          cachedTarget,
          strategyBudget,
          attempts,
        );
        if (match) {
          return { element: match, attempts };
        }
      }
    }

    const strategies = this.expandTargetStrategies(target);
    for (const strategy of strategies) {
      const match = await this.tryLocate(
        sessionId,
        strategy.strategy,
        strategy.target,
        strategyBudget,
        attempts,
      );
      if (match) {
        if (strategy.target.type === "selector") {
          this.cache.set(siteKey, actionKey, strategy.target.value);
        }
        return { element: match, attempts };
      }
    }

    throw this.runtimeError("LOCATE_FAILED", "Could not locate target.", attempts);
  }

  private async tryLocate(
    sessionId: string,
    strategyName: string,
    target: Target,
    timeoutMs: number,
    attempts: LocatorAttempt[],
  ): Promise<LocatedElement | null> {
    try {
      const found = await this.timed(
        timeoutMs,
        () => this.adapter.locate(sessionId, target, timeoutMs),
        "LOCATE_FAILED",
      );
      attempts.push({
        strategy: strategyName,
        target: this.targetToKey(target),
        timeoutMs,
        matched: Boolean(found),
      });
      return found;
    } catch (error) {
      attempts.push({
        strategy: strategyName,
        target: this.targetToKey(target),
        timeoutMs,
        matched: false,
        reason: error instanceof Error ? error.message : "Unknown locate error",
      });
      return null;
    }
  }

  private expandTargetStrategies(
    target: Target,
  ): Array<{ strategy: string; target: Target }> {
    if (target.type === "selector") {
      return [{ strategy: "selector", target }];
    }
    if (target.type === "text") {
      return [
        { strategy: "text_exact", target: { type: "text", value: target.value, exact: true } },
        { strategy: "text_fuzzy", target: { type: "text", value: target.value, exact: false } },
      ];
    }
    if (target.type === "role") {
      return [
        { strategy: "role_name_exact", target: { type: "role", role: target.role, name: target.name, exact: true } },
        { strategy: "role_name_fuzzy", target: { type: "role", role: target.role, name: target.name, exact: false } },
        { strategy: "fallback_text", target: { type: "text", value: target.name } },
      ];
    }
    // For new target types (ax_path, ax_attribute, coordinates, image), pass through directly
    return [{ strategy: target.type, target }];
  }

  private async currentSiteKey(sessionId: string): Promise<string> {
    // Try app context first for desktop apps, fall back to page URL for browsers
    try {
      const ctx = await this.adapter.getAppContext(sessionId);
      if (ctx.url) {
        try {
          return new URL(ctx.url).host || ctx.bundleId;
        } catch {
          // URL parsing failed, use bundleId + windowTitle
        }
      }
      return `${ctx.bundleId}::${ctx.windowTitle}`;
    } catch {
      // Fallback to page meta
      try {
        const page = await this.adapter.getPageMeta(sessionId);
        return new URL(page.url).host || "unknown-site";
      } catch {
        return "unknown-site";
      }
    }
  }

  private resolveBudget(input?: Partial<ActionBudget>): ActionBudget {
    return {
      ...DEFAULT_ACTION_BUDGET,
      ...input,
    };
  }

  private async timed<T>(
    timeoutMs: number,
    operation: () => Promise<T>,
    errorCode: RuntimeError["code"],
  ): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(this.runtimeError("TIMEOUT", `Timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (this.isRuntimeError(error)) {
        throw error;
      }
      throw this.runtimeError(
        errorCode,
        error instanceof Error ? error.message : "Unexpected runtime error",
      );
    }
  }

  private targetToKey(target: Target): string {
    switch (target.type) {
      case "selector":
        return `selector:${target.value}`;
      case "text":
        return `text:${target.value}`;
      case "role":
        return `role:${target.role}|name:${target.name}`;
      case "ax_path":
        return `ax_path:${target.path.join("/")}`;
      case "ax_attribute":
        return `ax_attr:${target.attribute}=${target.value}`;
      case "coordinates":
        return `coords:${target.x},${target.y}`;
      case "image":
        return `image:${target.base64.slice(0, 20)}`;
    }
  }

  private success<T>(data: T, telemetry: ActionTelemetry): ToolResult<T> {
    return {
      ok: true,
      data,
      telemetry: this.logger.finish(telemetry, "success"),
    };
  }

  private failure<T>(error: RuntimeError, telemetry: ActionTelemetry): ToolResult<T> {
    return {
      ok: false,
      error,
      telemetry: this.logger.finish(telemetry, "failed"),
    };
  }

  private runtimeError(
    code: RuntimeError["code"],
    message: string,
    attempts?: LocatorAttempt[],
  ): RuntimeError {
    const error: RuntimeError = { code, message };
    if (attempts && attempts.length > 0) {
      error.attempts = attempts;
    }
    return error;
  }

  private isRuntimeError(error: unknown): error is RuntimeError {
    if (typeof error !== "object" || error === null) {
      return false;
    }
    return "code" in error && "message" in error;
  }

  private asRuntimeError(error: unknown, attempts?: LocatorAttempt[]): RuntimeError {
    if (this.isRuntimeError(error)) {
      if (error.attempts || !attempts || attempts.length === 0) {
        return error;
      }
      return {
        ...error,
        attempts,
      };
    }
    return this.runtimeError(
      "ACTION_FAILED",
      error instanceof Error ? error.message : "Unexpected runtime error",
      attempts,
    );
  }
}
