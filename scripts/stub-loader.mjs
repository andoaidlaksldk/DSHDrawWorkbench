/** 把官方依赖解析到本地替身，仅用于 `scripts/verify.mjs` / `scripts/smoke.mjs`。 */
const STUBS = new Map([
  ['@deepseek-ai/schemastery', './stubs/schemastery.js'],
  ['@deepseek-ai/dsh-tools', './stubs/dsh-tools.js']
])

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub) return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
