// Connect ignores returned promises. Forward failures to its error chain instead of crashing the harness.
// Registers ordinary three-argument middleware, not four-argument error handlers.
function useAsyncMiddleware(middlewares, handler) {
  return middlewares.use((request, response, next) => {
    const onError = (reason) => {
      // Connect treats a falsy value as fallthrough, even when a promise rejected with it.
      next(reason || new Error("Middleware failed without an error", { cause: reason }));
    };
    return new Promise((resolve) => resolve(handler(request, response, next))).catch(onError);
  });
}

module.exports = { useAsyncMiddleware };
