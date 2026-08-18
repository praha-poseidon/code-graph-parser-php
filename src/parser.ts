import fs from "node:fs";
import path from "node:path";
import { Engine as PhpParserEngine } from "php-parser";
import {
  extractSymfonyYamlRouteFacts,
  runStaticExtractPhp,
  type ExtractedFact,
  type PhpAstFile
} from "@static-extract/extractor-php";
import {
  canonicalSymbol,
  endpointId,
  functionId,
  normalizeRelativePath,
  packageId,
  placeholderFunctionId,
  relationshipId,
  unitId
} from "./ids.js";
import type {
  CodeFunction,
  CodeEndpoint,
  CodePackage,
  CodeRelationship,
  CodeUnit,
  Diagnostic,
  GraphDelta,
  ParseRequest,
  RelationshipType
} from "./model.js";
import { resolvePhpPresetRules } from "./static-extract-presets.js";

interface AstNode {
  kind: string;
  loc?: {
    start?: { line?: number };
    end?: { line?: number };
  };
  [key: string]: unknown;
}

interface NamespaceBlock {
  namespace: string;
  relativePath: string;
  absolutePath: string;
  blockIndex: number;
  node: AstNode;
  children: AstNode[];
  imports: ImportTable;
  scopeUnitId?: string;
  fileInitId?: string;
}

interface ImportTable {
  classes: Map<string, string>;
  functions: Map<string, string>;
}

interface FunctionContext {
  id: string;
  namespace: string;
  relativePath: string;
  body: AstNode | AstNode[] | undefined;
  className?: string;
  imports: ImportTable;
  parameters: AstNode[];
  declaration?: AstNode;
}

interface ClassBinding {
  qualifiedName: string;
  namespace: string;
  imports: ImportTable;
  parents: string[];
  propertyTypes: Map<string, string[]>;
  constructorNode?: AstNode;
}

interface CallTarget {
  id?: string;
  qualifiedName: string;
  callType: string;
}

interface PendingClassRelation {
  fromUnitId: string;
  namespace: string;
  imports: ImportTable;
  target: string;
  type: "EXTENDS" | "IMPLEMENTS";
  lineNumber?: number;
}

interface ParseState {
  request: Required<Pick<ParseRequest, "projectRoot">> & ParseRequest;
  projectName: string;
  packages: Map<string, CodePackage>;
  units: Map<string, CodeUnit>;
  functions: Map<string, CodeFunction>;
  endpoints: Map<string, CodeEndpoint>;
  relationships: Map<string, CodeRelationship>;
  diagnostics: Diagnostic[];
  blocks: NamespaceBlock[];
  functionContexts: FunctionContext[];
  functionByQualifiedName: Map<string, string>;
  methodByQualifiedName: Map<string, string>;
  functionReturnTypes: Map<string, string[]>;
  classBindings: Map<string, ClassBinding>;
  containerServiceClasses: Map<string, string>;
  unitByQualifiedName: Map<string, string>;
  pendingClassRelations: PendingClassRelation[];
  astFiles: PhpAstFile[];
}

const GLOBAL_NAMESPACE = "<global>";
const DECLARATION_KINDS = new Set([
  "class",
  "constantstatement",
  "declare",
  "enum",
  "function",
  "halt",
  "interface",
  "namespace",
  "trait",
  "usegroup"
]);
const WALK_SKIP_KINDS = new Set(["class", "interface", "trait", "enum", "function", "closure", "arrowfunc"]);
const SCAN_EXCLUDED_DIRECTORIES = new Set([".git", ".idea", ".vscode", "node_modules", "vendor"]);

export class PhpCodeGraphParser {
  private readonly engine = new PhpParserEngine({
    parser: { extractDoc: true, suppressErrors: false },
    ast: { withPositions: true }
  });

  parse(request: ParseRequest): GraphDelta {
    const projectRoot = path.resolve(required(request.projectRoot, "ParseRequest.projectRoot"));
    const projectName = request.projectName?.trim() || path.basename(projectRoot);
    const state: ParseState = {
      request: { ...request, projectRoot },
      projectName,
      packages: new Map(),
      units: new Map(),
      functions: new Map(),
      endpoints: new Map(),
      relationships: new Map(),
      diagnostics: [],
      blocks: [],
      functionContexts: [],
      functionByQualifiedName: new Map(),
      methodByQualifiedName: new Map(),
      functionReturnTypes: new Map(),
      classBindings: new Map(),
      containerServiceClasses: new Map(),
      unitByQualifiedName: new Map(),
      pendingClassRelations: [],
      astFiles: []
    };

    const sourceFiles = discoverSourceFiles(projectRoot, request.sourceFiles);
    for (const absolutePath of sourceFiles) {
      this.parseFile(state, absolutePath);
    }
    for (const block of state.blocks) {
      this.collectDeclarations(state, block);
    }
    finalizePropertyBindings(state);
    collectContainerServiceBindings(state);
    this.emitClassRelations(state);
    for (const context of state.functionContexts) {
      this.collectCalls(state, context);
    }
    this.collectEndpoints(state);

    return {
      scope: {
        projectName,
        language: "php",
        gitRepoUrl: request.gitRepoUrl,
        gitBranch: request.gitBranch,
        projectRoot,
        sourceFiles: sourceFiles.map((file) => normalizeRelativePath(path.relative(projectRoot, file))),
        changeType: request.changeType,
        attributes: {
          parser: "php-parser",
          syntheticScopeUnits: "per-file-namespace-block",
          staticTypeBinding: "declared-types-phpdoc-and-local-flow",
          runtimeContainerBinding: false
        }
      },
      packages: [...state.packages.values()],
      units: [...state.units.values()],
      functions: [...state.functions.values()],
      endpoints: [...state.endpoints.values()],
      relationships: [...state.relationships.values()],
      deletedNodeIds: [],
      deletedRelationshipIds: [],
      diagnostics: state.diagnostics
    };
  }

