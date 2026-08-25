<?php

declare(strict_types=1);

namespace Poseidon\CodeGraphParserPhp;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Name;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\NodeFinder;
use PhpParser\ParserFactory;
use Poseidon\StaticExtractPhp\Extractor;

final class Parser
{
    /** @param array<string, mixed> $request @return array<string, mixed> */
    public function parse(array $request): array
    {
        $root = realpath((string) ($request['projectRoot'] ?? ''));
        if ($root === false || !is_dir($root)) throw new \InvalidArgumentException('projectRoot must be a directory');
        $project = (string) ($request['projectName'] ?? basename($root));
        $gitRepo = $request['gitRepoUrl'] ?? null;
        $gitBranch = $request['gitBranch'] ?? null;
        $files = $this->files($root, (array) ($request['sourceFiles'] ?? []));
        $packages = $units = $functions = $relationships = $endpoints = $diagnostics = [];
        $definitions = [];
        $calls = [];
        $phpParser = (new ParserFactory())->createForNewestSupportedVersion();
        $definitions = $this->definitionIndex($root, $phpParser);
        $typeDefinitions = $this->typeDefinitionIndex($root, $phpParser);

        foreach ($files as $absolute) {
            $relative = str_replace('\\', '/', substr($absolute, strlen($root) + 1));
            try {
                $nodes = $phpParser->parse((string) file_get_contents($absolute)) ?? [];
                $traverser = new NodeTraverser();
                $traverser->addVisitor(new NameResolver(null, ['preserveOriginalNames' => true]));
                $nodes = $traverser->traverse($nodes);
            } catch (\Throwable $error) {
                $diagnostics[] = ['level' => 'ERROR', 'code' => 'php.parse.failed', 'message' => $error->getMessage(), 'projectFilePath' => $relative, 'details' => []];
                continue;
            }
            $namespace = $this->namespaceOf($nodes);
            $packageName = $namespace ?: '<global>';
            $packageId = 'pkg:' . $packageName;
            $packages[$packageId] ??= $this->base($packageId, basename(str_replace('\\', '/', $packageName)), $packageName, $project, $relative) + ['packagePath' => str_replace('\\', '/', $namespace), 'startLine' => 1, 'endLine' => 1];
            $moduleName = $packageName . '@' . $relative;
            $moduleId = 'unit:' . $moduleName;
            $units[$moduleId] = $this->base($moduleId, basename($relative), $moduleName, $project, $relative) + ['unitType' => 'namespace', 'modifiers' => ['php-file-scope'], 'isAbstract' => false, 'packageId' => $packageId, 'startLine' => 1, 'endLine' => max(1, substr_count((string) file_get_contents($absolute), "\n") + 1)];
            $this->relationship($relationships, $packageId, 'PACKAGE_TO_UNIT', $moduleId, $project, 1);
            $init = $moduleName . '::<file-init>()';
            $initId = 'fn:' . $init;
            $functions[$initId] = $this->functionNode($initId, '<file-init>', $init, $project, $relative, '<file-init>()', false);
            $this->relationship($relationships, $moduleId, 'UNIT_TO_FUNCTION', $initId, $project, 1);

            $module = preg_replace('/\.[^.]+$/', '', str_replace(['\\', '/'], '.', $relative)) ?: '<global>';
            $this->walk($nodes, ['namespace' => $namespace, 'class' => null, 'parentClass' => null, 'fileScope' => $moduleName, 'module' => $module, 'callableName' => null, 'functionId' => $initId, 'ownerId' => $moduleId, 'parentOwnerId' => $moduleId, 'variableTypes' => [], 'propertyTypes' => []], function (Node $node, array $context) use (&$units, &$functions, &$relationships, &$definitions, &$calls, $typeDefinitions, $project, $relative): void {
                if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
                    $qualified = $context['class'];
                    $id = 'unit:' . $qualified;
                    $unitType = $node instanceof Node\Stmt\Interface_ ? 'interface'
                        : ($node instanceof Node\Stmt\Trait_ ? 'trait'
                            : ($node instanceof Node\Stmt\Enum_ ? 'enum' : 'class'));
                    $units[$id] = $this->base($id, $node->name->toString(), $qualified, $project, $relative) + ['unitType' => $unitType, 'modifiers' => [], 'isAbstract' => method_exists($node, 'isAbstract') && $node->isAbstract(), 'packageId' => 'pkg:' . ($context['namespace'] ?: '<global>'), 'startLine' => $node->getStartLine(), 'endLine' => $node->getEndLine()];
                    $this->relationship($relationships, 'pkg:' . ($context['namespace'] ?: '<global>'), 'PACKAGE_TO_UNIT', $id, $project, $node->getStartLine());
                    $bases = [];
                    if ($node instanceof Node\Stmt\Class_ && $node->extends instanceof Name) $bases[] = $node->extends;
                    if ($node instanceof Node\Stmt\Interface_) $bases = $node->extends;
                    foreach ($bases as $base) {
                        $target = 'unit:' . $this->resolvedName($base);
                        $this->relationship($relationships, $id, 'EXTENDS', $target, $project, $node->getStartLine());
                    }
                    if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Enum_) foreach ($node->implements as $base) $this->relationship($relationships, $id, 'IMPLEMENTS', 'unit:' . $this->resolvedName($base), $project, $node->getStartLine());
                }
                if ($node instanceof Node\Stmt\TraitUse && $context['class']) {
                    foreach ($node->traits as $trait) {
                        $this->relationship($relationships, 'unit:' . $context['class'], 'USES_TRAIT', 'unit:' . $this->resolvedName($trait), $project, $node->getStartLine());
                    }
                }
                if ($node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod || $node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction) {
                    $syntheticClosure = $node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction;
                    $callableName = $syntheticClosure ? ($context['declaredCallableName'] ?? null) : null;
                    $name = $syntheticClosure ? ($callableName ?? '<closure>') : $node->name->toString();
                    $qualified = $syntheticClosure
                        ? $this->closureQualifiedName($node, $context)
                        : ($node instanceof Node\Stmt\ClassMethod && $context['class']
                            ? $context['class'] . '::' . $name . '()' : ltrim($context['namespace'] . '\\' . $name . '()', '\\'));
                    $id = 'fn:' . $qualified;
                    $isStatic = $node instanceof Node\Stmt\ClassMethod && $node->isStatic();
                    $functions[$id] = $this->functionNode($id, $name, $qualified, $project, $relative, $name . '()', false, $isStatic, $name === '__construct', $node->getStartLine(), $node->getEndLine());
                    if (!$syntheticClosure || $callableName !== null) {
                        $definitions[strtolower($qualified)] = $id;
                        $definitions[strtolower(preg_replace('/\(\)$/', '', $qualified) ?? $qualified)] = $id;
                        if ($node instanceof Node\Stmt\ClassMethod && $context['class']) {
                            $simpleClass = preg_replace('/^.*\\\\/', '', $context['class']) ?? $context['class'];
                            $definitions[strtolower($simpleClass . '::' . $name)] = $id;
                        }
                        $definitions[strtolower($name)] ??= $id;
                    }
                    $this->relationship($relationships, $context['parentOwnerId'], 'UNIT_TO_FUNCTION', $id, $project, $node->getStartLine());
                    if ($node instanceof Node\Stmt\ClassMethod && $context['class'] && !$node->isPrivate()) {
                        foreach ($this->overriddenMethodIds($typeDefinitions, $context['class'], $name) as $overriddenId) {
                            $this->relationship($relationships, $id, 'OVERRIDES', $overriddenId, $project, $node->getStartLine());
                        }
                    }
                }
                if ($node instanceof Expr\CallLike) {
                    $target = $this->callTarget($node, $context);
                    if ($target !== '') $calls[] = [$context['functionId'], $target, $relative, $node->getStartLine()];
                }
            });
        }

        foreach ($calls as [$from, $target, $relative, $line]) {
            $to = $definitions[strtolower($target)] ?? $definitions[strtolower(preg_replace('/\(\)$/', '', $target) ?? $target)] ?? null;
            if ($to === null) {
                $qualified = str_ends_with($target, '()') ? $target : $target . '()';
                $to = 'fn:<unresolved>::' . $qualified;
                $functions[$to] ??= $this->functionNode($to, preg_replace('/^.*::|\(\)$/', '', $qualified) ?? $qualified, '<unresolved>::' . $qualified, $project, $relative, $qualified, true);
            }
            $this->relationship($relationships, $from, 'CALLS', $to, $project, $line);
        }

        $extract = (new Extractor())->extract($root, (array) ($request['ruleSources'] ?? []), (array) ($request['ruleTexts'] ?? []), (array) ($request['sourceFiles'] ?? []));
        $diagnostics = array_merge($diagnostics, $extract['diagnostics']);
        foreach ($extract['results'] as $fact) {
            if (($fact['fields']['endpointType'] ?? '') === '') continue;
            $endpointType = strtoupper((string) $fact['fields']['endpointType']);
            $direction = strtolower((string) ($fact['fields']['direction'] ?? 'outbound'));
            $methodValue = strtoupper((string) ($fact['fields']['method'] ?? 'ANY'));
            $methods = $endpointType === 'HTTP' ? (preg_split('/\s*,\s*/', $methodValue, flags: PREG_SPLIT_NO_EMPTY) ?: ['ANY']) : [$methodValue];
            $path = (string) ($fact['fields']['path'] ?? '');
            $identityValue = match ($endpointType) {
                'HTTP' => trim($path),
                'MQ' => trim((string) ($fact['fields']['topic'] ?? '')),
                'REDIS' => trim((string) ($fact['fields']['keyPattern'] ?? $fact['fields']['key'] ?? '')),
                'DB' => trim((string) ($fact['fields']['tableName'] ?? $fact['fields']['table'] ?? '')),
                default => '',
            };
            if ($identityValue === '') continue;
            $handler = strtolower((string) ($direction === 'inbound'
                ? ($fact['fields']['handler'] ?? '')
                : ($fact['enclosingSymbol'] ?? $fact['fields']['handler'] ?? '')));
            $handlerId = $definitions[$handler] ?? $definitions[$handler . '()'] ?? null;
            foreach ($methods as $method) {
                $identity = $endpointType === 'HTTP' ? "$endpointType:$method:$path" : "$endpointType:$identityValue";
                $id = 'endpoint:' . $direction . ':' . $endpointType . ':' . sha1("$direction:$endpointType:$identity");
                $endpoints[$id] = $this->base($id, $identity, $id, $project, $fact['projectFilePath']) + [
                    'gitRepoUrl' => $gitRepo, 'gitBranch' => $gitBranch, 'startLine' => $fact['startLine'], 'endLine' => $fact['endLine'],
                    'endpointType' => $endpointType, 'direction' => $direction, 'isExternal' => $direction === 'outbound', 'parseLevel' => (string) ($fact['fields']['parseLevel'] ?? 'full'), 'matchIdentity' => $identity,
                    'endpointKind' => strtolower($endpointType), 'httpMethod' => $endpointType === 'HTTP' ? $method : null, 'path' => $endpointType === 'HTTP' ? $path : null, 'normalizedPath' => $endpointType === 'HTTP' ? $path : null,
                    'other' => array_key_exists('other', $fact['fields']) ? (string) $fact['fields']['other'] : null,
                ];
                if ($endpointType === 'MQ') $endpoints[$id] += [
                    'topic' => $identityValue,
                    'operation' => $fact['fields']['operation'] ?? null,
                    'brokerType' => $fact['fields']['brokerType'] ?? null,
                ];
                elseif ($endpointType === 'REDIS') $endpoints[$id] += [
                    'command' => $fact['fields']['command'] ?? null,
                    'keyPattern' => $identityValue,
                ];
                elseif ($endpointType === 'DB') $endpoints[$id] += [
                    'tableName' => $identityValue,
                    'dbOperation' => $fact['fields']['dbOperation'] ?? null,
                ];
                if ($handlerId !== null) {
                    $relationshipType = $direction === 'inbound' ? 'ENDPOINT_TO_FUNCTION' : 'FUNCTION_TO_ENDPOINT';
                    $this->relationship($relationships, $direction === 'inbound' ? $id : $handlerId, $relationshipType, $direction === 'inbound' ? $handlerId : $id, $project, $fact['startLine']);
                }
            }
        }

        return [
            'scope' => ['projectName' => $project, 'language' => 'php', 'gitRepoUrl' => $gitRepo, 'gitBranch' => $gitBranch, 'projectRoot' => $root, 'sourceFiles' => array_map(fn ($file) => str_replace('\\', '/', substr($file, strlen($root) + 1)), $files)],
            'packages' => array_values($packages), 'units' => array_values($units), 'functions' => array_values($functions),
            'relationships' => array_values($relationships), 'endpoints' => array_values($endpoints), 'diagnostics' => $diagnostics,
            'deletedNodeIds' => [], 'deletedRelationshipIds' => [],
        ];
    }

    private function base(string $id, string $name, string $qualified, string $project, string $relative): array
    {
        return ['id' => $id, 'name' => $name, 'qualifiedName' => $qualified, 'language' => 'php', 'projectName' => $project, 'projectFilePath' => $relative];
    }

    private function functionNode(string $id, string $name, string $qualified, string $project, string $relative, string $signature, bool $placeholder, bool $static = false, bool $constructor = false, ?int $startLine = null, ?int $endLine = null): array
    {
        return $this->base($id, $name, $qualified, $project, $relative) + ['signature' => $signature, 'modifiers' => $placeholder ? ['placeholder', 'unresolved'] : [], 'isStatic' => $static, 'isAsync' => false, 'isConstructor' => $constructor, 'isPlaceholder' => $placeholder, 'startLine' => $startLine, 'endLine' => $endLine];
    }

    private function relationship(array &$output, string $from, string $type, string $to, string $project, int $line): void
    {
        [$fromNodeType, $toNodeType] = match ($type) {
            'PACKAGE_TO_UNIT' => ['CodePackage', 'CodeUnit'],
            'UNIT_TO_FUNCTION' => ['CodeUnit', 'CodeFunction'],
            'CALLS' => ['CodeFunction', 'CodeFunction'],
            'EXTENDS', 'IMPLEMENTS', 'USES_TRAIT' => ['CodeUnit', 'CodeUnit'],
            'OVERRIDES' => ['CodeFunction', 'CodeFunction'],
            'ENDPOINT_TO_FUNCTION' => ['CodeEndpoint', 'CodeFunction'],
            'FUNCTION_TO_ENDPOINT' => ['CodeFunction', 'CodeEndpoint'],
            default => throw new \InvalidArgumentException("Missing relationship contract for $type"),
        };
        $id = 'rel:' . sha1("$from|$type|$to");
        $output[$id] ??= [
            'id' => $id,
            'fromNodeId' => $from,
            'toNodeId' => $to,
            'relationshipType' => $type,
            'fromNodeType' => $fromNodeType,
            'toNodeType' => $toNodeType,
            'language' => 'php',
            'projectName' => $project,
            'lineNumber' => $line,
        ];
    }

    private function files(string $root, array $sources): array
    {
        if ($sources !== []) {
            $files = [];
            foreach ($sources as $file) {
                $resolved = realpath(str_starts_with($file, '/') ? $file : "$root/$file");
                if ($resolved !== false && is_file($resolved) && strtolower(pathinfo($resolved, PATHINFO_EXTENSION)) === 'php') $files[] = $resolved;
            }
            return array_values(array_unique($files));
        }
        $result = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveCallbackFilterIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), static fn (\SplFileInfo $item): bool => !$item->isDir() || !in_array($item->getFilename(), ['.git', 'vendor', 'node_modules'], true)));
        foreach ($iterator as $item) if ($item->isFile() && strtolower($item->getExtension()) === 'php') $result[] = $item->getRealPath();
        sort($result);
        return $result;
    }

    private function namespaceOf(array $nodes): string
    {
        foreach ($nodes as $node) if ($node instanceof Node\Stmt\Namespace_) return $node->name?->toString() ?? '';
        return '';
    }

    /** @return array<string, string> */
    private function definitionIndex(string $root, \PhpParser\Parser $phpParser): array
    {
        $definitions = [];
        foreach ($this->files($root, []) as $absolute) {
            try {
                $nodes = $phpParser->parse((string) file_get_contents($absolute)) ?? [];
                $traverser = new NodeTraverser();
                $traverser->addVisitor(new NameResolver(null, ['preserveOriginalNames' => true]));
                $nodes = $traverser->traverse($nodes);
            } catch (\Throwable) {
                continue;
            }
            $namespace = $this->namespaceOf($nodes);
            $this->walk($nodes, ['namespace' => $namespace, 'class' => null, 'parentClass' => null, 'fileScope' => '', 'functionId' => '', 'ownerId' => '', 'parentOwnerId' => '', 'variableTypes' => [], 'propertyTypes' => []], function (Node $node, array $context) use (&$definitions): void {
                if (!$node instanceof Node\Stmt\Function_ && !$node instanceof Node\Stmt\ClassMethod) return;
                $name = $node->name->toString();
                $qualified = $node instanceof Node\Stmt\ClassMethod && $context['class']
                    ? $context['class'] . '::' . $name . '()'
                    : ltrim($context['namespace'] . '\\' . $name . '()', '\\');
                $id = 'fn:' . $qualified;
                $definitions[strtolower($qualified)] = $id;
                $definitions[strtolower(preg_replace('/\(\)$/', '', $qualified) ?? $qualified)] = $id;
                if ($node instanceof Node\Stmt\ClassMethod && $context['class']) {
                    $simpleClass = preg_replace('/^.*\\\\/', '', $context['class']) ?? $context['class'];
                    $definitions[strtolower($simpleClass . '::' . $name)] ??= $id;
                }
                $definitions[strtolower($name)] ??= $id;
            });
        }
        return $definitions;
    }

    /**
     * @return array<string, array{qualified: string, parents: list<string>, methods: array<string, array{id: string, private: bool}>}>
     */
    private function typeDefinitionIndex(string $root, \PhpParser\Parser $phpParser): array
    {
        $types = [];
        foreach ($this->files($root, []) as $absolute) {
            try {
                $nodes = $phpParser->parse((string) file_get_contents($absolute)) ?? [];
                $traverser = new NodeTraverser();
                $traverser->addVisitor(new NameResolver(null, ['preserveOriginalNames' => true]));
                $nodes = $traverser->traverse($nodes);
            } catch (\Throwable) {
                continue;
            }
            $namespace = $this->namespaceOf($nodes);
            $this->walk($nodes, ['namespace' => $namespace, 'class' => null, 'parentClass' => null, 'fileScope' => '', 'functionId' => '', 'ownerId' => '', 'parentOwnerId' => '', 'variableTypes' => [], 'propertyTypes' => []], function (Node $node, array $context) use (&$types): void {
                if (!$node instanceof Node\Stmt\ClassLike || $node->name === null || !$context['class']) return;
                $parents = [];
                if ($node instanceof Node\Stmt\Class_ && $node->extends instanceof Name) {
                    $parents[] = $this->resolvedName($node->extends);
                }
                if ($node instanceof Node\Stmt\Interface_) {
                    foreach ($node->extends as $parent) $parents[] = $this->resolvedName($parent);
                }
                if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Enum_) {
                    foreach ($node->implements as $interface) $parents[] = $this->resolvedName($interface);
                }
                $methods = [];
                foreach ($node->getMethods() as $method) {
                    $name = $method->name->toString();
                    $methods[strtolower($name)] = [
                        'id' => 'fn:' . $context['class'] . '::' . $name . '()',
                        'private' => $method->isPrivate(),
                    ];
                }
                $types[strtolower($context['class'])] = [
                    'qualified' => $context['class'],
                    'parents' => $parents,
                    'methods' => $methods,
                ];
            });
        }
        return $types;
    }

    /**
     * @param array<string, array{qualified: string, parents: list<string>, methods: array<string, array{id: string, private: bool}>}> $types
     * @return list<string>
     */
    private function overriddenMethodIds(array $types, string $class, string $method): array
    {
        $result = [];
        $visited = [];
        $methodKey = strtolower($method);
        $visit = function (string $qualified) use (&$visit, &$result, &$visited, $types, $methodKey): void {
            $key = strtolower($qualified);
            if (isset($visited[$key])) return;
            $visited[$key] = true;
            $type = $types[$key] ?? null;
            if ($type === null) return;
            $candidate = $type['methods'][$methodKey] ?? null;
            if ($candidate !== null && !$candidate['private']) $result[$candidate['id']] = true;
            foreach ($type['parents'] as $parent) $visit($parent);
        };
        $current = $types[strtolower($class)] ?? null;
        if ($current === null) return [];
        foreach ($current['parents'] as $parent) $visit($parent);
        return array_keys($result);
    }

    private function walk(iterable $nodes, array $context, callable $visitor): void
    {
        foreach ($nodes as $node) {
            if (!$node instanceof Node) continue;
            $next = $context;
            $next['parentOwnerId'] = $context['ownerId'];
            if ($node instanceof Node\Stmt\Namespace_) $next['namespace'] = $node->name?->toString() ?? '';
            if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
                $next['class'] = $node->getAttribute('namespacedName')?->toString() ?? ltrim($next['namespace'] . '\\' . $node->name->toString(), '\\');
                $next['parentClass'] = $node instanceof Node\Stmt\Class_ && $node->extends instanceof Name ? $this->resolvedName($node->extends) : null;
                $next['ownerId'] = 'unit:' . $next['class'];
                $next['propertyTypes'] = $this->propertyTypes($node);
            }
            $assignedName = $this->assignedCallableName($node);
            if ($assignedName !== null) $next['callableName'] = $assignedName;
            if ($node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod) {
                $name = $node->name->toString();
                $qualified = $node instanceof Node\Stmt\ClassMethod && $next['class'] ? $next['class'] . '::' . $name . '()' : ltrim($next['namespace'] . '\\' . $name . '()', '\\');
                $next['functionId'] = 'fn:' . $qualified;
                $next['variableTypes'] = $this->variableTypes($node);
            }
            if ($node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction) {
                $next['declaredCallableName'] = $next['callableName'] ?? null;
                $next['functionId'] = 'fn:' . $this->closureQualifiedName($node, $next);
                $next['variableTypes'] = $this->variableTypes($node);
                $next['callableName'] = null;
            }
            $visitor($node, $next);
            foreach ($node->getSubNodeNames() as $name) {
                $child = $node->$name;
                if ($child instanceof Node) $this->walk([$child], $next, $visitor);
                elseif (is_array($child)) $this->walk($child, $next, $visitor);
            }
        }
    }

    private function callTarget(Expr\CallLike $node, array $context): string
    {
        if ($node instanceof Expr\FuncCall && $node->name instanceof Name) return $this->resolvedName($node->name);
        if ($node instanceof Expr\StaticCall && $node->class instanceof Name && $node->name instanceof Node\Identifier) {
            $owner = strtolower($node->class->toString());
            $class = match ($owner) {
                'self', 'static' => $context['class'] ?? $node->class->toString(),
                'parent' => $context['parentClass'] ?? $node->class->toString(),
                default => $this->resolvedName($node->class),
            };
            return $class . '::' . $node->name->toString();
        }
        if ($node instanceof Expr\MethodCall && $node->name instanceof Node\Identifier) {
            if ($node->var instanceof Expr\Variable && $node->var->name === 'this' && $context['class']) return $context['class'] . '::' . $node->name->toString();
            if ($node->var instanceof Expr\Variable && is_string($node->var->name) && isset($context['variableTypes'][$node->var->name])) {
                return $context['variableTypes'][$node->var->name] . '::' . $node->name->toString();
            }
            if ($node->var instanceof Expr\PropertyFetch
                && $node->var->var instanceof Expr\Variable && $node->var->var->name === 'this'
                && $node->var->name instanceof Node\Identifier
                && isset($context['propertyTypes'][$node->var->name->toString()])) {
                return $context['propertyTypes'][$node->var->name->toString()] . '::' . $node->name->toString();
            }
            if ($node->var instanceof Expr\New_ && $node->var->class instanceof Name) {
                return $this->resolvedName($node->var->class) . '::' . $node->name->toString();
            }
            return '<dynamic>::' . $node->name->toString();
        }
        if ($node instanceof Expr\New_ && $node->class instanceof Name) return $this->resolvedName($node->class) . '::__construct';
        return '';
    }

    private function resolvedName(Name $name): string
    {
        $resolved = $name->getAttribute('resolvedName');
        return $resolved instanceof Name ? $resolved->toString() : $name->toString();
    }

    private function closureQualifiedName(Node $node, array $context): string
    {
        $assigned = $context['declaredCallableName'] ?? null;
        if (is_string($assigned) && $assigned !== '') {
            if (($context['class'] ?? null) !== null) return $context['class'] . '::' . $assigned . '()';
            $owner = ($context['namespace'] ?? '') ?: ($context['module'] ?? '<global>');
            return ltrim($owner . '\\' . $assigned . '()', '\\');
        }
        return $context['fileScope'] . '::<closure@' . $node->getStartLine() . ':' . max(0, $node->getStartFilePos()) . '>()';
    }

    private function assignedCallableName(Node $node): ?string
    {
        $target = null;
        if ($node instanceof Expr\Assign && $node->expr instanceof Node\FunctionLike) $target = $node->var;
        elseif ($node instanceof Expr\ArrayItem && $node->value instanceof Node\FunctionLike) {
            if ($node->key instanceof Node\Scalar\String_ || $node->key instanceof Node\Scalar\Int_) return (string) $node->key->value;
            return null;
        }
        if ($target instanceof Expr\Variable && is_string($target->name)) return $target->name;
        if ($target instanceof Expr\PropertyFetch && $target->name instanceof Node\Identifier) return $target->name->toString();
        if ($target instanceof Expr\ArrayDimFetch && ($target->dim instanceof Node\Scalar\String_ || $target->dim instanceof Node\Scalar\Int_)) {
            return (string) $target->dim->value;
        }
        return null;
    }

    /** @return array<string, string> */
    private function variableTypes(Node\FunctionLike $function): array
    {
        $types = [];
        foreach ($function->getParams() as $param) {
            if ($param->var instanceof Expr\Variable && is_string($param->var->name)) {
                $type = $this->typeName($param->type);
                if ($type !== null) $types[$param->var->name] = $type;
            }
        }
        $finder = new NodeFinder();
        foreach ($finder->findInstanceOf($function->getStmts() ?? [], Expr\Assign::class) as $assign) {
            if ($assign->var instanceof Expr\Variable && is_string($assign->var->name)
                && $assign->expr instanceof Expr\New_ && $assign->expr->class instanceof Name) {
                $types[$assign->var->name] = $this->resolvedName($assign->expr->class);
            }
        }
        return $types;
    }

    /** @return array<string, string> */
    private function propertyTypes(Node\Stmt\ClassLike $class): array
    {
        $types = [];
        foreach ($class->getProperties() as $property) {
            $type = $this->typeName($property->type);
            if ($type === null) continue;
            foreach ($property->props as $prop) $types[$prop->name->toString()] = $type;
        }
        foreach ($class->getMethods() as $method) {
            if ($method->name->toString() !== '__construct') continue;
            $parameters = [];
            foreach ($method->getParams() as $param) {
                if (!$param->var instanceof Expr\Variable || !is_string($param->var->name)) continue;
                $type = $this->typeName($param->type);
                if ($type !== null) {
                    $parameters[$param->var->name] = $type;
                    if ($param->isPromoted()) $types[$param->var->name] = $type;
                }
            }
            $finder = new NodeFinder();
            foreach ($finder->findInstanceOf($method->getStmts() ?? [], Expr\Assign::class) as $assign) {
                if (!$assign->var instanceof Expr\PropertyFetch
                    || !$assign->var->var instanceof Expr\Variable || $assign->var->var->name !== 'this'
                    || !$assign->var->name instanceof Node\Identifier) continue;
                $name = $assign->var->name->toString();
                if ($assign->expr instanceof Expr\Variable && is_string($assign->expr->name) && isset($parameters[$assign->expr->name])) {
                    $types[$name] = $parameters[$assign->expr->name];
                } elseif ($assign->expr instanceof Expr\New_ && $assign->expr->class instanceof Name) {
                    $types[$name] = $this->resolvedName($assign->expr->class);
                }
            }
        }
        return $types;
    }

    private function typeName(null|Node\Identifier|Name|Node\ComplexType $type): ?string
    {
        if ($type instanceof Name) return $this->resolvedName($type);
        if ($type instanceof Node\NullableType) return $this->typeName($type->type);
        if ($type instanceof Node\UnionType || $type instanceof Node\IntersectionType) {
            foreach ($type->types as $candidate) {
                $name = $this->typeName($candidate);
                if ($name !== null) return $name;
            }
        }
        return null;
    }
}
