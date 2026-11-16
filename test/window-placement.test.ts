import { describe, expect, it } from 'vitest'
import { centeredIn, isVisibleOn, parsePlacement } from '../src/window-placement'

const screen = { x: 0, y: 0, width: 1920, height: 1040 }
const right = { x: 1920, y: 0, width: 2560, height: 1400 }

describe('window placement', () => {
    it('centers the compact window on the screen', () => {
        expect(centeredIn(right, { width: 900, height: 620 })).toEqual({ x: 1920 + 830, y: 390, width: 900, height: 620 })
    })

    it('shrinks it to fit a small screen', () => {
        expect(centeredIn({ x: 0, y: 0, width: 800, height: 500 }, { width: 900, height: 620 })).toEqual({ x: 0, y: 0, width: 800, height: 500 })
    })

    it('puts a window back only if enough of it is on a screen', () => {
        expect(isVisibleOn({ x: 100, y: 100, width: 800, height: 600 }, [screen])).toBe(true)
        expect(isVisibleOn({ x: 1900, y: 100, width: 800, height: 600 }, [screen])).toBe(false)
        expect(isVisibleOn({ x: 1900, y: 100, width: 800, height: 600 }, [screen, right])).toBe(true)
        expect(isVisibleOn({ x: 5000, y: 0, width: 800, height: 600 }, [screen, right])).toBe(false)
        expect(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, [])).toBe(false)
    })

    it('reads only well-formed saved placements', () => {
        expect(parsePlacement({ bounds: { x: 1, y: 2, width: 3, height: 4, extra: 5 }, maximized: 1 }))
            .toEqual({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true })
        expect(parsePlacement({ bounds: { x: 1, y: 2, width: 0, height: 4 } })).toBeNull()
        expect(parsePlacement({ bounds: { x: 'a', y: 2, width: 3, height: 4 } })).toBeNull()
        expect(parsePlacement(null)).toBeNull()
    })
})
