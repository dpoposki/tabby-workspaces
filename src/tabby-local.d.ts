// tabby-local ships with Tabby but publishes no typings; only what the plugin touches is declared.
declare module 'tabby-local' {
    export const TerminalTabComponent: any
    /** `openTab()` opens a terminal with the default local profile */
    export const TerminalService: any
}

// tabby-settings ships with Tabby; its typings aren't on npm for this version.
declare module 'tabby-settings' {
    /** Extend to add a tab to Settings */
    export abstract class SettingsTabProvider {
        id: string
        icon: string
        title: string
        weight?: number
        prioritized?: boolean
        getComponentType (): any
    }
}

// Shipped with Tabby (no typings installed); only the screen API is used.
declare module '@electron/remote' {
    export const screen: {
        getAllDisplays (): { workArea: import('./tabby-compat').Bounds }[]
        getDisplayMatching (bounds: import('./tabby-compat').Bounds): { workArea: import('./tabby-compat').Bounds }
    }
}
