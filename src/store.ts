import { Injectable } from '@angular/core'
import { PinRecord, Workspace } from './models'

/**
 * Persists workspaces in localStorage, which all Tabby windows share.
 *
 * The workspace list lives under one key and only changes on explicit user
 * actions. Pins live under one key per workspace, and only the window that
 * owns the workspace writes them, so windows never overwrite each other.
 */
export const LIST_KEY = 'tabbyWorkspaces.list'
const PINS_PREFIX = 'tabbyWorkspaces.pins.'
const HANDOFF_KEY = 'tabbyWorkspaces.handoff'
const HANDOFF_MAX_AGE = 30_000

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
    list (): Workspace[] {
        return this.readJSON<Workspace[]>(LIST_KEY) ?? []
    }

    get (id: string): Workspace | null {
        return this.list().find(x => x.id === id) ?? null
    }

    upsert (workspace: Workspace): void {
        const list = this.list()
        const index = list.findIndex(x => x.id === workspace.id)
        if (index === -1) {
            list.push(workspace)
        } else {
            list[index] = workspace
        }
        window.localStorage.setItem(LIST_KEY, JSON.stringify(list))
    }

    remove (id: string): void {
        window.localStorage.setItem(LIST_KEY, JSON.stringify(this.list().filter(x => x.id !== id)))
        window.localStorage.removeItem(PINS_PREFIX + id)
    }

    getPins (id: string): PinRecord[] {
        return this.readJSON<PinRecord[]>(PINS_PREFIX + id) ?? []
    }

    setPins (id: string, pins: PinRecord[]): void {
        window.localStorage.setItem(PINS_PREFIX + id, JSON.stringify(pins))
    }

    /** Tells the next window that starts which workspace to load. */
    setHandoff (id: string): void {
        window.localStorage.setItem(HANDOFF_KEY, JSON.stringify({ id, at: Date.now() }))
    }

    takeHandoff (): string | null {
        const handoff = this.readJSON<{ id: string, at: number }>(HANDOFF_KEY)
        window.localStorage.removeItem(HANDOFF_KEY)
        if (!handoff || Date.now() - handoff.at > HANDOFF_MAX_AGE) {
            return null
        }
        return handoff.id
    }

    private readJSON<T> (key: string): T | null {
        try {
            const raw = window.localStorage.getItem(key)
            return raw ? JSON.parse(raw) as T : null
        } catch {
            return null
        }
    }
}
