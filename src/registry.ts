import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'

type Message =
    | { type: 'query', nonce: string }
    | { type: 'present', nonce: string, id: string }
    | { type: 'focus', id: string }

/**
 * Lets Tabby windows find out which workspaces are open in other windows,
 * and ask each other to come to the front.
 */
@Injectable({ providedIn: 'root' })
export class WindowRegistry {
    /** Workspace shown in this window */
    currentId: string | null = null
    /** Fires (outside the Angular zone) when another window asks this one to focus */
    readonly focusRequested$ = new Subject<void>()

    private channel = new BroadcastChannel('tabby-workspaces')
    private pendingQueries = new Map<string, Set<string>>()

    constructor () {
        this.channel.onmessage = event => this.onMessage(event.data as Message)
    }

    /** Ids of workspaces open in other windows */
    async openElsewhere (timeoutMs = 250): Promise<Set<string>> {
        const nonce = crypto.randomUUID()
        const result = new Set<string>()
        this.pendingQueries.set(nonce, result)
        this.post({ type: 'query', nonce })
        await new Promise(resolve => setTimeout(resolve, timeoutMs))
        this.pendingQueries.delete(nonce)
        return result
    }

    requestFocus (id: string): void {
        this.post({ type: 'focus', id })
    }

    private onMessage (msg: Message): void {
        if (msg.type === 'query' && this.currentId) {
            this.post({ type: 'present', nonce: msg.nonce, id: this.currentId })
        } else if (msg.type === 'present') {
            this.pendingQueries.get(msg.nonce)?.add(msg.id)
        } else if (msg.type === 'focus' && msg.id === this.currentId) {
            this.focusRequested$.next()
        }
    }

    private post (msg: Message): void {
        this.channel.postMessage(msg)
    }
}
