import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { PhpCodeGraphParser } from "./parser.js";

test("emits namespace scope, classes, functions, file init, and calls", () => {
  const root = fixture({
    "src/UserService.php": `<?php
namespace App\\Service;

function helper(int $id): string {
    return normalize_id($id);
}

class BaseService {
    public function run(): void {}
}

class UserService extends BaseService {
    public function run(): void {
        $this->save();
        helper(1);
    }

    private function save(): void {}
}

$result = helper(2);
`
  });

  const delta = new PhpCodeGraphParser().parse({
    projectName: "php-demo",
    language: "php",
    projectRoot: root
  });

  assert.equal(delta.diagnostics.length, 0);
  assert.ok(delta.packages.some((pkg) => pkg.qualifiedName === "App\\Service"));

  const scope = delta.units.find((unit) => unit.modifiers.includes("namespace-scope"));
  assert.ok(scope);
  assert.equal(scope.projectFilePath, "src/UserService.php");
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "PACKAGE_TO_UNIT" && rel.toNodeId === scope.id
  ));

  const helper = required(delta.functions.find((fn) => fn.name === "helper"));
  const run = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Service\\UserService::run()"));
  const save = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Service\\UserService::save()"));
  const fileInit = required(delta.functions.find((fn) => fn.name === "<file-init>"));
  const baseRun = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Service\\BaseService::run()"));

  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "UNIT_TO_FUNCTION" && rel.fromNodeId === scope.id && rel.toNodeId === helper.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "CALLS" && rel.fromNodeId === run.id && rel.toNodeId === save.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "CALLS" && rel.fromNodeId === run.id && rel.toNodeId === helper.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "CALLS" && rel.fromNodeId === fileInit.id && rel.toNodeId === helper.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "OVERRIDES" && rel.fromNodeId === run.id && rel.toNodeId === baseRun.id
  ));
  assert.ok(delta.functions.some((fn) => fn.name === "normalize_id" && fn.isPlaceholder));
});

test("uses one synthetic namespace code unit per physical file", () => {
  const root = fixture({
    "src/First.php": "<?php namespace Shared; function first() {}",
    "src/Second.php": "<?php namespace Shared; function second() {}"
  });
  const delta = new PhpCodeGraphParser().parse({ projectName: "demo", projectRoot: root });

  assert.equal(delta.packages.length, 1);
  const scopes = delta.units.filter((unit) => unit.modifiers.includes("namespace-scope"));
  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes.map((unit) => unit.projectFilePath).sort(), ["src/First.php", "src/Second.php"]);
  assert.equal(new Set(scopes.map((unit) => unit.id)).size, 2);

  const first = required(delta.functions.find((fn) => fn.name === "first"));
  const second = required(delta.functions.find((fn) => fn.name === "second"));
  const firstOwner = required(delta.relationships.find((rel) => rel.relationshipType === "UNIT_TO_FUNCTION" && rel.toNodeId === first.id));
  const secondOwner = required(delta.relationships.find((rel) => rel.relationshipType === "UNIT_TO_FUNCTION" && rel.toNodeId === second.id));
  assert.notEqual(firstOwner.fromNodeId, secondOwner.fromNodeId);
});

test("resolves imported functions, class aliases, and constructors", () => {
  const root = fixture({
    "src/Library.php": `<?php
namespace Library;
function work(): void {}
class Worker { public function __construct() {} public static function execute(): void {} }
`,
    "src/App.php": `<?php
namespace App;
use function Library\\work as imported_work;
use Library\\Worker as ImportedWorker;
function run(): void {
    imported_work();
    new ImportedWorker();
    ImportedWorker::execute();
}
`
  });
  const delta = new PhpCodeGraphParser().parse({ projectName: "demo", projectRoot: root });

  const run = required(delta.functions.find((fn) => fn.qualifiedName === "App\\run()"));
  const work = required(delta.functions.find((fn) => fn.qualifiedName === "Library\\work()"));
  const constructor = required(delta.functions.find((fn) => fn.qualifiedName === "Library\\Worker::__construct()"));
  const execute = required(delta.functions.find((fn) => fn.qualifiedName === "Library\\Worker::execute()"));
  const targets = delta.relationships
    .filter((rel) => rel.relationshipType === "CALLS" && rel.fromNodeId === run.id)
    .map((rel) => rel.toNodeId);

  assert.deepEqual(new Set(targets), new Set([work.id, constructor.id, execute.id]));
});

