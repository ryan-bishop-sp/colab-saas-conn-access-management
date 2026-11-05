export type ApproverType =
    | 'APP_OWNER'
    | 'OWNER'
    | 'SOURCE_OWNER'
    | 'MANAGER'
    | 'ENTITLEMENT_OWNER'

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
}

/**
 * Access profiles and applications driven by a mapping file loaded as entitlements on a delimited-file source.
 * Each mapping row assigns AD groups (by DN or CN prefix) to an application name; the connector builds one
 * access profile and one source app per application name. The mapping file replaces query and expressions.
 */
export interface MappingDefinition {
    name: string
    /** Delimited-file source whose entitlements are the mapping rows. */
    mappingSourceName: string
    /** Source whose group entitlements are matched, e.g. the AD source. */
    targetSourceName: string
    /** Mapping-file column holding the row key. Defaults to mapping_id. */
    idColumn?: string
    /** Mapping-file column holding the application name. Defaults to application_name. */
    applicationNameColumn?: string
    /** Mapping-file column holding the match type (dn, cn_prefix, ou). Defaults to match_type. */
    matchTypeColumn?: string
    /** Mapping-file column holding the match value. Defaults to match_value. */
    matchValueColumn?: string
    /** Extra mapping-file columns kept for traceability. Defaults to instance_name and integration_type. */
    traceabilityColumns?: string[]
    requestable: boolean
    requireApproval: boolean
    approverType?: ApproverType
    /** When true, delete only the access profiles and apps this definition created. Never reads the mapping file. */
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
    mappingDefinitions?: MappingDefinition[]
}
