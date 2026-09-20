#!/usr/bin/env node
/**
 * 客户端 bundle 的契约测试。
 *
 * 浏览器加载这个文件的方式是：当作普通脚本执行 → 它调用
 * window.__ModuleLoader__.load({id, factory}) → 浏览器按 id 索引 factory，
 * 在需要时调用 factory(require) 拿到插件导出。
 *
 * 所以这里就照那条路径真的跑一遍，而不是只做语法检查：
 *   1. 作为**脚本**（非模块）能否解析
 *   2. 是否恰好注册一次，且 id 与 package.json 的 name 完全一致
 *   3. factory(require) 返回的对象是否含 name / inject / apply
 *   4. apply(fakeCtx) 是否真的往两个插槽各注册了一次
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

// --- 1. 必须是合法脚本，且不能含模块语法 ---
let run
try {
  run = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', source)
  check('作为普通脚本可解析', true)
} catch (e) {
  check('作为普通脚本可解析', false, e.message)
  process.exit(1)
}
check('不含 import/export 语句',
  !/^\s*(import|export)\s/m.test(source))

// --- 2. 捕获注册 ---
const captured = []
const styleNodes = []
const fakeDocument = {
  createElement() {
    const node = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, remove() {} }
    styleNodes.push(node)
    return node
  },
  head: { appendChild() {} },
}

run(
  { __ModuleLoader__: { load(registration) { captured.push(registration) } } },
  fakeDocument,
  async () => ({ json: async () => ({}) }),
  () => 0,
  () => {},
)

check('恰好注册一次', captured.length === 1, `实际 ${captured.length} 次`)
check("注册 id 与 package.json 的 name 一致", captured[0] && captured[0].id === pkg.name,
  `注册 id=${captured[0] && captured[0].id}，包名=${pkg.name}`)
check('提供了 factory 函数', captured[0] && typeof captured[0].factory === 'function')

// --- 3. factory 的产物 ---
const required = []
const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
}
const fakeRequire = (spec) => {
  required.push(spec)
  if (spec === 'react') return fakeReact
  throw new Error('未在种子表内: ' + spec)
}

let plugin
try {
  plugin = captured[0].factory(fakeRequire)
} catch (e) {
  check('factory(require) 可执行', false, e.message)
  process.exit(1)
}
check('factory(require) 可执行', true)
check('只向 require 索取种子表内的模块',
  required.every((s) => s === 'react'), required.join(', '))
check('导出 name', plugin && plugin.name === pkg.name, String(plugin && plugin.name))
check('导出 apply 函数', plugin && typeof plugin.apply === 'function')
check('导出 inject 数组且含 slots',
  plugin && Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
  JSON.stringify(plugin && plugin.inject))

// --- 4. apply 真的注册到插槽 ---
const injected = []
const registrations = []
const fakeCtx = {
  effect(fn) { return fn() },
  slots: {
    inject(name, factory) { injected.push(name); registrations.push(factory()) },
    register(spec) { return spec },
  },
}
let applyError = null
try {
  plugin.apply(fakeCtx)
} catch (e) {
  applyError = e
}
check('apply(ctx) 不抛异常', applyError === null, applyError && applyError.message)
check('注入 sidebar.panellist', injected.includes('sidebar.panellist'), injected.join(', '))
check('注入 main', injected.includes('main'), injected.join(', '))
check('插入了一个 <style> 节点', styleNodes.length === 1, `实际 ${styleNodes.length} 个`)
check('style 节点带 data-dsh-taskwatch 标记',
  styleNodes[0] && styleNodes[0].attrs['data-dsh-taskwatch'] !== undefined)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
