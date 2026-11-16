import { Inject, NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { CLIHandler, CommandProvider, ConfigProvider, HotkeyProvider, HotkeysService, TabContextMenuItemProvider } from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import {
    WorkspacesCommandProvider, WorkspacesConfigProvider, WorkspacesHotkeyProvider, WorkspacesStartupCLIHandler,
    WorkspacesTabContextMenu,
} from './providers'
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
        hotkeys: HotkeysService,
        @Inject(CommandProvider) commandProviders: CommandProvider[],
    ) {
        workspaces.init()
        putFirst(commandProviders, x => x instanceof WorkspacesCommandProvider)
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'workspaces-open') {
                workspaces.showPicker()
            } else if (hotkey === 'workspaces-menu') {
                workspaces.showMenu()
            }
        })
    }
}

/**
 * Start page order is "New terminal", the workspaces, then "Profiles & connections".
 * Built-in start page entries all have weight 0 and the sort is stable, so the order
 * among them is toolbar buttons ("New terminal") first, then command providers in
 * registration order. Moving this provider ahead of tabby-core's (the multi-provider
 * array is the one CommandService holds) puts the workspaces right after "New terminal".
 */
function putFirst<T> (array: T[], predicate: (item: T) => boolean): void {
    const index = array.findIndex(predicate)
    if (index > 0) {
        array.unshift(...array.splice(index, 1))
    }
}
