import { AsyncLocalStorage } from 'node:async_hooks';

const actionId = new AsyncLocalStorage<string>();

export function currentGraphActionId(): string | undefined {
  return actionId.getStore();
}

export function withGraphActionId<T>(id: string, work: () => Promise<T>): Promise<T> {
  return actionId.run(id, work);
}
