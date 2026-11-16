import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { heldLocks, holdLock, locksSupported } from './locks'

type Message =
    | { type: 'query', nonce: string }
    | { type: 'present', nonce: string, id: string }
    | { type: 'focus', id: string }

/** How long the fallback presence query waits for other windows to answer */
const QUERY_TIMEOUT_MS = 250
const LOCK_PREFIX = 'workspace:'

/**
 * Which workspace is open in which window. A window claims its workspace before loading
 * it, by taking that workspace's Web Lock and holding it until the window closes, so two
 * windows can never load the same workspace, even when they try at the same moment.
 * Windows also ask each other to come to the front over a BroadcastChannel.
 *
 * Without Web Locks it falls back to asking the other windows (a timed broadcast query),
 * which works but can let two simultaneous opens both through.
 */
@Injectable({ providedIn: 'root' })
export class WindowRegistry {
    /** Fires (inside the Angular zone) when another window asks this one to focus */
    readonly focusRequested$ = new Subject<void>()

    /** The workspace this window has claimed (a window holds at most one, for its lifetime) */
    private claimedId: string | null = null
    private release: (() => void) | null = null
    private channel = new BroadcastChannel('tabby-workspaces')
    private pendingQueries = new Map<string, Set<string>>()

    constructor (private zone: NgZone) {
        // Messages from other windows: re-enter Angular here, so subscribers don't have to
        this.channel.onmessage = event => this.zone.run(() => this.onMessage(event.data as Message))
    }

    /** Claims the workspace for this window; false if another window has it. */
    async claim (id: string): Promise<boolean> {
        if (this.claimedId) {
            return this.claimedId === id
        }
        if (locksSupported()) {
            this.release = await holdLock(LOCK_PREFIX + id)
            if (!this.release) {
                return false
            }
        } else if ((await this.queryPresence()).has(id)) {
            return false
        }
        this.claimedId = id
        return true
    }

    /** Gives the claim back (when the workspace turned out not to be loadable after all) */
    unclaim (): void {
        this.release?.()
        this.release = null
        this.claimedId = null
    }

    /** Ids of workspaces open in other windows */
    async openElsewhere (): Promise<Set<string>> {
        if (!locksSupported()) {
            return this.queryPresence()
        }
        const ids = (await heldLocks())
            .filter(name => name.startsWith(LOCK_PREFIX))
            .map(name => name.slice(LOCK_PREFIX.length))
            .filter(id => id !== this.claimedId)
        return new Set(ids)
    }

    requestFocus (id: string): void {
        this.post({ type: 'focus', id })
    }

    private async queryPresence (): Promise<Set<string>> {
        const nonce = crypto.randomUUID()
        const result = new Set<string>()
        this.pendingQueries.set(nonce, result)
        this.post({ type: 'query', nonce })
        await new Promise(resolve => setTimeout(resolve, QUERY_TIMEOUT_MS))
        this.pendingQueries.delete(nonce)
        return result
    }

    private onMessage (msg: Message): void {
        if (msg.type === 'query' && this.claimedId) {
            this.post({ type: 'present', nonce: msg.nonce, id: this.claimedId })
        } else if (msg.type === 'present') {
            this.pendingQueries.get(msg.nonce)?.add(msg.id)
        } else if (msg.type === 'focus' && msg.id === this.claimedId) {
            this.focusRequested$.next()
        }
    }

    private post (msg: Message): void {
        this.channel.postMessage(msg)
    }
}
