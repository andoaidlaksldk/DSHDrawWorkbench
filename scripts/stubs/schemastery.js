/**
 * 校验用的 `@deepseek-ai/schemastery` 替身。
 *
 * 真实依赖由宿主注入（见 package.json 的 dependencies）。`scripts/verify.mjs`
 * 在不安装依赖的前提下加载 `dsh/index.js`，只需要它能声明 `Config` 的形状。
 */
class Field {
  constructor(type) {
    this.type = type
    this.isRequired = false
  }

  required() {
    this.isRequired = true
    return this
  }
}

const Schema = {
  string: () => new Field('string'),
  number: () => new Field('number'),
  boolean: () => new Field('boolean'),
  object: (shape) => ({ type: 'object', shape })
}

export default Schema
