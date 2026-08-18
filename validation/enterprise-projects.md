# Enterprise PHP project validation

Validation date: 2026-08-18

The parser was run from a clean process with `staticExtractPresetRules=true`. Dependencies under
`vendor` were intentionally excluded. Endpoint counts below are checked against static route
declarations in the same source scope; frameworks were not booted.

## Akeneo PIM Community Edition

- Repository: `https://github.com/akeneo/pim-community-dev.git`
- Revision: `d3f66da42c7eb51bb5746ecc36bd1f46f5671572`
- Architecture exercised: Symfony, YAML route imports, bundle resources, YAML service IDs,
  invokable controllers, inheritance, interfaces, and a large typed domain model

| Item | Count |
| --- | ---: |
| PHP files | 8,438 |
| Packages | 2,483 |
| Units | 8,484 |
| Real functions/methods | 38,634 |
| Placeholder functions | 19,520 |
| `CALLS` relationships | 138,844 |
| Internal resolved `CALLS` | 50,802 |
| Symfony YAML route facts | 462 |
| Unique HTTP endpoints | 459 |
| Endpoint-to-function relationships | 385 |
| All relationships | 192,070 |
| Dangling relationships | 0 |

All 462 discovered route facts were emitted. Three facts collapse into existing endpoint
identities because the graph's HTTP identity is method plus normalized path, producing 459 unique
endpoint nodes. Of those, 385 link to real PHP handlers. Seventy routes intentionally have no PHP
controller (frontend/template entry routes). Four named handlers remain unlinked: two belong to
the excluded Symfony vendor package and two refer to an unresolved project service ID.

## SuiteCRM 7

- Repository: `https://github.com/SuiteCRM/SuiteCRM.git`
- Revision: `d6bca97a0159ec019a969b86eca32affab3beb7c`
- Architecture exercised: legacy and current PHP in one repository, Slim route groups,
  colon-style handlers, invokable controllers, and PHP container factories

| Item | Count |
| --- | ---: |
| PHP files discovered | 4,652 |
| Packages | 96 |
| Units | 5,944 |
| Real functions/methods | 18,013 |
| Placeholder functions | 5,120 |
| `CALLS` relationships | 64,159 |
| Internal resolved `CALLS` | 30,516 |
| Static Slim route declarations | 43 |
| Unique HTTP endpoints | 43 |
| Endpoint-to-function relationships | 42 |
| All relationships | 91,646 |
| Dangling relationships | 0 |

All 43 static Slim route declarations produced unique HTTP endpoints. Forty-two link to real PHP
handlers. The remaining endpoint uses a top-level anonymous closure, for which the graph currently
does not emit a separate named `CodeFunction` node.

Ten legacy/template PHP files report syntax diagnostics: two are code-generation templates with
placeholder class names such as `<module_name>`, and eight retain syntax rejected by the modern
PHP grammar. Valid files continue to parse, and these diagnostics do not affect the 43 route
declarations. Both project results have zero duplicate node IDs, zero duplicate relationship IDs,
and zero dangling relationships.
