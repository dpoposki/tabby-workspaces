import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const stub = name => fileURLToPath(new URL(`./test/stubs/${name}.ts`, import.meta.url))

// The parts of the plugin that run without Tabby; Tabby and Angular are replaced by stubs.
export default defineConfig({
    resolve: {
        alias: {
            '@angular/core': stub('angular-core'),
            'tabby-core': stub('tabby-core'),
            'tabby-local': stub('tabby-local'),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        setupFiles: ['test/setup.ts'],
    },
})
