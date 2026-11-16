class LinearError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LinearError";
    this.code = code;
  }
}

module.exports = { LinearError };
