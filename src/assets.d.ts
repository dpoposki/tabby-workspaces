// webpack bundles .css files as their text (asset/source), see webpack.config.js
declare module '*.css' {
    const text: string
    export default text
}
