declare module '*.css'

declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module '*.png' {
  const url: string
  export default url
}
