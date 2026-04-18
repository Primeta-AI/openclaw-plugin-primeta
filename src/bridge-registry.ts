import type { PrimetaBridge } from "./primeta-bridge.js";

const bridges = new Map<string, PrimetaBridge>();

export function registerBridge(accountId: string, bridge: PrimetaBridge): void {
  bridges.set(accountId, bridge);
}

export function unregisterBridge(accountId: string): void {
  bridges.delete(accountId);
}

export function getBridge(accountId: string): PrimetaBridge | undefined {
  return bridges.get(accountId);
}
