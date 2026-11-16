import { describe, expect, it } from 'vitest'
import { NgZone } from '@angular/core'
import { SCHEMA_VERSION, WorkspaceStore } from '../src/store'
import { Workspace } from '../src/models'

const newStore = () => new WorkspaceStore(new NgZone() as any)
const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: id, color: '#3b82f6', createdAt: 1, ...extra })

describe('WorkspaceStore', () => {
    it('adds, updates and removes workspaces with their pins', () => {
        const store = newStore()
        store.upsert(workspace('a'))
        store.upsert(workspace('b'))
        store.setPins('a', [{ id: 'p', token: { type: 'x' } }])
        expect(store.update('a', { name: 'Work' })?.name).toBe('Work')
        expect(store.list().map(x => x.name)).toEqual(['Work', 'b'])
        expect(store.getPins('a')).toHaveLength(1)

        store.remove('a')
        expect(store.get('a')).toBeNull()
        expect(localStorage.getItem('tabbyWorkspaces.pins.a')).toBeNull()
        expect(store.update('a', { name: 'gone' })).toBeNull()
    })

    it('marks the stored data with the schema version', () => {
        newStore()
        expect(localStorage.getItem('tabbyWorkspaces.schema')).toBe(String(SCHEMA_VERSION))
    })

    it('takes the newer of the two last-opened times', () => {
        const store = newStore()
        store.upsert(workspace('a', { lastOpenedAt: 500 }))
        expect(store.get('a')?.lastOpenedAt).toBe(500)
        localStorage.setItem('tabbyWorkspaces.opened.a', '900')
        expect(store.get('a')?.lastOpenedAt).toBe(900)
        localStorage.setItem('tabbyWorkspaces.opened.a', '100')
        expect(store.get('a')?.lastOpenedAt).toBe(500)
    })

    it('sets unreadable data aside instead of overwriting it', () => {
        localStorage.setItem('tabbyWorkspaces.list', '{broken')
        const store = newStore()
        const corrupted: string[] = []
        store.corrupted$.subscribe(x => corrupted.push(x.backupKey))
        expect(store.list()).toEqual([])
        expect(corrupted).toHaveLength(1)
        expect(localStorage.getItem(corrupted[0])).toBe('{broken')
        expect(localStorage.getItem('tabbyWorkspaces.list')).toBeNull()
    })

    it('ignores malformed entries', () => {
        localStorage.setItem('tabbyWorkspaces.list', JSON.stringify([workspace('ok'), { name: 'no id' }, null]))
        localStorage.setItem('tabbyWorkspaces.pins.ok', JSON.stringify([{ id: 'p', token: {} }, { id: 'no token' }]))
        const store = newStore()
        expect(store.list().map(x => x.id)).toEqual(['ok'])
        expect(store.getPins('ok').map(x => x.id)).toEqual(['p'])
    })

    it('is read-only when a newer plugin version wrote the data', () => {
        localStorage.setItem('tabbyWorkspaces.schema', String(SCHEMA_VERSION + 1))
        localStorage.setItem('tabbyWorkspaces.list', JSON.stringify([workspace('a')]))
        const store = newStore()
        expect(store.readOnly).toBe(true)
        expect(store.list()).toHaveLength(1)
        expect(() => store.upsert(workspace('b'))).toThrow(/newer version/)
        expect(() => store.remove('a')).toThrow()
        expect(localStorage.getItem('tabbyWorkspaces.schema')).toBe(String(SCHEMA_VERSION + 1))
    })

    it('hands workspaces to new windows oldest first', async () => {
        const store = newStore()
        await store.addHandoff('a')
        await store.addHandoff('b')
        expect(await store.takeHandoff()).toBe('a')
        expect(await store.takeHandoff()).toBe('b')
        expect(await store.takeHandoff()).toBeNull()
    })

    it('drops stale and broken handoffs, and reads the old single-entry format', async () => {
        const store = newStore()
        localStorage.setItem('tabbyWorkspaces.handoff', JSON.stringify([{ id: 'old', at: Date.now() - 60_000 }, { id: 1 }]))
        expect(await store.takeHandoff()).toBeNull()
        localStorage.setItem('tabbyWorkspaces.handoff', JSON.stringify({ id: 'single', at: Date.now() }))
        expect(await store.takeHandoff()).toBe('single')
        localStorage.setItem('tabbyWorkspaces.handoff', 'garbage')
        expect(await store.takeHandoff()).toBeNull()
    })
})
