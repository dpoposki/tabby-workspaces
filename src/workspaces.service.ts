import { Injectable } from '@angular/core'
import { AppService, ConfigService, HostAppService, HostWindowService, NotificationsService } from 'tabby-core'
import { newId, Workspace, WORKSPACE_COLORS } from './models'
import { WorkspaceStore } from './store'
import { ErrorReporter } from './errors'
import { WindowRegistry } from './registry'
import { WorkspaceSession } from './session'
import { WindowChrome } from './window-chrome'
import { TabbyCompat } from './tabby-compat'

/** Lets Tabby finish its own startup before a handed-off workspace is restored */
const STARTUP_DELAY_MS = 300
/** Set once the plugin has given back Tabby's "restore tabs" setting, which older versions switched off */
const RECOVER_TABS_RESTORED_KEY = 'tabbyWorkspaces.recoverTabsRestored'

/**
 * Workspace actions (open, create, rename, recolor, delete) and the plugin's startup.
 * No dialogs here: WorkspaceDialogs asks the questions, then calls these.
 */
@Injectable({ providedIn: 'root' })
export class WorkspacesService {
    private initialized = false
    private markReady!: () => void
    /** Settles once startup (onAppReady) has finished, whether it worked or not */
    private ready = new Promise<void>(resolve => { this.markReady = resolve })

    constructor (
        private app: AppService,
        private config: ConfigService,
        private hostApp: HostAppService,
        private hostWindow: HostWindowService,
        private notifications: NotificationsService,
        private store: WorkspaceStore,
        private registry: WindowRegistry,
        private session: WorkspaceSession,
        private chrome: WindowChrome,
        private compat: TabbyCompat,
        private errors: ErrorReporter,
    ) { }

    /** Workspace shown in this window, or null for a plain (unsaved) window */
    get current (): Workspace | null {
        return this.session.current
    }

    init (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true

        const failed = this.compat.install({
            afterPin: (tab, wasPinned) => this.session.afterPin(tab, wasPinned),
            afterUnpin: () => this.session.afterUnpin(),
            beforeCloseWindow: () => this.session.beforeCloseWindow(),
            afterCloseWindow: cancelled => this.session.afterCloseWindow(cancelled),
            decorateTitle: title => this.chrome.decorateTitle(title),
        })
        if (failed.length) {
            setTimeout(() => this.notifications.error(
                'Workspaces: not fully compatible with this Tabby version',
                `Disabled: ${failed.join(', ')}.`,
            ), 3000)
        }
        this.session.init()
        this.chrome.init()

        this.registry.focusRequested$.subscribe(() => this.hostWindow.bringToFront())
        this.store.listChangedElsewhere$.subscribe(() => this.session.reload())
        if (this.store.newerSchema) {
            setTimeout(() => this.notifications.error(
                'Workspaces: saved by a newer plugin version',
                'Your workspaces open as usual, but changes aren\'t saved until you update the plugin.',
            ), 3000)
        }
        this.store.corrupted$.subscribe(({ key, backupKey }) => this.notifications.error(
            'Workspaces: stored data was unreadable',
            `It was set aside under "${backupKey}" in Tabby's local storage (was "${key}").`,
        ))

        this.app.ready$.subscribe(() => {
            setTimeout(() => this.onAppReady()
                .catch(error => this.errors.report('Workspaces: startup failed', error))
                .finally(() => this.markReady()), STARTUP_DELAY_MS)
        })
    }

    // ---------------------------------------------------------------- startup

    private async onAppReady (): Promise<void> {
        await this.config.ready$.toPromise()
        this.restoreRecoverTabsSetting()

        // A window opened by openWorkspace() in another window: load what it asked for
        const handoffId = await this.store.takeHandoff()
        const handoff = handoffId ? this.store.get(handoffId) : null
        if (handoff) {
            await this.openWorkspace(handoff)
        }
        // Otherwise the window starts as a plain window; the start page entries and the
        // toolbar badge open the launcher (the first window shows it via the CLI handler).
    }

