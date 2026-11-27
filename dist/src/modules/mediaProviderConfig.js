/** Explicit disable wins; environment credentials override non-empty config values. */
export function resolveMediaCredential(enabled, environment, configured) {
    if (enabled === false)
        return undefined;
    for (const value of [environment, configured]) {
        if (typeof value === 'string' &&
            value.trim() &&
            !['\r', '\n', '\0'].some((character) => value.includes(character)))
            return value.trim();
    }
    return undefined;
}
