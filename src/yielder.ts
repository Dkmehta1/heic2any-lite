/** Lets the browser paint/handle input between chunks of work so large photos don't freeze the page. */
export function createYielder(enabled: boolean): { yieldNow: () => Promise<void>; dispose: () => void } {
  if (!enabled) return { yieldNow: () => Promise.resolve(), dispose: () => undefined };
  if (typeof MessageChannel !== 'undefined' && typeof window !== 'undefined') {
    const channel = new MessageChannel();
    const queue: (() => void)[] = [];
    channel.port1.onmessage = () => queue.shift()?.();
    return {
      yieldNow: () =>
        new Promise<void>((resolve) => {
          queue.push(resolve);
          channel.port2.postMessage(0);
        }),
      dispose: () => {
        channel.port1.close();
        channel.port2.close();
      },
    };
  }
  return { yieldNow: () => new Promise<void>((resolve) => setTimeout(resolve, 0)), dispose: () => undefined };
}
