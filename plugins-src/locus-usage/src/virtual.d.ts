/* esbuild 虚拟模块的类型面（必须住在非模块 d.ts 里才是环境声明）。 */
declare module 'virtual:tailwind.css' {
  const css: string;
  export default css;
}
