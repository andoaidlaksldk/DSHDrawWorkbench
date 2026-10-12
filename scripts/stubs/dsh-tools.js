/**
 * 校验用的 `@deepseek-ai/dsh-tools` 替身。
 *
 * 真实实现会把「参数 spec 方言」编译成 JSON Schema、校验 execute 的返回值，
 * 并挂上呈现器。替身只保留本仓库自检真正需要断言的部分：
 * 保存 name/description/parameters，对 required 参数做最小校验，
 * 让 `verify` 能**真的调用**这些工具、检查它们写出来的导图。
 */
export function defineTool(options) {
  if (!options || typeof options.name !== 'string' || !options.name) throw new Error('defineTool: name is required')
  if (typeof options.description !== 'string' || !options.description) throw new Error('defineTool: description is required')
  if (typeof options.execute !== 'function') throw new Error('defineTool: execute is required')
  const parameters = options.parameters && typeof options.parameters === 'object' ? options.parameters : {}
  const required = Object.entries(parameters)
    .filter(([, spec]) => spec && spec.required === true)
    .map(([key]) => key)
  return {
    name: options.name,
    description: options.description,
    parameters,
    required,
    output: options.output,
    execute: async (args, exec) => {
      for (const key of required) {
        if (args == null || args[key] === undefined) throw new Error(`invalid arguments: ${key} is required`)
      }
      return options.execute(args, exec)
    }
  }
}

export function assertSupportedJsonSchema() {}
export function validateJsonSchemaValue() {
  return []
}