  private parseFile(state: ParseState, absolutePath: string): void {
    const relativePath = normalizeRelativePath(path.relative(state.request.projectRoot, absolutePath));
    try {
      const source = fs.readFileSync(absolutePath, "utf8");
      const program = this.engine.parseCode(source, absolutePath) as unknown as AstNode;
      state.astFiles.push({ absoluteFilePath: absolutePath, projectFilePath: relativePath, source, ast: program });
      const children = nodeArray(program.children);
      const namespaceNodes = children.filter((child) => child.kind === "namespace");
      let blockIndex = 0;

      if (namespaceNodes.length === 0) {
        state.blocks.push(this.createBlock(GLOBAL_NAMESPACE, relativePath, absolutePath, ++blockIndex, program, children));
        return;
      }

      const globalChildren = children.filter((child) => child.kind !== "namespace" && child.kind !== "declare");
      if (globalChildren.length > 0) {
        state.blocks.push(this.createBlock(GLOBAL_NAMESPACE, relativePath, absolutePath, ++blockIndex, program, globalChildren));
      }
      for (const namespaceNode of namespaceNodes) {
        const namespace = stringValue(namespaceNode.name) || GLOBAL_NAMESPACE;
        state.blocks.push(this.createBlock(
          namespace,
          relativePath,
          absolutePath,
          ++blockIndex,
          namespaceNode,
          nodeArray(namespaceNode.children)
        ));
      }
    } catch (error) {
      state.diagnostics.push({
        level: "ERROR",
        code: "php.parse.failed",
        message: error instanceof Error ? error.message : String(error),
        projectFilePath: relativePath,
        details: {}
      });
    }
  }

  private createBlock(
    namespace: string,
    relativePath: string,
    absolutePath: string,
    blockIndex: number,
    node: AstNode,
    children: AstNode[]
  ): NamespaceBlock {
    return {
      namespace,
      relativePath,
      absolutePath,
      blockIndex,
      node,
      children,
      imports: collectImports(children, namespace)
    };
  }

  private collectDeclarations(state: ParseState, block: NamespaceBlock): void {
    const pkg = this.ensurePackage(state, block);
    const namespaceFunctions = block.children.filter((child) => child.kind === "function");
    const executable = block.children.filter((child) => !DECLARATION_KINDS.has(child.kind));
    if (namespaceFunctions.length > 0 || executable.length > 0) {
      block.scopeUnitId = this.ensureScopeUnit(state, block, pkg.id);
    }

    for (const child of block.children) {
      if (child.kind === "function" && block.scopeUnitId) {
        this.emitFunction(state, block, child, block.scopeUnitId);
      } else if (isClassLike(child)) {
        this.emitClass(state, block, child, pkg.id);
      }
    }

    if (executable.length > 0 && block.scopeUnitId) {
      const namespaceIdentity = namespaceIdentityOf(block.namespace);
      const qualifiedName = `${namespaceIdentity}\\<file-init@${block.relativePath}#${block.blockIndex}>()`;
      const id = functionId(qualifiedName);
      block.fileInitId = id;
      this.putFunction(state, {
        ...this.nodeBase(state, block.relativePath, id, "<file-init>", qualifiedName, block.node),
        signature: "<file-init>()",
        modifiers: ["synthetic", "file-init"]
      });
      this.addRelationship(state, block.scopeUnitId, "UNIT_TO_FUNCTION", id, lineOf(executable[0]));
      state.functionContexts.push({
        id,
        namespace: block.namespace,
        relativePath: block.relativePath,
        body: executable,
        imports: block.imports,
        parameters: []
      });
    }
  }

  private ensurePackage(state: ParseState, block: NamespaceBlock): CodePackage {
    const qualifiedName = namespaceIdentityOf(block.namespace);
    const id = packageId(qualifiedName);
    const existing = state.packages.get(id);
    if (existing) return existing;
    const name = block.namespace === GLOBAL_NAMESPACE
      ? "(global)"
      : block.namespace.split("\\").filter(Boolean).at(-1) ?? block.namespace;
    const pkg: CodePackage = {
      ...this.nodeBase(state, block.relativePath, id, name, qualifiedName, block.node),
      packagePath: qualifiedName
    };
    state.packages.set(id, pkg);
    return pkg;
  }

  private ensureScopeUnit(state: ParseState, block: NamespaceBlock, pkgId: string): string {
    const namespaceIdentity = namespaceIdentityOf(block.namespace);
    const label = block.namespace === GLOBAL_NAMESPACE ? "global" : "namespace";
    const qualifiedName = `${namespaceIdentity}.(${label}@${block.relativePath}#${block.blockIndex})`;
    const id = unitId(qualifiedName);
    if (!state.units.has(id)) {
      state.units.set(id, {
        ...this.nodeBase(state, block.relativePath, id, `(${label})`, qualifiedName, block.node),
        unitType: label,
        modifiers: ["synthetic", `${label}-scope`],
        packageId: pkgId
      });
      this.addRelationship(state, pkgId, "PACKAGE_TO_UNIT", id, lineOf(block.node));
    }
    return id;
  }

  private emitFunction(state: ParseState, block: NamespaceBlock, node: AstNode, ownerUnitId: string): void {
    const name = identifierName(node.name);
    if (!name) return;
    const qualifiedBase = qualify(block.namespace, name);
    const qualifiedName = `${qualifiedBase}()`;
    const id = functionId(qualifiedName);
    state.functionByQualifiedName.set(canonicalSymbol(qualifiedBase), id);
    this.putFunction(state, {
      ...this.nodeBase(state, block.relativePath, id, name, qualifiedName, node),
      signature: renderSignature(name, node),
      returnType: renderType(node.type),
      modifiers: functionModifiers(node)
    });
    state.functionReturnTypes.set(id, resolveFunctionReturnTypes(node, block.namespace, block.imports));
    this.addRelationship(state, ownerUnitId, "UNIT_TO_FUNCTION", id, lineOf(node));
    state.functionContexts.push({
      id,
      namespace: block.namespace,
      relativePath: block.relativePath,
      body: asNode(node.body),
      imports: block.imports,
      parameters: nodeArray(node.arguments),
      declaration: node
    });
  }

