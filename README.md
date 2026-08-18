# code-graph-parser-php

PHP static graph parser for `code-graph-engine`. It speaks the same one-request/one-`GraphDelta`
process protocol as the Go and JavaScript parsers and does not keep project ASTs in global memory.

## Graph model

The parser intentionally reuses the engine's existing structural relationships:

```text
CodePackage(namespace)
  -> PACKAGE_TO_UNIT
  -> synthetic CodeUnit(namespace block in one file)
  -> UNIT_TO_FUNCTION
  -> namespace/global function or synthetic <file-init>
```

Classes, interfaces, traits, and enums are real `CodeUnit` nodes. Their methods use
`UNIT_TO_FUNCTION`. Top-level executable statements are represented by a synthetic
`CodeFunction` named `<file-init>` so their outgoing `CALLS` relationships have a valid caller.

The synthetic namespace/global unit is file-scoped. This is required by the engine's
`projectFilePath` validation and file-based incremental deletion behavior.

## Supported graph elements

- namespace and global packages
- namespace/global functions
- class, interface, trait, and enum units
- methods and constructors
- `EXTENDS`, `IMPLEMENTS`, and local `OVERRIDES`
- direct/imported function calls, constructors, `$this->method()` calls, and static method calls
- source-only receiver type binding from parameter/return/property declarations, constructor property
  promotion, constructor assignments, local `new` assignments, inheritance, interfaces, and PHPDoc
- placeholder functions for unresolved or external calls
- top-level executable code through `<file-init>`

Endpoint extraction is provided by the sibling `static-extract-php` package. It reuses the
same parsed PHP AST and maps SER facts to HTTP, MQ, Redis, and DB endpoint nodes. Built-in HTTP
presets cover Laravel route groups, Symfony attributes and YAML route resources, and Slim route
groups. Symfony YAML service declarations and statically declared Slim container factories are
used for controller binding without starting either framework.

Enable all local PHP presets in a process request with:

```json
{
  "staticExtractPresetRules": true
}
```

Or pass project-specific SER through `ruleSources` (file paths) and `ruleTexts` (inline rules).

## Build and test

```bash
npm install
npm test
```

## CLI

Parse a whole project:

```bash
node dist/cli.js --project /path/to/php-project --project-name demo
```

Use the engine process protocol:

```bash
echo '{"projectName":"demo","language":"php","projectRoot":"/repo","sourceFiles":["/repo/src/App.php"]}' \
  | node dist/cli.js --stdio
```

Engine configuration:

```bash
CODEGRAPH_PARSER_PROCESS_LANGUAGES=php
CODEGRAPH_PARSER_PHP_COMMAND="node /path/to/code-graph-parser-php/dist/cli.js --stdio"
```

The parser scans `.php` files and skips `.git`, `vendor`, `node_modules`, and common editor
directories during a full-project parse. When `sourceFiles` is provided, only those files are
emitted; unresolved cross-file calls become stable placeholders.

Type binding is intentionally static. It does not boot a framework container or choose a runtime
implementation for an interface. Calls whose receiver cannot be proven from source remain
`dynamic-receiver` placeholders; statically named methods outside the parsed source remain
`statically-named-target` placeholders.

See [validation/krayin-crm.md](./validation/krayin-crm.md) and
[validation/enterprise-projects.md](./validation/enterprise-projects.md) for reproducible
Laravel, Symfony, and legacy Slim enterprise-project validation snapshots.
