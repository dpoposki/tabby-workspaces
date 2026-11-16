const path = require('path')

module.exports = {
    target: 'node',
    entry: './src/index.ts',
    devtool: false,
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
    },
    optimization: { minimize: false },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [
            { test: /\.ts$/, loader: 'ts-loader' },
            // Stylesheets are bundled as plain strings (see launcher.ts)
            { test: /\.css$/, type: 'asset/source' },
        ],
    },
    // Everything Tabby already ships is provided at runtime
    externals: [
        'fs', 'path', 'os', 'child_process', 'electron', '@electron/remote',
        /^@angular/, /^@ng-bootstrap/, /^rxjs/, /^tabby-/,
    ],
}