  private emitClass(state: ParseState, block: NamespaceBlock, node: AstNode, pkgId: string): void {
    const name = identifierName(node.name);
    if (!name) return;
    const qualifiedName = qualify(block.namespace, name);
    const id = unitId(qualifiedName);
    const unitType = node.kind === "class" ? "class" : node.kind;
    const modifiers = classModifiers(node);
    state.units.set(id, {
      ...this.nodeBase(state, block.relativePath, id, name, qualifiedName, node),
      unitType,
      modifiers,
      isAbstract: Boolean(node.isAbstract) || node.kind === "interface",
      packageId: pkgId
    });
    state.unitByQualifiedName.set(canonicalSymbol(qualifiedName), id);
    this.addRelationship(state, pkgId, "PACKAGE_TO_UNIT", id, lineOf(node));

    const parents = [
      ...optionalNames(node.extends),
      ...optionalNames(node.implements)
    ].map((target) => resolveClassName(target, block.namespace, block.imports));
    const classBinding: ClassBinding = {
      qualifiedName,
      namespace: block.namespace,
      imports: block.imports,
      parents,
      propertyTypes: collectDeclaredPropertyTypes(node, block.namespace, block.imports)
    };
    state.classBindings.set(canonicalSymbol(qualifiedName), classBinding);

    const extendsNames = optionalNames(node.extends);
    for (const target of extendsNames) {
      state.pendingClassRelations.push({
        fromUnitId: id,
        namespace: block.namespace,
        imports: block.imports,
        target,
        type: "EXTENDS",
        lineNumber: lineOf(node)
      });
    }
    for (const target of optionalNames(node.implements)) {
      state.pendingClassRelations.push({
        fromUnitId: id,
        namespace: block.namespace,
        imports: block.imports,
        target,
        type: "IMPLEMENTS",
        lineNumber: lineOf(node)
      });
    }

    for (const member of nodeArray(node.body)) {
      if (member.kind !== "method") continue;
      const methodName = identifierName(member.name);
      if (!methodName) continue;
      const methodBase = `${qualifiedName}::${methodName}`;
      const methodQualifiedName = `${methodBase}()`;
      const methodId = functionId(methodQualifiedName);
      state.methodByQualifiedName.set(canonicalSymbol(methodBase), methodId);
      const methodModifiers = functionModifiers(member);
      this.putFunction(state, {
        ...this.nodeBase(state, block.relativePath, methodId, methodName, methodQualifiedName, member),
        signature: renderSignature(methodName, member),
        returnType: renderType(member.type),
        modifiers: methodModifiers,
        isStatic: Boolean(member.isStatic),
        isConstructor: methodName.toLowerCase() === "__construct"
      });
      state.functionReturnTypes.set(methodId, resolveFunctionReturnTypes(
        member,
        block.namespace,
        block.imports,
        qualifiedName
      ));
      if (methodName.toLowerCase() === "__construct") {
        classBinding.constructorNode = member;
        for (const parameter of nodeArray(member.arguments)) {
          if (Number(parameter.flags ?? 0) === 0) continue;
          const propertyName = identifierName(parameter.name);
          const types = resolveDeclaredTypes(parameter.type, block.namespace, block.imports, qualifiedName);
          if (propertyName && types.length > 0) classBinding.propertyTypes.set(propertyName.toLowerCase(), types);
        }
      }
      this.addRelationship(state, id, "UNIT_TO_FUNCTION", methodId, lineOf(member));
      state.functionContexts.push({
        id: methodId,
        namespace: block.namespace,
        relativePath: block.relativePath,
        body: asNode(member.body),
        className: qualifiedName,
        imports: block.imports,
        parameters: nodeArray(member.arguments),
        declaration: member
      });
    }
  }

  private emitClassRelations(state: ParseState): void {
    for (const pending of state.pendingClassRelations) {
      const targetName = resolveClassName(pending.target, pending.namespace, pending.imports);
      const toUnitId = state.unitByQualifiedName.get(canonicalSymbol(targetName));
      if (!toUnitId) continue;
      this.addRelationship(state, pending.fromUnitId, pending.type, toUnitId, pending.lineNumber);

      if (pending.type === "EXTENDS") {
        const childUnit = state.units.get(pending.fromUnitId);
        if (!childUnit) continue;
        const childPrefix = `${childUnit.qualifiedName}::`;
        const parentUnit = state.units.get(toUnitId);
        if (!parentUnit) continue;
        for (const fn of state.functions.values()) {
          if (!fn.qualifiedName.startsWith(childPrefix)) continue;
          const methodName = fn.name;
          const parentMethod = state.methodByQualifiedName.get(canonicalSymbol(`${parentUnit.qualifiedName}::${methodName}`));
          if (parentMethod) this.addRelationship(state, fn.id, "OVERRIDES", parentMethod, fn.startLine);
        }
      }
    }
  }

  private collectCalls(state: ParseState, context: FunctionContext): void {
    const variableTypes = initialVariableTypes(context);
    walk(context.body, (node) => {
      if (node.kind === "assign") updateAssignedTypes(node, context, state, variableTypes);
      const targets = node.kind === "call"
        ? resolveCallTargets(node, context, state, variableTypes)
        : node.kind === "new"
          ? optionalTarget(resolveConstructorTarget(node, context, state))
          : [];
      for (const target of targets) {
        const targetId = target.id ?? this.ensurePlaceholder(state, target.qualifiedName, context.relativePath, node);
        this.addRelationship(state, context.id, "CALLS", targetId, lineOf(node), target.callType);
      }
    });
  }

  private ensurePlaceholder(
    state: ParseState,
    qualifiedName: string,
    projectFilePath: string,
    node: AstNode
  ): string {
    const id = placeholderFunctionId(qualifiedName);
    if (!state.functions.has(id)) {
      const simple = qualifiedName.replace(/\(\)$/, "").split(/\\|::/).at(-1) ?? qualifiedName;
      this.putFunction(state, {
        ...this.nodeBase(state, projectFilePath, id, simple, qualifiedName, node),
        signature: `${simple}()`,
        modifiers: [
          "placeholder",
          "unresolved",
          qualifiedName.startsWith("<dynamic>::") ? "dynamic-receiver" : "statically-named-target"
        ],
        isPlaceholder: true
      });
    }
    return id;
  }

  private collectEndpoints(state: ParseState): void {
    const presetInput = state.request.staticExtractPresetRules
      ?? optionBooleanOrStrings(state.request, "staticExtractPresetRules")
      ?? optionBooleanOrStrings(state.request, "staticExtractPreset");
    const presetRules = resolvePhpPresetRules(presetInput);
    const inlineRules = [
      ...presetRules,
      ...(state.request.ruleTexts ?? []),
      ...(optionStrings(state.request, "ruleTexts") ?? [])
    ];
    const ruleFiles = state.request.ruleSources ?? [];
    if (inlineRules.length === 0 && ruleFiles.length === 0) return;
    try {
      const report = runStaticExtractPhp({
        project: state.request.projectRoot,
        projectName: state.projectName,
        astFiles: state.astFiles,
        ruleFiles,
        ruleSources: inlineRules,
        externalValues: state.request.externalValues
      });
      for (const fact of report.results) this.addEndpointFact(state, fact);
      if (includesPreset(presetInput, "symfony-route")) {
        for (const fact of extractSymfonyYamlRouteFacts(state.request.projectRoot)) {
          this.addEndpointFact(state, fact);
        }
      }
    } catch (error) {
      state.diagnostics.push({
        level: "ERROR",
        code: "php.static-extract.failed",
        message: error instanceof Error ? error.message : String(error),
        details: {}
      });
    }
  }

