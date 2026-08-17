const implementation = await import(`./pi-core-fs.mjs?pi-compatible-core-fs-v4`)

export const name = implementation.name
export const inject = implementation.inject
export const apply = implementation.apply
