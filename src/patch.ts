/**
 * Replaces `target[name]` with `replace(original)`, where `original` is bound to `target`.
 * Returns false (and changes nothing) if the method doesn't exist, so a Tabby update that
 * renames something disables one feature instead of breaking the plugin's startup.
 */
export function patchMethod<T extends object> (
    target: T,
    name: keyof T & string,
    replace: (original: (...args: any[]) => any) => (...args: any[]) => any,
): boolean {
    const original = (target as any)[name]
    if (typeof original !== 'function') {
        console.warn(`[workspaces] cannot patch ${name}: not found in this Tabby version`)
        return false
    }
    (target as any)[name] = replace(original.bind(target))
    return true
}
