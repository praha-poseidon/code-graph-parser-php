# Krayin CRM validation

Validation date: 2026-08-17

- Repository: `https://github.com/krayin/laravel-crm.git`
- Revision: `209091c5b0513cb500c003b4165281726fc510ac`
- PHP files: 942
- Explicit `Route::get/post/put/patch/delete` calls in source: 251

## GraphDelta result

| Item | Count |
| --- | ---: |
| Packages | 179 |
| Units | 941 |
| Real functions/methods | 1,915 |
| Placeholder functions | 1,760 |
| HTTP endpoints | 251 |
| Endpoint-to-handler relationships | 248 |
| All relationships | 9,092 |
| Dangling relationships | 0 |

Every explicit Laravel route call produced an HTTP endpoint. The parser followed nested
`prefix`, `controller`, and array-form `group` contexts, file-backed route groups, route
`require` chains, imported controller aliases, optional parameters, and the default
`config('app.admin_path') = admin` value.

Three endpoints intentionally remain `parseLevel=unresolved` because the checked-out
project routes refer to controller methods that are absent from that revision:

- `AttributeController::massUpdate` at `settings-routes.php:248`
- `LocationController::update` at `settings-routes.php:296`
- `EventController::edit` at `settings-routes.php:327`

The general PHP call graph remains conservative. Calls with a statically known local,
imported, typed constructor dependency, `self`, or `$this` target resolve to real functions;
runtime-dispatched receivers remain stable placeholder nodes instead of being guessed.

With source-only type binding enabled, real internal `CALLS` relationships increased from
478 to 1,081. Dynamic-receiver call relationships decreased from 2,268 to 1,505. The
remaining placeholders are external/vendor targets or calls whose receiver type is not
provable from the checked-out source; no framework container was started.
