/** A workspace is the equivalent of a Chrome profile: its own window, its own pinned tabs. */
export interface Workspace {
    id: string
    name: string
    color: string
    createdAt: number
    lastOpenedAt?: number
}

/** One pinned tab, as stored for a workspace. */
export interface PinRecord {
    id: string
    /** Tabby recovery token (profile, cwd, custom title, ...) */
    token: any
    /** Typed into the shell after the tab is restored */
    startupCommand?: string
    /** Attach the tab to a persistent tmux session (WSL tabs only) */
    tmux?: boolean
}

/** Per-tab runtime metadata, kept for the lifetime of a tab: a pin record without its token. */
export type PinMeta = Omit<PinRecord, 'token'>

/** Identifies an export file; never change it, or older exports stop importing. */
export const EXPORT_FORMAT = 'tabby-workspaces'

/** Version of the export file's shape; older files must keep importing when it's bumped */
export const EXPORT_VERSION = 1

export interface ExportFile {
    format: typeof EXPORT_FORMAT
    version: number
    exportedAt: string
    workspaces: (Workspace & { pins: PinRecord[] })[]
}

/** Used when a stored color is missing or not a hex color */
export const FALLBACK_COLOR = '#6b7280'

export const WORKSPACE_COLORS: { name: string, value: string }[] = [
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Green', value: '#22c55e' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Purple', value: '#a855f7' },
    { name: 'Red', value: '#ef4444' },
    { name: 'Teal', value: '#14b8a6' },
    { name: 'Pink', value: '#ec4899' },
    { name: 'Yellow', value: '#eab308' },
    { name: 'Gray', value: FALLBACK_COLOR },
]

export const NAME_MAX_LENGTH = 60

export function newId (): string {
    return crypto.randomUUID()
}

/** The workspace color, safe to put into CSS or SVG */
export function safeColor (color?: string): string {
    return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : FALLBACK_COLOR
}

/** The letter shown on a workspace's badge, card and taskbar icon */
export function initialOf (name?: string, fallback = '?'): string {
    return (name?.trim()[0] ?? fallback).toUpperCase()
}

/** plural(1, 'pinned tab') → "1 pinned tab", plural(3, 'workspace') → "3 workspaces" */
export function plural (count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`
}
