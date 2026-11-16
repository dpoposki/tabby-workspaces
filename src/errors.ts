import { Injectable, NgZone } from '@angular/core'
import { NotificationsService } from 'tabby-core'

/**
 * The one place failures go: always to the console, and to the user when they
 * started the action (a click, a hotkey) and would otherwise see nothing happen.
 */
@Injectable({ providedIn: 'root' })
export class ErrorReporter {
    private reportedOnce = new Set<string>()

    constructor (private notifications: NotificationsService, private zone: NgZone) { }

    /** Runs a user-started action without blocking the caller; failures are shown to the user. */
    run (title: string, action: () => Promise<unknown>): void {
        this.zone.run(() => {
            action().catch(error => this.report(title, error))
        })
    }

    report (title: string, error: unknown): void {
        console.error(`[workspaces] ${title}`, error)
        this.zone.run(() => this.notifications.error(title, describe(error)))
    }

    /** For background work (saving, icons): tell the user only the first time per window. */
    reportOnce (title: string, error: unknown): void {
        if (this.reportedOnce.has(title)) {
            console.error(`[workspaces] ${title}`, error)
            return
        }
        this.reportedOnce.add(title)
        this.report(title, error)
    }

    log (context: string, error: unknown): void {
        console.warn(`[workspaces] ${context}`, error)
    }
}

function describe (error: unknown): string {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        return 'Tabby\'s local storage is full.'
    }
    return error instanceof Error ? error.message : String(error)
}
