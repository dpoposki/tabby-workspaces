import { describe, expect, it } from 'vitest'
import { START_PAGE_COUNT_MAX, START_PAGE_COUNT_MIN, startPageCount } from '../src/config'

const count = (value: unknown) => startPageCount({ startPageCount: value } as any)

describe('startPageCount', () => {
    it('keeps the setting within its bounds', () => {
        expect(count(5)).toBe(5)
        expect(count(0)).toBe(START_PAGE_COUNT_MIN)
        expect(count(500)).toBe(START_PAGE_COUNT_MAX)
        expect(count(3.6)).toBe(4)
        expect(count('7')).toBe(7)
    })

    it('falls back to the default for garbage', () => {
        expect(count('lots')).toBe(8)
        expect(count(undefined)).toBe(8)
    })
})