test("binds statically provable receiver types without runtime container inference", () => {
  const root = fixture({
    "src/Bindings.php": `<?php
namespace App;

interface Gateway {
    public function send(): Receipt;
}

class Receipt {
    public function id(): string { return 'ok'; }
}

class Repository {
    public function find(): void {}
}

class Factory {
    /** @return Repository */
    public function make() { return new Repository(); }
}

class Service {
    private Repository $declared;

    public function __construct(private Gateway $gateway) {
        $this->declared = new Repository();
    }

    public function run(Repository $parameter, $unknown): void {
        $local = new Repository();
        $parameter->find();
        $local->find();
        $this->declared->find();
        $this->gateway->send()->id();
        $unknown->find();
    }

    /** @param Repository $documented */
    public function documented($documented): void {
        $factory = new Factory();
        $documented->find();
        $factory->make()->find();
    }
}
`
  });
  const delta = new PhpCodeGraphParser().parse({ projectName: "bindings", projectRoot: root });
  const run = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Service::run()"));
  const repositoryFind = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Repository::find()"));
  const gatewaySend = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Gateway::send()"));
  const receiptId = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Receipt::id()"));
  const targets = new Set(delta.relationships
    .filter((rel) => rel.relationshipType === "CALLS" && rel.fromNodeId === run.id)
    .map((rel) => rel.toNodeId));

  assert.ok(targets.has(repositoryFind.id));
  assert.ok(targets.has(gatewaySend.id));
  assert.ok(targets.has(receiptId.id));
  assert.ok(delta.functions.some((fn) => fn.isPlaceholder && fn.qualifiedName === "<dynamic>::find()"));

  const documented = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Service::documented()"));
  const documentedTargets = delta.relationships
    .filter((rel) => rel.relationshipType === "CALLS" && rel.fromNodeId === documented.id)
    .map((rel) => rel.toNodeId);
  assert.ok(documentedTargets.includes(repositoryFind.id));
});

test("maps shared-AST static extraction facts to engine endpoints", () => {
  const root = fixture({
    "src/Controller.php": `<?php
namespace App\\Controller;
#[Route('/api')]
class UserController {
    #[Route('/users/{id}', methods: ['GET'])]
    public function show(int $id): void {
        $redis->get('user:' . $id);
        $db->query('SELECT * FROM users WHERE id = ?');
        $kafka->send('user.events');
    }
    public function register(): void {
        Route::post('/users', [self::class, 'store']);
    }
    public function store(): void {}
}
`
  });
  const delta = new PhpCodeGraphParser().parse({
    projectName: "demo",
    projectRoot: root,
    options: { staticExtractPresetRules: true }
  });

  assert.equal(delta.diagnostics.length, 0);
  const http = delta.endpoints.filter((endpoint) => endpoint.endpointType === "HTTP");
  const redis = required(delta.endpoints.find((endpoint) => endpoint.endpointType === "REDIS"));
  const database = required(delta.endpoints.find((endpoint) => endpoint.endpointType === "DB"));
  const mq = required(delta.endpoints.find((endpoint) => endpoint.endpointType === "MQ"));
  assert.deepEqual(new Set(http.map((endpoint) => endpoint.matchIdentity)), new Set([
    "HTTP:GET:/api/users/{param}",
    "HTTP:POST:/users"
  ]));
  assert.equal(redis.matchIdentity, "REDIS:user:{param}");
  assert.equal(database.matchIdentity, "DB:users");
  assert.equal(mq.matchIdentity, "MQ:user.events");

  const show = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Controller\\UserController::show()"));
  const store = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Controller\\UserController::store()"));
  const symfony = required(http.find((endpoint) => endpoint.httpMethod === "GET"));
  const laravel = required(http.find((endpoint) => endpoint.httpMethod === "POST"));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "ENDPOINT_TO_FUNCTION" && rel.fromNodeId === symfony.id && rel.toNodeId === show.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "ENDPOINT_TO_FUNCTION" && rel.fromNodeId === laravel.id && rel.toNodeId === store.id
  ));
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "FUNCTION_TO_ENDPOINT" && rel.fromNodeId === show.id && rel.toNodeId === redis.id
  ));
});

test("links Laravel grouped routes to imported controller methods", () => {
  const root = fixture({
    "src/Provider.php": `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('api')->group(__DIR__ . '/routes.php');
`,
    "src/routes.php": `<?php
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\CustomerController;
Route::controller(CustomerController::class)->prefix('customers')->group(function () {
    Route::get('{id?}', 'show');
});
`,
    "src/CustomerController.php": `<?php
namespace App\\Http;
class CustomerController { public function show(): void {} }
`
  });
  const delta = new PhpCodeGraphParser().parse({
    projectName: "laravel-demo",
    projectRoot: root,
    staticExtractPresetRules: ["laravel-route"]
  });

  const endpoint = required(delta.endpoints.find((candidate) => candidate.endpointType === "HTTP"));
  const handler = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Http\\CustomerController::show()"));
  assert.equal(endpoint.httpMethod, "GET");
  assert.equal(endpoint.normalizedPath, "/api/customers/{param}");
  assert.ok(delta.relationships.some((rel) =>
    rel.relationshipType === "ENDPOINT_TO_FUNCTION"
      && rel.fromNodeId === endpoint.id
      && rel.toNodeId === handler.id
  ));
});

