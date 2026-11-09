// Test-only resolution hook: the plugin's host half imports the platform's
// schema package at runtime, and the development checkout has no node_modules.
// Map that one specifier to a stub so the host half can be unit-tested here.
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./portal-wallpapers.schemastery.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
