const deniedFetch = async input => {
  let target = 'unknown';
  try { target = new URL(typeof input === 'string' ? input : input?.url).origin; } catch {}
  throw new Error(`Unexpected network request blocked by tests: ${target}`);
};

Object.defineProperty(globalThis, '__NEWS_TEST_DENIED_FETCH__', {
  value: deniedFetch,
  configurable: false,
  enumerable: false,
  writable: false,
});

globalThis.fetch = deniedFetch;
