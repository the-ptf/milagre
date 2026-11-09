export function readWithTimeout<T>(read: () => Promise<T>, milliseconds?: number): Promise<T>;
