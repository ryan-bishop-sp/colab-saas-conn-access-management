export type ApproverType = 'APP_OWNER' | 'OWNER' | 'SOURCE_OWNER' | 'MANAGER' | 'ENTITLEMENT_OWNER'

export interface Definition {
    name: string
    query: string
    entitlementExpression: string
    requestable: boolean
    requireApproval: boolean
    approverType?: ApproverType
}

export interface AccessProfileDefinition extends Definition {
    /**
     * When true: multiple entitlements with same entitlementExpression result are grouped into one access profile.
     * When false: 1:1 entitlement to access profile mapping; overlapping entitlements are discarded.
     */
    groupEntitlements: boolean
    /** When true, creates applications if they don't exist. */
    createApplication: boolean
    /**
     * When true: access profiles are distributed across multiple applications based on applicationExpression.
     * When false: all access profiles go to one application named definition.name.
     */
    groupAccessProfiles?: boolean
    /**
     * Velocity expression to determine application name (evaluated per access profile).
     * Required when groupAccessProfiles is true.
     * Context: $entitlement (single) if groupEntitlements=false, $entitlements (array) if groupEntitlements=true.
     */
    applicationExpression?: string
    /** When true, delete access profiles and applications instead of creating/updating them. */
    deleteMode?: boolean
}

export interface RoleDefinition extends Definition {
    automaticAssignment: boolean
    assignmentDefinition?: string
    groupEntitlements: boolean
    /** When true, delete roles that are no longer produced by any definition. */
    deleteStaleRoles?: boolean
}

export interface EntitlementDefinition extends Definition {
    /** When true, mark selected entitlements as privileged (bulk patch). */
    privileged?: boolean
    /** Additional Velocity selectors OR'd with entitlementExpression. */
    additionalEntitlementExpressions?: string[]
    /** Enables business-application enrichment when set. */
    businessApplicationName?: string
    /** Velocity expression that produces the friendly entitlement display name. */
    displayNameExpression?: string
    /** Optional Velocity expression that produces the entitlement description. */
    descriptionExpression?: string
    /** Existing entitlement AMM attribute technical key for the business application. */
    businessApplicationMetadataKey?: string
    /** Optional Velocity expression that produces the environment metadata value. */
    environmentExpression?: string
    /** Existing entitlement AMM attribute technical key for the environment. */
    environmentMetadataKey?: string
    /** Plan and report enrichment without patching entitlements. */
    dryRun?: boolean
}

/**
 * One application built from organizational units: every group in the subtree of the listed OUs on the
 * target source goes into one access profile and one source app, both named `name`. Groups are discovered
 * on every run; OUs are not.
 */
export interface OuApplicationDefinition {
    /** Application name. Also names the access profile and the ownership marker. */
    name: string
    /** Source whose group entitlements are matched, e.g. the AD source. */
    targetSourceName: string
    /** OU distinguished names. Groups anywhere beneath any of them belong to this application. */
    organizationalUnits: string[]
    requestable: boolean
    requireApproval: boolean
    approverType?: ApproverType
    /** When true, delete only the access profile and app this definition created. */
    deleteMode?: boolean
    /** When true, run every check and log the planned changes without writing. */
    dryRun?: boolean
}

export interface Config {
    spConnectorInstanceId: string
    spConnectorSpecId: string
    spConnectorSupportsCustomSchemas: boolean
    baseurl: string
    clientId: string
    clientSecret: string
    accessProfiles?: AccessProfileDefinition[]
    roles?: RoleDefinition[]
    entitlements?: EntitlementDefinition[]
    ouApplications?: OuApplicationDefinition[]
}
