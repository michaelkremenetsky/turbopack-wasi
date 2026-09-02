// Mirror teable's next.config experimental options to test whether they break
// turbopack-wasi page discovery.
module.exports = {
  experimental: {
    esmExternals: true,
    externalDir: true,
  },
};
