/** Bound a UI read without letting a late answer overwrite the retry's result. */
export function readWithTimeout(read, milliseconds = 15_000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(read),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The read took too long. Try again.")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
