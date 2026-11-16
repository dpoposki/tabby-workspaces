import { describe, expect, it } from 'vitest'
import { parseExport } from '../src/backup'
import { EXPORT_FORMAT, EXPORT_VERSION } from '../src/models'

describe('parseExport', () => {
    it('accepts this version and older ones', () => {
        for (const version of [1, EXPORT_VERSION]) {
            const result = parseExport(JSON.stringify({ format: EXPORT_FORMAT, version, workspaces: [] }))
            expect(result).toHaveProperty('data')
        }
    })

    it('refuses files from a newer plugin version', () => {
        const result = parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 1, workspaces: [] }))
        expect(result).toEqual({ error: expect.stringContaining('newer version') })
    })

    it('refuses other JSON and broken files', () => {
        expect(parseExport('{"workspaces": []}')).toEqual({ error: expect.stringContaining('not a Tabby workspaces export') })
        expect(parseExport(JSON.stringify({ format: EXPORT_FORMAT, workspaces: [] }))).toHaveProperty('error')
        expect(parseExport('{oops')).toEqual({ error: 'The file is not valid JSON.' })
        expect(parseExport('null')).toHaveProperty('error')
    })
})
