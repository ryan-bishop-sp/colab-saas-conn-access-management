import { SchemaV2025 } from 'sailpoint-api-client'
import { MappingError, resolveMappingColumns } from './mapping-source'
import { mappingColumnOrder, planMappingSourceSetup } from './mapping-source-setup'

const columns = resolveMappingColumns({
    name: 'Test Apps',
    mappingSourceName: 'App Mapping',
    targetSourceName: 'Directory',
    requestable: false,
    requireApproval: false,
})

const order = ['mapping_id', 'application_name', 'instance_name', 'integration_type', 'match_type', 'match_value']

const defaultGroupSchema: SchemaV2025 = {
    id: 'schema-group',
    name: 'group',
    nativeObjectType: 'Group',
    identityAttribute: 'id',
    displayAttribute: 'displayName',
    attributes: [
        { name: 'id', type: 'STRING' },
        { name: 'displayName', type: 'STRING' },
    ],
}
const accountSchema: SchemaV2025 = { id: 'schema-account', name: 'account', identityAttribute: 'id' }

const configuredAttributes = {
    'group.hasHeader': true,
    'group.delimiter': ',',
    'group.indexColumn': 'mapping_id',
    'group.columnNames': order,
}

describe('mappingColumnOrder', () => {
    it('follows the documented file order', () => {
        expect(mappingColumnOrder(columns)).toEqual(order)
    })
})

describe('planMappingSourceSetup', () => {
    it('sets up a new delimited-file source', () => {
        const setup = planMappingSourceSetup([accountSchema, defaultGroupSchema], {}, columns)
        expect(setup.schema?.id).toBe('schema-group')
        expect(setup.schema?.identityAttribute).toBe('mapping_id')
        expect(setup.schema?.displayAttribute).toBe('mapping_id')
        expect(setup.schema?.attributes?.map((a) => a.name)).toEqual(['id', 'displayName', ...order])
        expect(setup.connectorAttributePatch).toEqual([
            { op: 'add', path: '/connectorAttributes/group.hasHeader', value: true },
            { op: 'add', path: '/connectorAttributes/group.delimiter', value: ',' },
            { op: 'add', path: '/connectorAttributes/group.indexColumn', value: 'mapping_id' },
            { op: 'add', path: '/connectorAttributes/group.columnNames', value: order },
        ])
    })

    it('changes nothing when the source already matches', () => {
        const schema: SchemaV2025 = {
            ...defaultGroupSchema,
            identityAttribute: 'mapping_id',
            displayAttribute: 'mapping_id',
            attributes: order.map((name) => ({ name, type: 'STRING' })),
        }
        const setup = planMappingSourceSetup([schema], configuredAttributes, columns)
        expect(setup.schema).toBeUndefined()
        expect(setup.connectorAttributePatch).toEqual([])
    })

    it('adds only the missing columns and keeps existing attributes', () => {
        const schema: SchemaV2025 = {
            ...defaultGroupSchema,
            identityAttribute: 'mapping_id',
            displayAttribute: 'mapping_id',
            attributes: [...order.slice(0, 5).map((name) => ({ name, type: 'STRING' as const })), { name: 'owner' }],
        }
        const setup = planMappingSourceSetup([schema], configuredAttributes, columns)
        expect(setup.schema?.attributes?.map((a) => a.name)).toEqual([...order.slice(0, 5), 'owner', 'match_value'])
    })

    it('fixes a column list in the wrong order', () => {
        const setup = planMappingSourceSetup(
            [defaultGroupSchema],
            { ...configuredAttributes, 'group.columnNames': [...order].reverse() },
            columns
        )
        expect(setup.connectorAttributePatch).toEqual([
            { op: 'add', path: '/connectorAttributes/group.columnNames', value: order },
        ])
    })

    it('fails when the schema is keyed on another column', () => {
        expect(() =>
            planMappingSourceSetup([{ ...defaultGroupSchema, identityAttribute: 'app_key' }], {}, columns)
        ).toThrow(MappingError)
    })

    it('fails when the source has no group schema', () => {
        expect(() => planMappingSourceSetup([accountSchema], {}, columns)).toThrow(/not set up for entitlements/)
    })
})
