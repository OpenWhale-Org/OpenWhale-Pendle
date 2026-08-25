import { createRequire } from 'node:module'

/** The package's own version, read from package.json at runtime so the manifest can never drift from what npm published. */
export const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
