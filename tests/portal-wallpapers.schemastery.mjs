// Just enough of @deepseek-ai/schemastery to load a plugin module: every
// builder returns another builder, and no validation is performed.
const chainable = () => {
  const value = () => chainable();
  return new Proxy(value, { get: () => chainable(), apply: () => chainable() });
};
const z = {
  object: (shape) => ({ shape, default: () => ({ shape }), description: () => ({ shape }) }),
  string: chainable,
  boolean: chainable,
  number: chainable,
};
export default z;
