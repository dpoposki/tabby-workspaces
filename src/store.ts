import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'
import { PinRecord, Workspace } from './models'

/**
 * Persists workspaces in localStorage, which all Tabby windows share.
 *
 * The workspace list lives under one key and only changes on explicit user
 * actions. Pins live under one key per workspace, and only the window that
 * owns the workspace writes them, so windows never overwrite each other.
 *
 * Callers should not hold on to Workspace objects: another window may have
 * renamed or deleted the workspace since. Re-read by id before acting on one.
 */
const LIST_KEY = 'tabbyWorkspaces.list'
const PINS_PREFIX = 'tabbyWorkspaces.pins.'
const HANDOFF_KEY = 'tabbyWorkspaces.handoff'
const HANDOFF_MAX_AGE = 30_000

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
    /** Another window changed the workspace list (fires outside the Angular zone) */
    readonly listChangedElsewhere$ = new Subject<void>()
    /** Stored data couldn't be read; the raw value was copied to `backupKey` */
    readonly corrupted$ = new Subject<{ key: string, backupKey: string }>()

    constructor () {
        window.addEventListener('storage', event => {
            if (event.key === LIST_KEY) {
                this.listChangedElsewhere$.next()
            }
        })
    }

    list (): Workspace[] {
        return this.readArray<Workspace>(LIST_KEY).filter(x => x && typeof x.id === 'string' && typeof x.name === 'string')
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
        this.write(LIST_KEY, list)
    }

    /** Applies changes to the stored record as it is now; returns it, or null if it no longer exists. */
    update (id: string, changes: Partial<Omit<Workspace, 'id'>>): Workspace | null {
        const stored = this.get(id)
        if (!stored) {
            return null
        }
        const updated = { ...stored, ...changes }
        this.upsert(updated)
        return updated
    }

    remove (id: string): void {
        this.write(LIST_KEY, this.list().filter(x => x.id !== id))
        window.localStorage.removeItem(PINS_PREFIX + id)
    }

    getPins (id: string): PinRecord[] {
        return this.readArray<PinRecord>(PINS_PREFIX + id).filter(x => x && typeof x.id === 'string' && x.token)
    }

    setPins (id: string, pins: PinRecord[]): void {
        this.write(PINS_PREFIX + id, pins)
    }

    /** Tells the next window that starts which workspace to load. */
    setHandoff (id: string): void {
        this.write(HANDOFF_KEY, { id, at: Date.now() })
    }

    takeHandoff (): string | null {
        let handoff: { id?: unknown, at?: unknown } | null = null
        try {
            handoff = JSON.parse(window.localStorage.getItem(HANDOFF_KEY) ?? 'null')
        } catch {
            // A broken handoff is just ignored
        }
        window.localStorage.removeItem(HANDOFF_KEY)
        if (typeof handoff?.id !== 'string' || typeof handoff.at !== 'number' || Date.now() - handoff.at > HANDOFF_MAX_AGE) {
            return null
        }
        return handoff.id
    }

    /** Throws on a full quota, so callers can tell the user their changes weren't saved. */
    private write (key: string, value: unknown): void {
        window.localStorage.setItem(key, JSON.stringify(value))
    }

    /**
     * A missing key is an empty list. An unreadable one is copied aside before it's
     * treated as empty, so the next write can't silently destroy the only copy.
     */
    private readArray<T> (key: string): T[] {
        const raw = window.localStorage.getItem(key)
        if (!raw) {
            return []
        }
        try {
            const value = JSON.parse(raw)
            if (Array.isArray(value)) {
                return value
            }
        } catch {
            // handled below
        }
        const backupKey = `${key}.corrupt-${Date.now()}`
        try {
            window.localStorage.setItem(backupKey, raw)
            window.localStorage.removeItem(key)
        } catch {
            // Storage full: the original stays where it is until something overwrites it
        }
        this.corrupted$.next({ key, backupKey })
        return []
    }
}