  private addEndpointFact(state: ParseState, fact: ExtractedFact): void {
    const type = endpointTypeOf(fact);
    if (!type) return;
    const direction: CodeEndpoint["direction"] =
      fact.fields.direction?.toLowerCase() === "inbound" ? "inbound" : "outbound";
    const identity = endpointIdentity(type, fact.fields);
    if (!identity) return;
    const matchIdentity = fact.fields.matchIdentity || `${type}:${identity}`;
    const id = endpointId(direction, type, matchIdentity);
    const base = {
      id,
      name: matchIdentity,
      qualifiedName: id,
      language: "php" as const,
      projectName: state.projectName,
      projectFilePath: fact.projectFilePath,
      gitRepoUrl: state.request.gitRepoUrl,
      gitBranch: state.request.gitBranch,
      startLine: fact.startLine,
      endLine: fact.endLine,
      direction,
      isExternal: direction === "outbound",
      parseLevel: endpointParseLevel(fact.fields.parseLevel),
      matchIdentity
    };
    let endpoint: CodeEndpoint;
    if (type === "HTTP") {
      const httpMethod = normalizeHttpMethod(fact.fields.method);
      const normalizedPath = normalizeEndpointPath(fact.fields.path ?? fact.fields.url ?? fact.fields.route ?? "");
      endpoint = {
        ...base,
        endpointKind: "http",
        endpointType: "HTTP",
        httpMethod,
        path: fact.fields.path ?? fact.fields.url ?? fact.fields.route,
        normalizedPath
      };
    } else if (type === "MQ") {
      endpoint = {
        ...base,
        endpointKind: "mq",
        endpointType: "MQ",
        topic: fact.fields.topic,
        group: fact.fields.group,
        operation: fact.fields.operation,
        brokerType: fact.fields.brokerType
      };
    } else if (type === "REDIS") {
      endpoint = {
        ...base,
        endpointKind: "redis",
        endpointType: "REDIS",
        keyPattern: fact.fields.keyPattern ?? fact.fields.key,
        command: normalizeRedisCommand(fact.fields.command),
        dataStructure: fact.fields.dataStructure
      };
    } else {
      endpoint = {
        ...base,
        endpointKind: "db",
        endpointType: "DB",
        tableName: fact.fields.tableName ?? fact.fields.table,
        dbOperation: fact.fields.dbOperation ?? fact.fields.operation
      };
    }
    if (!state.endpoints.has(id)) state.endpoints.set(id, endpoint);

    const linkedFunction = resolveEndpointFunction(state, fact, direction);
    if (!linkedFunction) {
      if (direction === "inbound" && fact.fields.handler && !fact.fields.handler.startsWith("<closure@")) {
        const stored = state.endpoints.get(id);
        if (stored) stored.parseLevel = "unresolved";
        state.diagnostics.push({
          level: "WARN",
          code: "php.endpoint.handler.unresolved",
          message: `Route handler ${fact.fields.handler} was not found in the parsed project`,
          projectFilePath: fact.projectFilePath,
          lineNumber: fact.startLine,
          details: { handler: fact.fields.handler, endpointId: id }
        });
      }
      return;
    }
    this.addRelationship(
      state,
      direction === "inbound" ? id : linkedFunction.id,
      direction === "inbound" ? "ENDPOINT_TO_FUNCTION" : "FUNCTION_TO_ENDPOINT",
      direction === "inbound" ? linkedFunction.id : id,
      fact.startLine
    );
  }

  private putFunction(state: ParseState, fn: CodeFunction): void {
    const existing = state.functions.get(fn.id);
    if (!existing || existing.isPlaceholder) state.functions.set(fn.id, fn);
  }

  private addRelationship(
    state: ParseState,
    fromNodeId: string,
    type: RelationshipType,
    toNodeId: string,
    lineNumber?: number,
    callType?: string
  ): void {
    const key = `${fromNodeId}|${type}|${toNodeId}`;
    if (state.relationships.has(key)) return;
    const relationship: CodeRelationship = {
      id: relationshipId(fromNodeId, type, toNodeId),
      fromNodeId,
      toNodeId,
      relationshipType: type,
      lineNumber,
      callType,
      language: "php",
      projectName: state.projectName
    };
    state.relationships.set(key, relationship);
  }

  private nodeBase(
    state: ParseState,
    projectFilePath: string,
    id: string,
    name: string,
    qualifiedName: string,
    node: AstNode
  ) {
    return {
      id,
      name,
      qualifiedName,
      language: "php" as const,
      projectName: state.projectName,
      projectFilePath,
      gitRepoUrl: state.request.gitRepoUrl,
      gitBranch: state.request.gitBranch,
      startLine: lineOf(node),
      endLine: endLineOf(node)
    };
  }
}

function resolveCallTargets(
  call: AstNode,
  context: FunctionContext,
  state: ParseState,
  variableTypes: Map<string, string[]>
): CallTarget[] {
  const callee = asNode(call.what);
  if (!callee) return [];
  if (callee.kind === "name" || callee.kind === "identifier") {
    const raw = stringValue(callee.name);
    if (!raw) return [];
    const resolved = resolveFunctionName(raw, callee, context.namespace, context.imports, state);
    return [{
      id: state.functionByQualifiedName.get(canonicalSymbol(resolved)),
      qualifiedName: `${resolved}()`,
      callType: "direct"
    }];
  }
  if (callee.kind === "propertylookup" || callee.kind === "nullsafepropertylookup") {
    const method = identifierName(callee.offset);
    if (!method) return [];
    const receiver = asNode(callee.what);
    const receiverTypes = inferExpressionTypes(receiver, context, state, variableTypes);
    if (receiverTypes.length === 0) {
      return [{ qualifiedName: `<dynamic>::${method}()`, callType: "virtual" }];
    }
    return uniqueTargets(receiverTypes.map((receiverType) => {
      const resolved = resolveMethodInHierarchy(state, receiverType, method);
      const owner = resolved?.owner ?? receiverType;
      return {
        id: resolved?.id,
        qualifiedName: `${owner}::${method}()`,
        callType: "virtual"
      };
    }));
  }
  if (callee.kind === "staticlookup") {
    const method = identifierName(callee.offset);
    const owner = resolveStaticOwner(callee.what, context, state);
    if (!method || !owner) return [];
    const resolved = resolveMethodInHierarchy(state, owner, method);
    const resolvedOwner = resolved?.owner ?? owner;
    return [{
        id: resolved?.id,
        qualifiedName: `${resolvedOwner}::${method}()`,
        callType: "static"
      }];
  }
  return [];
}

