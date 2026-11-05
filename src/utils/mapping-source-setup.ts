import { JsonPatchOperationV2025, SchemaV2025 } from 'sailpoint-api-client'
import { MappingColumns, MappingError } from './mapping-source'

/** The delimited-file entitlement schema that holds the mapping rows. */
export const MAPPING_SCHEMA_NAME = 'group'

/** Identity attribute a new delimited-file source starts with. Only this one is safe to replace. */
const DEFAULT_IDENTITY_ATTRIBUTE = 'id'

/** Mapping-file columns in file order: row key, application name, traceability, match type, match value. */
export const mappingColumnOrder = (columns: MappingColumns): string[] => [
    columns.id,
    columns.applicationName,
    ...columns.traceability,
    columns.matchType,
    columns.matchValue,
]

export interface MappingSourceSetup {
    /** Full schema to PUT, or undefined when the schema already matches. */
    schema?: SchemaV2025
    /** Connector attribute patch, empty when the file settings already match. */
    connectorAttributePatch: JsonPatchOperationV2025[]
}

const sameStringArray = (a: unknown, b: string[]): boolean =>
    Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])

/**
 * Work out what the mapping source needs so a CSV upload loads one entitlement per row:
 * the group schema keyed on the row-key column with every mapping column as a string attribute, and the
 * delimited-file settings for the group object type. Only adds or fixes; never removes attributes.
 * Fails when the schema is keyed on a different column, because re-keying would orphan loaded rows.
 */
export const planMappingSourceSetup = (
    schemas: SchemaV2025[],
    connectorAttributes: Record<string, any> | undefined,
    columns: MappingColumns
): MappingSourceSetup => {
    const schema = schemas.find((s) => s.name === MAPPING_SCHEMA_NAME)
    if (!schema) {
        throw new MappingError('Mapping source is not set up for entitlements', [
            `no "${MAPPING_SCHEMA_NAME}" schema found; the mapping source must be a delimited-file source`,
        ])
    }

    const identityAttribute = schema.identityAttribute
    if (identityAttribute && identityAttribute !== columns.id && identityAttribute !== DEFAULT_IDENTITY_ATTRIBUTE) {
        throw new MappingError('Mapping source schema has diverged', [
            `the "${MAPPING_SCHEMA_NAME}" schema is keyed on "${identityAttribute}", expected "${columns.id}"`,
        ])
    }

    const order = mappingColumnOrder(columns)
    const existing = schema.attributes ?? []
    const existingNames = new Set(existing.map((a) => a.name))
    const missing = order.filter((name) => !existingNames.has(name))
    const needsSchema = identityAttribute !== columns.id || schema.displayAttribute !== columns.id || missing.length > 0

    const desiredAttributes: Record<string, unknown> = {
        'group.hasHeader': true,
        'group.delimiter': ',',
        'group.indexColumn': columns.id,
        'group.columnNames': order,
    }
    const connectorAttributePatch: JsonPatchOperationV2025[] = Object.entries(desiredAttributes)
        .filter(([key, value]) => {
            const current = connectorAttributes?.[key]
            return Array.isArray(value) ? !sameStringArray(current, value) : current !== value
        })
        .map(
            ([key, value]): JsonPatchOperationV2025 => ({
                // The client types only list remove/replace; ISC accepts add, which also works for a missing key.
                op: 'add' as JsonPatchOperationV2025['op'],
                path: `/connectorAttributes/${key}`,
                value: value as JsonPatchOperationV2025['value'],
            })
        )

    return {
        schema: needsSchema
            ? {
                  ...schema,
                  identityAttribute: columns.id,
                  displayAttribute: columns.id,
                  attributes: [
                      ...existing,
                      ...missing.map((name) => ({
                          name,
                          type: 'STRING' as const,
                          isMulti: false,
                          isEntitlement: false,
                          isGroup: false,
                      })),
                  ],
              }
            : undefined,
        connectorAttributePatch,
    }
}
