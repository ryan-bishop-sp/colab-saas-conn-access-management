import { EntitlementV2025 } from 'sailpoint-api-client'
import { MappingDefinition } from '../model/config'
import { MappingError } from '../utils/mapping-source'
import { describeOwned } from '../utils/ownership'
import { MappingClient, aggregateMappingDefinition, setUpMappingDefinition, timing } from './mapping-aggregation'

jest.mock('@sailpoint/connector-sdk', () => ({
    logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const DIRECTORY = 'src-directory'
const MAPPING = 'src-mapping'
const OTHER = 'src-other'

const definition: MappingDefinition = {
    name: 'Test Apps',
    mappingSourceName: 'App Mapping',
    targetSourceName: 'Directory',
    requestable: false,
    requireApproval: false,
}

const row = (id: string, applicationName: string, matchType: string, matchValue: string): EntitlementV2025 => ({
    id: `ent-${id}`,
    name: id,
    value: id,
    attributes: { application_name: applicationName, match_type: matchType, match_value: matchValue },
})

const group = (cn: string): EntitlementV2025 => {
    const dn = `CN=${cn},OU=Groups,DC=example,DC=com`
    return { id: `grp-${cn}`, name: dn, value: dn, attribute: 'memberOf', source: { id: DIRECTORY } as any }
}

const groups = [group('Payroll_Users'), group('Payroll_Admins'), group('Portal Users'), group('Unmapped')]
const rows = [
    row('payroll-001', 'Payroll', 'cn_prefix', 'Payroll_'),
    row('portal-001', 'Portal', 'dn', 'CN=Portal Users,OU=Groups,DC=example,DC=com'),
    row('hr-001', 'HR', 'ou', 'OU=HR,DC=example,DC=com'),
]

const WRITES = [
    'createAccessProfile',
    'updateAccessProfile',
    'createApp',
    'updateSourceAccessProfiles',
    'deleteAccessProfile',
    'deleteSourceApp',
] as const

function makeClient(overrides: Partial<Record<keyof MappingClient, jest.Mock>> = {}) {
    let created = 0
    const client: Record<keyof MappingClient, jest.Mock> = {
        resolveSourceByName: jest.fn(async (name: string) =>
            name === 'App Mapping'
                ? { id: MAPPING, name }
                : { id: DIRECTORY, name, owner: { id: 'owner-1', type: 'IDENTITY' } }
        ),
        applyMappingSourceSetup: jest.fn(async () => []),
        listEntitlements: jest.fn(async (filters: string) => (filters.includes(MAPPING) ? rows : groups)),
        searchAccessProfilesByNames: jest.fn(async () => []),
        listAppsByName: jest.fn(async () => []),
        listOwnedAccessProfiles: jest.fn(async () => []),
        listOwnedApps: jest.fn(async () => []),
        getAppAccessProfiles: jest.fn(async () => []),
        createAccessProfile: jest.fn(async (name: string) => ({ id: `ap-${++created}`, name })),
        updateAccessProfile: jest.fn(async (id: string) => ({ id })),
        createApp: jest.fn(async (name: string) => ({ id: `app-${name}`, name })),
        updateSourceAccessProfiles: jest.fn(async (id: string) => ({ id })),
        deleteAccessProfile: jest.fn(async () => undefined),
        deleteSourceApp: jest.fn(async () => undefined),
        ...overrides,
    }
    return client
}

const asClient = (client: ReturnType<typeof makeClient>) => client as unknown as MappingClient

const expectNoWrites = (client: ReturnType<typeof makeClient>) => {
    for (const method of WRITES) expect(client[method]).not.toHaveBeenCalled()
}

beforeAll(() => {
    timing.appReadyDelayMs = 0
})

describe('aggregateMappingDefinition: create and update', () => {
    it('creates one marked access profile and app per application, not requestable', async () => {
        const client = makeClient()
        const report = await aggregateMappingDefinition(asClient(client), definition)

        expect(report.accessProfiles.created).toEqual(['Payroll', 'Portal'])
        expect(report.apps.created).toEqual(['Payroll', 'Portal'])
        expect(report.deferredRuleCount).toBe(1)
        expect(report.deferredOnlyApplications).toEqual(['HR'])
        expect(report.unmatchedGroupCount).toBe(1)

        const payroll = client.createAccessProfile.mock.calls.find((c) => c[0] === 'Payroll')!
        expect(payroll[1]).toBe('owner-1')
        expect(payroll[2]).toBe(DIRECTORY)
        expect(payroll[3].map((r: any) => r.id).sort()).toEqual(['grp-Payroll_Admins', 'grp-Payroll_Users'])
        expect(payroll[4]).toBe(false)
        expect(payroll[6]).toBe(describeOwned('Payroll', definition.name))

        expect(client.createApp).toHaveBeenCalledWith('Payroll', DIRECTORY, describeOwned('Payroll', definition.name))
        const [appId, patch] = client.updateSourceAccessProfiles.mock.calls.find((c) => c[0] === 'app-Payroll')!
        expect(appId).toBe('app-Payroll')
        expect(patch).toEqual(
            expect.arrayContaining([
                { op: 'replace', path: '/accessProfiles', value: [expect.stringMatching(/^ap-/)] },
                { op: 'replace', path: '/appCenterEnabled', value: false },
                { op: 'replace', path: '/provisionRequestEnabled', value: false },
            ])
        )
    })

    it('reads candidates from the target source memberOf attribute', async () => {
        const client = makeClient()
        await aggregateMappingDefinition(asClient(client), definition)
        expect(client.listEntitlements).toHaveBeenCalledWith(`source.id eq "${MAPPING}"`, 'id')
        expect(client.listEntitlements).toHaveBeenCalledWith(
            `source.id eq "${DIRECTORY}" and attribute eq "memberOf"`,
            'id'
        )
    })

    it('leaves owned, matching objects unchanged and updates owned objects that differ', async () => {
        const client = makeClient({
            searchAccessProfilesByNames: jest.fn(async () => [
                {
                    id: 'ap-payroll',
                    name: 'Payroll',
                    description: describeOwned('Payroll', definition.name),
                    source: { id: DIRECTORY },
                    entitlements: [{ id: 'grp-Payroll_Users' }, { id: 'grp-Payroll_Admins' }],
                    enabled: true,
                },
                {
                    id: 'ap-portal',
                    name: 'Portal',
                    description: describeOwned('Portal', definition.name),
                    source: { id: DIRECTORY },
                    entitlements: [{ id: 'grp-Old' }],
                    enabled: true,
                },
            ]),
            listAppsByName: jest.fn(async (name: string) => [
                {
                    id: `app-${name}`,
                    name,
                    description: describeOwned(name, definition.name),
                    accountSource: { id: DIRECTORY },
                },
            ]),
            getAppAccessProfiles: jest.fn(async (appId: string) =>
                appId === 'app-Payroll' ? ['ap-payroll'] : ['ap-stale']
            ),
        })
        const report = await aggregateMappingDefinition(asClient(client), definition)

        expect(report.accessProfiles.unchanged).toEqual(['Payroll'])
        expect(report.accessProfiles.updated).toEqual(['Portal'])
        expect(report.apps.unchanged).toEqual(['Payroll'])
        expect(report.apps.updated).toEqual(['Portal'])
        expect(client.createAccessProfile).not.toHaveBeenCalled()
        expect(client.createApp).not.toHaveBeenCalled()
        expect(client.updateAccessProfile).toHaveBeenCalledTimes(1)
        expect(client.updateAccessProfile.mock.calls[0][0]).toBe('ap-portal')
        expect(client.updateSourceAccessProfiles).toHaveBeenCalledTimes(1)
        expect(client.updateSourceAccessProfiles.mock.calls[0][1]).toContainEqual({
            op: 'replace',
            path: '/accessProfiles',
            value: ['ap-portal'],
        })
    })

    it('reports owned objects no longer in the mapping as orphans without deleting them', async () => {
        const client = makeClient({
            listOwnedAccessProfiles: jest.fn(async () => [{ id: 'ap-old', name: 'Retired App' }]),
            listOwnedApps: jest.fn(async () => [{ id: 'app-old', name: 'Retired App' }]),
        })
        const report = await aggregateMappingDefinition(asClient(client), definition)
        expect(report.orphans).toEqual({ accessProfiles: ['Retired App'], apps: ['Retired App'] })
        expect(client.deleteAccessProfile).not.toHaveBeenCalled()
        expect(client.deleteSourceApp).not.toHaveBeenCalled()
    })

    it('throws after the run when a write fails, listing the failure', async () => {
        const client = makeClient({
            createAccessProfile: jest.fn(async (name: string) => {
                if (name === 'Portal') throw new Error('boom')
                return { id: 'ap-payroll', name }
            }),
        })
        await expect(aggregateMappingDefinition(asClient(client), definition)).rejects.toThrow(
            /access profile "Portal" create: Error: boom/
        )
        expect(client.createApp).toHaveBeenCalledWith('Payroll', DIRECTORY, expect.any(String))
        expect(client.createApp).not.toHaveBeenCalledWith('Portal', expect.anything(), expect.anything())
    })
})

describe('aggregateMappingDefinition: no writes unless every check passes', () => {
    it('dry run reports the plan and writes nothing, including source setup', async () => {
        const client = makeClient({ applyMappingSourceSetup: jest.fn(async () => ['group.columnNames']) })
        const report = await aggregateMappingDefinition(asClient(client), { ...definition, dryRun: true })

        expect(report.dryRun).toBe(true)
        expect(report.setupChanges).toEqual(['group.columnNames'])
        expect(report.accessProfiles.created).toEqual(['Payroll', 'Portal'])
        expect(report.apps.created).toEqual(['Payroll', 'Portal'])
        expect(client.applyMappingSourceSetup).toHaveBeenCalledWith(expect.anything(), expect.anything(), true)
        expectNoWrites(client)
    })

    it('treats the toggle string "true" as on', async () => {
        const client = makeClient()
        await aggregateMappingDefinition(asClient(client), { ...definition, dryRun: 'true' as any })
        expectNoWrites(client)
    })

    it('fails on a name held by an unmarked access profile', async () => {
        const client = makeClient({
            searchAccessProfilesByNames: jest.fn(async () => [
                { id: 'ap-hand', name: 'Payroll', description: 'Hand built', source: { id: DIRECTORY } },
            ]),
        })
        const error = await aggregateMappingDefinition(asClient(client), definition).catch((e) => e)
        expect(error).toBeInstanceOf(MappingError)
        expect(error.problems).toEqual([expect.stringContaining('access profile "Payroll": its description lacks')])
        expectNoWrites(client)
    })

    it('fails on a name held by an app on another source', async () => {
        const client = makeClient({
            listAppsByName: jest.fn(async (name: string) =>
                name === 'Portal'
                    ? [
                          {
                              id: 'app-x',
                              name,
                              description: describeOwned(name, definition.name),
                              accountSource: { id: OTHER },
                          },
                      ]
                    : []
            ),
        })
        await expect(aggregateMappingDefinition(asClient(client), definition)).rejects.toThrow(
            /app "Portal": it belongs to another source/
        )
        expectNoWrites(client)
    })

    it('fails on a mapping conflict before any lookup or write', async () => {
        const client = makeClient({
            listEntitlements: jest.fn(async (filters: string) =>
                filters.includes(MAPPING)
                    ? [...rows, row('admins-001', 'Admins', 'dn', 'CN=Payroll_Admins,OU=Groups,DC=example,DC=com')]
                    : groups
            ),
        })
        await expect(aggregateMappingDefinition(asClient(client), definition)).rejects.toThrow(/Mapping conflicts/)
        expect(client.searchAccessProfilesByNames).not.toHaveBeenCalled()
        expectNoWrites(client)
    })

    it('fails on a rule that matches no group', async () => {
        const client = makeClient({
            listEntitlements: jest.fn(async (filters: string) =>
                filters.includes(MAPPING) ? [...rows, row('gone-001', 'Gone', 'dn', 'CN=Gone,DC=example')] : groups
            ),
        })
        await expect(aggregateMappingDefinition(asClient(client), definition)).rejects.toThrow(
            /matched no group[\s\S]*gone-001/
        )
        expectNoWrites(client)
    })

    it('fails when the mapping and target source are the same', async () => {
        const client = makeClient({
            resolveSourceByName: jest.fn(async (name: string) => ({ id: DIRECTORY, name, owner: { id: 'o' } })),
        })
        await expect(aggregateMappingDefinition(asClient(client), definition)).rejects.toThrow(/same source/)
        expect(client.applyMappingSourceSetup).not.toHaveBeenCalled()
        expectNoWrites(client)
    })
})

describe('aggregateMappingDefinition: delete mode', () => {
    const owned = () =>
        makeClient({
            listOwnedAccessProfiles: jest.fn(async () => [
                { id: 'ap-1', name: 'Payroll' },
                { id: 'ap-2', name: 'Portal' },
            ]),
            listOwnedApps: jest.fn(async () => [{ id: 'app-1', name: 'Payroll' }]),
        })

    it('deletes only marked objects, apps first, without reading the mapping', async () => {
        const client = owned()
        const order: string[] = []
        client.deleteSourceApp.mockImplementation(async (id: string) => void order.push(id))
        client.deleteAccessProfile.mockImplementation(async (id: string) => void order.push(id))

        const report = await aggregateMappingDefinition(asClient(client), { ...definition, deleteMode: true })

        expect(report.apps.deleted).toEqual(['Payroll'])
        expect(report.accessProfiles.deleted).toEqual(['Payroll', 'Portal'])
        expect(order).toEqual(['app-1', 'ap-1', 'ap-2'])
        expect(client.listOwnedAccessProfiles).toHaveBeenCalledWith(DIRECTORY, definition.name)
        expect(client.listEntitlements).not.toHaveBeenCalled()
        expect(client.applyMappingSourceSetup).not.toHaveBeenCalled()
    })

    it('stops before deleting access profiles if an app delete fails', async () => {
        const client = owned()
        client.deleteSourceApp.mockRejectedValue(new Error('locked'))
        await expect(aggregateMappingDefinition(asClient(client), { ...definition, deleteMode: true })).rejects.toThrow(
            /delete app "Payroll"/
        )
        expect(client.deleteAccessProfile).not.toHaveBeenCalled()
    })

    it('dry run lists what would be deleted and deletes nothing', async () => {
        const client = owned()
        const report = await aggregateMappingDefinition(asClient(client), {
            ...definition,
            deleteMode: true,
            dryRun: true,
        })
        expect(report.accessProfiles.deleted).toEqual(['Payroll', 'Portal'])
        expectNoWrites(client)
    })
})

describe('setUpMappingDefinition', () => {
    it('resolves both sources and applies the mapping source setup', async () => {
        const client = makeClient({ applyMappingSourceSetup: jest.fn(async () => ['schema group']) })
        await expect(setUpMappingDefinition(asClient(client), { ...definition, dryRun: true })).resolves.toEqual([
            'schema group',
        ])
        expect(client.resolveSourceByName).toHaveBeenCalledWith('App Mapping')
        expect(client.resolveSourceByName).toHaveBeenCalledWith('Directory')
        expect(client.applyMappingSourceSetup).toHaveBeenCalledWith(
            { id: MAPPING, name: 'App Mapping' },
            expect.objectContaining({ id: 'mapping_id' })
        )
    })
})
