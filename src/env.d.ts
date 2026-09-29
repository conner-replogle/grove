declare module '*.css' {
  const css: string
  export default css
}
declare module '*.svg' {
  const svg: string
  export default svg
}
declare module '/tab_strip_api/*' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any
  export = mod
}