function uniqueTargets(targets: CallTarget[]): CallTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.id ?? canonicalSymbol(target.qualifiedName);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionalTarget(target: CallTarget | undefined): CallTarget[] {
  return target ? [target] : [];
}

function resolveConstructorTarget(
  expression: AstNode,
  context: FunctionContext,
  state: ParseState
): { id?: string; qualifiedName: string; callType: string } | undefined {
  const target = asNode(expression.what);
  const raw = target ? stringValue(target.name) : "";
  if (!raw) return undefined;
  const owner = resolveClassName(raw, context.namespace, context.imports);
  const base = `${owner}::__construct`;
  return {
    id: state.methodByQualifiedName.get(canonicalSymbol(base)),
    qualifiedName: `${base}()`,
    callType: "constructor"
  };
}

const PHP_BUILTIN_TYPES = new Set([
  "array", "array-key", "bool", "boolean", "callable", "class-string", "false", "float", "int",
  "integer", "iterable", "list", "mixed", "never", "non-empty-array", "non-empty-string", "null",
  "numeric-string", "object", "positive-int", "resource", "scalar", "string", "true", "void"
]);

function collectDeclaredPropertyTypes(
  classNode: AstNode,
  namespace: string,
  imports: ImportTable
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const member of nodeArray(classNode.body)) {
    if (member.kind !== "propertystatement") continue;
    for (const property of nodeArray(member.properties)) {
      const name = identifierName(property.name);
      const declared = resolveDeclaredTypes(property.type ?? member.type, namespace, imports);
      const types = declared.length > 0 ? declared : resolvePhpDocTypes(member, "var", namespace, imports);
      if (name && types.length > 0) result.set(name.toLowerCase(), types);
    }
  }
  return result;
}

function resolveFunctionReturnTypes(
  node: AstNode,
  namespace: string,
  imports: ImportTable,
  className?: string
): string[] {
  const declared = resolveDeclaredTypes(node.type, namespace, imports, className);
  return declared.length > 0 ? declared : resolvePhpDocTypes(node, "return", namespace, imports, className);
}

function resolvePhpDocTypes(
  node: AstNode,
  tag: "var" | "return" | "param",
  namespace: string,
  imports: ImportTable,
  className?: string,
  parameterName?: string
): string[] {
  const comments = nodeArray(node.leadingComments).map((comment) => stringValue(comment.value));
  const output: string[] = [];
  const expression = tag === "param"
    ? /@param\s+([^\s*]+)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g
    : new RegExp(`@${tag}\\s+([^\\s*]+)`, "g");
  for (const comment of comments) {
    for (const match of comment.matchAll(expression)) {
      if (tag === "param" && parameterName && match[2]?.toLowerCase() !== parameterName.toLowerCase()) continue;
      for (const rawType of (match[1] ?? "").split("|")) {
        const normalized = rawType.replace(/^\?/, "").replace(/<.*>$/, "");
        if (normalized.endsWith("[]") || normalized.includes("{") || normalized.includes("(")) continue;
        output.push(...resolveOneDeclaredType(normalized, namespace, imports, className));
      }
    }
  }
  return uniqueTypes(output);
}

function resolveDeclaredTypes(
  value: unknown,
  namespace: string,
  imports: ImportTable,
  className?: string
): string[] {
  if (typeof value === "string") return resolveOneDeclaredType(value, namespace, imports, className);
  const node = asNode(value);
  if (!node) return [];
  const nested = nodeArray(node.types);
  if (nested.length > 0) {
    return uniqueTypes(nested.flatMap((entry) => resolveDeclaredTypes(entry, namespace, imports, className)));
  }
  const raw = stringValue(node.name) || stringValue(node.raw);
  return resolveOneDeclaredType(raw, namespace, imports, className);
}

function resolveOneDeclaredType(
  raw: string,
  namespace: string,
  imports: ImportTable,
  className?: string
): string[] {
  const normalized = raw.trim().replace(/^\?/, "");
  if (!normalized || PHP_BUILTIN_TYPES.has(normalized.toLowerCase())) return [];
  if (["self", "static", "$this"].includes(normalized.toLowerCase())) return className ? [className] : [];
  if (normalized.toLowerCase() === "parent") return [];
  return [resolveClassName(normalized, namespace, imports)];
}

function finalizePropertyBindings(state: ParseState): void {
  for (const binding of state.classBindings.values()) {
    if (!binding.constructorNode) continue;
    const context: FunctionContext = {
      id: "",
      namespace: binding.namespace,
      relativePath: "",
      body: asNode(binding.constructorNode.body),
      className: binding.qualifiedName,
      imports: binding.imports,
      parameters: nodeArray(binding.constructorNode.arguments),
      declaration: binding.constructorNode
    };
    const variables = initialVariableTypes(context);
    walk(context.body, (node) => {
      if (node.kind === "assign") updateAssignedTypes(node, context, state, variables);
    });
  }
}

function initialVariableTypes(context: FunctionContext): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (context.className) result.set("this", [context.className]);
  for (const parameter of context.parameters) {
    const name = identifierName(parameter.name);
    const declared = resolveDeclaredTypes(parameter.type, context.namespace, context.imports, context.className);
    const types = declared.length > 0
      ? declared
      : context.declaration
        ? resolvePhpDocTypes(
          context.declaration,
          "param",
          context.namespace,
          context.imports,
          context.className,
          name
        )
        : [];
    if (name && types.length > 0) result.set(name.toLowerCase(), types);
  }
  return result;
}

