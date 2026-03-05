export class LocatorCache {
  private readonly store = new Map<string, string>();

  get(siteKey: string, actionKey: string): string | undefined {
    return this.store.get(this.key(siteKey, actionKey));
  }

  set(siteKey: string, actionKey: string, locator: string): void {
    this.store.set(this.key(siteKey, actionKey), locator);
  }

  private key(siteKey: string, actionKey: string): string {
    return `${siteKey}::${actionKey}`;
  }
}

