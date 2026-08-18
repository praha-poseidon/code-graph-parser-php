export type RelationshipType =
  | "PACKAGE_TO_UNIT"
  | "UNIT_TO_FUNCTION"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "OVERRIDES"
  | "ENDPOINT_TO_FUNCTION"
  | "FUNCTION_TO_ENDPOINT";

export interface ParseRequest {
  projectName?: string;
  language?: string;
  projectRoot: string;
  sourceFiles?: string[];
  sourceRoots?: string[];
  dependencies?: string[];
  gitRepoUrl?: string;
  gitBranch?: string;
  changeType?: string;
  ruleSources?: string[];
  ruleTexts?: string[];
  externalValues?: Record<string, unknown>;
  staticExtractPresetRules?: boolean | string[];
  options?: Record<string, unknown>;
}

export interface CodePackage {
  id: string;
  name: string;
  qualifiedName: string;
  language: "php";
  projectName: string;
  projectFilePath: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  packagePath: string;
  startLine?: number;
  endLine?: number;
}

export interface CodeUnit {
  id: string;
  name: string;
  qualifiedName: string;
  language: "php";
  projectName: string;
  projectFilePath: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  unitType: string;
  modifiers: string[];
  isAbstract?: boolean;
  packageId: string;
  startLine?: number;
  endLine?: number;
}

export interface CodeFunction {
  id: string;
  name: string;
  qualifiedName: string;
  language: "php";
  projectName: string;
  projectFilePath: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  signature: string;
  returnType?: string;
  modifiers: string[];
  isStatic?: boolean;
  isAsync?: boolean;
  isConstructor?: boolean;
  isPlaceholder?: boolean;
  startLine?: number;
  endLine?: number;
}

export interface CodeRelationship {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: RelationshipType;
  lineNumber?: number;
  callType?: string;
  language: "php";
  projectName: string;
}

export interface CodeEndpoint {
  endpointKind: "http" | "mq" | "redis" | "db";
  id: string;
  name: string;
  qualifiedName: string;
  language: "php";
  projectName: string;
  projectFilePath: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  startLine?: number;
  endLine?: number;
  endpointType: "HTTP" | "MQ" | "REDIS" | "DB";
  direction: "inbound" | "outbound";
  isExternal: boolean;
  parseLevel: "full" | "partial" | "unknown" | "config" | "unresolved";
  matchIdentity: string;
  httpMethod?: string;
  path?: string;
  normalizedPath?: string;
  topic?: string;
  group?: string;
  operation?: string;
  brokerType?: string;
  keyPattern?: string;
  command?: string;
  dataStructure?: string;
  tableName?: string;
  dbOperation?: string;
}

export interface Diagnostic {
  level: "INFO" | "WARN" | "ERROR";
  code: string;
  message: string;
  projectFilePath?: string;
  lineNumber?: number;
  details: Record<string, unknown>;
}

export interface GraphDelta {
  scope: {
    projectName: string;
    language: "php";
    gitRepoUrl?: string;
    gitBranch?: string;
    projectRoot: string;
    sourceFiles: string[];
    changeType?: string;
    attributes: Record<string, unknown>;
  };
  packages: CodePackage[];
  units: CodeUnit[];
  functions: CodeFunction[];
  endpoints: CodeEndpoint[];
  relationships: CodeRelationship[];
  deletedNodeIds: string[];
  deletedRelationshipIds: string[];
  diagnostics: Diagnostic[];
}