function updateAssignedTypes(
  assignment: AstNode,
  context: FunctionContext,
  state: ParseState,
  variableTypes: Map<string, string[]>
): void {
  const left = asNode(assignment.left);
  const right = asNode(assignment.right);
  const inferred = inferExpressionTypes(right, context, state, variableTypes);
  if (!left || inferred.length === 0) return;
  if (left.kind === "variable") {
    const name = stringValue(left.name).toLowerCase();
    if (name) variableTypes.set(name, mergeTypes(variableTypes.get(name), inferred));
    return;
  }
  if (["propertylookup", "nullsafepropertylookup"].includes(left.kind) && context.className) {
    const receiver = asNode(left.what);
    const property = identifierName(left.offset).toLowerCase();
    if (receiver?.kind === "variable" && stringValue(receiver.name) === "this" && property) {
      const binding = state.classBindings.get(canonicalSymbol(context.className));
      if (binding) binding.propertyTypes.set(property, mergeTypes(binding.propertyTypes.get(property), inferred));
    }
  }
}

function inferExpressionTypes(
  expression: AstNode | undefined,
  context: FunctionContext,
  state: ParseState,
  variableTypes: Map<string, string[]>,
  seen = new Set<AstNode>()
): string[] {
  if (!expression || seen.has(expression)) return [];
  seen.add(expression);
  if (expression.kind === "variable") {
    return variableTypes.get(stringValue(expression.name).toLowerCase()) ?? [];
  }
  if (expression.kind === "new") {
    const target = asNode(expression.what);
    if (!target) return [];
    if (["selfreference", "staticreference"].includes(target.kind)) return context.className ? [context.className] : [];
    if (target.kind === "parentreference" && context.className) {
      return state.classBindings.get(canonicalSymbol(context.className))?.parents.slice(0, 1) ?? [];
    }
    const raw = stringValue(target.name);
    return raw ? [resolveClassName(raw, context.namespace, context.imports)] : [];
  }
  if (["propertylookup", "nullsafepropertylookup"].includes(expression.kind)) {
    const property = identifierName(expression.offset);
    if (!property) return [];
    const receivers = inferExpressionTypes(asNode(expression.what), context, state, variableTypes, seen);
    return uniqueTypes(receivers.flatMap((receiver) => resolvePropertyTypes(state, receiver, property)));
  }
  if (expression.kind === "call") {
    const targets = resolveCallTargets(expression, context, state, variableTypes);
    return uniqueTypes(targets.flatMap((target) => target.id ? state.functionReturnTypes.get(target.id) ?? [] : []));
  }
  if (expression.kind === "assign") {
    return inferExpressionTypes(asNode(expression.right), context, state, variableTypes, seen);
  }
  if (["clone", "cast"].includes(expression.kind)) {
    return inferExpressionTypes(asNode(expression.what) ?? asNode(expression.expr), context, state, variableTypes, seen);
  }
  if (expression.kind === "retif") {
    return uniqueTypes([
      ...inferExpressionTypes(asNode(expression.trueExpr), context, state, variableTypes, seen),
      ...inferExpressionTypes(asNode(expression.falseExpr), context, state, variableTypes, seen)
    ]);
  }
  return [];
}

function resolvePropertyTypes(
  state: ParseState,
  className: string,
  property: string,
  visited = new Set<string>()
): string[] {
  const key = canonicalSymbol(className);
  if (visited.has(key)) return [];
  visited.add(key);
  const binding = state.classBindings.get(key);
  if (!binding) return [];
  const direct = binding.propertyTypes.get(property.toLowerCase());
  if (direct?.length) return direct;
  return uniqueTypes(binding.parents.flatMap((parent) => resolvePropertyTypes(state, parent, property, visited)));
}

function resolveMethodInHierarchy(
  state: ParseState,
  className: string,
  method: string,
  visited = new Set<string>()
): { id: string; owner: string } | undefined {
  const key = canonicalSymbol(className);
  if (visited.has(key)) return undefined;
  visited.add(key);
  const direct = state.methodByQualifiedName.get(canonicalSymbol(`${className}::${method}`));
  if (direct) return { id: direct, owner: className };
  const binding = state.classBindings.get(key);
  if (!binding) return undefined;
  for (const parent of binding.parents) {
    const resolved = resolveMethodInHierarchy(state, parent, method, visited);
    if (resolved) return resolved;
  }
  return undefined;
}

function mergeTypes(existing: string[] | undefined, incoming: string[]): string[] {
  return uniqueTypes([...(existing ?? []), ...incoming]);
}