    /**
     * Opens the most recently used workspace in this first window, once startup is done.
     * Returns false when there is none, or it's already open in another window, so the
     * caller can show the launcher instead.
     */
    async openLastOnStartup (): Promise<boolean> {
        await this.ready
        const last = this.sortedWorkspaces()[0]
        if (!last || this.current || (await this.registry.openElsewhere()).has(last.id)) {
            return false
        }
        await this.openHere(last)
        // openHere may not open it (another window claimed it first); read the session again
        return this.session.current?.id === last.id
    }

    /** Earlier versions of the plugin turned the setting off in the user's config; turn it back on once. */
    private restoreRecoverTabsSetting (): void {
        if (window.localStorage.getItem(RECOVER_TABS_RESTORED_KEY)) {
            return
        }
        window.localStorage.setItem(RECOVER_TABS_RESTORED_KEY, '1')
        if (this.config.store.recoverTabs === false) {
            this.config.store.recoverTabs = true
            this.config.save()
        }
    }

    // ---------------------------------------------------------------- actions

    /**
     * Brings the workspace's window to the front if it's already open somewhere, else loads
     * it into this window if it has none yet, or opens it in a new window.
     * `workspace` may be a stale copy (e.g. a launcher card); only its id is used.
     */
    async openWorkspace (workspace: Workspace): Promise<void> {
        if (workspace.id === this.current?.id) {
            return
        }
        if (!this.store.get(workspace.id)) {
            this.notifications.info(`Workspace "${workspace.name}" no longer exists`, 'It was deleted in another window.')
            return
        }
        if ((await this.registry.openElsewhere()).has(workspace.id)) {
            this.focusElsewhere(workspace.id)
        } else if (this.current) {
            await this.store.addHandoff(workspace.id)
            this.hostApp.newWindow()
        } else {
            await this.openHere(workspace)
        }
    }

    async createWorkspace (name: string, color: string): Promise<void> {
        const workspace: Workspace = { id: newId(), name, color, createdAt: Date.now() }
        this.store.upsert(workspace)
        if (this.current) {
            await this.openWorkspace(workspace)
        } else {
            await this.openHere(workspace) // brand new, so no other window has it
        }
    }

    /** Other windows showing this workspace pick the change up through the storage event. */
    rename (id: string, name: string): void {
        this.update(id, { name })
    }

    setColor (id: string, color: string): void {
        this.update(id, { color })
    }

    /** Workspaces open in a window (this one or another) can't be deleted */
    async canDelete (id: string): Promise<boolean> {
        return id !== this.current?.id && !(await this.registry.openElsewhere()).has(id)
    }

    /** Deletes the workspace unless it's open somewhere; returns whether it was deleted. */
    async delete (id: string): Promise<boolean> {
        if (!await this.canDelete(id)) {
            return false
        }
        this.store.remove(id)
        return true
    }

    sortedWorkspaces (): Workspace[] {
        return this.store.list().sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
    }

    /** Default color for the next new workspace, cycling through the palette */
    nextColor (): string {
        return WORKSPACE_COLORS[this.store.list().length % WORKSPACE_COLORS.length].value
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Claims the workspace and loads it into this (empty) window. The claim is what makes
     * this safe when another window tries to open the same workspace at the same moment:
     * only one of them gets it, the other brings that window to the front.
     */
    private async openHere (workspace: Workspace): Promise<void> {
        if (!await this.registry.claim(workspace.id)) {
            this.focusElsewhere(workspace.id)
            return
        }
        if (!await this.session.attach(workspace.id)) {
            this.registry.unclaim()
            this.notifications.info(`Workspace "${workspace.name}" no longer exists`, 'It was deleted in another window.')
        }
    }

    private focusElsewhere (id: string): void {
        this.registry.requestFocus(id)
        if (!this.current) {
            this.closeWindowIfEmpty()
        }
    }

    private update (id: string, changes: Partial<Workspace>): void {
        this.store.update(id, changes)
        if (id === this.current?.id) {
            this.session.reload()
        }
    }

    /** Only an empty window, i.e. one that existed just to open a workspace */
    private closeWindowIfEmpty (): void {
        if (!this.app.tabs.length) {
            this.hostWindow.close()
        }
    }
}
