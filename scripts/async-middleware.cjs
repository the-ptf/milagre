function useAsyncMiddleware(middlewares, handler) {
  return middlewares.use((request, response, next) => {
    const onError = (reason) => {
      next(reason || new Error("Middleware failed without an error", { cause: reason }));
    };
    return new Promise((resolve) => resolve(handler(request, response, next))).catch(onError);
  });
}

module.exports = { useAsyncMiddleware };
