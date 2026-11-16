import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { PinRecord, Workspace } from './models'
import { withLock } from './locks'

/**
 * Persists workspaces in localStorage, which all Tabby windows share.
 *
 * The workspace list lives under one key and only changes on explicit user
 * actions (create, rename, recolor, delete, import). Things that change all the
 * time have a key per workspace, written only by the window that has the
 * workspace open, so windows never overwrite each other: its pins, and when it
 * was last opened.
 *
 * Callers should not hold on to Workspace objects: another window may have
 * renamed or deleted the workspace since. Re-read by id before acting on one.
 */
/**
 * Version of the stored data's shape. When it changes, bump it and add a migration;
 * unversioned data (from before versioning) is version 1.
 */
export const SCHEMA_VERSION = 1
const SCHEMA_KEY = 'tabbyWorkspaces.schema'
/**
 * MIGRATIONS[n] upgrades the stored data from version n to n + 1. Several windows may
 * start at once, so a migration must be safe to run twice.
 */
const MIGRATIONS: Record<number, () => void> = {}

const LIST_KEY = 'tabbyWorkspaces.list'
const PINS_PREFIX = 'tabbyWorkspaces.pins.'
const OPENED_PREFIX = 'tabbyWorkspaces.opened.'
const HANDOFF_KEY = 'tabbyWorkspaces.handoff'
const HANDOFF_MAX_AGE = 30_000

type Handoff = { id: string, at: number }

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
    /** Another window changed the workspace list (fires inside the Angular zone) */
    readonly listChangedElsewhere$ = new Subject<void>()
    /** Stored data couldn't be read; the raw value was copied to `backupKey` */
    readonly corrupted$ = new Subject<{ key: string, backupKey: string }>()
    /**
     * Set when the stored data was written by a newer version of the plugin. Nothing is
     * written then, so this older version can't damage data it doesn't understand.
     */
    readonly newerSchema: number | null

    constructor (zone: NgZone) {
        this.newerSchema = this.migrate()
        // An event from another window: re-enter Angular here, so subscribers don't have to
        window.addEventListener('storage', event => {
            if (event.key === LIST_KEY) {
                zone.run(() => this.listChangedElsewhere$.next())
            }
        })
    }

    list (): Workspace[] {
        return this.readArray<Workspace>(LIST_KEY)
            .filter(x => x && typeof x.id === 'string' && typeof x.name === 'string')
            .map(x => {
                // Older versions kept lastOpenedAt in the list itself; the newer of the two wins
                const opened = Number(window.localStorage.getItem(OPENED_PREFIX + x.id)) || 0
                return opened > (x.lastOpenedAt ?? 0) ? { ...x, lastOpenedAt: opened } : x
            })
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
        this.assertWritable()
        this.write(LIST_KEY, this.list().filter(x => x.id !== id))
        window.localStorage.removeItem(PINS_PREFIX + id)
        window.localStorage.removeItem(OPENED_PREFIX + id)
    }

    /** Records that the workspace was just opened (for the "recent first" order) */
    markOpened (id: string): void {
        this.write(OPENED_PREFIX + id, Date.now())
    }

    getPins (id: string): PinRecord[] {
        return this.readArray<PinRecord>(PINS_PREFIX + id).filter(x => x && typeof x.id === 'string' && x.token)
    }

    setPins (id: string, pins: PinRecord[]): void {
        this.write(PINS_PREFIX + id, pins)
    }

    /**
     * Queues a workspace for the next window that starts. A queue, so opening several
     * workspaces in quick succession gives each new window its own one.
     */
    async addHandoff (id: string): Promise<void> {
        await withLock('handoff', () => {
            this.write(HANDOFF_KEY, [...this.readHandoffs(), { id, at: Date.now() }])
        })
    }

    /** The oldest queued workspace, removed from the queue; null if there is none. */
    async takeHandoff (): Promise<string | null> {
        return withLock('handoff', () => {
            const [first, ...rest] = this.readHandoffs()
            if (rest.length) {
                this.write(HANDOFF_KEY, rest)
            } else {
                window.localStorage.removeItem(HANDOFF_KEY)
            }
            return first?.id ?? null
        })
    }

    /** Fresh, well-formed entries only; a broken or stale queue is simply ignored */
    private readHandoffs (): Handoff[] {
        let value: unknown = null
        try {
            value = JSON.parse(window.localStorage.getItem(HANDOFF_KEY) ?? 'null')
        } catch {
            // ignored
        }
        // Older versions stored a single entry
        const entries = Array.isArray(value) ? value : value ? [value] : []
        return entries.filter((x: any): x is Handoff =>
            typeof x?.id === 'string' && typeof x.at === 'number' && Date.now() - x.at <= HANDOFF_MAX_AGE)
    }

    /** Throws on a full quota, so callers can tell the user their changes weren't saved. */
    private write (key: string, value: unknown): void {
        this.assertWritable()
        window.localStorage.setItem(key, JSON.stringify(value))
    }

    /** True when nothing may be written (see newerSchema) */
    get readOnly (): boolean {
        return this.newerSchema !== null
    }

    private assertWritable (): void {
        if (this.readOnly) {
            throw new Error('Workspaces were saved by a newer version of the plugin; update it to make changes.')
        }
    }

    /** Brings stored data up to SCHEMA_VERSION; returns the stored version if it's newer than this code. */
    private migrate (): number | null {
        const stored = Number(window.localStorage.getItem(SCHEMA_KEY)) || 1
        if (stored > SCHEMA_VERSION) {
            return stored
        }
        for (let version = stored; version < SCHEMA_VERSION; version++) {
            MIGRATIONS[version]?.()
        }
        if (stored !== SCHEMA_VERSION || !window.localStorage.getItem(SCHEMA_KEY)) {
            window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
        }
        return null
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
