import { Inject, NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { CLIHandler, CommandProvider, ConfigProvider, HotkeyProvider, HotkeysService, TabContextMenuItemProvider } from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import { ErrorReporter } from './errors'
import {
    WorkspacesCommandProvider, WorkspacesHotkeyProvider, WorkspacesStartupCLIHandler, WorkspacesTabContextMenu,
} from './providers'
import { HOTKEY_LAUNCHER, WorkspacesConfigProvider } from './config'
import { WorkspacesLauncher } from './launcher'
import { TabbyCompat } from './tabby-compat'
import { SettingsTabProvider } from 'tabby-settings'
import { WorkspacesSettingsTabComponent, WorkspacesSettingsTabProvider } from './settings'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    declarations: [WorkspacesSettingsTabComponent],
    providers: [
        { provide: TabContextMenuItemProvider, useClass: WorkspacesTabContextMenu, multi: true },
        { provide: CommandProvider, useClass: WorkspacesCommandProvider, multi: true },
        { provide: HotkeyProvider, useClass: WorkspacesHotkeyProvider, multi: true },
        { provide: ConfigProvider, useClass: WorkspacesConfigProvider, multi: true },
        { provide: CLIHandler, useClass: WorkspacesStartupCLIHandler, multi: true },
        { provide: SettingsTabProvider, useClass: WorkspacesSettingsTabProvider, multi: true },
    ],
})
export default class WorkspacesModule {
    constructor (
        workspaces: WorkspacesService,
        launcher: WorkspacesLauncher,
        hotkeys: HotkeysService,
        @Inject(CommandProvider) commandProviders: CommandProvider[],
        errors: ErrorReporter,
    ) {
        // This runs while Tabby bootstraps: a failure here must not take Tabby down with it
        try {
            workspaces.init()
            // Start page order: "New terminal", the workspaces, then "Profiles & connections"
            TabbyCompat.putFirst(commandProviders, x => x instanceof WorkspacesCommandProvider)
        } catch (error) {
            errors.report('Workspaces plugin failed to start', error)
            return
        }
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === HOTKEY_LAUNCHER) {
                launcher.show()
            }
        })
    }
}
