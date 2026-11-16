import { Injectable } from '@angular/core'
import { AppService, ConfigService, HostWindowService } from 'tabby-core'
import { workspacesSettings } from './config'
import { ErrorReporter } from './errors'
import { safeColor, Workspace } from './models'
import { WorkspaceSession } from './session'
import { TaskbarIdentity } from './taskbar'

const STRIPE_HEIGHT_PX = 3

/**
 * What makes a workspace window recognisable: the color stripe across the top, the
 * workspace name in the window title, and the taskbar icon. Follows the session's
 * current workspace and the settings; nothing needs to call it after a change.
 */
@Injectable({ providedIn: 'root' })
export class WindowChrome {
    private styleElement: HTMLStyleElement | null = null

    constructor (
        private app: AppService,
        private config: ConfigService,
        private hostWindow: HostWindowService,
        private session: WorkspaceSession,
        private taskbar: TaskbarIdentity,
        private errors: ErrorReporter,
    ) { }

    init (): void {
        this.session.current$.subscribe(() => this.apply())
        this.config.changed$.subscribe(() => this.apply())
    }

    /** Used by the window title patch: "[Workspace] tab title" */
    decorateTitle (title: string | undefined): string | undefined {
        const workspace = this.session.current
        if (!workspace) {
            return title
        }
        return title ? `[${workspace.name}] ${title}` : workspace.name
    }

    private apply (): void {
        const workspace = this.session.current
        const settings = workspacesSettings(this.config)
        this.applyStripe(settings.colorStripe ? workspace : null)
        // Re-set the active tab's title so the patched setTitle adds the (new) workspace name
        const tab = this.app.activeTab
        this.hostWindow.setTitle(tab ? tab.customTitle || tab.title : undefined)
        this.taskbar.apply(workspace, settings.taskbarIcon).catch(error => this.errors.log('taskbar icon failed', error))
    }

    private applyStripe (workspace: Workspace | null): void {
        if (!this.styleElement) {
            this.styleElement = document.createElement('style')
            document.head.appendChild(this.styleElement)
        }
        this.styleElement.textContent = workspace
            ? `body::after { content: ''; position: fixed; left: 0; right: 0; top: 0; height: ${STRIPE_HEIGHT_PX}px;
                 background: ${safeColor(workspace.color)}; z-index: 100000; pointer-events: none; }`
            : ''
    }
}
