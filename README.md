# code-graph-parser-php

Native PHP process parser for `code-graph-engine`. PHP source is parsed with
`nikic/php-parser`; production parsing does not use TypeScript or Node.js.

## Graph mapping

- PHP namespace (or `<global>`) -> `CodePackage`
- each PHP file/namespace scope -> synthetic file-scoped `CodeUnit`
- class/interface/trait -> `CodeUnit`
- namespace functions and synthetic `<file-init>()` -> functions of the file-scoped unit
- methods -> functions of their class/interface/trait unit
- closures/arrow functions -> synthetic file-position-stable functions
- calls -> `CALLS`; unresolved/dynamic targets -> placeholder `CodeFunction`
- class inheritance and implementation -> `EXTENDS` / `IMPLEMENTS`

Both real and synthetic nodes retain `projectFilePath`, so incremental file deletion remains
compatible with the engine. The synthetic `<file-init>()` is only a caller node for executable
top-level PHP statements; it does not pretend to be a source-declared function.

Names and imports are normalized by `php-parser`'s `NameResolver`. Direct functions, named static
calls, `self::`, `parent::`, `$this->method()`, declared parameter/property types, promoted
constructor properties, constructor assignments, and local `new` assignments can bind statically.
Calls whose receiver cannot be proven from source are preserved as placeholders instead of being
linked to an arbitrary same-name method.

For incremental requests, `sourceFiles` is the SCAN set (nodes emitted in this delta), while PHP
files under `projectRoot` form the LOAD set used for symbol binding. Therefore a scanned file can
resolve a function declared in another project file without emitting that dependency file again.

## Endpoint extraction

Endpoint facts come from the sibling native PHP package `static-extract-php`. This repository
contains no built-in framework or business rules. The engine/caller supplies rules through
`ParseRequest.ruleSources`; `ruleTexts` is also accepted by the CLI for conformance tests.

No rules means no endpoints.

## Install and test

```bash
composer install
composer test
```

For a machine without local PHP:

```bash
docker run --rm -v "$(dirname "$PWD"):/workspace" \
  -w /workspace/code-graph-parser-php composer:2 install
./bin/code-graph-parser-php-docker --project fixtures/basic --project-name demo
```

## Engine process protocol

```bash
printf '%s' '{
  "projectName":"demo",
  "language":"php",
  "projectRoot":"/repo",
  "sourceFiles":["/repo/src/App.php"],
  "ruleSources":["/repo/rules/http.ser"]
}' | php bin/code-graph-parser-php --stdio
```

Engine configuration with local PHP:

```bash
CODEGRAPH_PARSER_PROCESS_LANGUAGES=php
CODEGRAPH_PARSER_PHP_COMMAND="php /path/to/code-graph-parser-php/bin/code-graph-parser-php --stdio"
```

`bin/code-graph-parser-php-docker` is a development wrapper for machines without PHP. The parser
inside the container is still the same PHP entrypoint.
