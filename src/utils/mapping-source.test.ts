import { EntitlementV2025 } from 'sailpoint-api-client'
import { MappingDefinition } from '../model/config'
import {
    MappingError,
    buildCandidateIndex,
    matchMappingRules,
    normalizeDn,
    parseCn,
    planMapping,
    readMappingRules,
    resolveMappingColumns,
    splitDn,
} from './mapping-source'

const definition: MappingDefinition = {
    name: 'Test Apps',
    mappingSourceName: 'App Mapping',
    targetSourceName: 'Directory',
    requestable: false,
    requireApproval: false,
}
const columns = resolveMappingColumns(definition)

const row = (
    id: string,
    applicationName: string,
    matchType: string,
    matchValue: string,
    extra: Record<string, string> = {}
): EntitlementV2025 => ({
    id: `ent-${id}`,
    name: id,
    value: id,
    attribute: 'groups',
    attributes: { application_name: applicationName, match_type: matchType, match_value: matchValue, ...extra },
})

const group = (dn: string): EntitlementV2025 => ({ id: `grp-${dn}`, name: dn, value: dn, attribute: 'memberOf' })

const groups = [
    group('CN=Payroll_Users,OU=Groups,DC=example,DC=com'),
    group('CN=Payroll_Admins,OU=Groups,DC=example,DC=com'),
    group('CN=Portal Admin - North,OU=Dept,OU=Groups,DC=example,DC=com'),
    group('CN=Portal Admin - South,OU=Groups,DC=example,DC=com'),
    group('CN=Portal Users,OU=Groups,DC=example,DC=com'),
    group('CN=Smith\\, John Team,OU=Groups,DC=example,DC=com'),
    group('CN=Unmapped,OU=Groups,DC=example,DC=com'),
]

const expectMappingError = (fn: () => unknown, kind: string, problemCount: number): MappingError => {
    try {
        fn()
    } catch (e) {
        expect(e).toBeInstanceOf(MappingError)
        const error = e as MappingError
        expect(error.kind).toBe(kind)
        expect(error.problems).toHaveLength(problemCount)
        return error
    }
    throw new Error('expected a MappingError')
}

describe('DN helpers', () => {
    it('splits on unescaped commas only', () => {
        expect(splitDn('CN=Smith\\, John,OU=Groups,DC=example,DC=com')).toEqual([
            'CN=Smith\\, John',
            'OU=Groups',
            'DC=example',
            'DC=com',
        ])
    })

    it('normalizes case and whitespace around separators', () => {
        expect(normalizeDn(' cn=Payroll_Users , ou=Groups,DC=Example, DC=com ')).toBe(
            normalizeDn('CN=Payroll_Users,OU=Groups,DC=example,DC=com')
        )
    })

    it('keeps inner spaces in values', () => {
        expect(normalizeDn('CN=Portal  Users,OU=Groups')).toBe('cn=portal users,ou=groups')
    })

    it('parses the CN from the first RDN', () => {
        expect(parseCn('CN=Portal Admin - North,OU=Dept,DC=example,DC=com')).toBe('Portal Admin - North')
        expect(parseCn('CN=Smith\\, John Team,OU=Groups')).toBe('Smith, John Team')
        expect(parseCn('OU=Groups,DC=example,DC=com')).toBeUndefined()
    })
})

describe('resolveMappingColumns', () => {
    it('defaults to the documented column names', () => {
        expect(columns).toEqual({
            id: 'mapping_id',
            applicationName: 'application_name',
            matchType: 'match_type',
            matchValue: 'match_value',
            traceability: ['instance_name', 'integration_type'],
        })
    })

    it('uses configured column names', () => {
        const custom = resolveMappingColumns({ ...definition, applicationNameColumn: ' app ', traceabilityColumns: [] })
        expect(custom.applicationName).toBe('app')
        expect(custom.traceability).toEqual([])
    })
})

describe('readMappingRules', () => {
    it('reads the row key from the entitlement value and keeps traceability columns', () => {
        const { rules } = readMappingRules(
            [
                row('payroll-001', 'Payroll', 'dn', 'CN=Payroll_Users,OU=Groups,DC=example,DC=com', {
                    instance_name: 'PAY',
                }),
            ],
            columns
        )
        expect(rules).toEqual([
            {
                id: 'payroll-001',
                applicationName: 'Payroll',
                matchType: 'dn',
                matchValue: 'CN=Payroll_Users,OU=Groups,DC=example,DC=com',
                traceability: { instance_name: 'PAY' },
            },
        ])
    })

    it('accepts match types in any case', () => {
        const { rules } = readMappingRules([row('portal-001', 'Portal', 'CN_PREFIX', 'Portal Admin')], columns)
        expect(rules[0].matchType).toBe('cn_prefix')
    })

    it('sets ou rows aside as deferred', () => {
        const { rules, deferredRules } = readMappingRules(
            [
                row('payroll-001', 'Payroll', 'dn', 'CN=Payroll_Users,OU=Groups'),
                row('hr-001', 'HR', 'ou', 'OU=HR,DC=example'),
            ],
            columns
        )
        expect(rules.map((r) => r.id)).toEqual(['payroll-001'])
        expect(deferredRules.map((r) => r.id)).toEqual(['hr-001'])
    })

    it('fails on every invalid row at once', () => {
        const error = expectMappingError(
            () =>
                readMappingRules(
                    [
                        row('a-001', '', 'dn', 'CN=X'),
                        row('b-001', 'B', 'regex', 'CN=Y'),
                        row('c-001', 'C', 'dn', ''),
                        row('d-001', 'D', 'dn', 'CN=Z'),
                        row('D-001', 'D', 'dn', 'CN=Z2'),
                        row('e-001', 'E', 'dn', 'CN=W'),
                    ],
                    columns
                ),
            'Invalid mapping rows',
            4
        )
        expect(error.problems[0]).toContain('missing application_name')
        expect(error.problems[1]).toContain('unknown match_type "regex"')
        expect(error.problems[2]).toContain('missing match_value')
        expect(error.problems[3]).toContain('duplicate mapping_id')
    })
})

