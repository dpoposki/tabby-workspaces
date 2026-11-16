import { Component, Injectable, OnDestroy } from '@angular/core'
import { ConfigService, HostAppService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { WorkspacesBackup } from './backup'
import { ErrorReporter } from './errors'
import { TaskbarIdentity } from './taskbar'
import { START_PAGE_COUNT_MAX, START_PAGE_COUNT_MIN, WorkspacesSettings, startPageCount, workspacesSettings } from './config'

/** What happens when Tabby starts; one choice in the UI, two settings in config.yaml */
type Startup = 'terminal' | 'launcher' | 'last'

/** Saving rewrites config.yaml and makes every open window reload it, so clicks and typing are batched */
const SAVE_DELAY_MS = 400

/** Settings → Workspaces */
@Component({
    template: `
        <h3 class="mb-3">Workspaces</h3>

        <div class="form-line">
            <div class="header">
                <div class="title">When Tabby starts</div>
                <div class="description">{{ startupDescriptions[startup] }}</div>
            </div>
            <select class="form-control" style="width: auto; flex-shrink: 0" [(ngModel)]="startup">
                <option value="terminal">Open a terminal</option>
                <option value="launcher">Show the launcher</option>
                <option value="last">Reopen the last workspace</option>
            </select>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Workspaces on the start page</div>
                <div class="description">Recent workspaces between "New terminal" and "Profiles & connections", up to the number set here ({{ countMin }}–{{ countMax }})</div>
            </div>
            <div class="d-flex align-items-center gap-3">
                <input class="form-control" type="number" style="width: 5rem"
                    [min]="countMin" [max]="countMax" step="1"
                    [disabled]="!settings.startPageList"
                    [(ngModel)]="settings.startPageCount" (ngModelChange)="save()" (blur)="clampCount()">
                <toggle [(ngModel)]="settings.startPageList" (ngModelChange)="save()"></toggle>
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">tmux for new pins</div>
                <div class="description">New pins of WSL, SSH and macOS/Linux shell tabs get a persistent tmux session, which starts the next time the workspace opens. You can still switch it per pin: right-click the tab → Pinned tab</div>
            </div>
            <toggle [(ngModel)]="settings.tmuxByDefault" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Toolbar badge</div>
                <div class="description">Workspace color and initial in the top right; click it to switch, add or edit workspaces. Applies to new windows</div>
            </div>
            <toggle [(ngModel)]="settings.toolbarBadge" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Color stripe</div>
                <div class="description">Thin line in the workspace color across the top of the window</div>
            </div>
            <toggle [(ngModel)]="settings.colorStripe" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line" *ngIf="taskbarSupported">
            <div class="header">
                <div class="title">Taskbar icon</div>
                <div class="description">Each workspace window gets its own taskbar button, with the workspace's color and initial on the Tabby icon. Turning it off applies to new windows</div>
            </div>
            <toggle [(ngModel)]="settings.taskbarIcon" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Backup</div>
                <div class="description">All workspaces with their pinned tabs, as a JSON file</div>
            </div>
            <div class="d-flex gap-2">
                <button class="btn btn-secondary" (click)="errors.run('Export failed', exportWorkspaces)">
                    <i class="fas fa-file-export me-2"></i>Export…
                </button>
                <button class="btn btn-secondary" (click)="errors.run('Import failed', importWorkspaces)">
                    <i class="fas fa-file-import me-2"></i>Import…
                </button>
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Hotkeys</div>
                <div class="description">"Workspaces: show launcher" is under Settings → Hotkeys</div>
            </div>
        </div>
    `,
})
export class WorkspacesSettingsTabComponent implements OnDestroy {
    /** Not on macOS, where windows are told apart by their title */
    taskbarSupported: boolean
    countMin = START_PAGE_COUNT_MIN
    countMax = START_PAGE_COUNT_MAX

    readonly startupDescriptions: Record<Startup, string> = {
        terminal: 'Tabby opens a terminal, as it does without this plugin',
        launcher: "Pick a workspace (or guest mode) in a small launcher window in the middle of the screen, like Chrome's profile picker. The window then opens at the workspace's size",
        last: "Reopen the workspace you used last. If it's already open in another window, the launcher shows instead",
    }

    private saveTimer?: ReturnType<typeof setTimeout>

    get settings (): WorkspacesSettings {
        // Not cached: Tabby replaces the store when another window changes the config
        return workspacesSettings(this.config)
    }

    get startup (): Startup {
        const settings = this.settings
        if (!settings.showLauncher) {
            return 'terminal'
        }
        return settings.openLastWorkspace ? 'last' : 'launcher'
    }

    set startup (value: Startup) {
        const settings = this.settings
        settings.showLauncher = value !== 'terminal'
        if (settings.showLauncher) {
            settings.openLastWorkspace = value === 'last'
        }
        this.save()
    }

    exportWorkspaces = () => this.backup.exportWorkspaces()
    importWorkspaces = () => this.backup.importWorkspaces()

    constructor (
        public config: ConfigService,
        public errors: ErrorReporter,
        private backup: WorkspacesBackup,
        hostApp: HostAppService,
    ) {
        this.taskbarSupported = TaskbarIdentity.isSupported(hostApp.platform)
    }

    /** Saves shortly after the last change */
    save (): void {
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
    }

    /** An empty or out-of-range count shows the number actually used */
    clampCount (): void {
        const count = startPageCount(this.settings)
        if (this.settings.startPageCount !== count) {
            this.settings.startPageCount = count
            this.save()
        }
    }

    ngOnDestroy (): void {
        if (this.saveTimer !== undefined) {
            this.flush()
        }
    }

    private flush (): void {
        clearTimeout(this.saveTimer)
        this.saveTimer = undefined
        this.errors.run('Could not save the settings', () => this.config.save())
    }
}

@Injectable()
export class WorkspacesSettingsTabProvider extends SettingsTabProvider {
    id = 'workspaces'
    icon = 'window-restore'
    title = 'Workspaces'

    getComponentType (): any {
        return WorkspacesSettingsTabComponent
    }
}