test("reports a named Laravel handler that is absent from the project", () => {
  const root = fixture({
    "routes.php": `<?php
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\MissingController;
Route::get('missing', [MissingController::class, 'show']);
`
  });
  const delta = new PhpCodeGraphParser().parse({
    projectName: "laravel-missing",
    projectRoot: root,
    staticExtractPresetRules: ["laravel-route"]
  });

  assert.equal(delta.endpoints[0]?.parseLevel, "unresolved");
  assert.ok(delta.diagnostics.some((diagnostic) =>
    diagnostic.code === "php.endpoint.handler.unresolved"
      && diagnostic.details.handler === "MissingController::show"
  ));
});

test("links Symfony YAML routes to invokable controllers", () => {
  const root = fixture({
    "src/AcmeBundle.php": `<?php class AcmeBundle {}`,
    "src/UserAction.php": `<?php
namespace App\\Controller;
class UserAction { public function __invoke(): void {} }
`,
    "config/routes.yml": `acme:
  resource: "@AcmeBundle/Resources/config/routing.yml"
  prefix: /api
`,
    "config/services.yml": `services:
  acme.controller.user:
    class: App\\Controller\\UserAction
`,
    "src/Resources/config/routing.yml": `users:
  path: /users/{id}
  controller: acme.controller.user
  methods: [GET, HEAD]
`
  });
  const delta = new PhpCodeGraphParser().parse({
    projectName: "symfony-yaml",
    projectRoot: root,
    staticExtractPresetRules: ["symfony-route"]
  });

  assert.equal(delta.endpoints.length, 2);
  assert.ok(delta.endpoints.every((endpoint) => endpoint.normalizedPath === "/api/users/{param}"));
  const invoke = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Controller\\UserAction::__invoke()"));
  const links = delta.relationships.filter((relationship) => relationship.relationshipType === "ENDPOINT_TO_FUNCTION");
  assert.equal(links.length, 2);
  assert.ok(links.every((relationship) => relationship.toNodeId === invoke.id));
});

test("extracts nested Slim routes and links colon-style handlers", () => {
  const root = fixture({
    "routes.php": `<?php
use App\\Controller\\UserController;
$app->group('/V8', function () use ($app) {
    $app->get('/users', 'App\\Controller\\UserController:list');
    $app->post('/logout', UserController::class);
    $app->get('/service-users', 'UserService:list');
});
`,
    "container.php": `<?php
$container['UserService'] = function () {
    return new \\App\\Controller\\UserController();
};
`,
    "src/UserController.php": `<?php
namespace App\\Controller;
class UserController { public function list(): void {} public function __invoke(): void {} }
`
  });
  const delta = new PhpCodeGraphParser().parse({
    projectName: "slim-routes",
    projectRoot: root,
    staticExtractPresetRules: ["slim-route"]
  });

  const endpoint = required(delta.endpoints.find((candidate) => candidate.normalizedPath === "/V8/users"));
  const handler = required(delta.functions.find((fn) => fn.qualifiedName === "App\\Controller\\UserController::list()"));
  assert.equal(endpoint.httpMethod, "GET");
  assert.equal(endpoint.normalizedPath, "/V8/users");
  assert.ok(delta.relationships.some((relationship) =>
    relationship.relationshipType === "ENDPOINT_TO_FUNCTION"
      && relationship.fromNodeId === endpoint.id
      && relationship.toNodeId === handler.id
  ));
  const endpointLinks = delta.relationships.filter((relationship) => relationship.relationshipType === "ENDPOINT_TO_FUNCTION");
  assert.equal(delta.endpoints.length, 3);
  assert.equal(endpointLinks.length, 3);
});

test("emits a global scope and reports syntax errors without corrupting valid files", () => {
  const root = fixture({
    "good.php": "<?php function ok() {} ok();",
    "bad.php": "<?php function broken( {"
  });
  const delta = new PhpCodeGraphParser().parse({ projectName: "demo", projectRoot: root });

  assert.ok(delta.units.some((unit) => unit.modifiers.includes("global-scope")));
  assert.ok(delta.functions.some((fn) => fn.name === "ok"));
  assert.ok(delta.diagnostics.some((diagnostic) =>
    diagnostic.code === "php.parse.failed" && diagnostic.projectFilePath === "bad.php"
  ));
});

test("stdio CLI returns the engine GraphDelta contract", () => {
  const root = fixture({ "index.php": "<?php function boot() {} boot();" });
  const request = JSON.stringify({ projectName: "stdio-demo", language: "php", projectRoot: root });
  const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "--stdio"], {
    cwd: path.resolve("."),
    input: request,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const delta = JSON.parse(result.stdout) as { scope: { language: string }; deletedNodeIds: unknown[]; endpoints: unknown[] };
  assert.equal(delta.scope.language, "php");
  assert.deepEqual(delta.deletedNodeIds, []);
  assert.deepEqual(delta.endpoints, []);
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-parser-php-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function required<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
