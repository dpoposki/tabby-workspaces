import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NgZone } from '@angular/core'
import { WindowRegistry } from '../src/registry'

// Two registries play two Tabby windows, talking over a real BroadcastChannel. Web Locks
// are switched off, so this is the fallback: windows asking each other what they have open.
describe('WindowRegistry without Web Locks', () => {
    let windows: WindowRegistry[] = []

    beforeEach(() => {
        vi.stubGlobal('navigator', {})
    })
    afterEach(() => {
        vi.unstubAllGlobals()
        // Closed windows: they stop answering, so tests don't see each other's claims
        windows.forEach(x => (x as any).channel.close())
        windows = []
    })

    const newWindow = () => {
        const registry = new WindowRegistry(new NgZone() as any)
        windows.push(registry)
        return registry
    }

    it('sees which workspace another window has claimed', async () => {
        const first = newWindow()
        const second = newWindow()
        expect(await first.claim('a')).toBe(true)
        expect([...await second.openElsewhere()]).toEqual(['a'])
        expect([...await first.openElsewhere()]).toEqual([])
    })

    it("refuses a workspace that's open in another window", async () => {
        const first = newWindow()
        const second = newWindow()
        await first.claim('a')
        expect(await second.claim('a')).toBe(false)
        expect(await second.claim('b')).toBe(true)
    })

    it('keeps one workspace per window, and gives it back on unclaim', async () => {
        const first = newWindow()
        const second = newWindow()
        await first.claim('a')
        expect(await first.claim('b')).toBe(false)
        expect(await first.claim('a')).toBe(true)
        first.unclaim()
        expect(await second.claim('a')).toBe(true)
    })

    it('asks the window that has a workspace to come to the front', async () => {
        const first = newWindow()
        const second = newWindow()
        await first.claim('a')
        const focused = new Promise<void>(resolve => first.focusRequested$.subscribe(() => resolve()))
        second.requestFocus('a')
        await expect(focused).resolves.toBeUndefined()
    })
})