function uniqueTypes(types: string[]): string[] {
  const seen = new Set<string>();
  return types.filter((type) => {
    const key = canonicalSymbol(type);
    if (!type || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function endpointTypeOf(fact: ExtractedFact): CodeEndpoint["endpointType"] | undefined {
  const explicit = fact.fields.endpointType?.toUpperCase();
  if (["HTTP", "MQ", "REDIS", "DB"].includes(explicit)) return explicit as CodeEndpoint["endpointType"];
  const factType = fact.factType.toLowerCase();
  if (factType.includes("route") || factType.includes("http") || fact.fields.path || fact.fields.url) return "HTTP";
  if (factType.includes("redis") || fact.fields.keyPattern) return "REDIS";
  if (factType.includes("mq") || fact.fields.topic) return "MQ";
  if (factType.includes("db") || fact.fields.tableName) return "DB";
  return undefined;
}

function endpointParseLevel(value: string | undefined): CodeEndpoint["parseLevel"] {
  const normalized = value?.trim().toLowerCase();
  if (["full", "partial", "unknown", "config", "unresolved"].includes(normalized ?? "")) {
    return normalized as CodeEndpoint["parseLevel"];
  }
  return "full";
}

function endpointIdentity(type: CodeEndpoint["endpointType"], fields: Record<string, string>): string {
  if (type === "HTTP") {
    const rawPath = fields.path ?? fields.url ?? fields.route;
    if (!rawPath) return "";
    return `${normalizeHttpMethod(fields.method)}:${normalizeEndpointPath(rawPath)}`;
  }
  if (type === "MQ") return fields.topic ?? "";
  if (type === "REDIS") return fields.keyPattern ?? fields.key ?? "";
  return fields.tableName ?? fields.table ?? "";
}

function normalizeHttpMethod(value: string | undefined): string {
  const method = (value || "ANY").trim().toUpperCase();
  return method === "DEL" ? "DELETE" : method;
}

function normalizeRedisCommand(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const command = value.trim().toUpperCase();
  return command === "DEL" ? "DELETE" : command;
}

function normalizeEndpointPath(value: string): string {
  let result = stripUrlQuery(value.trim().replace(/^https?:\/\/[^/]+/i, ""));
  result = result.replace(/\\/g, "/").replace(/\/+/g, "/");
  result = result.replace(/\{[^}/]+}/g, "{param}").replace(/:([A-Za-z_$][\w$]*)/g, "{param}");
  if (result && !result.startsWith("/")) result = `/${result}`;
  return result.length > 1 ? result.replace(/\/$/, "") : result;
}

function stripUrlQuery(value: string): string {
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") braceDepth += 1;
    else if (value[index] === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (value[index] === "?" && braceDepth === 0) return value.slice(0, index);
  }
  return value;
}

function resolveEndpointFunction(
  state: ParseState,
  fact: ExtractedFact,
  direction: "inbound" | "outbound"
): CodeFunction | undefined {
  if (direction === "outbound") return findFunctionByReference(state, fact.enclosingSymbol, fact.projectFilePath);
  const handler = fact.fields.handler;
  if (handler) {
    const exact = findFunctionByReference(state, handler, fact.projectFilePath, fact.enclosingSymbol);
    if (exact) return exact;
  }
  return findFunctionByReference(state, fact.enclosingSymbol, fact.projectFilePath);
}

function findFunctionByReference(
  state: ParseState,
  reference: string | null | undefined,
  projectFilePath: string,
  enclosingSymbol?: string | null
): CodeFunction | undefined {
  if (!reference) return undefined;
  let normalized = reference.replace(/^\\+/, "").replace(/\(\)$/, "");
  const legacyController = normalized.includes("::") ? null : normalized.match(/^(.+):([^:]+)$/);
  if (legacyController) normalized = `${legacyController[1]}::${legacyController[2]}`;
  if (normalized.startsWith("self::") && enclosingSymbol?.includes("::")) {
    normalized = `${enclosingSymbol.slice(0, enclosingSymbol.indexOf("::"))}::${normalized.slice("self::".length)}`;
  }
  const serviceSeparator = normalized.lastIndexOf("::");
  const serviceOwner = serviceSeparator > 0 ? normalized.slice(0, serviceSeparator) : normalized;
  const serviceClass = state.containerServiceClasses.get(serviceOwner.toLowerCase());
  if (serviceClass) {
    normalized = serviceSeparator > 0
      ? `${serviceClass}::${normalized.slice(serviceSeparator + 2)}`
      : serviceClass;
  }
  const functions = [...state.functions.values()].filter((fn) => !fn.isPlaceholder);
  const exact = functions.find((fn) =>
    canonicalSymbol(fn.qualifiedName.replace(/\(\)$/, "")) === canonicalSymbol(normalized)
  );
  if (exact) return exact;

  if (!normalized.includes("::")) {
    for (const block of state.blocks.filter((candidate) => candidate.relativePath === projectFilePath)) {
      const resolvedOwner = resolveClassName(normalized, block.namespace, block.imports);
      const invokeId = state.methodByQualifiedName.get(canonicalSymbol(`${resolvedOwner}::__invoke`));
      if (invokeId) return state.functions.get(invokeId);
    }
    if (normalized.includes("\\")) {
      const invokeId = state.methodByQualifiedName.get(canonicalSymbol(`${normalized}::__invoke`));
      if (invokeId) return state.functions.get(invokeId);
    }
  }

  const separator = normalized.lastIndexOf("::");
  if (separator > 0) {
    const owner = normalized.slice(0, separator).replace(/::class$/i, "");
    const method = normalized.slice(separator + 2);
    for (const block of state.blocks.filter((candidate) => candidate.relativePath === projectFilePath)) {
      const resolvedOwner = resolveClassName(owner, block.namespace, block.imports);
      const resolvedId = state.methodByQualifiedName.get(canonicalSymbol(`${resolvedOwner}::${method}`));
      if (resolvedId) return state.functions.get(resolvedId);
    }
    const ownerShortName = owner.split("\\").at(-1)?.toLowerCase();
    const matches = functions.filter((fn) => {
      const base = fn.qualifiedName.replace(/\(\)$/, "");
      const fnSeparator = base.lastIndexOf("::");
      if (fnSeparator < 0 || fn.name.toLowerCase() !== method.toLowerCase()) return false;
      return base.slice(0, fnSeparator).split("\\").at(-1)?.toLowerCase() === ownerShortName;
    });
    if (matches.length === 1) return matches[0];
  }

  const localCandidates = functions.filter((fn) => fn.projectFilePath === projectFilePath);
  return localCandidates.find((fn) =>
    fn.name.toLowerCase() === normalized.split("::").at(-1)?.split("\\").at(-1)?.toLowerCase()
  );
}

function includesPreset(input: boolean | string[] | undefined, name: string): boolean {
  return input === true || Array.isArray(input) && (input.includes("all") || input.includes(name));
}

function collectContainerServiceBindings(state: ParseState): void {
  for (const block of state.blocks) {
    walkAll(block.node, (node) => {
      if (node.kind !== "assign") return;
      const left = asNode(node.left);
      const right = asNode(node.right);
      if (left?.kind !== "offsetlookup" || !right || !["closure", "arrowfunc"].includes(right.kind)) return;
      const container = asNode(left.what);
      const offset = asNode(left.offset);
      if (container?.kind !== "variable" || offset?.kind !== "string") return;
      const serviceId = stringValue(offset.value);
      if (!serviceId) return;
      let constructor: AstNode | undefined;
      walkAll(right, (candidate) => {
        if (!constructor && candidate.kind === "new") constructor = candidate;
      });
      const rawClass = identifierName(constructor?.what);
      if (!rawClass) return;
      state.containerServiceClasses.set(
        serviceId.toLowerCase(),
        resolveClassName(rawClass, block.namespace, block.imports)
      );
    });
  }
}

function resolveFunctionName(
  raw: string,
  node: AstNode,
  namespace: string,
  imports: ImportTable,
  state: ParseState
): string {
  const clean = raw.replace(/^\\+/, "");
  if (raw.startsWith("\\") || node.resolution === "fqn") return clean;
  const first = clean.split("\\")[0]?.toLowerCase();
  const imported = first ? imports.functions.get(first) : undefined;
  if (imported) return clean.includes("\\") ? `${imported}${clean.slice(clean.indexOf("\\"))}` : imported;
  const namespaced = qualify(namespace, clean);
  if (state.functionByQualifiedName.has(canonicalSymbol(namespaced))) return namespaced;
  if (state.functionByQualifiedName.has(canonicalSymbol(clean))) return clean;
  return namespaced;
}

function resolveStaticOwner(value: unknown, context: FunctionContext, state: ParseState): string | undefined {
  const node = asNode(value);
  if (!node) return undefined;
  if (["selfreference", "staticreference"].includes(node.kind)) return context.className;
  if (node.kind === "parentreference" && context.className) {
    return state.classBindings.get(canonicalSymbol(context.className))?.parents[0];
  }
  const raw = stringValue(node.name);
  return raw ? resolveClassName(raw, context.namespace, context.imports) : undefined;
}

function resolveClassName(raw: string, namespace: string, imports: ImportTable): string {
  const clean = raw.replace(/^\\+/, "");
  if (raw.startsWith("\\")) return clean;
  const first = clean.split("\\")[0]?.toLowerCase();
  const imported = first ? imports.classes.get(first) : undefined;
  if (imported) return clean.includes("\\") ? `${imported}${clean.slice(clean.indexOf("\\"))}` : imported;
  return qualify(namespace, clean);
}

function collectImports(children: AstNode[], namespace: string): ImportTable {
  const table: ImportTable = { classes: new Map(), functions: new Map() };
  for (const child of children) {
    if (child.kind !== "usegroup") continue;
    const prefix = stringValue(child.name);
    const groupType = stringValue(child.type);
    for (const item of nodeArray(child.items)) {
      const itemName = stringValue(item.name);
      if (!itemName) continue;
      const fullName = [prefix, itemName].filter(Boolean).join("\\");
      const alias = identifierName(item.alias) || itemName.split("\\").at(-1) || itemName;
      const type = stringValue(item.type) || groupType;
      const target = type === "function" ? table.functions : table.classes;
      // PHP use declarations are absolute even when written without a leading slash.
      target.set(alias.toLowerCase(), fullName.replace(/^\\+/, ""));
    }
  }
  return table;
}

function renderSignature(name: string, node: AstNode): string {
  const params = nodeArray(node.arguments).map((param) => {
    const type = renderType(param.type);
    const paramName = identifierName(param.name);
    const prefix = `${param.byref ? "&" : ""}${param.variadic ? "..." : ""}`;
    return [type, `${prefix}$${paramName}`].filter(Boolean).join(" ");
  });
  return `${name}(${params.join(", ")})`;
}

function renderType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const node = asNode(value);
  if (!node) return undefined;
  const direct = stringValue(node.name) || stringValue(node.raw);
  if (direct) return `${node.nullable ? "?" : ""}${direct}`;
  const types = nodeArray(node.types).map((entry) => renderType(entry)).filter((entry): entry is string => Boolean(entry));
  if (types.length > 0) return types.join(node.kind === "intersectiontype" ? "&" : "|");
  return undefined;
}

function functionModifiers(node: AstNode): string[] {
  const result: string[] = [];
  const visibility = stringValue(node.visibility);
  if (visibility) result.push(visibility);
  if (node.isStatic) result.push("static");
  if (node.isAbstract) result.push("abstract");
  if (node.isFinal) result.push("final");
  if (node.byref) result.push("returns-by-reference");
  return result;
}

function classModifiers(node: AstNode): string[] {
  const result: string[] = [];
  if (node.isAbstract) result.push("abstract");
  if (node.isFinal) result.push("final");
  if (node.isReadonly) result.push("readonly");
  return result;
}

function isClassLike(node: AstNode): boolean {
  return ["class", "interface", "trait", "enum"].includes(node.kind);
}

function namespaceIdentityOf(namespace: string): string {
  return namespace === GLOBAL_NAMESPACE ? GLOBAL_NAMESPACE : namespace;
}

function qualify(namespace: string, name: string): string {
  const clean = name.replace(/^\\+/, "");
  return namespace === GLOBAL_NAMESPACE ? clean : `${namespace}\\${clean}`;
}

function identifierName(value: unknown): string {
  if (typeof value === "string") return value;
  const node = asNode(value);
  return node ? stringValue(node.name) : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as Partial<AstNode>;
  return typeof node.kind === "string" ? node as AstNode : undefined;
}

function nodeArray(value: unknown): AstNode[] {
  if (!Array.isArray(value)) return [];
  return value.map(asNode).filter((node): node is AstNode => Boolean(node));
}

function optionalNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => identifierName(entry)).filter(Boolean);
  const one = identifierName(value);
  return one ? [one] : [];
}