describe('matchMappingRules', () => {
    const index = buildCandidateIndex(groups)
    const rules = (...entitlements: EntitlementV2025[]) => readMappingRules(entitlements, columns).rules

    it('matches dn rules ignoring case and spacing', () => {
        const { targets } = matchMappingRules(
            rules(row('payroll-001', 'Payroll', 'dn', 'cn=payroll_users, ou=groups, dc=example, dc=com')),
            index
        )
        expect(targets).toHaveLength(1)
        expect(targets[0].entitlements.map((e) => e.value)).toEqual(['CN=Payroll_Users,OU=Groups,DC=example,DC=com'])
    })

    it('matches dn rules with escaped commas', () => {
        const { targets } = matchMappingRules(
            rules(row('team-001', 'Team', 'dn', 'CN=Smith\\, John Team,OU=Groups,DC=example,DC=com')),
            index
        )
        expect(targets[0].entitlements).toHaveLength(1)
    })

    it('matches cn_prefix rules against the CN only, in any OU', () => {
        const { targets } = matchMappingRules(rules(row('portal-001', 'Portal', 'cn_prefix', 'portal admin')), index)
        expect(targets[0].entitlements.map((e) => e.value).sort()).toEqual([
            'CN=Portal Admin - North,OU=Dept,OU=Groups,DC=example,DC=com',
            'CN=Portal Admin - South,OU=Groups,DC=example,DC=com',
        ])
    })

    it('does not match a cn_prefix against OU or DC components', () => {
        expectMappingError(
            () => matchMappingRules(rules(row('dept-001', 'Dept', 'cn_prefix', 'Dept')), index),
            'Mapping rules matched no group',
            1
        )
    })

    it('groups several rules into one target per application and de-duplicates groups', () => {
        const { targets } = matchMappingRules(
            rules(
                row('payroll-001', 'Payroll', 'dn', 'CN=Payroll_Users,OU=Groups,DC=example,DC=com'),
                row('payroll-002', 'Payroll', 'cn_prefix', 'Payroll_'),
                row('portal-001', 'Portal', 'dn', 'CN=Portal Users,OU=Groups,DC=example,DC=com')
            ),
            index
        )
        expect(targets.map((t) => t.applicationName)).toEqual(['Payroll', 'Portal'])
        expect(targets[0].entitlements).toHaveLength(2)
        expect(targets[0].ruleIds).toEqual(['payroll-001', 'payroll-002'])
    })

    it('fails on every rule that matches nothing', () => {
        const error = expectMappingError(
            () =>
                matchMappingRules(
                    rules(
                        row('gone-001', 'Gone', 'dn', 'CN=Deleted,OU=Groups,DC=example,DC=com'),
                        row('typo-001', 'Typo', 'cn_prefix', 'Payrol_X'),
                        row('payroll-001', 'Payroll', 'cn_prefix', 'Payroll_')
                    ),
                    index
                ),
            'Mapping rules matched no group',
            2
        )
        expect(error.problems[0]).toContain('gone-001 (Gone)')
        expect(error.problems[1]).toContain('typo-001 (Typo)')
    })

    it('fails when one group lands under two applications, across match types', () => {
        const error = expectMappingError(
            () =>
                matchMappingRules(
                    rules(
                        row('portal-001', 'Portal', 'cn_prefix', 'Portal'),
                        row(
                            'north-001',
                            'North Portal',
                            'dn',
                            'CN=Portal Admin - North,OU=Dept,OU=Groups,DC=example,DC=com'
                        ),
                        row('south-001', 'South Portal', 'dn', 'cn=portal admin - south,ou=groups,dc=example,dc=com')
                    ),
                    index
                ),
            'Mapping conflicts',
            2
        )
        expect(error.problems[0]).toContain('"Portal" and "North Portal"')
        expect(error.problems[1]).toContain('"Portal" and "South Portal"')
    })

    it('allows the same group twice under the same application', () => {
        const { targets } = matchMappingRules(
            rules(
                row('portal-001', 'Portal', 'cn_prefix', 'Portal Admin'),
                row('portal-002', 'Portal', 'dn', 'CN=Portal Admin - South,OU=Groups,DC=example,DC=com')
            ),
            index
        )
        expect(targets[0].entitlements).toHaveLength(2)
    })
})

describe('planMapping', () => {
    it('reports deferred rules, deferred-only applications and unmatched groups', () => {
        const plan = planMapping(
            [
                row('payroll-001', 'Payroll', 'cn_prefix', 'Payroll_'),
                row('payroll-002', 'Payroll', 'ou', 'OU=Payroll,DC=example,DC=com'),
                row('hr-001', 'HR', 'ou', 'OU=HR,DC=example,DC=com'),
            ],
            groups,
            definition
        )
        expect(plan.targets.map((t) => t.applicationName)).toEqual(['Payroll'])
        expect(plan.deferredRules.map((r) => r.id)).toEqual(['payroll-002', 'hr-001'])
        expect(plan.deferredOnlyApplications).toEqual(['HR'])
        expect(plan.unmatchedCandidateCount).toBe(5)
        expect(plan.unmatchedCandidateSample).toContain('CN=Unmapped,OU=Groups,DC=example,DC=com')
    })

    it('fails before matching when any row is invalid', () => {
        expectMappingError(
            () => planMapping([row('payroll-001', 'Payroll', 'cn_prefix', '')], groups, definition),
            'Invalid mapping rows',
            1
        )
    })
})
