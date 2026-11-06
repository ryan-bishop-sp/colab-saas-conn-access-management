import { EntitlementV2025 } from 'sailpoint-api-client'
import { Config, EntitlementDefinition } from '../model/config'
import {
    aggregateEntitlements,
    EntitlementAggregationClient,
    EntitlementEnrichmentError,
} from './entitlement-aggregation'

jest.mock('@sailpoint/connector-sdk', () => ({
    logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const query = 'source.id eq "directory" and attribute eq "memberOf"'
const prod: EntitlementV2025 = {
    id: 'prod-admin',
    name: 'CN=Admin,OU=Prod,OU=Example,DC=example,DC=com',
    value: 'CN=Admin,OU=Prod,OU=Example,DC=example,DC=com',
    attribute: 'memberOf',
}
const dev: EntitlementV2025 = {
    id: 'dev-user',
    name: 'CN=User,OU=Dev,OU=Example,DC=example,DC=com',
    value: 'CN=User,OU=Dev,OU=Example,DC=example,DC=com',
    attribute: 'memberOf',
}
const other: EntitlementV2025 = {
    id: 'other',
    name: 'CN=Other,OU=Elsewhere,DC=example,DC=com',
    value: 'CN=Other,OU=Elsewhere,DC=example,DC=com',
    attribute: 'memberOf',
}

const definition = (application: string, overrides: Partial<EntitlementDefinition> = {}): EntitlementDefinition => ({
    name: `${application} enrichment`,
    query,
    entitlementExpression: "#if($id == 'prod-admin')include#end",
    additionalEntitlementExpressions: ["#if($id == 'dev-user')include#end"],
    requestable: false,
    requireApproval: false,
    businessApplicationName: application,
    displayNameExpression: '$businessApplication - $environment - $technicalName',
    descriptionExpression: '$businessApplication access in $environment',
    businessApplicationMetadataKey: 'businessApplication',
    environmentExpression: 'Prod',
    environmentMetadataKey: 'environment',
    ...overrides,
})

const config = (...entitlements: EntitlementDefinition[]): Config =>
    ({
        entitlements,
    } as Config)

const makeClient = (entitlements: EntitlementV2025[] = [prod, dev, other]) => ({
    listEntitlements: jest.fn(async () => entitlements),
    updateEntitlementsInBulk: jest.fn(async () => undefined),
    putEntitlementRequestConfig: jest.fn(async () => ({})),
    patchEntitlement: jest.fn(async (id: string, _patch: unknown) => ({ id })),
})

const run = (client: ReturnType<typeof makeClient>, ...definitions: EntitlementDefinition[]) =>
    aggregateEntitlements(config(...definitions), client as unknown as EntitlementAggregationClient)

describe('entitlement application enrichment', () => {
    it('ORs environment expressions, reuses a shared query and honors dry run', async () => {
        const client = makeClient()

        await run(
            client,
            definition('Example', { dryRun: true }),
            definition('Other', {
                entitlementExpression: "#if($id == 'other')include#end",
                additionalEntitlementExpressions: [],
                dryRun: true,
            })
        )

        expect(client.listEntitlements).toHaveBeenCalledTimes(1)
        expect(client.patchEntitlement).not.toHaveBeenCalled()
        expect(client.updateEntitlementsInBulk).not.toHaveBeenCalled()
    })

    it('patches friendly context and AMM without changing the technical value', async () => {
        const client = makeClient([
            {
                ...prod,
                accessModelMetadata: {
                    attributes: [{ key: 'risk', values: [{ value: 'high' }] }],
                },
            },
        ])

        await run(client, definition('Example'))

        expect(client.patchEntitlement).toHaveBeenCalledTimes(1)
        const [id, patch] = client.patchEntitlement.mock.calls[0]
        expect(id).toBe('prod-admin')
        expect(patch).toEqual([
            { op: 'replace', path: '/name', value: 'Example - Prod - Admin' },
            {
                op: 'replace',
                path: '/description',
                value: 'Example access in Prod [AMC-ENT:Example]',
            },
            {
                op: 'replace',
                path: '/accessModelMetadata',
                value: {
                    attributes: [
                        { key: 'risk', values: [{ value: 'high' }] },
                        { key: 'businessApplication', values: [{ value: 'Example' }] },
                        { key: 'environment', values: [{ value: 'Prod' }] },
                    ],
                },
            },
        ])
        expect(JSON.stringify(patch)).not.toContain('/value')
    })

    it('does not patch an already-owned entitlement whose enrichment is unchanged', async () => {
        const client = makeClient([
            {
                ...prod,
                name: 'Example - Prod - Admin',
                description: 'Example access in Prod [AMC-ENT:Example]',
                accessModelMetadata: {
                    attributes: [
                        { key: 'businessApplication', values: [{ value: 'Example' }] },
                        { key: 'environment', values: [{ value: 'Prod' }] },
                    ],
                },
            },
        ])

        await run(client, definition('Example'))

        expect(client.patchEntitlement).not.toHaveBeenCalled()
    })

    it('fails before writing when one entitlement matches two applications', async () => {
        const client = makeClient([prod])

        await expect(run(client, definition('Example'), definition('Second'))).rejects.toThrow(
            EntitlementEnrichmentError
        )
        expect(client.patchEntitlement).not.toHaveBeenCalled()
        expect(client.updateEntitlementsInBulk).not.toHaveBeenCalled()
    })

    it('does not overwrite an unowned manually managed display name', async () => {
        const client = makeClient([
            {
                ...prod,
                name: 'Curated name',
                manuallyUpdatedFields: { DISPLAY_NAME: true },
            },
        ])

        await expect(run(client, definition('Example'))).rejects.toThrow('manually managed display name')
        expect(client.patchEntitlement).not.toHaveBeenCalled()
    })

    it('preserves the existing bulk entitlement update behavior', async () => {
        const client = makeClient([prod])
        const legacy: EntitlementDefinition = {
            name: 'Privileged groups',
            query,
            entitlementExpression: 'include',
            requestable: false,
            requireApproval: false,
            privileged: true,
        }

        await run(client, legacy)

        expect(client.updateEntitlementsInBulk).toHaveBeenCalledWith(
            ['prod-admin'],
            [{ op: 'replace', path: '/privileged', value: true }]
        )
        expect(client.patchEntitlement).not.toHaveBeenCalled()
    })
})