function lineOf(node: AstNode | undefined): number | undefined {
  return node?.loc?.start?.line;
}

function endLineOf(node: AstNode | undefined): number | undefined {
  return node?.loc?.end?.line;
}

function walk(value: AstNode | AstNode[] | undefined, visitor: (node: AstNode) => void, root = true): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visitor, root);
    return;
  }
  visitor(value);
  if (!root && WALK_SKIP_KINDS.has(value.kind)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "kind") continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        const node = asNode(entry);
        if (node) walk(node, visitor, false);
      }
    } else {
      const node = asNode(child);
      if (node) walk(node, visitor, false);
    }
  }
}

function walkAll(value: AstNode | AstNode[] | undefined, visitor: (node: AstNode) => void): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const entry of value) walkAll(entry, visitor);
    return;
  }
  visitor(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "kind") continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        const node = asNode(entry);
        if (node) walkAll(node, visitor);
      }
    } else {
      const node = asNode(child);
      if (node) walkAll(node, visitor);
    }
  }
}

function discoverSourceFiles(projectRoot: string, requested: string[] | undefined): string[] {
  if (requested && requested.length > 0) {
    return requested
      .map((file) => path.resolve(projectRoot, file))
      .filter((file) => file.toLowerCase().endsWith(".php") && fs.existsSync(file))
      .sort();
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".php")) result.push(absolute);
    }
  };
  visit(projectRoot);
  return result.sort();
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

function optionStrings(request: ParseRequest, key: string): string[] | undefined {
  const value = request.options?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function optionBooleanOrStrings(request: ParseRequest, key: string): boolean | string[] | undefined {
  const value = request.options?.[key];
  if (typeof value === "boolean") return value;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}
