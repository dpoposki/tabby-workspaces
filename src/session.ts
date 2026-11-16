import { Injectable } from '@angular/core'
import { BehaviorSubject, Subject } from 'rxjs'
import { AppService, BaseTabComponent, NotificationsService, TabRecoveryService } from 'tabby-core'
import { newId, PinMeta, PinRecord, plural, Workspace } from './models'
import { WorkspaceStore } from './store'
import { ErrorReporter } from './errors'
import type { TabbyHooks } from './tabby-compat'
import { getTerminal, waitForPrompt, waitForSession } from './terminal'
import { getWslTarget, lookupWslCwds, normalizeWslCwd, stripWslTagFromEnv } from './wsl'
import { buildTmuxCommand, killTmuxSession, tmuxSessionName } from './tmux'

const SAVE_DEBOUNCE_MS = 800
/** Periodic save so working directories stay fresh */
const SAVE_INTERVAL_MS = 10_000

/**
 * The workspace shown in this window and its pinned tabs: restoring them when the
 * workspace is attached, and saving them as they change. One per window.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceSession implements Omit<TabbyHooks, 'decorateTitle'> {
    /** Workspace shown in this window (null: a plain, unsaved window); emits on every change, renames included */
    readonly current$ = new BehaviorSubject<Workspace | null>(null)
    /** Fires once when a workspace is loaded into this window */
    readonly attached$ = new Subject<Workspace>()

    private meta = new WeakMap<BaseTabComponent, PinMeta>()
    /** Pins that could not be restored (e.g. their profile is gone); kept so they aren't silently lost */
    private unrestorable: PinRecord[] = []
    private restoring = false
    private closing = false
    private saveTimer: any = null
    /** The save in progress, if any; saves never overlap (see save()) */
    private saving: Promise<void> | null = null
    private saveAgain = false

    constructor (
        private app: AppService,
        private tabRecovery: TabRecoveryService,
        private notifications: NotificationsService,
        private store: WorkspaceStore,
        private errors: ErrorReporter,
    ) { }

    get current (): Workspace | null {
        return this.current$.value
    }

    init (): void {
        this.app.tabOpened$.subscribe(tab => this.watchTab(tab))
        this.app.tabsChanged$.subscribe(() => this.scheduleSave())
        this.app.tabClosed$.subscribe(() => this.app.tabs.length ? this.scheduleSave() : this.saveEmpty())
        setInterval(() => this.scheduleSave(), SAVE_INTERVAL_MS)
    }

    // ---------------------------------------------------------------- attach & restore

    /**
     * Loads the workspace as it is stored now; false if it no longer exists. The caller
     * must have claimed it (WindowRegistry.claim), so no other window has it open.
     */
    async attach (id: string): Promise<boolean> {
        const workspace = this.store.get(id)
        if (!workspace) {
            return false
        }
        if (!this.store.readOnly) {
            this.store.markOpened(id)
        }
        this.current$.next(workspace)
        this.attached$.next(workspace)

        this.restoring = true
        this.unrestorable = []
        try {
            for (const pin of this.store.getPins(workspace.id)) {
                if (!await this.restorePin(workspace, pin)) {
                    this.unrestorable.push(pin)
                }
            }
        } finally {
            this.restoring = false
        }
        if (this.unrestorable.length) {
            this.notifications.error(
                `${plural(this.unrestorable.length, 'pinned tab')} could not be restored`,
                'They are kept in the workspace and will be retried next time.',
            )
        }
        const firstPinned = this.app.tabs.find(x => x.pinned)
        if (firstPinned) {
            this.app.selectTab(firstPinned)
        }
        this.scheduleSave()
        return true
    }

    /**
     * Re-reads this window's workspace after it changed in storage (here or in another
     * window). If it was removed while open here (e.g. an import with "Replace"), this
     * window still has its pins, so it is put back rather than lost when the window closes.
     */
    reload (): void {
        const current = this.current
        if (!current) {
            return
        }
        const fresh = this.store.get(current.id)
        if (!fresh) {
            this.store.upsert(current)
        } else if (fresh.name !== current.name || fresh.color !== current.color) {
            this.current$.next(fresh)
        }
    }

    private async restorePin (workspace: Workspace, pin: PinRecord): Promise<boolean> {
        try {
            const params = await this.tabRecovery.recoverTab(pin.token)
            if (!params) {
                return false
            }
            const tab = this.app.openNewTabRaw(params)
            if (!tab.pinned) {
                this.app.pinTab(tab)
            }
            const { token: _token, ...meta } = pin
            this.meta.set(tab, meta)
            this.runStartup(workspace, tab, meta).catch(error => this.errors.log('startup command failed', error))
            return true
        } catch (error) {
            this.errors.log(`could not restore pin ${pin.id}`, error)
            return false
        }
    }

    /** Types the pin's tmux attach and/or startup command into a freshly restored tab. */
    private async runStartup (workspace: Workspace, tab: BaseTabComponent, meta: PinMeta): Promise<void> {
        if (!meta.startupCommand && !meta.tmux) {
            return
        }
        const terminal = await waitForSession(tab)
        if (!terminal) {
            return
        }
        await waitForPrompt(terminal.session)
        const command = meta.tmux && getWslTarget(terminal)
            ? buildTmuxCommand(tmuxSessionName(workspace.id, meta.id), meta.startupCommand)
            : meta.startupCommand
        if (command) {
            terminal.sendInput(command + '\r')
        }
    }

    // ---------------------------------------------------------------- pins

    /** The tab's pin metadata, created on first use (a newly pinned tab gets a new id) */
    getMeta (tab: BaseTabComponent): PinMeta {
        let meta = this.meta.get(tab)
        if (!meta) {
            meta = { id: newId() }
            this.meta.set(tab, meta)
        }
        return meta
    }

    // ---------------------------------------------------------------- Tabby hooks (see tabby-compat.ts)

    afterPin (tab: BaseTabComponent, wasPinned: boolean): void {
        if (!wasPinned && tab.pinned && this.current && !this.restoring) {
            // A new pin: ask for its name
            this.getMeta(tab)
            setTimeout(() => this.app.renameTab(tab))
        }
        this.scheduleSave()
    }

    afterUnpin (): void {
        this.scheduleSave()
    }

    /** Saves first, then stops saving: closing the window must not look like "all pins removed" */
    async beforeCloseWindow (): Promise<void> {
        clearTimeout(this.saveTimer)
        await this.save().catch(error => this.errors.log('save on close failed', error))
        this.closing = true
    }

    afterCloseWindow (cancelled: boolean): void {
        if (cancelled) {
            this.closing = false
        }
    }

    // ---------------------------------------------------------------- saving

    private watchTab (tab: BaseTabComponent): void {
        tab.recoveryStateChangedHint$.subscribe(() => this.scheduleSave())
        tab.destroyed$.subscribe(() => this.onTabDestroyed(tab))
    }

    private onTabDestroyed (tab: BaseTabComponent): void {
        const meta = this.meta.get(tab)
        // A pinned tab closing with its window keeps its session; anything else means the pin is gone.
        if (!meta?.tmux || !this.current || (this.closing && tab.pinned)) {
            return
        }
        const target = getWslTarget(getTerminal(tab))
        if (target) {
            killTmuxSession(target, tmuxSessionName(this.current.id, meta.id))
        }
    }

    /**
     * The last tab just closed. With Tabby's "last tab closes window" setting the window
     * closes right away, without going through closeWindow (so beforeCloseWindow doesn't
     * run) and before a debounced save would. With no tabs left there are no tokens to
     * collect, so this saves synchronously, before the window goes.
     */
    private saveEmpty (): void {
        if (!this.current || this.restoring || this.closing || this.store.readOnly) {
            return
        }
        clearTimeout(this.saveTimer)
        // A save still running collected the tabs before they closed; make it run again
        if (this.saving) {
            this.saveAgain = true
        }
        try {
            this.store.setPins(this.current.id, [...this.unrestorable])
        } catch (error) {
            this.errors.reportOnce('Workspaces: pinned tabs could not be saved', error)
        }
    }

    scheduleSave (): void {
        if (!this.current || this.restoring || this.closing || this.store.readOnly) {
            return
        }
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(
            () => this.save().catch(error => this.errors.reportOnce('Workspaces: pinned tabs could not be saved', error)),
            SAVE_DEBOUNCE_MS,
        )
    }

    /**
     * Saves the pins now. Saves never run at the same time: one can take seconds (the WSL
     * cwd lookup), and an older one finishing last would overwrite newer pins. A save
     * requested meanwhile runs once more right after; the caller's promise resolves when
     * the pins as they are now have been written.
     */
    async save (): Promise<void> {
        if (this.saving) {
            this.saveAgain = true
            while (this.saving) {
                await this.saving
            }
            return
        }
        this.saving = (async () => {
            try {
                do {
                    this.saveAgain = false
                    await this.saveOnce()
                } while (this.saveAgain)
            } finally {
                this.saving = null
            }
        })()
        return this.saving
    }

    private async saveOnce (): Promise<void> {
        const workspace = this.current
        if (!workspace || this.restoring || this.closing || this.store.readOnly) {
            return
        }
        const pinnedTabs = this.app.tabs.filter(x => x.pinned)
        const wslCwds = await lookupWslCwds(pinnedTabs.map(x => getTerminal(x)))
        const pins: PinRecord[] = []
        for (const tab of pinnedTabs) {
            const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: false })
            if (token) {
                const terminal = getTerminal(tab)
                prepareToken(token, getWslTarget(terminal), wslCwds.get(terminal))
                pins.push({ ...this.getMeta(tab), token })
            }
        }
        // The window may have started closing while tokens were collected
        if (this.closing || this.current?.id !== workspace.id) {
            return
        }
        this.store.setPins(workspace.id, [...pins, ...this.unrestorable])
    }
}

/**
 * Makes a recovery token fit for storing as a pin: marked pinned, without this plugin's
 * WSL tab id, and with the WSL working directory as a \\wsl.localhost\... path.
 */
function prepareToken (token: any, wslTarget: { args: string[] } | null, wslCwd: string | undefined): void {
    token.tabPinned = true
    const options = terminalTokenOf(token)?.profile?.options
    if (!options) {
        return
    }
    if (options.env) {
        options.env = stripWslTagFromEnv(options.env)
    }
    if (wslCwd) {
        options.cwd = wslCwd
    } else {
        normalizeWslCwd(options, wslTarget)
    }
}

/**
 * A top-level tab's token is a split container ({ type: 'app:split-tab', children: [...] });
 * the terminal's own token (with the profile and cwd) is its first leaf, matching getTerminal().
 */
function terminalTokenOf (token: any): any | null {
    if (!token) {
        return null
    }
    if (token.profile) {
        return token
    }
    for (const child of token.children ?? []) {
        const leaf = terminalTokenOf(child)
        if (leaf) {
            return leaf
        }
    }
    return null
}
